// Per-viewer UI conveniences (player menu toggles, collapsed panels, panel sizes, onboarding/tour flags). Everything that
// matters is stored by the Local Service; this is only window-local state and must survive storage being unavailable.
/** Window-width buckets for panel sizes (EDITOR_INTERACTION_MODEL.md §9 "Persistence"). */
export type SizeBucket = 'narrow' | 'standard' | 'wide';
export interface PanelSizes { lib?: number; agent?: number; timeline?: number }
export interface Prefs {
  onboardingDone: boolean; onboardingStep: number; tourDone: boolean; tourStep: number; safeArea: boolean; draft: boolean; loop: boolean; muted: boolean; seekOnSelect: boolean;
  libCollapsed: boolean; agentCollapsed: boolean; nudgesDismissed: string[]; onboardingLang: 'en' | 'id';
  /** Dragged panel sizes per window-width bucket (FR-099, FR-155); missing = default. */
  panelSizes: Partial<Record<SizeBucket, PanelSizes>>;
}
const DEFAULTS: Prefs = {
  onboardingDone: false, onboardingStep: 0, tourDone: false, tourStep: 0, safeArea: false, draft: true, loop: false, muted: false, seekOnSelect: true,
  libCollapsed: false, agentCollapsed: false, nudgesDismissed: [], onboardingLang: 'en', panelSizes: {},
};
export const PREFS_KEY = 'expertmotion.prefs.v1';
export function loadPrefs(): Prefs {
  try { const raw = globalThis.localStorage?.getItem(PREFS_KEY); return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; }
}
export function savePrefs(p: Prefs): void {
  try { globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable: keep in memory only */ }
}
