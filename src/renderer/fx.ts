// Canvas layer: pane frames, the laser, hold rings and action bursts.
// Everything is drawn at display refresh rate and eased toward the latest
// 30 fps hand data, so motion looks fluid on a recording.

import type { EngineView } from '../engine/engine.ts';
import type { LayoutSnapshot, PaneView, Rect } from '../shared/types.ts';

export type BurstKind = 'approve' | 'deny' | 'stop' | 'send' | 'cancel';

const C = {
  accent: '56,225,255',
  blocked: '255,176,32',
  approve: '52,211,153',
  deny: '255,84,112',
  stop: '255,138,61',
  talk: '167,139,250',
  white: '255,255,255',
  working: '120,190,255',
  done: '52,211,153',
};

const BURST_COLOR: Record<BurstKind, string> = {
  approve: C.approve,
  deny: C.deny,
  stop: C.stop,
  send: C.talk,
  cancel: C.deny,
};

interface PaneAnim {
  focus: number;
  seen: number;
}

interface Burst {
  kind: BurstKind;
  paneId: string | null;
  at: { x: number; y: number };
  t0: number;
}

interface Comet {
  from: { x: number; y: number };
  paneId: string;
  t0: number;
  dur: number;
}

export class Fx {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private dpr = 1;
  layout: LayoutSnapshot = { connected: false, frame: { x: 0, y: 0, w: 0, h: 0 }, panes: [] };
  view: EngineView | null = null;
  talkLevel = 0;
  talkPaneId: string | null = null;
  private armedAmt = 0;
  private laser = { x: 0, y: 0, alpha: 0, init: false };
  private trail: { x: number; y: number; t: number }[] = [];
  private panes = new Map<string, PaneAnim>();
  private bursts: Burst[] = [];
  private comets: Comet[] = [];
  private last = performance.now();
  private idleCleared = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(innerWidth * this.dpr);
    this.canvas.height = Math.round(innerHeight * this.dpr);
  }

  burst(kind: BurstKind, paneId: string | null, at?: { x: number; y: number }): void {
    const p = paneId ? this.pane(paneId) : null;
    const pt = at ?? (p ? center(p.rect) : { x: innerWidth / 2, y: innerHeight / 2 });
    this.bursts.push({ kind, paneId, at: pt, t0: performance.now() });
  }

  comet(from: { x: number; y: number }, paneId: string): void {
    this.comets.push({ from, paneId, t0: performance.now(), dur: 380 });
  }

  paneCenter(paneId: string): { x: number; y: number } | null {
    const p = this.pane(paneId);
    return p ? center(p.rect) : null;
  }

  private pane(id: string): PaneView | undefined {
    return this.layout.panes.find((p) => p.id === id);
  }

  draw(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const v = this.view;
    const armed = v?.armed ?? false;
    this.armedAmt = approach(this.armedAmt, armed ? 1 : 0, dt, armed ? 8 : 4);

    const anyBlocked = this.layout.panes.some((p) => p.state === 'blocked');
    const busy =
      this.armedAmt > 0.001 || anyBlocked || this.bursts.length > 0 || this.comets.length > 0 || this.laser.alpha > 0.01;
    const ctx = this.ctx;
    if (!busy) {
      if (!this.idleCleared) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.idleCleared = true;
      return;
    }
    this.idleCleared = false;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    // Per-pane focus easing.
    const focusId = this.talkPaneId ?? v?.hoverPaneId ?? v?.addressedPaneId ?? null;
    for (const p of this.layout.panes) {
      const a = this.panes.get(p.id) ?? { focus: 0, seen: now };
      a.focus = approach(a.focus, p.id === focusId && (armed || p.id === this.talkPaneId) ? 1 : 0, dt, 14);
      a.seen = now;
      this.panes.set(p.id, a);
    }
    for (const [id, a] of this.panes) if (a.seen !== now) this.panes.delete(id);

    for (const p of this.layout.panes) this.drawPane(p, now);
    if (v?.hold) this.drawHold(v.hold.paneId, v.hold.kind, v.hold.progress, now);
    this.drawLaser(dt, now);
    this.drawComets(now);
    this.drawBursts(now);
  }

  // ---- panes ------------------------------------------------------------------

  private drawPane(p: PaneView, now: number): void {
    if (p.rect.w <= 0 || p.rect.h <= 0) return;
    const ctx = this.ctx;
    const a = this.panes.get(p.id)!;
    const r = inset(p.rect, 3);
    const armed = this.armedAmt;

    // Ambient: blocked agents glow even when the hand is down.
    if (p.state === 'blocked') {
      const pulse = 0.5 + 0.5 * Math.sin((now / 1000) * Math.PI * 1.25);
      const alpha = 0.35 + 0.45 * pulse;
      edgeGlow(ctx, r, C.blocked, 0.1 + 0.12 * pulse);
      glowStroke(ctx, r, 12, C.blocked, alpha, 2);
      this.chip(p, r, C.blocked, `${p.label} · needs you`, Math.max(0.85, armed), now);
    }

    if (armed > 0.01) {
      const base = p.state === 'working' ? C.working : p.state === 'done' ? C.done : C.white;
      if (p.state !== 'blocked') {
        roundRect(ctx, r, 12);
        ctx.strokeStyle = `rgba(${base},${0.22 * armed * (1 - a.focus)})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (p.agent) {
          const stateText = p.state === 'working' ? 'working' : p.state === 'done' ? 'done' : 'idle';
          this.chip(p, r, base, `${p.label} · ${stateText}`, armed * (0.55 + 0.45 * a.focus), now);
        }
      }
    }

    if (a.focus > 0.01) {
      const f = easeOutBack(a.focus);
      const grow = (1 - f) * 16;
      const fr = inset(r, -grow);
      const color = p.id === this.talkPaneId ? C.talk : p.state === 'blocked' ? C.blocked : C.accent;
      glowStroke(ctx, fr, 12, color, a.focus, 2.5);
      brackets(ctx, inset(fr, -6), 26, `rgba(${color},${a.focus})`, 3.5);
      edgeGlow(ctx, r, color, 0.08 * a.focus);
    }
  }

  private chip(p: PaneView, r: Rect, color: string, text: string, alpha: number, now: number): void {
    if (alpha <= 0.01) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 30;
    const h = 24;
    const x = r.x + r.w - w - 12;
    const y = r.y + 12;
    roundRect(ctx, { x, y, w, h }, h / 2);
    ctx.fillStyle = `rgba(12,14,20,${0.88 * alpha})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${color},${0.55 * alpha})`;
    ctx.lineWidth = 1;
    ctx.stroke();
    const blink = p.state === 'blocked' ? 0.55 + 0.45 * Math.sin(now / 180) : 1;
    ctx.beginPath();
    ctx.arc(x + 13, y + h / 2, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color},${alpha * blink})`;
    ctx.fill();
    ctx.fillStyle = `rgba(238,241,247,${alpha})`;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 22, y + h / 2 + 0.5);
    ctx.restore();
  }

  private drawHold(paneId: string, kind: 'interrupt' | 'approve', progress: number, now: number): void {
    const c = this.paneCenter(paneId);
    if (!c) return;
    const ctx = this.ctx;
    const color = kind === 'interrupt' ? C.stop : C.approve;
    const R = 46;
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.x, c.y, R + 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,12,18,0.78)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${color},0.18)`;
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = `rgba(${color},1)`;
    ctx.lineCap = 'round';
    ctx.lineWidth = 7;
    ctx.shadowColor = `rgba(${color},0.9)`;
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.shadowBlur = 0;
    glyph(ctx, kind === 'interrupt' ? 'stop' : 'approve', c.x, c.y, 20, `rgba(${color},1)`);
    ctx.font = '700 11px -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(238,241,247,${0.6 + 0.4 * Math.sin(now / 120)})`;
    ctx.fillText(kind === 'interrupt' ? 'HOLD TO STOP' : 'HOLD TO CONFIRM', c.x, c.y + R + 34);
    ctx.restore();
  }

  // ---- laser ------------------------------------------------------------------

  private drawLaser(dt: number, now: number): void {
    const ctx = this.ctx;
    const p = this.view?.pointer;
    const visible = !!p && p.visible && (this.view?.armed ?? false);
    const L = this.laser;
    L.alpha = approach(L.alpha, visible ? 1 : 0, dt, visible ? 16 : 7);
    if (p) {
      if (!L.init) {
        L.x = p.x;
        L.y = p.y;
        L.init = true;
      }
      // Ease toward the filtered fingertip every display frame (stable at any frame rate).
      L.x = approach(L.x, p.x, dt, 26);
      L.y = approach(L.y, p.y, dt, 26);
    }
    if (L.alpha < 0.01) {
      this.trail = [];
      return;
    }
    this.trail.push({ x: L.x, y: L.y, t: now });
    this.trail = this.trail.filter((q) => now - q.t < 140);

    const locked = p?.locked ?? false;
    const talking = this.view?.talking ?? false;
    const color = talking ? C.talk : C.accent;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      const k = i / this.trail.length;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(${color},${0.5 * k * L.alpha})`;
      ctx.lineWidth = 1.5 + 9 * k;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    const glowR = locked ? 24 : 40;
    const g = ctx.createRadialGradient(L.x, L.y, 0, L.x, L.y, glowR);
    g.addColorStop(0, `rgba(${color},${0.55 * L.alpha})`);
    g.addColorStop(0.4, `rgba(${color},${0.18 * L.alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(L.x, L.y, glowR, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.arc(L.x, L.y, locked ? 4 : 6.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${L.alpha})`;
    ctx.shadowColor = `rgba(${color},${L.alpha})`;
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (locked) {
      ctx.beginPath();
      ctx.arc(L.x, L.y, 13, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${color},${0.9 * L.alpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (talking) {
      for (let i = 0; i < 3; i++) {
        const ph = ((now / 900 + i / 3) % 1);
        ctx.beginPath();
        ctx.arc(L.x, L.y, 14 + ph * (30 + 50 * this.talkLevel), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${C.talk},${(1 - ph) * 0.6 * L.alpha})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---- effects ------------------------------------------------------------------

  private drawComets(now: number): void {
    const ctx = this.ctx;
    for (const c of this.comets) if (now - c.t0 >= c.dur) this.burst('send', c.paneId);
    this.comets = this.comets.filter((c) => now - c.t0 < c.dur);
    for (const c of this.comets) {
      const to = this.paneCenter(c.paneId);
      if (!to) continue;
      const k = easeInOut((now - c.t0) / c.dur);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 10; i++) {
        const kk = Math.max(0, k - i * 0.025);
        const x = c.from.x + (to.x - c.from.x) * kk;
        const y = c.from.y + (to.y - c.from.y) * kk - Math.sin(kk * Math.PI) * 60;
        ctx.beginPath();
        ctx.arc(x, y, 7 - i * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${C.talk},${0.9 - i * 0.085})`;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawBursts(now: number): void {
    const ctx = this.ctx;
    this.bursts = this.bursts.filter((b) => now - b.t0 < 900);
    for (const b of this.bursts) {
      const t = (now - b.t0) / 900;
      const color = BURST_COLOR[b.kind];
      const pane = b.paneId ? this.pane(b.paneId) : null;

      // Pane flash.
      if (pane) {
        const fa = Math.max(0, 1 - t * 1.6);
        glowStroke(ctx, inset(pane.rect, 3), 12, color, fa, 3);
        edgeGlow(ctx, inset(pane.rect, 3), color, 0.22 * fa);
      }
      // Ripples.
      for (let i = 0; i < 2; i++) {
        const tt = Math.max(0, t - i * 0.12);
        if (tt <= 0) continue;
        ctx.beginPath();
        ctx.arc(b.at.x, b.at.y, 40 + easeOut(tt) * 150, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${color},${(1 - tt) * 0.55})`;
        ctx.lineWidth = 3 - i;
        ctx.stroke();
      }
      // Badge.
      if (b.kind === 'send') continue;
      const s = t < 0.25 ? easeOutBack(t / 0.25) : 1;
      const fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      const R = 38 * s;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.arc(b.at.x, b.at.y, R, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${color},0.95)`;
      ctx.shadowColor = `rgba(${color},0.8)`;
      ctx.shadowBlur = 30;
      ctx.fill();
      ctx.shadowBlur = 0;
      glyph(ctx, b.kind, b.at.x, b.at.y, 17 * s, 'rgba(10,12,18,0.92)');
      ctx.restore();
    }
  }
}

// ---- drawing helpers ------------------------------------------------------------

function glyph(ctx: CanvasRenderingContext2D, kind: BurstKind | 'stop', x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, s * 0.28);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (kind) {
    case 'approve':
      ctx.moveTo(x - s * 0.62, y + s * 0.02);
      ctx.lineTo(x - s * 0.18, y + s * 0.48);
      ctx.lineTo(x + s * 0.66, y - s * 0.46);
      ctx.stroke();
      break;
    case 'deny':
    case 'cancel':
      ctx.moveTo(x - s * 0.5, y - s * 0.5);
      ctx.lineTo(x + s * 0.5, y + s * 0.5);
      ctx.moveTo(x + s * 0.5, y - s * 0.5);
      ctx.lineTo(x - s * 0.5, y + s * 0.5);
      ctx.stroke();
      break;
    case 'stop':
      roundRect(ctx, { x: x - s * 0.5, y: y - s * 0.5, w: s, h: s }, s * 0.18);
      ctx.fill();
      break;
    case 'send':
      break;
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, rad: number): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(rad, r.w / 2, r.h / 2));
}

function glowStroke(ctx: CanvasRenderingContext2D, r: Rect, rad: number, color: string, alpha: number, width: number): void {
  if (alpha <= 0.005) return;
  roundRect(ctx, r, rad);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgba(${color},${0.07 * alpha})`;
  ctx.lineWidth = width + 14;
  ctx.stroke();
  ctx.strokeStyle = `rgba(${color},${0.16 * alpha})`;
  ctx.lineWidth = width + 6;
  ctx.stroke();
  ctx.strokeStyle = `rgba(${color},${alpha})`;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Soft inner glow along a rect's edges. */
function edgeGlow(ctx: CanvasRenderingContext2D, r: Rect, color: string, alpha: number): void {
  if (alpha <= 0.005) return;
  const d = Math.min(70, r.w / 3, r.h / 3);
  const sides: [number, number, number, number, number, number, number, number][] = [
    [r.x, r.y, r.w, d, r.x, r.y, r.x, r.y + d],
    [r.x, r.y + r.h - d, r.w, d, r.x, r.y + r.h, r.x, r.y + r.h - d],
    [r.x, r.y, d, r.h, r.x, r.y, r.x + d, r.y],
    [r.x + r.w - d, r.y, d, r.h, r.x + r.w, r.y, r.x + r.w - d, r.y],
  ];
  ctx.save();
  roundRect(ctx, r, 12);
  ctx.clip();
  for (const [x, y, w, h, x0, y0, x1, y1] of sides) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

function brackets(ctx: CanvasRenderingContext2D, r: Rect, len: number, color: string, width: number): void {
  const l = Math.min(len, r.w / 3, r.h / 3);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const corners: [number, number, number, number][] = [
    [r.x, r.y, 1, 1],
    [r.x + r.w, r.y, -1, 1],
    [r.x + r.w, r.y + r.h, -1, -1],
    [r.x, r.y + r.h, 1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    ctx.moveTo(x, y + sy * l);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * l, y);
  }
  ctx.stroke();
  ctx.restore();
}

function inset(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d };
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function approach(cur: number, target: number, dt: number, rate: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - Math.min(1, t), 3);
}

function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function easeOutBack(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
