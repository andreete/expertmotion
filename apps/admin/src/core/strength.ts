/**
 * Passphrase strength hint (UI only; the hard rule is the CLI's minimum of 12 characters). A rough
 * estimate: length × log2(character pool), with a penalty for repeats and sequences. It is a hint,
 * not a guarantee; a long phrase of unrelated words is the recommended form.
 */
export type Strength = 'too-short' | 'weak' | 'fair' | 'strong';

export const MIN_PASSPHRASE = 12;

export function passphraseStrength(p: string): { level: Strength; bits: number; hint: string } {
  const chars = [...p];
  if (chars.length < MIN_PASSPHRASE) return { level: 'too-short', bits: 0, hint: `At least ${MIN_PASSPHRASE} characters (you have ${chars.length}).` };
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(p)) pool += 33;
  const unique = new Set(chars).size;
  // repeats / tiny alphabets ("aaaaaaaaaaaa", "abababababab") count for little
  const effectiveLen = Math.min(chars.length, unique * 3);
  let bits = Math.round(effectiveLen * Math.log2(Math.max(pool, 2)));
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|password|sandi|rahasia)/i.test(p)) bits = Math.round(bits * 0.6);
  if (bits < 60) return { level: 'weak', bits, hint: 'Weak: add more unrelated words.' };
  if (bits < 80) return { level: 'fair', bits, hint: 'Fair: one or two more words make it strong.' };
  return { level: 'strong', bits, hint: 'Strong. Store it in your password manager; it cannot be recovered.' };
}
