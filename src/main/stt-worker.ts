// Speech worker (Electron utility process): NVIDIA Canary 180M Flash via
// sherpa-onnx, fully on-device. Re-decodes the growing utterance a few times a
// second for live partials, then once more on release for the final text.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

type In =
  | { type: 'init'; modelDir: string; threads: number }
  | { type: 'begin'; id: number }
  | { type: 'chunk'; id: number; samples: Float32Array }
  | { type: 'end'; id: number; cancel: boolean };

type Out =
  | { kind: 'ready'; model: string }
  | { kind: 'partial'; id: number; text: string }
  | { kind: 'final'; id: number; text: string; ms: number }
  | { kind: 'error'; message: string };

interface Recognizer {
  createStream(): { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text: string };
}

const RATE = 16000;
const PARTIAL_EVERY_MS = 450;

const port = (process as unknown as { parentPort: { on(ev: 'message', cb: (e: { data: In }) => void): void; postMessage(m: Out): void } }).parentPort;
const send = (m: Out) => port.postMessage(m);

let recognizer: Recognizer | null = null;
interface Utterance {
  id: number;
  chunks: Float32Array[];
  length: number;
  lastLen: number;
}
let current: Utterance | null = null;
let partialTimer: NodeJS.Timeout | null = null;
let lastDecodeMs = 0;

function init(modelDir: string, threads: number): void {
  const files = { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokens: 'tokens.txt' };
  for (const f of Object.values(files)) {
    if (!existsSync(join(modelDir, f))) {
      send({ kind: 'error', message: `Canary model not found in ${modelDir} — run \`npm run models\`` });
      return;
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sherpa = require('sherpa-onnx-node');
    const t0 = Date.now();
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: RATE, featureDim: 128 },
      modelConfig: {
        canary: {
          encoder: join(modelDir, files.encoder),
          decoder: join(modelDir, files.decoder),
          srcLang: 'en',
          tgtLang: 'en',
          usePnc: 1,
        },
        tokens: join(modelDir, files.tokens),
        numThreads: threads,
        provider: 'cpu',
        debug: 0,
      },
    }) as Recognizer;
    // Warm up so the first real utterance is fast.
    decode(new Float32Array(RATE / 2));
    send({ kind: 'ready', model: `canary-180m-flash (${Date.now() - t0} ms load)` });
  } catch (err) {
    send({ kind: 'error', message: `speech engine failed to load: ${String((err as Error)?.message ?? err)}` });
  }
}

function decode(samples: Float32Array): string {
  if (!recognizer) return '';
  const stream = recognizer.createStream();
  // A little trailing silence helps the decoder finish the last word.
  const padded = new Float32Array(samples.length + RATE / 4);
  padded.set(samples);
  stream.acceptWaveform({ samples: padded, sampleRate: RATE });
  const t0 = Date.now();
  recognizer.decode(stream);
  lastDecodeMs = Date.now() - t0;
  const text = recognizer.getResult(stream).text.trim();
  // sherpa-onnx forces a token out of any non-silent audio, so a cough or a
  // beep comes back as "." — no letters or digits means nothing was said.
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

function joined(u: Utterance): Float32Array {
  const out = new Float32Array(u.length);
  let o = 0;
  for (const c of u.chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Utterances that are essentially silence decode to nothing (and Canary can hallucinate on them). */
function isSilent(samples: Float32Array): boolean {
  let peak = 0;
  const win = 1600;
  for (let i = 0; i + win <= samples.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += samples[j] * samples[j];
    peak = Math.max(peak, Math.sqrt(s / win));
  }
  return peak < 0.012;
}

/** Re-decode the utterance so far; paced so decoding never hogs the worker. */
function partial(): void {
  partialTimer = null;
  if (!current || !recognizer) return;
  if (current.length !== current.lastLen && current.length >= RATE * 0.4) {
    current.lastLen = current.length;
    const audio = joined(current);
    if (!isSilent(audio)) send({ kind: 'partial', id: current.id, text: decode(audio) });
  }
  partialTimer = setTimeout(partial, Math.max(PARTIAL_EVERY_MS, lastDecodeMs * 2));
}

port.on('message', ({ data: m }) => {
  switch (m.type) {
    case 'init':
      init(m.modelDir, m.threads);
      break;
    case 'begin':
      current = { id: m.id, chunks: [], length: 0, lastLen: 0 };
      if (partialTimer) clearTimeout(partialTimer);
      partialTimer = setTimeout(partial, PARTIAL_EVERY_MS);
      break;
    case 'chunk':
      if (current?.id === m.id) {
        current.chunks.push(m.samples);
        current.length += m.samples.length;
      }
      break;
    case 'end': {
      if (partialTimer) clearTimeout(partialTimer);
      partialTimer = null;
      if (!current || current.id !== m.id) break;
      const utter = current;
      current = null;
      if (m.cancel) break;
      if (!recognizer) {
        send({ kind: 'error', message: 'speech model is not loaded' });
        break;
      }
      const t0 = Date.now();
      const audio = joined(utter);
      const text = audio.length < RATE * 0.3 || isSilent(audio) ? '' : decode(audio);
      send({ kind: 'final', id: utter.id, text, ms: Date.now() - t0 });
      break;
    }
  }
});
