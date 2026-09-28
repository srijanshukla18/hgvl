// Tiny synthesized UI sounds (no assets): each under ~120 ms and quiet.

export type Sound = 'arm' | 'click' | 'approve' | 'deny' | 'stop' | 'cancel' | 'talk' | 'send';

export class Sounds {
  enabled = true;
  private ctx: AudioContext | null = null;

  play(kind: Sound): void {
    if (!this.enabled) return;
    const ctx = (this.ctx ??= new AudioContext());
    const t = ctx.currentTime + 0.005;
    switch (kind) {
      case 'arm':
        tone(ctx, t, 520, 780, 0.09, 0.05);
        break;
      case 'click':
        tone(ctx, t, 1400, 900, 0.03, 0.06);
        break;
      case 'approve':
        tone(ctx, t, 660, 660, 0.07, 0.07);
        tone(ctx, t + 0.075, 990, 990, 0.1, 0.07);
        break;
      case 'deny':
        tone(ctx, t, 420, 300, 0.12, 0.07, 'triangle');
        break;
      case 'stop':
        tone(ctx, t, 300, 180, 0.14, 0.09, 'square', 900);
        break;
      case 'cancel':
        tone(ctx, t, 700, 350, 0.12, 0.05);
        break;
      case 'talk':
        tone(ctx, t, 880, 1320, 0.06, 0.05);
        break;
      case 'send':
        noise(ctx, t, 0.16, 0.05);
        tone(ctx, t + 0.02, 900, 1800, 0.12, 0.035);
        break;
    }
  }
}

function tone(
  ctx: AudioContext,
  t: number,
  f0: number,
  f1: number,
  dur: number,
  gain: number,
  type: OscillatorType = 'sine',
  lowpass = 6000,
): void {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = lowpass;
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(lp).connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(ctx: AudioContext, t: number, dur: number, gain: number): void {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(800, t);
  bp.frequency.exponentialRampToValueAtTime(5000, t + dur);
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t);
}
