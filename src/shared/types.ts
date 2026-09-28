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
  error?: string;
}

/** What the gesture/voice layer asks Herdr to do. */
export type Intent =
  | { kind: 'approve'; paneId: string }
  | { kind: 'deny'; paneId: string }
  | { kind: 'interrupt'; paneId: string }
  | { kind: 'focus'; paneId: string }
  | { kind: 'focusTab'; tabId: string }
  | { kind: 'focusWorkspace'; workspaceId: string }
  | { kind: 'prompt'; paneId: string; text: string };

/** What a spoken utterance should do, decided once the transcript is final and confirmed with 👍. */
export type Route =
  | { kind: 'prompt'; paneId: string }
  | { kind: 'approve' | 'deny' | 'interrupt'; paneId: string }
  | { kind: 'focusTab'; tabId: string; label: string }
  | { kind: 'focusWorkspace'; workspaceId: string; label: string }
  | { kind: 'none'; reason: string };

export interface RouteRequest {
  text: string;
  /** The pane pointed at when the pinch started, if any. */
  paneId: string | null;
}

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
  /** Jev routes utterances, so talking without pointing at an agent works. */
  jev: boolean;
}

/** API exposed to the overlay by the preload script. */
export interface HandsBridge {
  config(): Promise<OverlayConfig>;
  onLayout(cb: (layout: LayoutSnapshot) => void): void;
  onSpeech(cb: (e: SpeechEvent) => void): void;
  onToggle(cb: (enabled: boolean) => void): void;
  onDemo(cb: (cmd: string) => void): void;
  intent(intent: Intent): Promise<IntentResult>;
  route(req: RouteRequest): Promise<Route>;
  speechStart(id: number): void;
  speechChunk(id: number, samples: Float32Array): void;
  speechEnd(id: number, cancel: boolean): void;
  log(...args: unknown[]): void;
}
