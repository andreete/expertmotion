// Round 2 (QA 2026-10-29, nikel vs the reference video): line breaks never split a tightly bound group. glueText() turns the
// breakable spaces inside such a group into no-break spaces (U+00A0) — at RENDER time (Engine text preset) and in the estimator
// (text-box.ts), never in the stored text, so what the Creator typed stays as typed. Groups (Indonesian + English):
//   • a month or month range and its year ("Jan–Agu 2026", "Agustus 2026", "Okt 2026"), a day and its month ("28 Okt");
//   • a short parenthesised group ("(miliar US$)", ≤ 24 characters, ≤ 3 spaces);
//   • a number and its unit ("25,96 miliar", "17 persen"), a currency sign and its number ("US$ 45", "Rp 472").
// A space after clause punctuation ("Indonesia, Jan–Agu") stays breakable.
export const NBSP = ' ';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'mei', 'may', 'jun', 'jul', 'agu', 'agt', 'aug', 'sep', 'okt', 'oct', 'nov', 'des', 'dec'];
const UNIT_WORDS = new Set(['persen', '%', 'ribu', 'juta', 'miliar', 'milyar', 'triliun', 'rupiah', 'dolar', 'dollar', 'usd', 'idr', 'ton', 'kg', 'gram', 'km', 'meter', 'liter',
  'barel', 'jam', 'menit', 'detik', 'derajat', 'kali', 'poin', 'thousand', 'million', 'billion', 'trillion', 'percent', 'tons', 'hours', 'minutes', 'seconds']);
const CURRENCY = /^(rp\.?|us\$|\$|idr|usd|€|£|s\$|rm)$/i;
const bare = (w: string): string => w.toLowerCase().replace(/^["'“‘(\[]+|["'”’)\].,;:!?…]+$/g, '');
const isMonth = (w: string): boolean => { const b = bare(w).replace(/\.$/, ''); return b.length >= 3 && b.length <= 9 && MONTHS.some((m) => b.startsWith(m)) && /^[a-z]+$/.test(b); };
const isMonthRange = (w: string): boolean => { const parts = bare(w).split(/[–—-]/); return parts.length === 2 && parts.every((p) => isMonth(p)); };
const isYear = (w: string): boolean => /^(1[89]|20)\d{2}$/.test(bare(w));
const isDay = (w: string): boolean => /^([1-9]|[12]\d|3[01])$/.test(bare(w));
const isNumber = (w: string): boolean => /^[+−–-]?(rp|us\$|\$)?\d[\d.,]*%?$/i.test(bare(w));
const endsClause = (w: string): boolean => /[,;:.!?…]["'”’)\]]*$/.test(w);

/** True when no line break may fall between the words `a` and `b`. */
export function gluedPair(a: string, b: string): boolean {
  if (endsClause(a)) return false;
  if ((isMonth(a) || isMonthRange(a)) && isYear(b)) return true;
  if (isDay(a) && isMonth(b)) return true;
  if (CURRENCY.test(bare(a)) && isNumber(b)) return true;
  if (isNumber(a) && UNIT_WORDS.has(bare(b))) return true;
  return false;
}

/** The text with the spaces inside bound groups replaced by U+00A0 (same length; newlines and other spaces kept). */
export function glueText(text: string): string {
  if (!text.includes(' ')) return text;
  // short parenthesised groups first
  let out = text.replace(/\(([^()\n]{1,22})\)/g, (m, inner: string) => ((inner.match(/ /g) ?? []).length <= 3 ? m.replace(/ /g, NBSP) : m));
  // then word pairs (a run of single spaces between two words)
  const parts = out.split(/( )/);
  for (let i = 1; i < parts.length - 1; i += 2) {
    const a = parts[i - 1]!, b = parts[i + 1]!;
    if (!a || !b) continue;
    const lastA = a.split(/[\n ]/).pop()!, firstB = b.split(/[\n ]/)[0]!;
    if (lastA && firstB && gluedPair(lastA, firstB)) parts[i] = NBSP;
  }
  out = parts.join('');
  return out;
}
