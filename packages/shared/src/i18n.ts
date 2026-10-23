import type { EmCode } from './errors.js';
/** i18n key; scheme in docs/ACCESSIBILITY_AND_I18N.md (`ui.<region>.<element>.<state>`, `err.<code>`, `tour.<step>`, `preset.*`). */
export type I18nKey = string;
export type Lang = 'en' | 'id';
export const emKey = (code: EmCode, part: 'title' | 'body' | 'action'): I18nKey => `err.${code}.${part}`;
export interface Bilingual { en: string; id: string }
