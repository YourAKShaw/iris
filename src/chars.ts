/**
 * Builds a global RegExp character class from code points, so invisible characters
 * (zero-width, bidi controls, exotic spaces) never appear literally in source files.
 */
export function charClass(codes: Array<number | [number, number]>, flags = 'g'): RegExp {
  const escape = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`;
  const body = codes.map((code) => (Array.isArray(code) ? `${escape(code[0])}-${escape(code[1])}` : escape(code))).join('');
  return new RegExp(`[${body}]`, flags);
}
