export const PUNCTUATION_LABELS = [
  '<unk>',
  '_',
  '，',
  '。',
  '？',
  '、'
] as const;

function isAsciiWord(word: string): boolean {
  return /^[\x00-\x7F]+$/u.test(word);
}

export function tokenizePunctuationText(text: string): string[] {
  const normalized = text
    .replace(/[，。！？、,.!?;；:：]/gu, ' ')
    .trim();
  const words: string[] = [];
  let asciiWord = '';

  for (const char of normalized) {
    if (char.trim() === '') {
      if (asciiWord) {
        words.push(asciiWord);
        asciiWord = '';
      }
    } else if ((char.codePointAt(0) || 0) <= 0x7f) {
      asciiWord += char;
    } else {
      if (asciiWord) {
        words.push(asciiWord);
        asciiWord = '';
      }
      words.push(char);
    }
  }

  if (asciiWord) {
    words.push(asciiWord);
  }
  return words;
}

export function applyPunctuation(
  words: string[],
  punctuationIds: number[]
): string {
  let result = '';
  let previousWasAscii = false;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const ascii = isAsciiWord(word);
    if (ascii && previousWasAscii) {
      result += ' ';
    }
    result += word;

    const punctuation = PUNCTUATION_LABELS[punctuationIds[index] ?? 0];
    if (punctuation !== '_' && punctuation !== '<unk>') {
      result += punctuation;
      previousWasAscii = false;
    } else {
      previousWasAscii = ascii;
    }
  }

  return result;
}

