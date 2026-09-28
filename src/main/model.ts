// The daemon's view of Herdr: panes in terminal cell coordinates, agent
// states, and the commands the gesture layer can issue. Two sources implement
// it: the real socket client and a mock for trying the overlay without Herdr.

import type { EventEmitter } from 'node:events';
import type { AgentState, IntentResult } from '../shared/types.ts';
import type { KeyMap } from './config.ts';

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneModel {
  id: string;
  agent: string | null;
  label: string;
  state: AgentState;
  focused: boolean;
  cells: CellRect;
  /** Recent visible text of the pane (for danger-list checks), when known. */
  tail?: string;
}

export interface HerdrModel {
  connected: boolean;
  /** Size of the herdr client's terminal grid, in cells. */
  cols: number;
  rows: number;
  panes: PaneModel[];
  zoomedPaneId: string | null;
  error?: string;
}

export interface HerdrSource extends EventEmitter {
  readonly model: HerdrModel;
  start(): void;
  stop(): void;
  approve(paneId: string, keys: KeyMap): Promise<IntentResult>;
  deny(paneId: string, keys: KeyMap): Promise<IntentResult>;
  interrupt(paneId: string, keys: KeyMap): Promise<IntentResult>;
  zoom(paneId: string): Promise<IntentResult>;
  focus(paneId: string): Promise<IntentResult>;
  prompt(paneId: string, text: string): Promise<IntentResult>;
}

/** Default approval keystrokes per agent CLI (herdr's agent names). */
export const DEFAULT_KEYS: Record<string, KeyMap> = {
  claude: { approve: '1', deny: '\x1b', interrupt: '\x1b' },
  codex: { approve: 'y', deny: 'n', interrupt: '\x1b' },
  opencode: { approve: '\r', deny: '\x1b', interrupt: '\x1b' },
  cursor: { approve: 'y', deny: 'n', interrupt: '\x03' },
  default: { approve: '\r', deny: '\x1b', interrupt: '\x1b' },
};
