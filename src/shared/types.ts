// Types shared between the main process (Herdr, speech) and the overlay renderer.

export type AgentState = 'working' | 'blocked' | 'idle' | 'done' | 'unknown';

/** A pane as the overlay sees it: rect in overlay (CSS px) coordinates. */
export interface PaneView {
  id: string;
  /** Agent CLI detected by Herdr ("claude", "codex", ...) or null for a plain shell. */
  agent: string | null;
  /** Friendly label shown on the overlay. */
  label: string;
  state: AgentState;
  focused: boolean;
  rect: Rect;
  /** Danger-list phrase found in the pane's pending prompt, if any. */
  danger?: string | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutSnapshot {
  connected: boolean;
  /** Terminal content rect in overlay coordinates (the pointer maps onto this). */
  frame: Rect;
  panes: PaneView[];
  zoomedPaneId: string | null;
  error?: string;
}

/** What the gesture/voice layer asks Herdr to do. */
export type Intent =
  | { kind: 'approve'; paneId: string }
  | { kind: 'deny'; paneId: string }
  | { kind: 'interrupt'; paneId: string }
  | { kind: 'zoom'; paneId: string }
  | { kind: 'focus'; paneId: string }
  | { kind: 'prompt'; paneId: string; text: string };

export interface IntentResult {
  ok: boolean;
  error?: string;
}

export type SpeechEvent =
  | { kind: 'ready'; model: string }
  | { kind: 'partial'; id: number; text: string }
  | { kind: 'final'; id: number; text: string; ms: number }
  | { kind: 'error'; message: string };

export interface OverlayConfig {
  showCamera: boolean;
  sounds: boolean;
  dangerList: string[];
  pointerGain: number;
  pointerCenter: [number, number];
  mirror: boolean;
  visionDelegate: 'GPU' | 'CPU';
}

/** API exposed to the overlay by the preload script. */
export interface HandsBridge {
  config(): Promise<OverlayConfig>;
  onLayout(cb: (layout: LayoutSnapshot) => void): void;
  onSpeech(cb: (e: SpeechEvent) => void): void;
  onToggle(cb: (enabled: boolean) => void): void;
  onDemo(cb: (cmd: string) => void): void;
  intent(intent: Intent): Promise<IntentResult>;
  speechStart(id: number): void;
  speechChunk(id: number, samples: Float32Array): void;
  speechEnd(id: number, cancel: boolean): void;
  log(...args: unknown[]): void;
}
