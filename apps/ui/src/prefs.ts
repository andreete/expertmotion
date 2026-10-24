// Per-viewer UI conveniences (player menu toggles, collapsed panels, onboarding/tour flags). Everything that matters is
// stored by the Local Service; this is only window-local state and must survive storage being unavailable.
export interface Prefs {
  onboardingDone: boolean; onboardingStep: number; tourDone: boolean; safeArea: boolean; draft: boolean; loop: boolean; muted: boolean; seekOnSelect: boolean;
  libCollapsed: boolean; agentCollapsed: boolean; nudgesDismissed: string[]; onboardingLang: 'en' | 'id';
}
const DEFAULTS: Prefs = {
  onboardingDone: false, onboardingStep: 0, tourDone: false, safeArea: false, draft: true, loop: false, muted: false, seekOnSelect: true,
  libCollapsed: false, agentCollapsed: false, nudgesDismissed: [], onboardingLang: 'en',
};
const KEY = 'expertmotion.prefs.v1';
export function loadPrefs(): Prefs {
  try { const raw = globalThis.localStorage?.getItem(KEY); return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; }
}
export function savePrefs(p: Prefs): void {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable: keep in memory only */ }
}
