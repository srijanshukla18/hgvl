// Jev (TypeSafe's decision model) over OpenRouter's Decisions API: typed
// questions in, probabilities out, no generated text. Used for routing voice
// commands and for judging whether a pending approval is risky.
// https://openrouter.ai/docs/guides/community/jev

const URL = 'https://openrouter.ai/api/alpha/decisions';

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> };

export type JevAnswers = Record<string, JevAnswer | undefined>;

export class Jev {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model: string, timeoutMs: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /** All questions are answered in one parallel pass; none can see the others' answers. */
  async decide(questions: Record<string, JevQuestion>, state: unknown): Promise<JevAnswers> {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'herdr hands' },
      // Terminal text and transcripts are sent: ask providers not to keep them.
      body: JSON.stringify({ model: this.model, questions, state, provider: { data_collection: 'deny' } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { answers?: JevAnswers; error?: { message?: string } } | null;
    if (!res.ok || !body?.answers) throw new Error(`jev ${res.status}: ${body?.error?.message ?? res.statusText}`);
    return body.answers;
  }
}
