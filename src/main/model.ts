// The daemon's view of Herdr: panes of the visible tab in cell coordinates,
// agent states, and the commands the gesture layer can issue. Two sources
// implement it: the real socket client and a mock for trying the overlay.

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
  /** Agent kind ("claude", "codex", …) or null for a plain terminal. */
  agent: string | null;
  label: string;
  state: AgentState;
  focused: boolean;
  /** Rect in cells, relative to the tab area; zero-sized when hidden by zoom. */
  cells: CellRect;
  /** Visible text of a blocked pane, for danger-list checks. */
  tail?: string;
}

export interface TabModel {
  id: string;
  label: string;
  number: number;
  workspaceId: string;
  focused: boolean;
}

export interface WorkspaceModel {
  id: string;
  label: string;
  number: number;
  focused: boolean;
}

export interface HerdrModel {
  connected: boolean;
  /** Tab area in cells; pane rects are relative to it. */
  area: { w: number; h: number };
  /** Attached client's cell size in pixels, when Herdr can report it. */
  cellPx: { w: number; h: number } | null;
  /** True when Herdr's sidebar and tab bar surround the tab area. */
  chrome: boolean;
  panes: PaneModel[];
  zoomedPaneId: string | null;
  /** Every tab and workspace in the session, for voice navigation. */
  tabs: TabModel[];
  workspaces: WorkspaceModel[];
  error?: string;
}

export interface HerdrSource extends EventEmitter {
  readonly model: HerdrModel;
  start(): void;
  stop(): void;
  approve(paneId: string, keys: KeyMap): Promise<IntentResult>;
  deny(paneId: string, keys: KeyMap): Promise<IntentResult>;
  interrupt(paneId: string, keys: KeyMap): Promise<IntentResult>;
  focus(paneId: string): Promise<IntentResult>;
  focusTab(tabId: string): Promise<IntentResult>;
  focusWorkspace(workspaceId: string): Promise<IntentResult>;
  prompt(paneId: string, text: string): Promise<IntentResult>;
}

/**
 * Keystrokes per agent kind, as Herdr logical keys. Approve answers with the
 * highlighted (default) option; deny and interrupt are Esc for every current CLI.
 */
export const DEFAULT_KEYS: Record<string, KeyMap> = {
  claude: { approve: ['enter'], deny: ['esc'], interrupt: ['esc'] },
  codex: { approve: ['y'], deny: ['esc'], interrupt: ['esc'] },
  opencode: { approve: ['enter'], deny: ['esc'], interrupt: ['esc'] },
  cursor: { approve: ['y'], deny: ['n'], interrupt: ['ctrl+c'] },
  default: { approve: ['enter'], deny: ['esc'], interrupt: ['esc'] },
};
