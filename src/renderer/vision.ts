// Camera capture + MediaPipe gesture recognizer (hand landmarks + canned
// gestures in one model). Frames never leave this process.

import { FilesetResolver, GestureRecognizer, type GestureRecognizerResult } from '@mediapipe/tasks-vision';
import type { Canned, HandFrame } from '../engine/features.ts';

export interface VisionFrame {
  hand: HandFrame | null;
  t: number;
  inferMs: number;
}

export class Vision {
  readonly video: HTMLVideoElement;
  private recognizer: GestureRecognizer | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private lastVideoTime = -1;
  delegate: 'GPU' | 'CPU' = 'GPU';

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async init(prefer: 'GPU' | 'CPU' = 'GPU'): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks('app://hands/wasm');
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: 'app://hands/models/gesture_recognizer.task', delegate },
      runningMode: 'VIDEO' as const,
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    this.delegate = prefer;
    try {
      this.recognizer = await GestureRecognizer.createFromOptions(fileset, options(prefer));
    } catch (err) {
      if (prefer === 'CPU') throw err;
      console.warn('GPU delegate unavailable, falling back to CPU', err);
      this.delegate = 'CPU';
      this.recognizer = await GestureRecognizer.createFromOptions(fileset, options('CPU'));
    }
  }

  async start(onFrame: (f: VisionFrame) => void): Promise<void> {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;

    const tick = () => {
      if (!this.running) return;
      this.process(onFrame);
      this.video.requestVideoFrameCallback(tick);
    };
    this.video.requestVideoFrameCallback(tick);
  }

  stop(): void {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get active(): boolean {
    return this.running;
  }

  private process(onFrame: (f: VisionFrame) => void): void {
    if (!this.recognizer || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    const t = performance.now();
    let result: GestureRecognizerResult;
    try {
      result = this.recognizer.recognizeForVideo(this.video, t);
    } catch (err) {
      console.error('recognizeForVideo failed', err);
      return;
    }
    onFrame({ hand: toHandFrame(result), t, inferMs: performance.now() - t });
  }
}

function toHandFrame(r: GestureRecognizerResult): HandFrame | null {
  const image = r.landmarks?.[0];
  if (!image || image.length !== 21) return null;
  const top = r.gestures?.[0]?.[0];
  return {
    image: image.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    world: r.worldLandmarks?.[0]?.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    canned: (top?.categoryName || 'None') as Canned,
    cannedScore: top?.score ?? 0,
  };
}
