import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript } from '../src/main/transcript.ts';

test('stray single characters and punctuation are dropped', () => {
  for (const noise of ['', '.', ' ? ', 'T S F', 'T. S. F.', 'A', 'I.', 'x, y', '4 5']) {
    assert.equal(cleanTranscript(noise), '', JSON.stringify(noise));
  }
});

test('real speech is kept, including single-letter words inside it', () => {
  assert.equal(cleanTranscript(' Yes. '), 'Yes.');
  assert.equal(cleanTranscript('OK'), 'OK');
  assert.equal(cleanTranscript('I think a test is failing'), 'I think a test is failing');
});
