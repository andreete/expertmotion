// @vitest-environment jsdom
// Project lifecycle in the Editor (mock mode): Save As duplicates (FR-013), unsaved prompt on switch/close (FR-174), close during
// a render (FR-002), New/Settings duration policy + folder (FR-009/015), Open dialog thumbnail/modified/usage/delete (FR-010/178),
// Recovery hash/size (FR-016), Backup folder + estimate (FR-017), onboarding Done + resume + server record (FR-004/006/007/008).
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el } from './setup-dom.js';
import { requestWindowClose, startCloseFlow } from '../src/screens/Lifecycle.js';
import type { AppState, Screen } from '../src/state/reducer.js';
import type { Actions } from '../src/state/store.js';

afterEach(() => { cleanup(); delete (window as { expertmotion?: unknown }).expertmotion; });

const until = (fn: () => unknown, msg = 'condition') => waitFor(() => { if (!fn()) throw new Error(`waiting for ${msg}`); });
const untilAsync = (fn: () => Promise<unknown>, msg = 'condition') => waitFor(async () => { if (!(await fn())) throw new Error(`waiting for ${msg}`); });
const byText = (text: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text) ?? null;

async function makeDirty() {
  await until(() => document.querySelector('[data-el="lib.catalogue.tab"][data-category="transition"]'), 'catalogue');
  fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.catalogue.tab"][data-category="transition"]')!);
  await until(() => document.querySelector('[data-preset-id="preset:transition.fade"]'), 'fade card');
  await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-preset-id="preset:transition.fade"]')!); });
  await until(() => el('hdr.title.dirty'), 'dirty dot');
}
const title = () => el('hdr.title')?.textContent ?? '';

describe('File ▸ Save As (FR-013)', () => {
  it('duplicates the project under a new name and switches to the copy', async () => {
    const { runtime } = await renderEditor('sample');
    const before = title();
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.saveas')!);
    await until(() => el('scr.project.saveas.create'), 'save-as dialog');
    expect(el('scr.project.new.fps')).toBeNull();                       // the copy keeps the original's settings
    const name = el('scr.project.new.name') as HTMLInputElement;
    expect(name.value).toBe(`${before} copy`);
    fireEvent.change(name, { target: { value: 'Kopi B' } });
    await act(async () => { fireEvent.click(el('scr.project.saveas.create')!); });
    await until(() => title().includes('Kopi B'), 'copy opened');
    const list = await runtime.api.listProjects();
    expect(list.items.map((p) => p.name)).toContain('Kopi B');
    expect(list.items).toHaveLength(2);                                  // the original is still there
  });
});

describe('Unsaved prompt (FR-174)', () => {
  it('asks Save / Don\'t save / Cancel before New, and says the composition is safe', async () => {
    await renderEditor('sample');
    await makeDirty();
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.new')!);
    await until(() => el('scr.unsaved'), 'unsaved prompt');
    for (const id of ['scr.unsaved.save', 'scr.unsaved.discard', 'scr.unsaved.cancel']) expect(el(id)).not.toBeNull();
    expect(el('scr.unsaved')!.textContent).toContain('already stored as versions');
    fireEvent.click(el('scr.unsaved.cancel')!);
    expect(el('scr.unsaved')).toBeNull();
    expect(el('scr.project.new')).toBeNull();
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.new')!);
    await until(() => el('scr.unsaved.save'));
    await act(async () => { fireEvent.click(el('scr.unsaved.save')!); });
    await until(() => el('scr.project.new'), 'new dialog after save');
    expect(el('hdr.title.dirty')).toBeNull();                           // Save cleared the dirty state first
  });

  it('closing the window with unsaved state prompts, then closes (Desktop Shell)', async () => {
    (window as { expertmotion?: unknown }).expertmotion = {};
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    await renderEditor('sample');
    await makeDirty();
    act(() => { requestWindowClose(); });
    await until(() => el('scr.unsaved'), 'close prompt');
    expect(el('scr.unsaved')!.textContent).toContain('before closing');
    expect(close).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(el('scr.unsaved.discard')!); });
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });

  it('closing during a render asks "Cancel render and close" / "Keep rendering" after the unsaved prompt (FR-002)', () => {
    const screens: Screen[] = [];
    const closeNow = vi.fn();
    const store = (dirty: boolean) => ({
      state: { project: { dirty }, renders: [{ id: 'j1', status: 'rendering', progress: 0.4 }] } as unknown as AppState,
      actions: { setScreen: (sc: Screen | null) => { if (sc) screens.push(sc); } } as unknown as Actions,
    });
    startCloseFlow(store(false), closeNow);
    expect(screens[0]).toMatchObject({ kind: 'close.render', jobId: 'j1' });
    expect(closeNow).not.toHaveBeenCalled();                            // "Keep rendering" just closes the prompt
    (screens[0] as Extract<Screen, { kind: 'close.render' }>).then();   // "Cancel render and close"
    expect(closeNow).toHaveBeenCalledTimes(1);
    screens.length = 0;
    startCloseFlow(store(true), closeNow);
    expect(screens[0]).toMatchObject({ kind: 'unsaved', closing: true });
    (screens[0] as Extract<Screen, { kind: 'unsaved' }>).then();
    expect(screens[1]).toMatchObject({ kind: 'close.render' });
  });
});

describe('New and Settings: duration policy and output folder (FR-009, FR-015)', () => {
  it('New offers duration policy (with seconds) and an output folder', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.new')!);
    await until(() => el('scr.project.new.duration.policy'));
    expect(el('scr.project.new.output.folder')).not.toBeNull();
    expect((el('scr.project.new.name') as HTMLInputElement).value).toBe('Untitled');
    fireEvent.change(el('scr.project.new.duration.policy')!, { target: { value: 'fixed' } });
    expect(el('scr.project.new.duration.fixed')).not.toBeNull();
    fireEvent.change(el('scr.project.new.duration.fixed')!, { target: { value: '0' } });
    expect(el('scr.project.new.create')!.getAttribute('aria-disabled') ?? el('scr.project.new.create')!.hasAttribute('disabled')).toBeTruthy();
  });

  it('Settings saves the duration policy as a new version', async () => {
    const { runtime } = await renderEditor('sample');
    const pid = (await runtime.api.listProjects()).items[0]!.id;
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.settings')!);
    await until(() => el('scr.project.settings.duration.policy'));
    fireEvent.change(el('scr.project.settings.duration.policy')!, { target: { value: 'fixed' } });
    fireEvent.change(el('scr.project.settings.duration.fixed')!, { target: { value: '5' } });
    await act(async () => { fireEvent.click(byText('Save', el('scr.project.settings')!)!); });
    await until(() => !el('scr.project.settings'), 'dialog closed');
    const head = (await runtime.api.getComposition(pid)).head.model!;
    expect(head.durationPolicy).toBe('fixed');
    expect(head.fixedDurationMs).toBe(5000);
  });
});

describe('Open dialog and Recovery (FR-010, FR-016, FR-178)', () => {
  it('shows thumbnail slot, last modified, disk usage and deletes with confirmation', async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { await runtime.api.createProject({ name: 'Hapus Saya' }); });
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.open')!);
    await until(() => el('scr.project.open.usage.total'), 'usage total');
    expect(el('scr.project.open.thumb')).not.toBeNull();
    expect(el('scr.project.open.list')!.textContent).toContain('Modified');
    expect(el('scr.project.open.usage')).not.toBeNull();
    const row = [...el('scr.project.open.list')!.querySelectorAll('li')].find((li) => li.textContent?.includes('Hapus Saya'))!;
    fireEvent.click(row.querySelector('[data-el="scr.project.open.delete"]')!);
    await until(() => el('scr.project.open.delete.confirm'));
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('backup');
    await act(async () => { fireEvent.click(el('scr.project.open.delete.confirm')!); });
    await untilAsync(async () => !(await runtime.api.listProjects()).items.some((p) => p.name === 'Hapus Saya'), 'deleted');
  });

  it('lists checkpoints with version hash and size', async () => {
    await renderEditor('sample');
    await act(async () => { fireEvent.click(el('hdr.menu.file')!); });
    fireEvent.click(el('hdr.menu.file.save')!);
    await until(() => !el('hdr.title.dirty'));
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.recover')!);
    await until(() => el('scr.project.recover.hash'), 'hash');
    expect(el('scr.project.recover.hash')!.textContent).toMatch(/^v[0-9a-f]{6}$/);
  });
});

describe('Backup (FR-017)', () => {
  it('has a folder picker field and a size estimate', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.action.backup')!);
    await until(() => el('scr.backup.backup.estimate'), 'estimate');
    expect((el('scr.backup.backup.folder') as HTMLInputElement).value).toContain('Expertmotion');
    expect(el('scr.backup.backup.estimate')!.textContent).toMatch(/Estimated size .* free/);
  });
});

describe('Onboarding (FR-004…FR-008)', () => {
  it('per-step skip, Done opens New prefilled "Untitled" and stores the record server-side', async () => {
    const { runtime } = await renderEditor('sample', { prefs: { onboardingDone: false } });
    await until(() => el('scr.onboarding.welcome'), 'wizard');
    fireEvent.click(byText('Get started')!);
    await until(() => el('scr.onboarding.license'));
    fireEvent.click(el('scr.onboarding.skip')!);                         // licence → provider
    await until(() => el('scr.onboarding.provider'));
    expect(el('scr.onboarding.provider.consequence')!.textContent).toBe('Agents stay off until a provider is connected');
    expect((document.querySelector('[data-el="scr.providers.add"] select') as HTMLSelectElement | null)?.value ?? 'openrouter').toBe('openrouter');
    fireEvent.click(byText('Skip for now')!);                            // provider + models skipped
    await until(() => el('scr.onboarding.hardware'));
    expect(el('scr.onboarding.hardware.disk')).not.toBeNull();
    expect(el('scr.onboarding.hardware.recheck')).not.toBeNull();
    await act(async () => { fireEvent.click(el('scr.onboarding.hardware.recheck')!); });
    fireEvent.click(byText('Next')!);
    await until(() => el('scr.onboarding.tour'));
    fireEvent.click(byText('Skip the tour')!);
    await until(() => el('scr.onboarding.done'));
    expect(el('scr.onboarding.done')!.textContent).toContain('Skipped');
    await act(async () => { fireEvent.click(el('scr.onboarding.done.open')!); });
    await until(() => el('scr.project.new'), 'new dialog');
    expect((el('scr.project.new.name') as HTMLInputElement).value).toBe('Untitled');
    await untilAsync(async () => (await runtime.api.getSettings()).onboardingDone === true, 'server record');
    expect((await runtime.api.getSettings()).onboardingSkippedSteps).toEqual(expect.arrayContaining(['license', 'provider', 'models', 'tour']));
  });

  it('Help ▸ Resume onboarding reopens the wizard', async () => {
    await renderEditor('sample');
    fireEvent.click(el('hdr.menu.help')!);
    fireEvent.click(el('hdr.menu.help.onboarding')!);
    await until(() => el('scr.onboarding'), 'wizard');
  });
});

describe('Restart recovery toast (FR-171, FR-172)', () => {
  it('tells the Creator once when the Service run changed since this window last saw it', async () => {
    sessionStorage.clear();
    sessionStorage.setItem('expertmotion.recovery.seen', '2000-01-01T00:00:00.000Z');
    await renderEditor('sample', { keepStorage: true });
    await until(() => [...document.querySelectorAll('[data-el="sys.toast"]')].some((n) => n.textContent?.includes('Service restarted')), 'EM-8003 toast');
    expect(sessionStorage.getItem('expertmotion.recovery.seen')).not.toBe('2000-01-01T00:00:00.000Z');
  });
  it('stays quiet after a clean first start', async () => {
    await renderEditor('sample');
    await until(() => sessionStorage.getItem('expertmotion.recovery.seen'), 'recovery checked');
    expect([...document.querySelectorAll('[data-el="sys.toast"]')].some((n) => n.textContent?.includes('Service restarted'))).toBe(false);
  });
});
