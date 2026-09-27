import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GestureEngine, type EngineContext, type EngineEvent } from '../src/engine/engine.ts';
import type { Canned, HandFrame, Pt } from '../src/engine/features.ts';
import type { PaneView } from '../src/shared/types.ts';

// A schematic right hand in palm units (wrist at origin, fingers toward -y).
const BASE: [number, number][] = [
  [0, 0],
  [-0.3, -0.2], [-0.5, -0.4], [-0.65, -0.6], [-0.75, -0.8], // thumb
  [-0.25, -1.0], [-0.3, -1.4], [-0.32, -1.65], [-0.33, -1.85], // index
  [0, -1.0], [0, -1.45], [0, -1.7], [0, -1.9], // middle
  [0.22, -0.95], [0.25, -1.35], [0.27, -1.55], [0.28, -1.72], // ring
  [0.42, -0.85], [0.47, -1.15], [0.5, -1.32], [0.52, -1.45], // pinky
];

type Shape = 'point' | 'curled' | 'pinch';

function hand(shape: Shape, canned: Canned, tipX = 0.5, tipY = 0.5, score = 0.9): HandFrame {
  const pts = BASE.map(([x, y]) => ({ x, y, z: 0 }));
  if (shape === 'curled') {
    pts[8] = { x: -0.2, y: -0.8, z: 0 };
    pts[7] = { x: -0.25, y: -1.0, z: 0 };
    pts[6] = { x: -0.3, y: -1.3, z: 0 };
  } else if (shape === 'pinch') {
    pts[8] = { x: -0.6, y: -1.2, z: 0 };
    pts[4] = { x: -0.6, y: -1.15, z: 0 };
  }
  // Place the image so that the (mirrored) index tip lands at tipX/tipY.
  const s = 0.12;
  const ox = 1 - tipX + pts[8].x * s; // mirror: image x = 1 - screen u
  const oy = tipY - pts[8].y * s;
  const image: Pt[] = pts.map((p) => ({ x: ox - p.x * s, y: oy + p.y * s, z: 0 }));
  return { image, world: pts, canned, cannedScore: score };
}

const frame = { x: 0, y: 0, w: 1000, h: 600 };
function pane(id: string, x: number, state: PaneView['state'], danger: string | null = null): PaneView {
  return { id, agent: 'claude', label: id, state, focused: false, rect: { x, y: 0, w: 500, h: 600 }, danger };
}

class Rig {
  engine = new GestureEngine({ gain: 1, centerX: 0.5, centerY: 0.5 });
  t = 0;
  events: EngineEvent[] = [];
  ctx: EngineContext;
  constructor(panes: PaneView[]) {
    this.ctx = { panes, frame, zoomedPaneId: null };
  }
  run(h: HandFrame | null, ms: number) {
    const end = this.t + ms;
    let last;
    while (this.t < end) {
      this.t += 33;
      const r = this.engine.update(h, this.t, this.ctx);
      this.events.push(...r.events);
      last = r.view;
    }
    return last!;
  }
  types() {
    return this.events.filter((e) => e.type !== 'arm' && e.type !== 'disarm');
  }
}

test('arms on a raised hand and disarms after it leaves', () => {
  const r = new Rig([pane('a', 0, 'idle')]);
  r.run(hand('point', 'None'), 300);
  assert.deepEqual(r.events[0], { type: 'arm' });
  r.run(null, 2000);
  assert.deepEqual(r.events.at(-1), { type: 'disarm' });
});

test('hands resting at the keyboard never arm', () => {
  const r = new Rig([pane('a', 0, 'blocked')]);
  r.run(hand('curled', 'Thumb_Up', 0.5, 1.2), 1500);
  assert.equal(r.events.length, 0);
});

test('pointing maps the fingertip onto the terminal and addresses the pane under it', () => {
  const r = new Rig([pane('a', 0, 'idle'), pane('b', 500, 'idle')]);
  const v = r.run(hand('point', 'Pointing_Up', 0.8, 0.5), 1000);
  assert.ok(v.pointer && v.pointer.visible);
  assert.ok(Math.abs(v.pointer!.x - 800) < 20, `x=${v.pointer!.x}`);
  assert.equal(v.hoverPaneId, 'b');
  assert.equal(v.addressedPaneId, 'b');
});

test('thumbs up approves the sole blocked agent exactly once per gesture', () => {
  const r = new Rig([pane('a', 0, 'working'), pane('b', 500, 'blocked')]);
  r.run(hand('curled', 'Thumb_Up'), 1500);
  assert.deepEqual(r.types(), [{ type: 'approve', paneId: 'b', confirmed: false }]);
  r.run(hand('point', 'None'), 400);
  r.run(hand('curled', 'Thumb_Up'), 600);
  assert.equal(r.types().length, 2);
});

test('with two blocked agents, the one you pointed at gets the answer', () => {
  const r = new Rig([pane('a', 0, 'blocked'), pane('b', 500, 'blocked')]);
  r.run(hand('point', 'None', 0.2, 0.5), 800);
  r.run(hand('curled', 'Thumb_Up', 0.2, 0.7), 500);
  assert.deepEqual(r.types(), [{ type: 'approve', paneId: 'a', confirmed: false }]);
});

test('with two blocked agents and nothing pointed at, thumbs up only hints', () => {
  const r = new Rig([pane('a', 0, 'blocked'), pane('b', 500, 'blocked')]);
  r.run(hand('curled', 'Thumb_Up'), 800);
  assert.equal(r.types()[0].type, 'hint');
});

test('danger-listed approvals need the thumbs up held', () => {
  const r = new Rig([pane('a', 0, 'blocked', 'deploy')]);
  const v = r.run(hand('curled', 'Thumb_Up'), 500);
  assert.equal(r.types().length, 0);
  assert.equal(v.hold?.kind, 'approve');
  r.run(hand('curled', 'Thumb_Up'), 800);
  assert.deepEqual(r.types(), [{ type: 'approve', paneId: 'a', confirmed: true }]);
});

test('a brief fist does nothing; a held fist interrupts', () => {
  const r = new Rig([pane('a', 0, 'working')]);
  r.run(hand('curled', 'Closed_Fist'), 400);
  r.run(hand('point', 'None'), 400);
  assert.equal(r.types().length, 0);
  r.run(hand('curled', 'Closed_Fist'), 1000);
  assert.deepEqual(r.types(), [{ type: 'interrupt', paneId: 'a' }]);
});

test('pinch tap zooms the pointed pane', () => {
  const r = new Rig([pane('a', 0, 'idle'), pane('b', 500, 'idle')]);
  r.run(hand('point', 'None', 0.7, 0.5), 600);
  r.run(hand('pinch', 'None', 0.6, 0.55), 150);
  r.run(hand('point', 'None', 0.7, 0.5), 200);
  assert.deepEqual(r.types(), [{ type: 'zoom', paneId: 'b' }]);
});

test('pinch hold talks to the pointed pane even if the hand drifts', () => {
  const r = new Rig([pane('a', 0, 'idle'), pane('b', 500, 'idle')]);
  r.run(hand('point', 'None', 0.3, 0.5), 600);
  const v = r.run(hand('pinch', 'None', 0.35, 0.5), 400);
  assert.equal(v.talking, true);
  r.run(hand('pinch', 'None', 0.8, 0.5), 1200);
  r.run(hand('point', 'None', 0.8, 0.5), 100);
  const t = r.types();
  assert.equal(t[0].type, 'talkStart');
  assert.equal((t[0] as { paneId: string }).paneId, 'a');
  assert.deepEqual(t[1], { type: 'talkEnd', paneId: 'a' });
});
