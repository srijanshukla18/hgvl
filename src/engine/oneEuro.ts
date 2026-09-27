// One-euro filter (Casiez et al. 2012): heavy smoothing when the hand is still,
// low lag when it moves fast. Units of `beta` follow the units of the signal.

function alpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

export class OneEuro {
  minCutoff: number;
  beta: number;
  dCutoff: number;
  private x: number | null = null;
  private dx = 0;
  private tMs: number | null = null;

  constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
    this.tMs = null;
  }

  filter(value: number, tMs: number): number {
    if (this.x === null || this.tMs === null) {
      this.x = value;
      this.tMs = tMs;
      return value;
    }
    const dt = Math.max(1e-3, (tMs - this.tMs) / 1000);
    this.tMs = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

export class OneEuro2D {
  private fx: OneEuro;
  private fy: OneEuro;

  constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0) {
    this.fx = new OneEuro(minCutoff, beta, dCutoff);
    this.fy = new OneEuro(minCutoff, beta, dCutoff);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(x: number, y: number, tMs: number): { x: number; y: number } {
    return { x: this.fx.filter(x, tMs), y: this.fy.filter(y, tMs) };
  }
}
