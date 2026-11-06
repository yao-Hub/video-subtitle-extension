import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getNextRecognitionBoundary,
  shouldRecognizeAtTime
} from '../apps/extension/src/recognition-gate.ts';

const generatedRange = [{
  type: 'caption.final',
  videoStartMs: 5_000,
  videoEndMs: 8_000
}];

test('recognizes an ungenerated historical gap before existing captions', () => {
  assert.equal(shouldRecognizeAtTime(1_000, generatedRange), true);
  assert.equal(shouldRecognizeAtTime(4_500, generatedRange), true);
});

test('pauses while replaying an already generated caption range', () => {
  assert.equal(shouldRecognizeAtTime(5_000, generatedRange), false);
  assert.equal(shouldRecognizeAtTime(5_500, generatedRange), false);
  assert.equal(shouldRecognizeAtTime(7_999, generatedRange), false);
});

test('resumes recognition after leaving the generated range', () => {
  assert.equal(shouldRecognizeAtTime(8_000, generatedRange), true);
  assert.equal(shouldRecognizeAtTime(9_000, generatedRange), true);
});

test('finds the next caption boundary instead of polling', () => {
  assert.equal(getNextRecognitionBoundary(1_000, generatedRange), 5_000);
  assert.equal(getNextRecognitionBoundary(5_000, generatedRange), 8_000);
  assert.equal(getNextRecognitionBoundary(6_000, generatedRange), 8_000);
  assert.equal(getNextRecognitionBoundary(8_000, generatedRange), null);
});
