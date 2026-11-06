export interface CaptionPart {
  text: string;
  audioStartUs: number;
  audioEndUs: number;
}

const TARGET_CHARS = 20;
const MAX_CHARS = 28;
const HARD_BOUNDARIES = new Set(['。', '！', '？', '!', '?', '；', ';']);
const SOFT_BOUNDARIES = new Set(['，', ',', '、', '：', ':']);

function chooseCut(chars: string[], start: number): number {
  const remaining = chars.length - start;
  const hardBoundaryLimit = Math.min(chars.length, start + MAX_CHARS);

  for (let cut = start + 1; cut < hardBoundaryLimit; cut += 1) {
    if (HARD_BOUNDARIES.has(chars[cut - 1] || '')) {
      return cut;
    }
  }

  if (remaining <= TARGET_CHARS) {
    return chars.length;
  }

  const minimumEnd = start + 1;
  const maximumEnd = Math.min(chars.length, start + MAX_CHARS);
  const target = Math.min(start + TARGET_CHARS, maximumEnd);
  let bestIndex = target;
  let bestScore = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let cut = minimumEnd; cut <= maximumEnd; cut += 1) {
    const previous = chars[cut - 1]!;
    let score = 0;
    if (HARD_BOUNDARIES.has(previous)) {
      score = 100;
    } else if (SOFT_BOUNDARIES.has(previous)) {
      score = 80;
    } else if (previous === ' ') {
      score = 60;
    }

    const distance = Math.abs(cut - target);
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      bestScore = score;
      bestDistance = distance;
      bestIndex = cut;
    }
  }

  return bestIndex;
}

export function splitChineseCaption(
  text: string,
  audioStartUs: number,
  audioEndUs: number
): CaptionPart[] {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return [];
  }

  const chars = Array.from(normalized);
  const rawParts: string[] = [];
  let cursor = 0;
  while (cursor < chars.length) {
    const cut = chooseCut(chars, cursor);
    const part = chars.slice(cursor, cut).join('')
      .replace(/^[\s，,、：:；;]+/u, '')
      .replace(/\s{2,}/gu, ' ')
      .trim();
    if (part) {
      rawParts.push(part);
    }
    cursor = cut;
  }

  const weights = rawParts.map((part) => Math.max(1, Array.from(part).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const durationUs = Math.max(0, audioEndUs - audioStartUs);
  let weightBefore = 0;

  return rawParts.map((part, index) => {
    const startUs = audioStartUs + Math.round(
      durationUs * weightBefore / totalWeight
    );
    weightBefore += weights[index] || 1;
    const endUs = index === rawParts.length - 1
      ? audioEndUs
      : audioStartUs + Math.round(durationUs * weightBefore / totalWeight);
    return {
      text: part,
      audioStartUs: startUs,
      audioEndUs: Math.max(startUs + 1, endUs)
    };
  });
}

