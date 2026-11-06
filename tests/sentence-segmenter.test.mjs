import assert from 'node:assert/strict';
import test from 'node:test';
import { splitChineseCaption } from '../apps/extension/src/sentence-segmenter.ts';

test('uses width only when the model returned no boundary', () => {
  const text = (
    '法院开庭审理每方援行观疫情诽谤案武汉市中级人民法院十一月二日通报'
    + '该院于十月三十日开庭审理武汉市政府中国科学院武汉病毒研究所二零二五年'
    + '共提取的诽谤案一开始告的是美国密苏里州核潜艇两任总检察长后来又把'
  );
  const parts = splitChineseCaption(text, 0, 12_000_000);

  assert.ok(parts.length >= 3);
  assert.equal(parts[0]?.audioStartUs, 0);
  assert.equal(parts.at(-1)?.audioEndUs, 12_000_000);

  for (const [index, part] of parts.entries()) {
    assert.ok(Array.from(part.text).length <= 30);
    assert.ok(part.audioEndUs > part.audioStartUs);
    if (index < parts.length - 1) {
      assert.equal(part.audioEndUs, parts[index + 1]?.audioStartUs);
    }
  }
});

test('does not invent punctuation', () => {
  const parts = splitChineseCaption('好的', 0, 800_000);
  assert.deepEqual(parts, [{
    text: '好的',
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

test('falls back to width when discourse text has no model boundary', () => {
  const parts = splitChineseCaption(
    '对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢',
    0,
    6_000_000
  );
  assert.equal(parts.length, 2);
  assert.equal(parts.map((part) => part.text).join(''), (
    '对我做了介绍那么我想说的是大家如果对我的研究感兴趣呢'
  ));
  assert.doesNotMatch(parts[0]?.text || '', /[，。]$/u);
});

test('prefers a model soft boundary near the target length', () => {
  const parts = splitChineseCaption(
    '这是模型插入逗号之前的一段介绍，后面还有比较长的内容需要继续识别',
    0,
    6_000_000
  );
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.text, '这是模型插入逗号之前的一段介绍，');
});

test('prefers an early model boundary over the width fallback', () => {
  const parts = splitChineseCaption(
    '好的，后面这部分内容很长但是没有更多模型标点只能继续向后识别',
    0,
    7_000_000
  );
  assert.equal(parts[0]?.text, '好的，');
});
