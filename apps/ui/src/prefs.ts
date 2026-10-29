// Per-viewer UI conveniences (player menu toggles, collapsed panels, panel sizes, onboarding/tour flags). Everything that
// matters is stored by the Local Service; this is only window-local state and must survive storage being unavailable.
/** Window-width buckets for panel sizes (EDITOR_INTERACTION_MODEL.md §9 "Persistence"). */
export type SizeBucket = 'narrow' | 'standard' | 'wide';
export interface PanelSizes { lib?: number; agent?: number; timeline?: number }
export interface Prefs {
  onboardingDone: boolean; onboardingStep: number; tourDone: boolean; tourStep: number; safeArea: boolean; draft: boolean; loop: boolean; muted: boolean; seekOnSelect: boolean;
  libCollapsed: boolean; agentCollapsed: boolean; nudgesDismissed: string[]; onboardingLang: 'en' | 'id';
  /** Entry 36: true once the Creator switched the onboarding language on the Welcome step; until then onboarding and the tour
   *  follow the UI language (the licence screen's choice), not the 'en' default. */
  onboardingLangPicked?: boolean;
  /** FR-099: Output Settings collapsed (persisted with the panel layout in Settings `layout`). */
  outputCollapsed: boolean;
  /** Retired 2026-10-26 (one assistant chat): was the Brainstorming Chat share of the split chat area; kept for old prefs. */
  chatSplit: number;
  /** FR-099: the assistant chat fills the Agent Panel (Output Settings hidden) when non-null (written as the mode it was
   *  maximized in; any non-null value means maximized). */
  chatMaximized: ChatAgent | null;
  /** FR-073 (2026-10-26): the last chat mode per Project ("Diskusi" = brainstorm, "Edit" = editor); missing = brainstorm. */
  chatModeByProject: Record<string, ChatAgent>;
  /** The "Your picks" strip above the composer in Edit mode is expanded. */
  picksOpen: boolean;
  /** FR-090: EM-3106 (Turbo on T1) has been shown once. */
  turboWarned: boolean;
  /** Dragged panel sizes per window-width bucket (FR-099, FR-155); missing = default. */
  panelSizes: Partial<Record<SizeBucket, PanelSizes>>;
  /** FR-060: Player menu choices per Project (UI state, never in the Composition Model); missing keys fall back to the globals above. */
  playerByProject: Record<string, Partial<PlayerPrefs>>;
}
export type ChatAgent = 'brainstorm' | 'editor';
export interface PlayerPrefs { safeArea: boolean; draft: boolean; loop: boolean; muted: boolean }
/** The Player menu choices in effect for a Project. */
export function playerPrefsFor(p: Prefs, projectId: string | undefined): PlayerPrefs {
  const own = projectId ? p.playerByProject?.[projectId] ?? {} : {};
  return { safeArea: own.safeArea ?? p.safeArea, draft: own.draft ?? p.draft, loop: own.loop ?? p.loop, muted: own.muted ?? p.muted };
}
/** The chat mode remembered for a Project (FR-073, 2026-10-26). */
export const chatModeFor = (p: Prefs, projectId: string | undefined): ChatAgent => (projectId ? p.chatModeByProject?.[projectId] : undefined) ?? 'brainstorm';
/** Patch that remembers the chat mode of a Project (at most 50 Projects kept). */
export function chatModePatch(p: Prefs, projectId: string | undefined, mode: ChatAgent): Partial<Prefs> {
  if (!projectId) return {};
  const all = { ...(p.chatModeByProject ?? {}) };
  delete all[projectId]; all[projectId] = mode;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k];
  return { chatModeByProject: all };
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
  libCollapsed: false, agentCollapsed: false, nudgesDismissed: [], onboardingLang: 'en', panelSizes: {}, playerByProject: {}, outputCollapsed: true, chatSplit: 0.4, chatMaximized: null, chatModeByProject: {}, picksOpen: false, turboWarned: false,
};
/** The language of onboarding + tour copy (I18N-09): the Creator's own pick on the Welcome step, else the UI language. */
export const onboardingLangFor = (p: Prefs, uiLanguage: 'en' | 'id' | undefined): 'en' | 'id' => (p.onboardingLangPicked || p.onboardingLang !== 'en' || !uiLanguage ? p.onboardingLang : uiLanguage);
export const PREFS_KEY = 'expertmotion.prefs.v1';
export function loadPrefs(): Prefs {
  try { const raw = globalThis.localStorage?.getItem(PREFS_KEY); return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; }
}
export function savePrefs(p: Prefs): void {
  try { globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable: keep in memory only */ }
}

/** FR-099 / FR-155: the layout part of the prefs, mirrored to the Local Service Settings `layout` (settings.json equivalent). */
export interface LayoutPrefs { panelSizes: Partial<Record<SizeBucket, PanelSizes>>; libCollapsed: boolean; agentCollapsed: boolean; outputCollapsed: boolean; chatSplit: number; chatMaximized: ChatAgent | null }
export const layoutOf = (p: Prefs): LayoutPrefs => ({ panelSizes: p.panelSizes, libCollapsed: p.libCollapsed, agentCollapsed: p.agentCollapsed, outputCollapsed: p.outputCollapsed, chatSplit: p.chatSplit, chatMaximized: p.chatMaximized });
