// Per-viewer UI conveniences (player menu toggles, collapsed panels, panel sizes, onboarding/tour flags). Everything that
// matters is stored by the Local Service; this is only window-local state and must survive storage being unavailable.
/** Window-width buckets for panel sizes (EDITOR_INTERACTION_MODEL.md §9 "Persistence"). */
export type SizeBucket = 'narrow' | 'standard' | 'wide';
export interface PanelSizes { lib?: number; agent?: number; timeline?: number }
export interface Prefs {
  onboardingDone: boolean; onboardingStep: number; tourDone: boolean; tourStep: number; safeArea: boolean; draft: boolean; loop: boolean; muted: boolean; seekOnSelect: boolean;
  libCollapsed: boolean; agentCollapsed: boolean; nudgesDismissed: string[]; onboardingLang: 'en' | 'id';
  /** FR-099: Output Settings collapsed (persisted with the panel layout in Settings `layout`). */
  outputCollapsed: boolean;
  /** FR-090: EM-3106 (Turbo on T1) has been shown once. */
  turboWarned: boolean;
  /** Dragged panel sizes per window-width bucket (FR-099, FR-155); missing = default. */
  panelSizes: Partial<Record<SizeBucket, PanelSizes>>;
  /** FR-060: Player menu choices per Project (UI state, never in the Composition Model); missing keys fall back to the globals above. */
  playerByProject: Record<string, Partial<PlayerPrefs>>;
}
export interface PlayerPrefs { safeArea: boolean; draft: boolean; loop: boolean; muted: boolean }
/** The Player menu choices in effect for a Project. */
export function playerPrefsFor(p: Prefs, projectId: string | undefined): PlayerPrefs {
  const own = projectId ? p.playerByProject?.[projectId] ?? {} : {};
  return { safeArea: own.safeArea ?? p.safeArea, draft: own.draft ?? p.draft, loop: own.loop ?? p.loop, muted: own.muted ?? p.muted };
}
/** Patch for setPrefs that stores Player choices under the Project (at most 50 Projects kept). */
export function playerPrefsPatch(p: Prefs, projectId: string | undefined, patch: Partial<PlayerPrefs>): Partial<Prefs> {
  if (!projectId) return patch;
  const all = { ...(p.playerByProject ?? {}) };
  all[projectId] = { ...(all[projectId] ?? {}), ...patch };
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k];
  return { playerByProject: all };
}
const DEFAULTS: Prefs = {
  onboardingDone: false, onboardingStep: 0, tourDone: false, tourStep: 0, safeArea: false, draft: true, loop: false, muted: false, seekOnSelect: true,
  libCollapsed: false, agentCollapsed: false, nudgesDismissed: [], onboardingLang: 'en', panelSizes: {}, playerByProject: {}, outputCollapsed: false, turboWarned: false,
};
export const PREFS_KEY = 'expertmotion.prefs.v1';
export function loadPrefs(): Prefs {
  try { const raw = globalThis.localStorage?.getItem(PREFS_KEY); return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; }
}
export function savePrefs(p: Prefs): void {
  try { globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable: keep in memory only */ }
}

/** FR-099 / FR-155: the layout part of the prefs, mirrored to the Local Service Settings `layout` (settings.json equivalent). */
export interface LayoutPrefs { panelSizes: Partial<Record<SizeBucket, PanelSizes>>; libCollapsed: boolean; agentCollapsed: boolean; outputCollapsed: boolean }
export const layoutOf = (p: Prefs): LayoutPrefs => ({ panelSizes: p.panelSizes, libCollapsed: p.libCollapsed, agentCollapsed: p.agentCollapsed, outputCollapsed: p.outputCollapsed });
