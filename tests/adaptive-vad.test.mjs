import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptiveVadGate } from '../apps/extension/src/adaptive-vad.ts';

test('uses bootstrap thresholds before enough samples are collected', () => {
  const gate = new AdaptiveVadGate();
  const decision = gate.update(0.4, false);
  assert.equal(decision.positiveThreshold, 0.5);
  assert.equal(decision.negativeThreshold, 0.35);
});

test('adapts thresholds to a quiet noise floor', () => {
  const gate = new AdaptiveVadGate();
  let decision;
  for (let index = 0; index < 40; index += 1) {
    decision = gate.update(0.04 + (index % 3) * 0.01, false);
  }
  assert.ok(decision.positiveThreshold < 0.5);
  assert.ok(decision.negativeThreshold < 0.35);
});

test('raises thresholds for noisy input', () => {
  const gate = new AdaptiveVadGate();
  let decision;
  for (let index = 0; index < 40; index += 1) {
    decision = gate.update(0.2 + (index % 5) * 0.02, false);
  }
  assert.ok(decision.positiveThreshold > 0.4);
});

test('freezes noise learning while speech is active', () => {
  const gate = new AdaptiveVadGate();
  for (let index = 0; index < 40; index += 1) {
    gate.update(0.05, false);
  }
  const duringSpeech = gate.update(0.9, true);
  const afterSpeech = gate.update(0.06, true);
  assert.equal(
    afterSpeech.positiveThreshold,
    duringSpeech.positiveThreshold
  );
});
