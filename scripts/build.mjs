// Bundles main, preload, the speech worker and the overlay with esbuild.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };
const targets = [
  {
    ...common,
    entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts', 'stt-worker': 'src/main/stt-worker.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'sherpa-onnx-node'],
  },
  {
    ...common,
    entryPoints: { overlay: 'src/renderer/overlay.ts' },
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'iife',
  },
];

for (const f of ['index.html', 'overlay.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);

if (watch) {
  for (const t of targets) await (await context(t)).watch();
} else {
  await Promise.all(targets.map((t) => build(t)));
}
