import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appMenuTemplate, showMenuBar } from '../src/lib/window-chrome.js';

// QA 2026-10-25: Electron's default "File Edit View Window" menu bar showed above the Editor header on Windows.
describe('window chrome', () => {
  it('Windows / Linux: one hidden Edit menu with the standard edit roles only (accelerators keep working in inputs); no default reload role', () => {
    for (const p of ['win32', 'linux'] as const) {
      const t = appMenuTemplate(p);
      expect(t).toHaveLength(1);
      const roles = (t[0]!.submenu as Array<{ role?: string }>).flatMap((i) => (i.role ? [i.role] : []));
      expect(roles).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
      expect(JSON.stringify(t)).not.toMatch(/reload|toggleDevTools|forceReload|close|quit|zoom/i);
      expect(showMenuBar(p)).toBe(false);
    }
  });
  it('macOS keeps its app and window menus (menu bar outside the window)', () => {
    expect(appMenuTemplate('darwin').map((i) => i.role ?? i.label)).toEqual(['appMenu', 'Edit', 'windowMenu']);
    expect(showMenuBar('darwin')).toBe(true);
  });
  it('main.ts installs the menu and hides the bar instead of removing the menu', () => {
    const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(src).toContain('Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, {');   // + the FR-199 recovery menu
    expect(src).toContain('win.setMenuBarVisibility(false)');
    expect(src).not.toMatch(/removeMenu\(\)|setApplicationMenu\(null\)/);
  });
});
