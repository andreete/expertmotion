// @vitest-environment jsdom
// Project storage transparency (QA 2026-10-31 "pas save project atau save as kita gak tau projectnya ada dimana"; FR-313 … FR-315):
// the Save As note + "Back up to zip…" link, the backup result row (path, Open folder, Copy path), File ▸ Back up / Open exports folder.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el } from './setup-dom.js';

afterEach(() => { cleanup(); delete (window as { expertmotion?: unknown }).expertmotion; });

const until = (fn: () => unknown, msg = 'condition') => waitFor(() => { if (!fn()) throw new Error(`waiting for ${msg}`); });
const shell = () => {
  const s = { openFolder: vi.fn(async (_path: string) => undefined), copyText: vi.fn(async (_text: string) => true) };
  (window as unknown as { expertmotion: unknown }).expertmotion = s;
  return s;
};
const openFile = (item: string) => { fireEvent.click(el('hdr.menu.file')!); fireEvent.click(el(item)!); };

describe('Save As says where the copy lives (FR-313)', () => {
  it('shows the storage note and its link replaces the dialog with Backup', async () => {
    await renderEditor('sample');
    openFile('hdr.menu.file.saveas');
    await until(() => el('scr.project.saveas.create'), 'save-as dialog');
    const note = el('scr.project.saveas.storage')!;
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toContain('inside Expertmotion');
    expect(note.textContent).toContain('not as a file');
    fireEvent.click(el('scr.project.saveas.backup')!);
    await until(() => el('scr.backup.backup.start'), 'backup dialog');
    expect(el('scr.project.saveas.create')).toBeNull();
  });
});

describe('Backup result row (FR-314)', () => {
  const runBackup = async () => {
    await until(() => el('scr.backup.backup.estimate'), 'estimate');
    fireEvent.click(el('scr.backup.backup.plain')!);
    await act(async () => { fireEvent.click(el('scr.backup.backup.start')!); });
    await until(() => el('scr.backup.result.path'), 'result row');
    return el('scr.backup.result.path')!.textContent ?? '';
  };

  it('names the default folder, then shows the full path with Open folder and Copy path (Desktop Shell)', async () => {
    const s = shell();
    await renderEditor('sample');
    openFile('hdr.menu.file.backup');
    await until(() => el('scr.backup.backup.folder'), 'backup dialog');
    const folder = (el('scr.backup.backup.folder') as HTMLInputElement).value;
    expect(folder).toContain('Expertmotion');
    expect(el('scr.backup.backup.folder.default')!.textContent).toBe(`Usually in ${folder}`);
    const path = await runBackup();
    expect(path.startsWith(folder)).toBe(true);
    expect(path).toMatch(/\.(emproj|zip)$/);
    expect(el('scr.backup.progress')!.textContent).toContain(`Saved to ${path}`);   // the toast line stays
    fireEvent.click(el('scr.backup.result.open')!);
    await until(() => s.openFolder.mock.calls.length === 1, 'openFolder');
    expect(s.openFolder).toHaveBeenCalledWith(path);
    await act(async () => { fireEvent.click(el('scr.backup.result.copy')!); });
    expect(s.copyText).toHaveBeenCalledWith(path);
    await until(() => el('scr.backup.result.copy')!.textContent === 'Copied', 'copied label');
  });

  it('hides Open folder without the Shell bridge (browser dev build) but keeps the path and Copy path', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.action.backup')!);
    const path = await runBackup();
    expect(path.length).toBeGreaterThan(10);
    expect(el('scr.backup.result.open')).toBeNull();
    expect(el('scr.backup.result.copy')).not.toBeNull();
  });
});

describe('File menu: Back up / Open exports folder (FR-315)', () => {
  it('lists both entries; Open exports folder is disabled without the Shell bridge', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.menu.file')!);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((m) => m.getAttribute('data-el'));
    expect(items.indexOf('hdr.menu.file.backup')).toBe(items.indexOf('hdr.menu.file.saveas') + 1);
    expect(items.indexOf('hdr.menu.file.openexports')).toBe(items.indexOf('hdr.menu.file.export') + 1);
    expect(el('hdr.menu.file.backup')!.getAttribute('aria-disabled')).toBeNull();
    expect(el('hdr.menu.file.openexports')!.getAttribute('aria-disabled')).toBe('true');
    expect(el('hdr.menu.file.openexports')!.getAttribute('title')).toBe('Only in the desktop app');
  });

  it('Open exports folder reveals the newest Output, else the output folder (Desktop Shell)', async () => {
    const s = shell();
    await renderEditor('sample');
    // no Output yet → the app's output folder (mock setting)
    openFile('hdr.menu.file.openexports');
    await until(() => s.openFolder.mock.calls.length === 1, 'openFolder folder');
    expect(s.openFolder.mock.calls[0]![0]).toContain('Videos\\Expertmotion');
    // after an export → the Output's own path (selected in its folder)
    await act(async () => { fireEvent.click(el('hdr.action.export')!); });
    await waitFor(() => { if (el('scr.export.start')?.getAttribute('aria-disabled')) throw new Error('blocked'); });
    await act(async () => { fireEvent.click(el('scr.export.start')!); });
    await waitFor(() => { if (!el('scr.export.done')) throw new Error('not done'); });
    fireEvent.keyDown(el('scr.export')!, { key: 'Escape' });
    await until(() => !el('scr.export'), 'export closed');
    openFile('hdr.menu.file.openexports');
    await until(() => s.openFolder.mock.calls.length === 2, 'openFolder output');
    expect(s.openFolder.mock.calls[1]![0]).toMatch(/\.(mp4|webm|gif|png|jpg)$/);
  }, 20_000);
});
