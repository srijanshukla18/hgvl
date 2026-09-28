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

  async zoom(id: string): Promise<IntentResult> {
    this.model.zoomedPaneId = this.model.zoomedPaneId === id ? null : id;
    this.relayout();
    return { ok: true };
  }

  async focus(id: string): Promise<IntentResult> {
    for (const p of this.model.panes) p.focused = p.id === id;
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
