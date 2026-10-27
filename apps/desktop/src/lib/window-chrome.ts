/**
 * Window chrome (QA 2026-10-25): Electron's default application menu ("File Edit View Window") showed above the Editor's own
 * header on Windows, doubling the chrome. Pure module: no `electron` value import (unit-tested on Linux).
 *
 * The replacement menu keeps only the standard Edit roles. On Windows / Linux the menu bar is hidden (not auto-hidden: Alt
 * does not reveal it) but the menu stays attached, so its accelerators keep working exactly as with the default menu:
 * Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, Ctrl+X / C / V, Ctrl+A in inputs and text areas. Chromium also handles those keys natively
 * in editable fields, so copy / paste does not depend on the menu; the Editor's own clipboard bridge (IPC copyText /
 * readClipboardText) is unchanged. The default View / Window items (reload, devtools, zoom, close) are gone on purpose:
 * Ctrl+Shift+I / Ctrl+W no longer open devtools or close the window behind the Editor's close flow. Ctrl+R / F5 reload again since
 * FR-199, through the Shell's recovery reload (below), never the default role.
 * macOS keeps an app menu (the menu bar is outside the window there).
 */
import type { MenuItemConstructorOptions } from 'electron';
import { RECOVERY_ACCELERATORS } from './escape-hatches.js';

const EDIT_ROLES: MenuItemConstructorOptions[] = [
  { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
  { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { type: 'separator' }, { role: 'selectAll' },
];

export interface RecoveryHandlers { reload: () => void; openLogs: () => void }

/**
 * FR-199: the hidden "Pemulihan" (recovery) menu — Ctrl+R / F5 reload the window, Ctrl+Shift+L opens the log folder. These go
 * through the Shell's own reload (lib/escape-hatches.ts), not the default `reload` role, so a hung renderer is replaced first.
 * main.ts also reads the same keys in 'before-input-event' (works while the page paints nothing); one action per second.
 */
function recoveryMenu(h: RecoveryHandlers): MenuItemConstructorOptions {
  return {
    label: 'Pemulihan',
    submenu: [
      { label: 'Muat ulang tampilan', accelerator: RECOVERY_ACCELERATORS.reload, click: () => h.reload() },
      { label: 'Muat ulang tampilan (F5)', accelerator: RECOVERY_ACCELERATORS.reloadAlt, click: () => h.reload() },
      { label: 'Buka folder log', accelerator: RECOVERY_ACCELERATORS.openLogs, click: () => h.openLogs() },
    ],
  };
}

/** The application menu template: Edit roles (plus the app menu on macOS) and, when handlers are given, the recovery menu. */
export function appMenuTemplate(platform: NodeJS.Platform, recovery?: RecoveryHandlers): MenuItemConstructorOptions[] {
  const edit: MenuItemConstructorOptions = { label: 'Edit', submenu: EDIT_ROLES.map((r) => ({ ...r })) };
  const extra = recovery ? [recoveryMenu(recovery)] : [];
  if (platform === 'darwin') return [{ role: 'appMenu' }, edit, ...extra, { role: 'windowMenu' }];
  return [edit, ...extra];
}

/** Whether the native menu bar is drawn inside the window (never on Windows / Linux: the Editor header is the menu). */
export const showMenuBar = (platform: NodeJS.Platform): boolean => platform === 'darwin';
