// Microphone capture at 16 kHz mono. The mic opens only while the overlay is
// armed; a short ring buffer provides pre-roll so the first word of an
// utterance is not lost while the pinch is still being recognised.

const RATE = 16000;
const PRE_ROLL_MAX = RATE * 1; // one second

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1600); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
`;

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private ring: Float32Array[] = [];
  private ringLen = 0;
  private sink: ((chunk: Float32Array) => void) | null = null;
  private opening: Promise<void> | null = null;
  /** Smoothed input level, 0..1, for the waveform. */
  level = 0;
  /** Recent levels for drawing a scrolling waveform. */
  readonly levels: number[] = new Array(40).fill(0);

  get open(): boolean {
    return this.ctx !== null;
  }

  async ensureOpen(): Promise<void> {
    if (this.ctx) return;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const ctx = new AudioContext({ sampleRate: RATE });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const src = ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(ctx, 'tap');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onChunk(e.data);
      src.connect(node);
      this.ctx = ctx;
      this.node = node;
    })();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  close(): void {
    this.sink = null;
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    this.ring = [];
    this.ringLen = 0;
    this.level = 0;
  }

  /** Start streaming to `sink`, first replaying up to `preRollMs` of buffered audio. */
  begin(preRollMs: number, sink: (chunk: Float32Array) => void): void {
    const want = Math.min(PRE_ROLL_MAX, Math.round((preRollMs / 1000) * RATE));
    const all = concat(this.ring);
    if (all.length > 0) sink(all.subarray(Math.max(0, all.length - want)));
    this.sink = sink;
  }

  end(): void {
    this.sink = null;
  }

  private onChunk(chunk: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    const lvl = Math.min(1, rms * 9);
    this.level = this.level * 0.5 + lvl * 0.5;
    this.levels.push(this.level);
    this.levels.shift();

    this.ring.push(chunk);
    this.ringLen += chunk.length;
    while (this.ringLen - this.ring[0].length >= PRE_ROLL_MAX) {
      this.ringLen -= this.ring.shift()!.length;
    }
    this.sink?.(chunk);
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
