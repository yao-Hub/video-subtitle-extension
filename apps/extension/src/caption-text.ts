const MIN_SHARED_TEXT_LENGTH = 6;

export function normalizeCaptionText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function captionsShareOverlappingText(
  first: string,
  second: string
): boolean {
  const normalizedFirst = normalizeCaptionText(first);
  const normalizedSecond = normalizeCaptionText(second);
  if (!normalizedFirst || !normalizedSecond) {
    return false;
  }
  if (
    normalizedFirst.includes(normalizedSecond)
    || normalizedSecond.includes(normalizedFirst)
  ) {
    return true;
  }

  let previous = new Array<number>(normalizedSecond.length + 1).fill(0);
  for (let firstIndex = 1; firstIndex <= normalizedFirst.length; firstIndex += 1) {
    const current = new Array<number>(normalizedSecond.length + 1).fill(0);
    for (
      let secondIndex = 1;
      secondIndex <= normalizedSecond.length;
      secondIndex += 1
    ) {
      if (
        normalizedFirst[firstIndex - 1]
        !== normalizedSecond[secondIndex - 1]
      ) {
        continue;
      }
      current[secondIndex] = (previous[secondIndex - 1] || 0) + 1;
      if (current[secondIndex]! >= MIN_SHARED_TEXT_LENGTH) {
        return true;
      }
    }
    previous = current;
  }
  return false;
}
