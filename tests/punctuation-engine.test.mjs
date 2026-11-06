import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPunctuation,
  tokenizePunctuationText
} from '../apps/extension/src/punctuation-engine.ts';

test('tokenizes Chinese characters and ASCII words', () => {
  assert.deepEqual(
    tokenizePunctuationText('我对LOGO没啥感觉。'),
    ['我', '对', 'LOGO', '没', '啥', '感', '觉']
  );
});

test('applies model punctuation and preserves English spaces', () => {
  assert.equal(
    applyPunctuation(
      ['我', '喜欢', 'LOGO', '你', '好'],
      [1, 1, 2, 1, 3]
    ),
    '我喜欢LOGO，你好。'
  );
});

