// Indonesian number formatting by hand (ported from the predecessor packages/video/src/format-number.ts), so a count-up renders
// identically in Node, headless Chrome and the Editor (no ICU differences): 1234.5 → "1.234,5"; 1.2e12 → "1,2 triliun" (compact).
// ADR-034 adds parsing of the number inside a text ("+17,2%", "US$ 25,96", "Rp472 triliun", "1.200 MW", "−3,8%") so a counter
// can run from any start value to it while keeping the text's own sign, separators and decimals.
export interface NumberFormatOptions { prefix?: string; unit?: string; decimals?: number; compact?: boolean }
const SCALES: Array<[number, string]> = [[1e12, 'triliun'], [1e9, 'miliar'], [1e6, 'juta'], [1e3, 'ribu']];

/** 1234567.891, 2 → "1.234.567,89" */
export function formatId(n: number, decimals = 0, group = '.', dec = ','): string {
  if (!Number.isFinite(n)) return '–';
  const fixed = Math.abs(n).toFixed(Math.max(0, decimals));
  const [intPart, frac] = fixed.split('.');
  const grouped = group ? intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, group) : intPart!;
  return `${n < 0 && Number(fixed) !== 0 ? '-' : ''}${grouped}${frac ? `${dec}${frac}` : ''}`;
}
export function scaleFor(value: number, compact: boolean): { divisor: number; word: string } {
  if (!compact) return { divisor: 1, word: '' };
  for (const [divisor, word] of SCALES) if (Math.abs(value) >= divisor) return { divisor, word };
  return { divisor: 1, word: '' };
}
/** Format `current` with the scale `final` would use (count-ups never change unit midway). */
export function formatValue(current: number, final: number, opts: NumberFormatOptions = {}): string {
  const { prefix = '', unit = '', decimals = 0, compact = false } = opts;
  const { divisor, word } = scaleFor(final, compact);
  let out = formatId(current / divisor, decimals);
  if (word) out = `${out} ${word}`;
  if (unit) out = unit === '%' ? `${out}%` : `${out} ${unit}`;
  return prefix ? `${prefix} ${out}` : out;
}

export interface ParsedNumber {
  /** Text before / after the number and the number itself as written. */
  before: string; after: string; raw: string;
  value: number; decimals: number; sign: string; group: string; dec: string;
}
const SIGNS = '+-−–';
/**
 * The first number in a text, read the Indonesian way: "," is the decimal mark, "." groups thousands when followed by exactly
 * three digits ("1.200", "25.960.000"); "25.96" (two digits) is read as a decimal point. A sign right before the digits is kept.
 */
export function parseNumberIn(text: string): ParsedNumber | null {
  const m = /([+\-−–]?)(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)/.exec(text);
  if (!m) return null;
  const sign = m[1] ?? '', body = m[2]!;
  let group = '', dec = ',', intDigits = body, frac = '';
  const dots = (body.match(/\./g) ?? []).length, commas = (body.match(/,/g) ?? []).length;
  if (dots && commas) { const last = Math.max(body.lastIndexOf('.'), body.lastIndexOf(',')); dec = body[last]!; group = dec === ',' ? '.' : ','; intDigits = body.slice(0, last); frac = body.slice(last + 1); }
  else if (dots || commas) {
    const sep = dots ? '.' : ',', parts = body.split(sep), n = dots || commas;
    const grouping = parts.slice(1).every((p) => p.length === 3) && (n > 1 || sep === '.');
    if (grouping) { group = sep; dec = sep === '.' ? ',' : '.'; intDigits = body; }
    else { dec = sep; intDigits = parts[0]!; frac = parts[1] ?? ''; }
  }
  const intVal = Number(intDigits.split(group || '\u0000').join(''));
  const value = (sign === '-' || sign === '−' || sign === '–' ? -1 : 1) * Number(`${intVal}.${frac || '0'}`);
  return { before: text.slice(0, m.index), after: text.slice(m.index + m[0].length), raw: m[0], value, decimals: frac.length, sign, group, dec };
}
/** The text with its number replaced by `v`, written like the original (sign character, separators, decimals). */
export function withNumber(p: ParsedNumber, v: number): string {
  const s = formatId(Math.abs(v), p.decimals, p.group || (p.dec === ',' && Math.abs(v) >= 10_000 ? '.' : ''), p.dec);
  const sign = p.sign && SIGNS.includes(p.sign) ? (p.value < 0 || p.sign === '+' ? p.sign : '') : v < 0 ? '−' : '';
  return `${p.before}${sign}${s}${p.after}`;
}
