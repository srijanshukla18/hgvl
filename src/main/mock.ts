// A pretend herdr: four agents in a 2x2 grid that work, block, and react to
// intents. Lets you try the overlay (and rehearse a demo) without herdr.

import { EventEmitter } from 'node:events';
import type { AgentState, IntentResult } from '../shared/types.ts';
import type { HerdrModel, HerdrSource, PaneModel } from './model.ts';

const COLS = 200;
const ROWS = 56;

export class MockHerdr extends EventEmitter implements HerdrSource {
  model: HerdrModel;
  private timers: NodeJS.Timeout[] = [];
  private base: PaneModel[];

  constructor() {
    super();
    const half = { w: COLS / 2, h: ROWS / 2 };
    this.base = [
      { id: 'mock-1', agent: 'claude', label: 'claude', state: 'working', focused: true, cells: { x: 0, y: 0, ...half } },
      { id: 'mock-2', agent: 'codex', label: 'codex', state: 'working', focused: false, cells: { x: half.w, y: 0, ...half } },
      { id: 'mock-3', agent: 'opencode', label: 'opencode', state: 'idle', focused: false, cells: { x: 0, y: half.h, ...half } },
      { id: 'mock-4', agent: 'claude', label: 'claude · infra', state: 'working', focused: false, cells: { x: half.w, y: half.h, ...half } },
    ];
    this.model = {
      connected: true,
      area: { w: COLS, h: ROWS },
      cellPx: null,
      chrome: false,
      panes: this.base.map((p) => ({ ...p })),
      zoomedPaneId: null,
      workspaces: [
        { id: 'mw1', label: 'checkout', number: 1, focused: true },
        { id: 'mw2', label: 'infra', number: 2, focused: false },
      ],
      tabs: [
        { id: 'mw1:t1', label: 'agents', number: 1, workspaceId: 'mw1', focused: true },
        { id: 'mw1:t2', label: 'api', number: 2, workspaceId: 'mw1', focused: false },
        { id: 'mw1:t3', label: 'dashboard', number: 3, workspaceId: 'mw1', focused: false },
        { id: 'mw2:t1', label: 'terraform', number: 1, workspaceId: 'mw2', focused: false },
      ],
    };
  }

  start(): void {
    this.later(3000, () => this.set('mock-1', 'blocked', 'Bash command: npm test\nDo you want to proceed?\n❯ 1. Yes\n  2. No'));
    this.later(9000, () => this.set('mock-4', 'blocked', 'Bash command: wrangler deploy --env production\nDo you want to proceed?'));
    this.emitChange();
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  async approve(id: string): Promise<IntentResult> {
    this.set(id, 'working');
    this.later(5000, () => this.set(id, 'done'));
    return { ok: true };
  }

  async deny(id: string): Promise<IntentResult> {
    this.set(id, 'idle');
    return { ok: true };
  }

  async interrupt(id: string): Promise<IntentResult> {
    this.set(id, 'idle');
    return { ok: true };
  }

  async focus(id: string): Promise<IntentResult> {
    for (const p of this.model.panes) p.focused = p.id === id;
    this.emitChange();
    return { ok: true };
  }

  // Navigation only moves the focus markers: the mock always shows the same four agents.
  async focusTab(id: string): Promise<IntentResult> {
    const tab = this.model.tabs.find((t) => t.id === id);
    if (!tab) return { ok: false, error: 'no such tab' };
    for (const t of this.model.tabs) t.focused = t === tab;
    for (const w of this.model.workspaces) w.focused = w.id === tab.workspaceId;
    this.emitChange();
    return { ok: true };
  }

  async focusWorkspace(id: string): Promise<IntentResult> {
    if (!this.model.workspaces.some((w) => w.id === id)) return { ok: false, error: 'no such workspace' };
    for (const w of this.model.workspaces) w.focused = w.id === id;
    const first = this.model.tabs.find((t) => t.workspaceId === id);
    for (const t of this.model.tabs) t.focused = t === first;
    this.emitChange();
    return { ok: true };
  }

  async prompt(id: string, text: string): Promise<IntentResult> {
    console.log(`[mock] prompt → ${id}: ${text}`);
    this.set(id, 'working');
    this.later(7000, () => this.set(id, 'blocked', `Edit file src/alerts.ts?\n${text}`));
    return { ok: true };
  }

  private set(id: string, state: AgentState, tail?: string): void {
    for (const list of [this.base, this.model.panes]) {
      const p = list.find((x) => x.id === id);
      if (p) {
        p.state = state;
        p.tail = tail;
      }
    }
    this.emitChange();
  }

  private relayout(): void {
    const z = this.model.zoomedPaneId;
    this.model.panes = this.base.map((p) => ({
      ...p,
      cells: z === null ? p.cells : p.id === z ? { x: 0, y: 0, w: COLS, h: ROWS } : { x: 0, y: 0, w: 0, h: 0 },
    }));
    this.emitChange();
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private emitChange(): void {
    this.emit('change', this.model);
  }
}
