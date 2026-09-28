// Hosts the speech worker in an Electron utility process so model loading and
// decoding never stall the main process or the overlay.

import { app, utilityProcess, type UtilityProcess } from 'electron';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { SpeechEvent } from '../shared/types.ts';
import type { HandsConfig } from './config.ts';

export function defaultModelDir(): string {
  return join(app.getAppPath(), 'models', 'canary-180m-flash');
}

export class Speech {
  private cfg: HandsConfig;
  private emit: (e: SpeechEvent) => void;
  private proc: UtilityProcess | null = null;
  private stopping = false;

  constructor(cfg: HandsConfig, emit: (e: SpeechEvent) => void) {
    this.cfg = cfg;
    this.emit = emit;
  }

  start(): void {
    this.stopping = false;
    const proc = utilityProcess.fork(join(app.getAppPath(), 'dist', 'stt-worker.js'), [], {
      serviceName: 'herdr-hands speech',
      stdio: 'inherit',
    });
    proc.on('message', (e: SpeechEvent) => {
      if (e.kind === 'ready' || e.kind === 'error') console.log('[hands] speech:', e.kind === 'ready' ? e.model : e.message);
      this.emit(e);
    });
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) return;
      this.emit({ kind: 'error', message: `speech engine exited (${code}); restarting` });
      setTimeout(() => this.start(), 1000);
    });
    proc.postMessage({ type: 'init', modelDir: this.cfg.sttModelDir ?? defaultModelDir(), threads: Math.max(2, Math.min(4, availableParallelism() - 2)) });
    this.proc = proc;
  }

  stop(): void {
    this.stopping = true;
    this.proc?.kill();
    this.proc = null;
  }

  begin(id: number): void {
    this.proc?.postMessage({ type: 'begin', id });
  }

  push(id: number, samples: Float32Array): void {
    this.proc?.postMessage({ type: 'chunk', id, samples });
  }

  end(id: number, cancel: boolean): void {
    this.proc?.postMessage({ type: 'end', id, cancel });
  }
}
