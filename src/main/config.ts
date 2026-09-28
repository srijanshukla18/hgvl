// Config lives in ~/.config/herdr/hands.json; every key is optional.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Herdr logical keys, e.g. ["enter"], ["esc"], ["y"], ["ctrl+c"]. */
export interface KeyMap {
  approve: string[];
  deny: string[];
  interrupt: string[];
}

export interface HandsConfig {
  showCamera: boolean;
  sounds: boolean;
  mirror: boolean;
  pointerGain: number;
  /** Where in the camera frame (0..1) your pointing hand rests when aiming at the middle of the terminal. */
  pointerCenter: [number, number];
  /** MediaPipe delegate; GPU (Metal via WebGL) is fastest on a Mac. */
  visionDelegate: 'GPU' | 'CPU';
  /** Substrings that make an approval require a held thumbs-up. */
  dangerList: string[];
  /** Explicit herdr socket path; otherwise HERDR_SOCKET_PATH or herdr's default. */
  herdrSocket: string | null;
  /** App hosting the herdr client window ("Ghostty", "iTerm2", ...); "auto" finds it from the process tree. */
  terminalApp: string;
  /** Pixels to trim from the terminal window to reach the cell grid. "auto" top = title bar unless fullscreen. */
  frameInsets: { top: number | 'auto'; left: number; right: number; bottom: number };
  /** Directory holding the Canary model files; downloaded on first run when absent. */
  sttModelDir: string | null;
  /** Per-agent keystroke overrides, keyed by herdr's agent name. */
  agents: Record<string, Partial<KeyMap>>;
  /** Start with fake panes instead of connecting to herdr (for trying the overlay). */
  mock: boolean;
  /**
   * Jev over OpenRouter for voice commands, picking the agent you mean and
   * judging risky approvals. Active only when OPENROUTER_API_KEY is set.
   */
  jev: { enabled: boolean; model: string; timeoutMs: number };
}

export const configPath = join(homedir(), '.config', 'herdr', 'hands.json');

export const defaults: HandsConfig = {
  showCamera: true,
  sounds: true,
  mirror: true,
  pointerGain: 1.8,
  pointerCenter: [0.5, 0.55],
  visionDelegate: 'GPU',
  dangerList: ['deploy', 'wrangler', 'terraform apply', 'git push --force', 'git push -f', 'rm -rf', 'kubectl apply', 'drop table'],
  herdrSocket: null,
  terminalApp: 'auto',
  frameInsets: { top: 'auto', left: 0, right: 0, bottom: 0 },
  sttModelDir: null,
  agents: {},
  mock: false,
  jev: { enabled: true, model: 'typesafe/jev-1.13', timeoutMs: 3000 },
};

export function loadConfig(): HandsConfig {
  let user: Partial<HandsConfig> = {};
  if (existsSync(configPath)) {
    try {
      user = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.error(`[hands] ignoring ${configPath}: ${String(err)}`);
    }
  }
  const cfg: HandsConfig = {
    ...defaults,
    ...user,
    frameInsets: { ...defaults.frameInsets, ...(user.frameInsets ?? {}) },
    jev: { ...defaults.jev, ...(user.jev ?? {}) },
  };
  if (process.env.HANDS_MOCK === '1') cfg.mock = true;
  if (process.env.HANDS_DELEGATE === 'CPU' || process.env.HANDS_DELEGATE === 'GPU') cfg.visionDelegate = process.env.HANDS_DELEGATE;
  return cfg;
}

/** KEY=value lines from a .env file, without overriding the real environment. */
export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
