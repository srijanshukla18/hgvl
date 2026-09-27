// Per-frame hand features, computed once and shared by every recognizer.
// Landmark indices follow MediaPipe Hands: 0 wrist, 4 thumb tip, 5/6/8 index
// MCP/PIP/tip, 9 middle MCP, 12 middle tip, 16 ring tip, 20 pinky tip.

export interface Pt {
  x: number;
  y: number;
  z: number;
}

/** Canned MediaPipe gesture categories we care about. */
export type Canned =
  | 'None'
  | 'Closed_Fist'
  | 'Open_Palm'
  | 'Pointing_Up'
  | 'Thumb_Down'
  | 'Thumb_Up'
  | 'Victory'
  | 'ILoveYou';

export interface HandFrame {
  /** 21 image-space landmarks, x/y normalised to [0,1] of the camera frame. */
  image: Pt[];
  /** 21 world landmarks (metres, hand-centred) when available; used for shape. */
  world?: Pt[];
  canned: Canned;
  cannedScore: number;
}

export interface Features {
  /** Wrist to middle-finger MCP, the scale every shape distance is divided by. */
  palm: number;
  /** Thumb tip to index tip, in palm units. */
  pinch: number;
  /** Index tip to wrist, in palm units (≈0.8 curled, ≈1.8 straight). */
  indexReach: number;
  indexExtended: boolean;
  /** Mirrored image-space fingertip, [0,1]. */
  tip: { x: number; y: number };
  /** Image-space wrist height, [0,1] top to bottom. */
  wristY: number;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function computeFeatures(hand: HandFrame, mirror = true): Features {
  const s = hand.world && hand.world.length === 21 ? hand.world : hand.image;
  const palm = Math.max(1e-6, dist(s[0], s[9]));
  const pinch = dist(s[4], s[8]) / palm;
  const indexReach = dist(s[0], s[8]) / palm;
  // Straight index: tip clearly further from the wrist than its PIP joint.
  const indexExtended = dist(s[0], s[8]) > dist(s[0], s[6]) * 1.15 && indexReach > 1.25;
  const tipPt = hand.image[8];
  return {
    palm,
    pinch,
    indexReach,
    indexExtended,
    tip: { x: mirror ? 1 - tipPt.x : tipPt.x, y: tipPt.y },
    wristY: hand.image[0].y,
  };
}
