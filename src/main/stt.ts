// Placeholder until the Canary worker lands.
import type { SpeechEvent } from '../shared/types.ts';
import type { HandsConfig } from './config.ts';
export class Speech {
  constructor(_cfg: HandsConfig, private emit: (e: SpeechEvent) => void) {}
  start(): void {}
  stop(): void {}
  begin(_id: number): void {}
  push(_id: number, _s: Float32Array): void {}
  end(id: number, cancel: boolean): void { if (!cancel) this.emit({ kind: 'final', id, text: 'add a p95 latency alert', ms: 0 }); }
}
