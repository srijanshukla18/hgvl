// Downloads the on-device models into ./models (skips what is already there):
//  - MediaPipe gesture recognizer (hand landmarks + canned gestures), ~8 MB
//  - NVIDIA Canary 180M Flash, int8 ONNX export for sherpa-onnx, ~200 MB
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODELS = join(import.meta.dirname, '..', 'models');
const GESTURE_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task';
const CANARY_NAME = 'sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8';
const CANARY_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${CANARY_NAME}.tar.bz2`;

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -10;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (total && pct >= lastPct + 10) {
      lastPct = pct;
      process.stdout.write(`  ${pct}%`);
    }
  });
  await pipeline(body, createWriteStream(dest + '.part'));
  renameSync(dest + '.part', dest);
  if (total) process.stdout.write('\n');
}

mkdirSync(MODELS, { recursive: true });

const gesture = join(MODELS, 'gesture_recognizer.task');
if (!existsSync(gesture)) {
  console.log('Fetching MediaPipe gesture recognizer…');
  await download(GESTURE_URL, gesture);
}

const canary = join(MODELS, 'canary-180m-flash');
if (!existsSync(join(canary, 'encoder.int8.onnx'))) {
  console.log('Fetching Canary 180M Flash (int8, sherpa-onnx)…');
  const tarball = join(MODELS, `${CANARY_NAME}.tar.bz2`);
  if (!existsSync(tarball)) await download(CANARY_URL, tarball);
  execFileSync('tar', ['-xjf', tarball, '-C', MODELS], { stdio: 'inherit' });
  rmSync(canary, { recursive: true, force: true });
  renameSync(join(MODELS, CANARY_NAME), canary);
  rmSync(tarball);
}

console.log(`Models ready in ${MODELS}`);
