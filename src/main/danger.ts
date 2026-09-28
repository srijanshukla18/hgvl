// Asks Jev whether what a blocked agent wants to do is risky, so approving it
// needs a held 👍. Verdicts are cached per blocked episode; until the first one
// arrives the approval also needs a hold, so a fast 👍 can't slip past the check.

import type { Jev, JevQuestion } from './jev.ts';
import type { PaneModel } from './model.ts';

/** At or above this probability of "hard to undo", approval needs a hold. */
const RISKY_P = 0.5;

const QUESTION: JevQuestion = {
  type: 'noul',
  instructions: 'A coding agent is asking permission for the action shown at the bottom of its terminal. Could approving it cause damage that is hard to undo?',
  criteria: {
    true: 'Destructive, irreversible or outward-facing: deletes data or files, force-pushes, deploys, changes infrastructure or production, spends money, sends messages or publishes.',
    false: 'Routine and reversible: reads files, runs tests or linters, edits code in the working tree, local builds and installs.',
  },
};

interface Entry {
  /** Text of the latest check sent (or in flight). */
  tail: string;
  /** Probability from the latest completed check, for this blocked episode. */
  risky: number | null;
  inflight: boolean;
  failed: boolean;
}

export class DangerCheck {
  private entries = new Map<string, Entry>();
  private readonly jev: Jev;
  private readonly onVerdict: () => void;
  private readonly log: (...args: unknown[]) => void;

  constructor(jev: Jev, onVerdict: () => void, log: (...args: unknown[]) => void) {
    this.jev = jev;
    this.onVerdict = onVerdict;
    this.log = log;
  }

  /** A reason approval of this blocked pane needs a hold, or null. */
  verdict(pane: PaneModel): string | null {
    if (!pane.tail) return null;
    let e = this.entries.get(pane.id);
    if (!e) {
      e = { tail: pane.tail, risky: null, inflight: false, failed: false };
      this.entries.set(pane.id, e);
      this.check(pane.id, e);
    } else if (e.tail !== pane.tail && !e.inflight) {
      e.tail = pane.tail;
      this.check(pane.id, e);
    }
    if (e.risky === null) return e.failed ? null : 'checking';
    return e.risky >= RISKY_P ? `risky (${Math.round(e.risky * 100)}%)` : null;
  }

  /** Forget panes that are no longer blocked; their next question is a new episode. */
  keep(blockedIds: string[]): void {
    for (const id of [...this.entries.keys()]) if (!blockedIds.includes(id)) this.entries.delete(id);
  }

  private check(paneId: string, e: Entry): void {
    e.inflight = true;
    const tail = e.tail;
    const t0 = Date.now();
    this.jev
      .decide({ risky: QUESTION }, { terminal: tail })
      .then((answers) => {
        const a = answers.risky;
        if (a?.type !== 'noul') throw new Error('no answer');
        e.risky = a.noul;
        e.failed = false;
        this.log(`jev danger (${Date.now() - t0} ms): ${paneId} ${a.noul.toFixed(2)}`);
      })
      .catch((err) => {
        e.failed = true;
        this.log('jev danger check failed, using the danger list only:', String((err as Error)?.message ?? err));
      })
      .finally(() => {
        e.inflight = false;
        if (this.entries.get(paneId) === e) this.onVerdict();
      });
  }
}
