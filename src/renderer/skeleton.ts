// Hand skeleton drawn over the camera picture-in-picture.

import type { HandFrame } from '../engine/features.ts';

const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export function drawSkeleton(canvas: HTMLCanvasElement, video: HTMLVideoElement, hand: HandFrame | null, color: string): void {
  const dpr = devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!hand) return;

  // object-fit: cover mapping from video-normalised coords to canvas px.
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.max(cw / vw, ch / vh);
  const dx = (cw - vw * scale) / 2;
  const dy = (ch - vh * scale) / 2;
  const P = hand.image.map((p) => ({ x: dx + p.x * vw * scale, y: dy + p.y * vh * scale }));

  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of BONES) {
    ctx.moveTo(P[a].x, P[a].y);
    ctx.lineTo(P[b].x, P[b].y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (let i = 0; i < P.length; i++) {
    ctx.beginPath();
    ctx.arc(P[i].x, P[i].y, i === 8 || i === 4 ? 3.5 : 2, 0, Math.PI * 2);
    ctx.fillStyle = i === 8 ? '#fff' : color;
    ctx.fill();
  }
}
