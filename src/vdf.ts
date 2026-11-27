// Minimal parser for Valve's text KeyValues format (.vdf and .acf files), which is
// how Steam stores its library list and per-game install records.
export type VdfValue = string | { [key: string]: VdfValue };

export function parseVdf(text: string): { [key: string]: VdfValue } {
  let i = 0;

  const skipSpaceAndComments = (): void => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) while (i < text.length && text[i] !== '\n') i++;
      else return;
    }
  };

  const readString = (): string => {
    // Callers have checked that text[i] is the opening quote.
    i++;
    let out = '';
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < text.length) {
        i++;
        const c = text[i];
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c; // \\ and \" and anything else keep the character
      } else out += text[i];
      i++;
    }
    if (i >= text.length) throw new Error('Unterminated string in VDF');
    i++;
    return out;
  };

  const readObject = (closing: boolean): { [key: string]: VdfValue } => {
    const obj: { [key: string]: VdfValue } = {};
    for (;;) {
      skipSpaceAndComments();
      if (i >= text.length) {
        if (closing) throw new Error('Unexpected end of VDF inside a block');
        return obj;
      }
      if (text[i] === '}') {
        if (!closing) throw new Error('Unexpected "}" in VDF');
        i++;
        return obj;
      }
      if (text[i] !== '"') throw new Error(`Unexpected "${text[i]}" in VDF at ${i}`);
      const key = readString();
      skipSpaceAndComments();
      if (text[i] === '{') {
        i++;
        obj[key] = readObject(true);
      } else if (text[i] === '"') {
        obj[key] = readString();
      } else {
        throw new Error(`Expected a value for "${key}" in VDF at ${i}`);
      }
    }
  };

  return readObject(false);
}
