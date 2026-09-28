// Filters decoder output that isn't speech. sherpa-onnx forces a token out of
// any non-silent audio, so a cough or a beep comes back as "." or as stray
// letters ("T S F"): a transcript made only of single characters and
// punctuation means nothing was said.

const NOISE = /^[\s\p{P}\p{S}]*(?:[\p{L}\p{N}](?:[\s\p{P}\p{S}]+|$))*$/u;

export function cleanTranscript(text: string): string {
  const t = text.trim();
  return NOISE.test(t) ? '' : t;
}
