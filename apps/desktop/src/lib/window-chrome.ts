/**
 * Window chrome (QA 2026-10-25): Electron's default application menu ("File Edit View Window") showed above the Editor's own
 * header on Windows, doubling the chrome. Pure module: no `electron` value import (unit-tested on Linux).
 *
 * The replacement menu keeps only the standard Edit roles. On Windows / Linux the menu bar is hidden (not auto-hidden: Alt
 * does not reveal it) but the menu stays attached, so its accelerators keep working exactly as with the default menu:
 * Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, Ctrl+X / C / V, Ctrl+A in inputs and text areas. Chromium also handles those keys natively
 * in editable fields, so copy / paste does not depend on the menu; the Editor's own clipboard bridge (IPC copyText /
 * readClipboardText) is unchanged. The default View / Window items (reload, devtools, zoom, close) are gone on purpose:
 * Ctrl+R / Ctrl+Shift+I / Ctrl+W no longer reload, open devtools or close the window behind the Editor's close flow.
 * macOS keeps an app menu (the menu bar is outside the window there).
 */
import type { MenuItemConstructorOptions } from 'electron';

const EDIT_ROLES: MenuItemConstructorOptions[] = [
  { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
  { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { type: 'separator' }, { role: 'selectAll' },
];

/** The application menu template: Edit roles only (plus the app menu on macOS). */
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const edit: MenuItemConstructorOptions = { label: 'Edit', submenu: EDIT_ROLES.map((r) => ({ ...r })) };
  if (platform === 'darwin') return [{ role: 'appMenu' }, edit, { role: 'windowMenu' }];
  return [edit];
}

/** Whether the native menu bar is drawn inside the window (never on Windows / Linux: the Editor header is the menu). */
export const showMenuBar = (platform: NodeJS.Platform): boolean => platform === 'darwin';

/**
 * Renderer console lines worth keeping in the Shell log: warnings / errors the Editor tags with "[em]" (for example the
 * Player's "preview still loading" cause). Anything else is dropped; the text is capped (the Shell log redacts secrets).
 */
export function rendererLogLine(level: string, message: string): { level: 'warn' | 'error'; msg: string } | null {
  if (level !== 'warning' && level !== 'error') return null;
  if (!message.startsWith('[em]')) return null;
  return { level: level === 'error' ? 'error' : 'warn', msg: message.slice(0, 500) };
}
