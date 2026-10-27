/**
 * Escape hatches that work while the Editor window is black or hung (FR-199; QA 2026-10-27). Pure module: no `electron` value
 * import (unit-tested on Linux).
 *
 *   - Keys, read in the MAIN process from `webContents` 'before-input-event' (delivered by the browser process before the page,
 *     so they work when the renderer paints nothing): Ctrl+R / F5 = reload the window, Ctrl+Shift+L = open the log folder.
 *     The same accelerators sit in a hidden "Pemulihan" application menu (macOS menu bar; a second path on Windows / Linux).
 *     They do not collide with the Editor's shortcuts (apps/ui/src/shortcuts.ts: Ctrl+R, F5 and Ctrl+Shift+L are unused there;
 *     plain L = play stays the Editor's). Auto-repeat is ignored and one action runs at most once per KEY_DEBOUNCE_MS.
 *   - Tray menu (Indonesian; the Creator's language): Tampilkan, Muat ulang tampilan, safe-graphics restart (or back to GPU),
 *     Buka folder log, Simpan laporan diagnostik ke Desktop, Keluar.
 */

export type RecoveryAction = 'reload' | 'open-logs';
export const KEY_DEBOUNCE_MS = 1_000;

export interface KeyInput { type: string; key: string; code?: string; control: boolean; meta: boolean; shift: boolean; alt: boolean; isAutoRepeat: boolean }

/** The recovery action of a key event, or null. `platform` decides Ctrl vs Cmd. */
export function recoveryKey(input: KeyInput, platform: NodeJS.Platform): RecoveryAction | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt) return null;
  const mod = platform === 'darwin' ? input.meta : input.control;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key === 'F5' && !input.shift && !input.control && !input.meta) return 'reload';
  if (mod && !input.shift && (key === 'r' || input.code === 'KeyR')) return 'reload';
  if (mod && input.shift && (key === 'l' || input.code === 'KeyL')) return 'open-logs';
  return null;
}

/** Fixed debounce: true when `action` may run now. */
export function createDebounce(ms = KEY_DEBOUNCE_MS): (action: string, now: number) => boolean {
  const last = new Map<string, number>();
  return (action, now) => {
    const t = last.get(action);
    if (t !== undefined && now - t < ms) return false;
    last.set(action, now);
    return true;
  };
}

/** Accelerators of the hidden "Pemulihan" menu (Electron accelerator syntax). */
export const RECOVERY_ACCELERATORS = { reload: 'CmdOrCtrl+R', reloadAlt: 'F5', openLogs: 'CmdOrCtrl+Shift+L' } as const;

export type TrayAction = 'show' | 'reload' | 'safe-graphics-on' | 'safe-graphics-off' | 'open-logs' | 'diagnostics' | 'quit';
export interface TrayItem { action: TrayAction; label: string }
/** Tray items in order; `null` = separator. */
export function trayItems(safeGraphics: boolean): Array<TrayItem | null> {
  return [
    { action: 'show', label: 'Tampilkan Expertmotion' },
    { action: 'reload', label: 'Muat ulang tampilan' },
    safeGraphics
      ? { action: 'safe-graphics-off', label: 'Mulai ulang dengan akselerasi GPU (matikan mode grafis aman)' }
      : { action: 'safe-graphics-on', label: 'Mulai ulang dalam mode grafis aman' },
    null,
    { action: 'open-logs', label: 'Buka folder log' },
    { action: 'diagnostics', label: 'Simpan laporan diagnostik ke Desktop' },
    null,
    { action: 'quit', label: 'Keluar' },
  ];
}

/** Dialogs after the diagnostic report (FR-199). */
export function reportSavedDialog(fileName: string): { title: string; message: string; detail: string; buttons: string[] } {
  return { title: 'Expertmotion', message: 'Laporan diagnostik tersimpan', detail: `${fileName}\n\nFile ini ada di Desktop. Tidak ada proyek, media atau kunci di dalamnya; Expertmotion tidak mengirimnya ke mana pun.`, buttons: ['Oke'] };
}
export function reportFailedDialog(error: string): { title: string; message: string; detail: string; buttons: string[] } {
  return { title: 'Expertmotion', message: 'Laporan diagnostik gagal dibuat', detail: `${error.slice(0, 300)}\n\nBuka folder log lewat ikon Expertmotion di tray dan kirim file di sana.\n\nEM-8013`, buttons: ['Oke'] };
}
