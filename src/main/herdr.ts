// Herdr socket client: newline-delimited JSON over the session's Unix socket.
// State comes from `session.snapshot`, refreshed whenever the event stream
// reports a change (plus a slow poll as a safety net).

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentState, IntentResult } from '../shared/types.ts';
import type { HandsConfig, KeyMap } from './config.ts';
import type { HerdrModel, HerdrSource, PaneModel } from './model.ts';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Snapshot {
  focused_workspace_id: string | null;
  focused_tab_id: string | null;
  focused_pane_id: string | null;
  panes: { pane_id: string; tab_id: string; focused: boolean; agent_status?: string; cwd?: string; foreground_cwd?: string }[];
  layouts: { tab_id: string; zoomed: boolean; area: Rect; focused_pane_id: string; panes: { pane_id: string; focused: boolean; rect: Rect }[] }[];
  agents: { pane_id: string; agent: string; name?: string | null; agent_status: string; cwd?: string; foreground_cwd?: string }[];
  workspaces?: { workspace_id: string; label: string; number: number }[];
  tabs?: { tab_id: string; workspace_id: string; label: string; number: number }[];
}

class HerdrError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function resolveSocketPath(explicit: string | null): string {
  if (explicit) return explicit;
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const base = join(homedir(), '.config', 'herdr');
  if (process.env.HERDR_SESSION) return join(base, 'sessions', process.env.HERDR_SESSION, 'herdr.sock');
  return join(base, 'herdr.sock');
}

const GLOBAL_EVENTS = [
  'layout.updated',
  'pane.created',
  'pane.closed',
  'pane.focused',
  'pane.agent_detected',
  'pane.updated',
  'tab.focused',
  'tab.created',
  'tab.closed',
  'workspace.focused',
];

export class HerdrClient extends EventEmitter implements HerdrSource {
  model: HerdrModel = { connected: false, area: { w: 0, h: 0 }, cellPx: null, chrome: true, panes: [], zoomedPaneId: null, tabs: [], workspaces: [] };
  private path: string;
  private seq = 0;
  private sub: net.Socket | null = null;
  private subKey = '';
  private refreshTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private cellCheckedAt = 0;
  private tails = new Map<string, { text: string; at: number }>();
  private refreshing = false;
  private again = false;
  private stopped = false;

  constructor(cfg: HandsConfig) {
    super();
    this.path = resolveSocketPath(cfg.herdrSocket);
  }

  start(): void {
    this.stopped = false;
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.sub?.destroy();
    this.sub = null;
  }

  // ---- requests -----------------------------------------------------------

  /** One request per connection keeps the client stateless and robust to server restarts. */
  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 2500): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = `hands_${++this.seq}`;
      const sock = net.createConnection(this.path);
      let buf = '';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new HerdrError('timeout', `${method} timed out`));
      }, timeoutMs);
      sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'));
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg: { id?: string; result?: T; error?: { code: string; message: string } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== id && !(msg.error && msg.id === '')) continue;
          clearTimeout(timer);
          sock.end();
          if (msg.error) reject(new HerdrError(msg.error.code, msg.error.message));
          else resolve(msg.result as T);
          return;
        }
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(new HerdrError('socket', err.message));
      });
    });
  }

  // ---- state ----------------------------------------------------------------------

  private scheduleRefresh(ms = 30): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, ms);
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    try {
      const res = await this.request<{ snapshot: Snapshot }>('session.snapshot');
      await this.apply(res.snapshot);
    } catch (err) {
      const e = err as HerdrError;
      const missing = !existsSync(this.path);
      const error = missing ? `no herdr session at ${this.path}` : e.message;
      if (this.model.connected || this.model.error !== error) {
        this.model = { ...this.model, connected: false, panes: [], error };
        this.sub?.destroy();
        this.sub = null;
        this.subKey = '';
        this.emit('change', this.model);
      }
    } finally {
      this.refreshing = false;
      if (this.again) {
        this.again = false;
        this.scheduleRefresh(0);
      }
    }
  }

  private async apply(s: Snapshot): Promise<void> {
    const tabs = (s.tabs ?? []).map((t) => ({
      id: t.tab_id,
      label: t.label,
      number: t.number,
      workspaceId: t.workspace_id,
      focused: t.tab_id === s.focused_tab_id,
    }));
    const workspaces = (s.workspaces ?? []).map((w) => ({
      id: w.workspace_id,
      label: w.label,
      number: w.number,
      focused: w.workspace_id === s.focused_workspace_id,
    }));
    const layout = s.layouts.find((l) => l.tab_id === s.focused_tab_id) ?? s.layouts[0];
    if (!layout) {
      this.model = { ...this.model, connected: true, panes: [], tabs, workspaces, error: undefined };
      this.emit('change', this.model);
      return;
    }
    const byPane = new Map(s.panes.map((p) => [p.pane_id, p]));
    const agents = new Map(s.agents.map((a) => [a.pane_id, a]));
    const zoomedPaneId = layout.zoomed ? layout.focused_pane_id : null;

    const panes: PaneModel[] = layout.panes.map((lp) => {
      const info = byPane.get(lp.pane_id);
      const agent = agents.get(lp.pane_id);
      const hidden = zoomedPaneId !== null && lp.pane_id !== zoomedPaneId;
      const cells = hidden
        ? { x: 0, y: 0, w: 0, h: 0 }
        : zoomedPaneId === lp.pane_id
          ? { x: 0, y: 0, w: layout.area.width, h: layout.area.height }
          : { x: lp.rect.x - layout.area.x, y: lp.rect.y - layout.area.y, w: lp.rect.width, h: lp.rect.height };
      const status = (agent?.agent_status ?? info?.agent_status ?? 'unknown') as AgentState;
      return {
        id: lp.pane_id,
        agent: agent?.agent ?? null,
        label: agent?.name || agent?.agent || 'terminal',
        state: agent ? normalizeState(status) : 'idle',
        focused: lp.focused,
        cells,
        tail: this.tails.get(lp.pane_id)?.text,
      };
    });
    disambiguate(panes, (id) => {
      const p = byPane.get(id);
      const a = agents.get(id);
      return a?.foreground_cwd || a?.cwd || p?.foreground_cwd || p?.cwd || '';
    });

    this.model = {
      connected: true,
      area: { w: layout.area.width, h: layout.area.height },
      cellPx: this.model.cellPx,
      chrome: true,
      panes,
      zoomedPaneId,
      tabs,
      workspaces,
      error: undefined,
    };
    this.emit('change', this.model);

    this.ensureSubscription(s.panes.map((p) => p.pane_id));
    await Promise.all([this.updateCellSize(s.focused_pane_id ?? layout.focused_pane_id), this.updateTails(panes)]);
  }

  /** The attached client's cell size lets us place panes exactly on screen. */
  private async updateCellSize(paneId: string): Promise<void> {
    if (Date.now() - this.cellCheckedAt < 4000) return;
    this.cellCheckedAt = Date.now();
    try {
      const info = await this.request<{ cell_width_px: number; cell_height_px: number }>('pane.graphics.info', { pane_id: paneId });
      const cellPx = info.cell_width_px > 0 && info.cell_height_px > 0 ? { w: info.cell_width_px, h: info.cell_height_px } : null;
      if (JSON.stringify(cellPx) !== JSON.stringify(this.model.cellPx)) {
        this.model = { ...this.model, cellPx };
        this.emit('change', this.model);
      }
    } catch {
      // kitty graphics disabled or no client attached: geometry falls back to defaults.
    }
  }

  /** Read what blocked agents are asking, so dangerous approvals need a held gesture. */
  private async updateTails(panes: PaneModel[]): Promise<void> {
    const now = Date.now();
    for (const id of [...this.tails.keys()]) {
      if (!panes.some((p) => p.id === id && p.state === 'blocked')) this.tails.delete(id);
    }
    let changed = false;
    await Promise.all(
      panes
        .filter((p) => p.state === 'blocked' && now - (this.tails.get(p.id)?.at ?? 0) > 1500)
        .map(async (p) => {
          try {
            const res = await this.request<{ read: { text: string } }>('pane.read', { pane_id: p.id, source: 'visible', lines: 40 });
            // The question sits at the bottom of the screen; older output above it doesn't count.
            const text = res.read.text.split('\n').filter((l) => l.trim()).slice(-14).join('\n');
            this.tails.set(p.id, { text, at: Date.now() });
            if (p.tail !== text) {
              p.tail = text;
              changed = true;
            }
          } catch {
            // pane went away; the next snapshot will drop it
          }
        }),
    );
    if (changed) this.emit('change', this.model);
  }

  /** Global lifecycle events plus per-pane agent status; resubscribes when the pane set changes. */
  private ensureSubscription(paneIds: string[]): void {
    const key = [...paneIds].sort().join(',');
    if (this.sub && key === this.subKey) return;
    this.sub?.destroy();
    this.subKey = key;
    const subscriptions = [
      ...GLOBAL_EVENTS.map((type) => ({ type })),
      ...paneIds.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
    ];
    const sock = net.createConnection(this.path);
    this.sub = sock;
    let buf = '';
    sock.on('connect', () =>
      sock.write(JSON.stringify({ id: `hands_sub_${++this.seq}`, method: 'events.subscribe', params: { subscriptions } }) + '\n'),
    );
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\n')) {
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
        this.scheduleRefresh();
      }
    });
    const drop = () => {
      if (this.sub === sock) {
        this.sub = null;
        this.subKey = '';
      }
    };
    sock.on('error', drop);
    sock.on('close', drop);
  }

  // ---- commands --------------------------------------------------------------------

  private pane(id: string): PaneModel | undefined {
    return this.model.panes.find((p) => p.id === id);
  }

  /** Agent-level keys validate the agent; fall back to raw pane keys for hook-reported agents. */
  private async keys(paneId: string, keys: string[]): Promise<IntentResult> {
    try {
      await this.request('agent.send_keys', { target: paneId, keys });
      return { ok: true };
    } catch (err) {
      if ((err as HerdrError).code !== 'agent_not_ready') return fail(err);
      try {
        await this.request('pane.send_keys', { pane_id: paneId, keys });
        return { ok: true };
      } catch (err2) {
        return fail(err2);
      }
    }
  }

  async approve(paneId: string, k: KeyMap): Promise<IntentResult> {
    if (this.pane(paneId)?.state !== 'blocked') return { ok: false, error: 'that agent is not waiting for an answer' };
    return this.keys(paneId, k.approve);
  }

  async deny(paneId: string, k: KeyMap): Promise<IntentResult> {
    if (this.pane(paneId)?.state !== 'blocked') return { ok: false, error: 'that agent is not waiting for an answer' };
    return this.keys(paneId, k.deny);
  }

  async interrupt(paneId: string, k: KeyMap): Promise<IntentResult> {
    return this.keys(paneId, k.interrupt);
  }

  async focus(paneId: string): Promise<IntentResult> {
    try {
      await this.request('agent.focus', { target: paneId });
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  }

  async focusTab(tabId: string): Promise<IntentResult> {
    try {
      await this.request('tab.focus', { tab_id: tabId });
      this.scheduleRefresh(0);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  }

  async focusWorkspace(workspaceId: string): Promise<IntentResult> {
    try {
      await this.request('workspace.focus', { workspace_id: workspaceId });
      this.scheduleRefresh(0);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  }

  async prompt(paneId: string, text: string): Promise<IntentResult> {
    try {
      await this.request('agent.prompt', { target: paneId, text }, 5000);
      return { ok: true };
    } catch (err) {
      const code = (err as HerdrError).code;
      if (code === 'agent_blocked') return { ok: false, error: `${this.pane(paneId)?.label ?? 'agent'} is waiting for an answer — 👍 or 👎 first` };
      if (code !== 'agent_not_ready') return fail(err);
      try {
        await this.request('pane.send_input', { pane_id: paneId, text, keys: ['enter'] });
        return { ok: true };
      } catch (err2) {
        return fail(err2);
      }
    }
  }
}

function normalizeState(s: string): AgentState {
  return s === 'working' || s === 'blocked' || s === 'idle' || s === 'done' ? s : 'unknown';
}

/** Two agents of the same kind get their working directory appended: "claude · api". */
function disambiguate(panes: PaneModel[], cwdOf: (id: string) => string): void {
  const counts = new Map<string, number>();
  for (const p of panes) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  for (const p of panes) {
    if ((counts.get(p.label) ?? 0) > 1) {
      const dir = basename(cwdOf(p.id));
      p.label = dir ? `${p.label} · ${dir}` : `${p.label} · ${p.id.split(':').pop()}`;
    }
  }
  const seen = new Map<string, number>();
  for (const p of panes) {
    const n = (seen.get(p.label) ?? 0) + 1;
    seen.set(p.label, n);
    if (n > 1) p.label = `${p.label} ${n}`;
  }
}

function fail(err: unknown): IntentResult {
  return { ok: false, error: (err as Error)?.message ?? String(err) };
}
