import assert from 'node:assert/strict';
import test from 'node:test';
import { splitChineseCaption } from '../apps/extension/src/sentence-segmenter.ts';

test('splits a long unpunctuated Chinese transcript into readable captions', () => {
  const text = (
    '法院开庭审理每方援行观疫情诽谤案武汉市中级人民法院十一月二日通报'
    + '该院于十月三十日开庭审理武汉市政府中国科学院武汉病毒研究所二零二五年'
    + '共提取的诽谤案一开始告的是美国密苏里州核潜艇两任总检察长后来又把'
  );
  const parts = splitChineseCaption(text, 0, 12_000_000);

  assert.ok(parts.length >= 3);
  assert.equal(parts[0]?.audioStartUs, 0);
  assert.equal(parts.at(-1)?.audioEndUs, 12_000_000);
  assert.match(parts.at(-1)?.text || '', /。$/u);

  for (const [index, part] of parts.entries()) {
    assert.ok(Array.from(part.text).length <= 30);
    assert.ok(part.audioEndUs > part.audioStartUs);
    if (index < parts.length - 1) {
      assert.equal(part.audioEndUs, parts[index + 1]?.audioStartUs);
    }
  }
});

test('keeps a short caption intact and adds final punctuation', () => {
  const parts = splitChineseCaption('好的', 0, 800_000);
  assert.deepEqual(parts, [{
    text: '好的。',
    audioStartUs: 0,
    audioEndUs: 800_000
  }]);
});

test('respects existing hard sentence punctuation', () => {
  const parts = splitChineseCaption('第一句。第二句。', 0, 2_000_000);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.text, '第一句。');
  assert.equal(parts[1]?.text, '第二句。');
});

test('splits at a discourse marker even when the whole caption fits', () => {
  const parts = splitChineseCaption(
    '对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢',
    0,
    6_000_000
  );
  assert.equal(parts.length, 2);
  assert.match(parts[0]?.text || '', /，$/u);
  assert.match(parts[1]?.text || '', /。$/u);
});

test('does not add punctuation during streaming previews', () => {
  const parts = splitChineseCaption(
    '对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢',
    0,
    6_000_000,
    { preview: true }
  );
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.text, '对我做了介绍');
  assert.equal(parts[1]?.text, '那么我想说的是大家如果对我的研究感兴趣呢');
});
