// The intent engine: turns a stream of hand frames into a laser pointer, an
// addressed pane, and discrete events (approve, deny, interrupt, zoom, talk).
// Pure logic, no DOM or IPC, so it can be unit-tested with synthetic frames.

import type { PaneView, Rect } from '../shared/types.ts';
import { computeFeatures, type Canned, type Features, type HandFrame } from './features.ts';
import { OneEuro2D } from './oneEuro.ts';

export interface EngineConfig {
  mirror: boolean;
  /** Pointer gain about the camera-space centre; 1.8 means ~55% of the frame spans the terminal. */
  gain: number;
  centerX: number;
  centerY: number;
  /** Hands whose wrist is below this image height are resting on the keyboard: ignored. */
  floorY: number;
  armMs: number;
  disarmMs: number;
  stableFrames: number;
  cannedMinScore: number;
  fistHoldMs: number;
  confirmHoldMs: number;
  pinchOn: number;
  pinchOff: number;
  pinchTapMaxMs: number;
  addressGraceMs: number;
  cooldownMs: number;
  minCutoff: number;
  beta: number;
}

export const defaultEngineConfig: EngineConfig = {
  mirror: true,
  gain: 1.8,
  centerX: 0.5,
  centerY: 0.5,
  floorY: 0.94,
  armMs: 160,
  disarmMs: 1500,
  stableFrames: 4,
  cannedMinScore: 0.55,
  fistHoldMs: 650,
  confirmHoldMs: 900,
  pinchOn: 0.32,
  pinchOff: 0.5,
  pinchTapMaxMs: 300,
  addressGraceMs: 3500,
  cooldownMs: 650,
  minCutoff: 1.4,
  beta: 0.012,
};

export type Pose = 'none' | 'point' | 'pinch' | 'talk' | 'fist' | 'thumbUp' | 'thumbDown' | 'open' | 'other';

export type EngineEvent =
  | { type: 'arm' }
  | { type: 'disarm' }
  | { type: 'approve'; paneId: string; confirmed: boolean }
  | { type: 'deny'; paneId: string | null }
  | { type: 'interrupt'; paneId: string }
  | { type: 'zoom'; paneId: string }
  | { type: 'talkStart'; paneId: string | null; preRollMs: number }
  | { type: 'talkEnd'; paneId: string | null }
  | { type: 'hint'; text: string };

export interface HoldView {
  kind: 'interrupt' | 'approve';
  paneId: string;
  progress: number;
}

export interface EngineView {
  armed: boolean;
  handVisible: boolean;
  pose: Pose;
  pointer: { x: number; y: number; visible: boolean; locked: boolean } | null;
  hoverPaneId: string | null;
  addressedPaneId: string | null;
  hold: HoldView | null;
  talking: boolean;
}

export interface EngineContext {
  panes: PaneView[];
  frame: Rect;
  zoomedPaneId: string | null;
}

type PinchState =
  | { phase: 'none' }
  | { phase: 'down'; since: number; paneId: string | null }
  | { phase: 'talk'; since: number; paneId: string | null };

export class GestureEngine {
  cfg: EngineConfig;
  private filter: OneEuro2D;
  private present = false;
  private presentSince = 0;
  private lastSeen = -Infinity;
  private armed = false;
  private pointer: { x: number; y: number } | null = null;
  private pointerVisible = false;
  private history: { t: number; paneId: string | null }[] = [];
  private addressed: { paneId: string; t: number } | null = null;
  private candidate: { label: Canned; count: number } = { label: 'None', count: 0 };
  private latched: { label: Canned; clearSince: number | null } | null = null;
  private hold: { kind: 'interrupt' | 'approve'; paneId: string; since: number } | null = null;
  private pinch: PinchState = { phase: 'none' };
  private cooldownUntil = 0;

  constructor(cfg: Partial<EngineConfig> = {}) {
    this.cfg = { ...defaultEngineConfig, ...cfg };
    this.filter = new OneEuro2D(this.cfg.minCutoff, this.cfg.beta);
  }

  update(hand: HandFrame | null, now: number, ctx: EngineContext): { view: EngineView; events: EngineEvent[] } {
    const events: EngineEvent[] = [];
    const f = hand ? computeFeatures(hand, this.cfg.mirror) : null;
    const usable = f !== null && f.wristY < this.cfg.floorY;

    // ---- presence / arming -------------------------------------------------
    if (usable) {
      if (!this.present) this.presentSince = now;
      this.present = true;
      this.lastSeen = now;
      if (!this.armed && now - this.presentSince >= this.cfg.armMs) {
        this.armed = true;
        events.push({ type: 'arm' });
      }
    } else {
      this.present = false;
      // A dropped frame or two while talking must not end the utterance.
      if (this.pinch.phase === 'talk' && now - this.lastSeen > 450) {
        events.push({ type: 'talkEnd', paneId: this.pinch.paneId });
        this.pinch = { phase: 'none' };
      } else if (this.pinch.phase === 'down' && now - this.lastSeen > 200) {
        this.pinch = { phase: 'none' };
      }
      this.hold = null;
      this.candidate = { label: 'None', count: 0 };
      this.pointerVisible = false;
      if (this.armed && now - this.lastSeen >= this.cfg.disarmMs) {
        this.armed = false;
        this.pointer = null;
        this.filter.reset();
        this.addressed = null;
        this.latched = null;
        events.push({ type: 'disarm' });
      }
    }

    if (!usable || !this.armed || !f || !hand) {
      this.expireAddress(now);
      return { view: this.view(ctx, now, usable ? 'other' : 'none'), events };
    }

    const canned = hand.cannedScore >= this.cfg.cannedMinScore ? hand.canned : 'None';

    // ---- pinch (thumb + index), with hysteresis ----------------------------
    const pinchClosed =
      f.indexReach > 1.05 &&
      canned !== 'Closed_Fist' &&
      (this.pinch.phase === 'none' ? f.pinch < this.cfg.pinchOn : f.pinch < this.cfg.pinchOff);

    if (this.pinch.phase === 'none' && pinchClosed && now >= this.cooldownUntil) {
      // The fingertip dips toward the thumb while pinching; address what the
      // laser was on just before the pinch started.
      const paneId = this.paneAt(now - 140) ?? this.addressedPane(ctx);
      this.pinch = { phase: 'down', since: now, paneId };
      this.hold = null;
    } else if (this.pinch.phase === 'down') {
      if (!pinchClosed) {
        const target = this.pinch.paneId ?? ctx.zoomedPaneId;
        if (target) {
          events.push({ type: 'zoom', paneId: target });
          this.cooldownUntil = now + this.cfg.cooldownMs;
        } else {
          events.push({ type: 'hint', text: 'Point at a pane, then pinch to zoom' });
        }
        this.pinch = { phase: 'none' };
      } else if (now - this.pinch.since >= this.cfg.pinchTapMaxMs) {
        this.pinch = { phase: 'talk', since: this.pinch.since, paneId: this.pinch.paneId };
        events.push({ type: 'talkStart', paneId: this.pinch.paneId, preRollMs: this.cfg.pinchTapMaxMs + 200 });
      }
    } else if (this.pinch.phase === 'talk' && !pinchClosed) {
      events.push({ type: 'talkEnd', paneId: this.pinch.paneId });
      this.pinch = { phase: 'none' };
      this.cooldownUntil = now + this.cfg.cooldownMs;
    }

    // ---- pointer -------------------------------------------------------------
    const pinching = this.pinch.phase !== 'none';
    const curled = canned === 'Closed_Fist' || canned === 'Thumb_Up' || canned === 'Thumb_Down';
    const wasVisible = this.pointerVisible;
    this.pointerVisible = pinching || (f.indexExtended && !curled);

    if (this.pointerVisible && !pinching) {
      const target = this.mapPointer(f, ctx.frame);
      this.pointer = this.filter.filter(target.x, target.y, now);
      const hover = this.hitTest(ctx, this.pointer);
      this.history.push({ t: now, paneId: hover });
      if (hover) this.addressed = { paneId: hover, t: now };
      else this.addressed = null;
    } else if (wasVisible && !this.pointerVisible) {
      // The index curls on its way to a thumbs-up or fist and drags the tip
      // with it; roll the address back to where the laser was a moment ago.
      const before = this.paneAt(now - 220);
      if (before) this.addressed = { paneId: before, t: now };
    }
    this.history = this.history.filter((h) => now - h.t < 1000);
    this.expireAddress(now);

    // ---- discrete gestures -----------------------------------------------------
    if (canned === this.candidate.label) this.candidate.count++;
    else this.candidate = { label: canned, count: 1 };
    const stable = this.candidate.count >= this.cfg.stableFrames ? this.candidate.label : 'None';

    if (this.latched) {
      if (stable === this.latched.label || canned === this.latched.label) this.latched.clearSince = null;
      else if (this.latched.clearSince === null) this.latched.clearSince = now;
      else if (now - this.latched.clearSince > 250) this.latched = null;
    }
    const fresh = (label: Canned) => stable === label && (!this.latched || this.latched.label !== label);
    const ready = !pinching && now >= this.cooldownUntil;

    if (this.hold && (stable !== (this.hold.kind === 'interrupt' ? 'Closed_Fist' : 'Thumb_Up') || pinching)) {
      this.hold = null;
    }

    if (ready && fresh('Thumb_Up')) {
      const target = this.resolveTarget(ctx, ['blocked']);
      if (!target) {
        events.push({ type: 'hint', text: nobody(ctx, 'approve') });
        this.fire('Thumb_Up', now);
      } else if (target.danger) {
        if (!this.hold) this.hold = { kind: 'approve', paneId: target.id, since: now };
        else if (now - this.hold.since >= this.cfg.confirmHoldMs) {
          events.push({ type: 'approve', paneId: target.id, confirmed: true });
          this.fire('Thumb_Up', now);
        }
      } else {
        events.push({ type: 'approve', paneId: target.id, confirmed: false });
        this.fire('Thumb_Up', now);
      }
    } else if (ready && fresh('Thumb_Down')) {
      // Deny is also "cancel": the overlay uses a paneless deny to abort a pending send.
      const target = this.resolveTarget(ctx, ['blocked']);
      events.push({ type: 'deny', paneId: target?.id ?? null });
      this.fire('Thumb_Down', now);
    } else if (ready && fresh('Closed_Fist')) {
      const target = this.resolveTarget(ctx, ['blocked', 'working']);
      if (!target) {
        events.push({ type: 'hint', text: 'Point at an agent, then make a fist to stop it' });
        this.fire('Closed_Fist', now);
      } else if (!this.hold) {
        this.hold = { kind: 'interrupt', paneId: target.id, since: now };
      } else if (now - this.hold.since >= this.cfg.fistHoldMs) {
        events.push({ type: 'interrupt', paneId: target.id });
        this.fire('Closed_Fist', now);
      }
    }

    return { view: this.view(ctx, now, this.poseOf(f, canned)), events };
  }

  /** Pane under the laser at a past moment (from the last second of history). */
  private paneAt(t: number): string | null {
    let best: { t: number; paneId: string | null } | null = null;
    for (const h of this.history) {
      if (h.t <= t && (!best || h.t > best.t)) best = h;
    }
    return best ? best.paneId : (this.history[0]?.paneId ?? null);
  }

  private fire(label: Canned, now: number): void {
    this.latched = { label, clearSince: null };
    this.hold = null;
    this.cooldownUntil = now + this.cfg.cooldownMs;
  }

  private expireAddress(now: number): void {
    if (this.addressed && !this.pointerVisible && now - this.addressed.t > this.cfg.addressGraceMs) {
      this.addressed = null;
    }
  }

  private addressedPane(ctx: EngineContext): string | null {
    if (!this.addressed) return null;
    return ctx.panes.some((p) => p.id === this.addressed!.paneId) ? this.addressed.paneId : null;
  }

  /** Address, then act: the pointed pane wins; otherwise the sole agent in a matching state. */
  private resolveTarget(ctx: EngineContext, states: PaneView['state'][]): PaneView | null {
    const id = this.addressedPane(ctx);
    if (id) {
      const p = ctx.panes.find((x) => x.id === id)!;
      return states.includes(p.state) ? p : null;
    }
    for (const s of states) {
      const matches = ctx.panes.filter((p) => p.state === s && p.agent);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    }
    return null;
  }

  private mapPointer(f: Features, frame: Rect): { x: number; y: number } {
    const u = clamp(0.5 + (f.tip.x - this.cfg.centerX) * this.cfg.gain, -0.03, 1.03);
    const v = clamp(0.5 + (f.tip.y - this.cfg.centerY) * this.cfg.gain, -0.03, 1.03);
    return { x: frame.x + u * frame.w, y: frame.y + v * frame.h };
  }

  private hitTest(ctx: EngineContext, p: { x: number; y: number }): string | null {
    for (const pane of ctx.panes) {
      const r = pane.rect;
      if (r.w > 0 && p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) return pane.id;
    }
    return null;
  }

  private poseOf(f: Features, canned: Canned): Pose {
    if (this.pinch.phase === 'talk') return 'talk';
    if (this.pinch.phase === 'down') return 'pinch';
    if (canned === 'Thumb_Up') return 'thumbUp';
    if (canned === 'Thumb_Down') return 'thumbDown';
    if (canned === 'Closed_Fist') return 'fist';
    if (f.indexExtended && canned !== 'Open_Palm') return 'point';
    if (canned === 'Open_Palm') return 'open';
    return 'other';
  }

  private view(ctx: EngineContext, now: number, pose: Pose): EngineView {
    const hoverPaneId = this.pointerVisible && this.pointer ? this.hitTest(ctx, this.pointer) : null;
    let hold: HoldView | null = null;
    if (this.hold) {
      const total = this.hold.kind === 'interrupt' ? this.cfg.fistHoldMs : this.cfg.confirmHoldMs;
      hold = { kind: this.hold.kind, paneId: this.hold.paneId, progress: clamp((now - this.hold.since) / total, 0, 1) };
    }
    const locked = this.pinch.phase !== 'none';
    return {
      armed: this.armed,
      handVisible: this.present,
      pose,
      pointer: this.pointer ? { ...this.pointer, visible: this.pointerVisible, locked } : null,
      hoverPaneId: this.pinch.phase !== 'none' ? this.pinch.paneId : hoverPaneId,
      addressedPaneId: this.addressedPane(ctx),
      hold,
      talking: this.pinch.phase === 'talk',
    };
  }
}

function nobody(ctx: EngineContext, verb: string): string {
  const blocked = ctx.panes.filter((p) => p.state === 'blocked').length;
  if (blocked > 1) return `${blocked} agents are waiting — point at one to ${verb}`;
  return 'No agent is waiting for an answer';
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
