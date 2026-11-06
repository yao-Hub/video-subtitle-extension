export interface CaptionPart {
  text: string;
  audioStartUs: number;
  audioEndUs: number;
}

const MIN_CHARS = 12;
const TARGET_CHARS = 20;
const MAX_CHARS = 28;
const HARD_BOUNDARIES = new Set(['。', '！', '？', '!', '?', '；', ';']);
const SOFT_BOUNDARIES = new Set(['，', ',', '、', '：', ':']);
const DISCOURSE_MARKERS = [
  '但是',
  '不过',
  '然而',
  '因此',
  '所以',
  '然后',
  '后来',
  '同时',
  '此外',
  '另外',
  '那么',
  '接下来',
  '也就是说',
  '另一方面',
  '首先',
  '其次',
  '目前',
  '如今'
];

function hasDiscourseMarkerAt(chars: string[], index: number): boolean {
  for (const marker of DISCOURSE_MARKERS) {
    const markerChars = Array.from(marker);
    if (index + markerChars.length > chars.length) {
      continue;
    }
    if (markerChars.every((char, offset) => chars[index + offset] === char)) {
      return true;
    }
  }
  return false;
}

function chooseCut(chars: string[], start: number): number {
  const remaining = chars.length - start;
  if (remaining <= MAX_CHARS) {
    for (let cut = start + 1; cut < chars.length; cut += 1) {
      if (HARD_BOUNDARIES.has(chars[cut - 1] || '')) {
        return cut;
      }
    }

    let bestCut = chars.length;
    let bestDistance = Number.POSITIVE_INFINITY;
    const target = start + TARGET_CHARS;
    for (let cut = start + 4; cut <= chars.length - 4; cut += 1) {
      const isMarker = hasDiscourseMarkerAt(chars, cut);
      const previous = chars[cut - 1]!;
      const isSoftBoundary = SOFT_BOUNDARIES.has(previous);
      if (!isMarker && !isSoftBoundary) {
        continue;
      }
      const distance = Math.abs(cut - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCut = cut;
      }
    }
    if (bestCut < chars.length) {
      return bestCut;
    }
    return chars.length;
  }

  const minimumEnd = Math.max(
    start + MIN_CHARS,
    chars.length - MAX_CHARS
  );
  const maximumEnd = Math.min(
    start + MAX_CHARS,
    chars.length - MIN_CHARS
  );
  const target = Math.min(start + TARGET_CHARS, maximumEnd);
  let bestIndex = target;
  let bestScore = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let cut = minimumEnd; cut <= maximumEnd; cut += 1) {
    const previous = chars[cut - 1]!;
    let score = 0;
    if (HARD_BOUNDARIES.has(previous)) {
      score = 100;
    } else if (hasDiscourseMarkerAt(chars, cut)) {
      score = 90;
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

function punctuatePart(text: string, isLast: boolean): string {
  const chars = Array.from(text);
  if (HARD_BOUNDARIES.has(chars.at(-1) || '')) {
    return text;
  }
  const last = chars.at(-1) || '';
  if (SOFT_BOUNDARIES.has(last)) {
    return isLast ? `${chars.slice(0, -1).join('')}。` : text;
  }
  return `${text}${isLast ? '。' : '，'}`;
}

export function splitChineseCaption(
  text: string,
  audioStartUs: number,
  audioEndUs: number,
  options: { preview?: boolean } = {}
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

  const punctuated = options.preview
    ? rawParts
    : rawParts.map((part, index) => (
      punctuatePart(part, index === rawParts.length - 1)
    ));
  const weights = punctuated.map((part) => Math.max(1, Array.from(part).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const durationUs = Math.max(0, audioEndUs - audioStartUs);
  let weightBefore = 0;

  return punctuated.map((part, index) => {
    const startUs = audioStartUs + Math.round(
      durationUs * weightBefore / totalWeight
    );
    weightBefore += weights[index] || 1;
    const endUs = index === punctuated.length - 1
      ? audioEndUs
      : audioStartUs + Math.round(durationUs * weightBefore / totalWeight);
    return {
      text: part,
      audioStartUs: startUs,
      audioEndUs: Math.max(startUs + 1, endUs)
    };
  });
}

