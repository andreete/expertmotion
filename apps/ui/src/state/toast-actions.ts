// QA UX round 1 (2026-10-29): an error toast always says what happened (err.<code>.body) and offers its next action. Callers
// that pass their own action keep it; for the rest the code's catalogue action (err.<code>.action, "A · B" = primary · secondary)
// maps to one deterministic UI step below. Codes whose action is only "OK" get an OK button; codes whose action needs context the
// toast does not have ("Try again" of an unknown request) show the body only. Never computes or mutates the Composition Model.
import { LOCALES, translate, type Lang } from '../i18n/index.js';
import type { Screen } from './reducer.js';

export type ToastStep = { kind: 'screen'; screen: Screen } | { kind: 'privateOff' } | { kind: 'reload' } | { kind: 'dismiss' };
/** `seg` = which " · " segment of err.<code>.action labels the button. */
interface Mapped { step: ToastStep; seg: number }

const PROVIDERS: Screen = { kind: 'providers' };
const MODELS: Screen = { kind: 'models' };
const EXPORT: Screen = { kind: 'export' };
const TABLE: Record<string, Mapped> = {
  'EM-4001': { step: { kind: 'screen', screen: PROVIDERS }, seg: 0 },
  'EM-4002': { step: { kind: 'screen', screen: PROVIDERS }, seg: 0 },
  'EM-4004': { step: { kind: 'screen', screen: PROVIDERS }, seg: 0 },
  'EM-4007': { step: { kind: 'screen', screen: PROVIDERS }, seg: 0 },
  'EM-4101': { step: { kind: 'screen', screen: PROVIDERS }, seg: 1 },
  'EM-4103': { step: { kind: 'screen', screen: PROVIDERS }, seg: 1 },
  'EM-4202': { step: { kind: 'screen', screen: PROVIDERS }, seg: 1 },
  'EM-4404': { step: { kind: 'screen', screen: PROVIDERS }, seg: 0 },
  'EM-4501': { step: { kind: 'screen', screen: PROVIDERS }, seg: 1 },
  'EM-4503': { step: { kind: 'screen', screen: PROVIDERS }, seg: 1 },
  'EM-7113': { step: { kind: 'screen', screen: PROVIDERS }, seg: 0 },
  'EM-2104': { step: { kind: 'screen', screen: MODELS }, seg: 0 },
  'EM-7001': { step: { kind: 'screen', screen: MODELS }, seg: 0 },
  'EM-7003': { step: { kind: 'screen', screen: MODELS }, seg: 0 },
  'EM-7004': { step: { kind: 'screen', screen: MODELS }, seg: 0 },
  'EM-7108': { step: { kind: 'screen', screen: MODELS }, seg: 0 },
  'EM-7109': { step: { kind: 'screen', screen: MODELS }, seg: 0 },
  'EM-3203': { step: { kind: 'screen', screen: EXPORT }, seg: 0 },
  'EM-3208': { step: { kind: 'screen', screen: EXPORT }, seg: 0 },
  'EM-6303': { step: { kind: 'screen', screen: { kind: 'project.open' } }, seg: 0 },
  'EM-2001': { step: { kind: 'screen', screen: { kind: 'project.recover' } }, seg: 0 },
  'EM-4401': { step: { kind: 'privateOff' }, seg: 0 },
  'EM-8202': { step: { kind: 'privateOff' }, seg: 0 },
  'EM-8004': { step: { kind: 'reload' }, seg: 0 },
  'EM-8009': { step: { kind: 'reload' }, seg: 0 },
  'EM-9002': { step: { kind: 'reload' }, seg: 0 },
};

const segments = (s: string): string[] => s.split(' · ').map((x) => x.trim()).filter(Boolean);

/** The default next step of an error toast for `code`, with its localized label; null when the toast shows the body only. */
export function toastActionFor(code: string, lang: Lang): { step: ToastStep; label: string } | null {
  const en = LOCALES.en[`err.${code}.action`];
  if (!en) return null;
  const local = segments(translate(lang, `err.${code}.action`));
  const enSeg = segments(en);
  const label = (i: number) => local[i] ?? enSeg[i] ?? '';
  const mapped = TABLE[code];
  if (mapped) return { step: mapped.step, label: label(mapped.seg) };
  const diag = enSeg.findIndex((s) => /^Open Diagnostics$/i.test(s));
  if (diag >= 0) return { step: { kind: 'screen', screen: { kind: 'diagnostics' } }, label: label(diag) };
  if (enSeg[0] === 'OK') return { step: { kind: 'dismiss' }, label: label(0) };
  return null;
}

/** The body line of an error toast whose text is `err.<code>.title`; null when the catalogue has no body for the code. */
export function toastBodyOf(toast: { textKey: string; code?: string; vars?: Record<string, string | number> }, lang: Lang): string | null {
  if (!toast.code || toast.textKey !== `err.${toast.code}.title`) return null;
  const key = `err.${toast.code}.body`;
  if (LOCALES.en[key] === undefined) return null;
  const b = translate(lang, key, toast.vars);
  return b.trim() && b !== key ? b : null;
}
