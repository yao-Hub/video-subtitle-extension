import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captionsShareOverlappingText,
  normalizeCaptionText
} from '../apps/extension/src/caption-text.ts';

test('normalizes punctuation and spacing for caption comparison', () => {
  assert.equal(normalizeCaptionText(' Apple， 苹果！ '), 'apple苹果');
});

test('detects overlapping recognition text from adjacent captions', () => {
  assert.equal(captionsShareOverlappingText(
    '但是苹果真的不应该把触。',
    '苹果真的不应该把触摸屏作为这一台笔记本电脑的首要宣传点。'
  ), true);
});

test('keeps unrelated captions separate', () => {
  assert.equal(captionsShareOverlappingText(
    '虽然它只是十指触控',
    '但是我自已真的想不到应用场景'
  ), false);
});
