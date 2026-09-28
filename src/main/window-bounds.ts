// Finds the on-screen rectangle of the terminal window that shows herdr, so
// pane cells can be mapped to pixels. macOS only (System Events); elsewhere
// callers fall back to the whole display.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Rect } from '../shared/types.ts';

const run = promisify(execFile);

export interface WindowInfo {
  app: string;
  bounds: Rect;
}

/** Walk up from a herdr client process to the .app bundle hosting it. */
export async function findTerminalApp(): Promise<{ app: string; pid: number } | null> {
  if (process.platform !== 'darwin') return null;
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,comm=']);
  const procs = new Map<number, { ppid: number; comm: string }>();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
  }
  // herdr clients are the herdr processes attached to a terminal; the server is
  // a daemon whose ancestry ends at launchd, which the walk below rejects.
  for (const [pid, p] of procs) {
    if (!/(^|\/)herdr$/.test(p.comm)) continue;
    let cur = p.ppid;
    for (let depth = 0; depth < 12 && cur > 1; depth++) {
      const q = procs.get(cur);
      if (!q) break;
      const app = q.comm.match(/\/([^/]+)\.app\/Contents\/MacOS\//);
      if (app) return { app: app[1], pid: cur };
      cur = q.ppid;
    }
    void pid;
  }
  return null;
}

export async function frontWindowBounds(target: { app: string; pid?: number }): Promise<WindowInfo | null> {
  if (process.platform !== 'darwin') return null;
  const who = target.pid ? `first process whose unix id is ${target.pid}` : `process "${target.app.replace(/"/g, '')}"`;
  const script = `tell application "System Events" to tell (${who})
    set w to front window
    set p to position of w
    set s to size of w
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end tell`;
  try {
    const { stdout } = await run('osascript', ['-e', script], { timeout: 2000 });
    const [x, y, w, h] = stdout.trim().split(',').map(Number);
    if ([x, y, w, h].some((n) => !Number.isFinite(n)) || w <= 0 || h <= 0) return null;
    return { app: target.app, bounds: { x, y, w, h } };
  } catch {
    return null;
  }
}
