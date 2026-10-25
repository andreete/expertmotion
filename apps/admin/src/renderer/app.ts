/**
 * Renderer of Expertmotion License Admin. Plain DOM, bundled to dist/renderer/app.js. All data is
 * inserted with textContent (never innerHTML). Every action goes through window.emAdmin.request;
 * main validates and does all crypto and file work.
 */
import { passphraseStrength } from '../core/strength.js';

interface Bridge {
  request(channel: string, args?: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string; emCode?: string } }>;
  onLocked(cb: (reason: string) => void): () => void;
}
declare global {
  interface Window { emAdmin: Bridge }
}

class UiError extends Error {
  constructor(public code: string, message: string, public emCode?: string) {
    super(message);
  }
}

async function call<T = Record<string, unknown>>(channel: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await window.emAdmin.request(`em-admin:${channel}`, args);
  if (!r.ok) throw new UiError(r.error.code, r.error.message, r.error.emCode);
  return r.result as T;
}

// ---------- tiny DOM helpers ----------
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else if (k === 'disabled' || k === 'checked' || k === 'readOnly') (el as unknown as Record<string, boolean>)[k] = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}
const $ = (id: string): HTMLElement => document.getElementById(id)!;
function field(labelText: string, input: HTMLElement, opt = false, hint?: HTMLElement): HTMLElement {
  return h('div', {}, h('label', {}, labelText, opt ? h('span', { class: 'opt' }, ' (optional)') : null), input, hint ?? null);
}
function errorBox(e: unknown): HTMLElement {
  const msg = e instanceof Error ? e.message : String(e);
  return h('div', { class: 'err' }, msg);
}
function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 1800);
}
async function copy(text: string, what: string): Promise<void> {
  try {
    await call('clipboard.write', { text });
    toast(`${what} copied`);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Copy failed');
  }
}
function copyBtn(get: () => string, what: string): HTMLButtonElement {
  return h('button', { class: 'btn', onclick: () => void copy(get(), what) }, `Copy ${what.toLowerCase()}`);
}
/** Two-step confirmation: first click arms the button for 8 s, the second runs the action. */
function confirmBtn(label: string, armedLabel: string, run: () => Promise<void>, cls = 'btn danger'): HTMLButtonElement {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const b = h('button', { class: cls }, label);
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = armedLabel;
      b.classList.add('armed');
      timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 8000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    b.textContent = label;
    b.classList.remove('armed');
    void run();
  });
  return b;
}
function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- state ----------
interface State {
  key: { unlocked: boolean; kid: string | null; publicKeyHex: string | null; file: string | null; idleRemainingMs: number | null };
  idleMs: number;
  network: { up: string[]; online: boolean; policy: 'strict' | 'warn' };
  settings: { workspaceDir: string; networkPolicy: 'strict' | 'warn'; signature: string; lang: 'en' | 'id'; lastKeyFile: string | null; knownKeys: { kid: string; publicKeyHex: string; file: string }[] };
  paths: { auditPath: string; outDir: string; distDir: string; revokedPath: string };
}
let state: State | null = null;
let currentTab = 'keys';

async function refreshState(): Promise<void> {
  state = await call<State>('state.get');
  const ks = $('keystatus');
  ks.replaceChildren();
  if (state.key.unlocked) {
    const min = Math.ceil((state.key.idleRemainingMs ?? 0) / 60000);
    ks.append(h('span', { class: 'pill ok' }, `Key ${state.key.kid} unlocked`), h('span', { class: 'small' }, `auto-lock in ${min} min`),
      h('button', { class: 'btn', onclick: async () => { await call('key.lock'); await refreshState(); render(); } }, 'Lock'));
  } else {
    ks.append(h('span', { class: 'pill bad' }, 'Key locked'));
  }
  const b = $('netbanner');
  if (state.network.online) {
    b.className = `banner ${state.network.policy}`;
    b.textContent = state.network.policy === 'strict'
      ? `Online (${state.network.up.join(', ')}): signing is refused under the strict network policy. Disconnect this computer, or change Settings > Network policy.`
      : `Online (${state.network.up.join(', ')}): signing is allowed because Settings > Network policy is "Warn only". An offline PC is safer for the signing key.`;
  } else {
    b.className = 'banner hidden';
  }
}

// ---------- shared pieces ----------
function machineCodeInput(onValid: (ok: boolean) => void): { el: HTMLElement; input: HTMLTextAreaElement } {
  const input = h('textarea', { rows: '2', class: 'mono', placeholder: 'MC1-…', spellcheck: 'false' });
  const hint = h('div', { class: 'hint' }, 'Paste the Machine Code from the Creator (Help > Licence > Copy).');
  const check = debounce(async () => {
    try {
      const r = await call<{ ok: boolean; message: string; reason?: string }>('machineCode.check', { machineCode: input.value });
      hint.textContent = r.message;
      hint.className = `hint ${r.ok ? 'ok' : r.reason === 'empty' ? '' : 'bad'}`;
      onValid(r.ok);
    } catch (e) {
      hint.textContent = e instanceof Error ? e.message : String(e);
      hint.className = 'hint bad';
      onValid(false);
    }
  }, 200);
  input.addEventListener('input', () => { onValid(false); check(); });
  return { el: field('Machine Code', input, false, hint), input };
}

interface KeyResult { action: string; lid: string; rev: number; kid: string; updatesUntil: string; file: string; key: string; keyGrouped: string; emailText: string; revocationEpoch: number | null }

function keyResultView(r: KeyResult): HTMLElement {
  return h('div', { class: 'card' },
    h('div', { class: 'success' }, `${r.action}: licence ${r.lid} rev ${r.rev} (key ${r.kid}), updates until ${r.updatesUntil}`),
    r.revocationEpoch !== null ? h('p', { class: 'hint warn' }, `The previous key is revoked from epoch ${r.revocationEpoch}: export revoked.json (Licences) and ship it so older keys stop working.`) : null,
    h('label', {}, 'Licence Key'), h('div', { class: 'out' }, r.keyGrouped),
    h('div', { class: 'row' }, copyBtn(() => r.key, 'Key'), h('button', { class: 'btn', onclick: () => void call('dialog.openPath', { path: r.file }) }, 'Show .emlicense file'), h('span', { class: 'path' }, r.file)),
    h('label', {}, 'Delivery email (EN + ID, §12)'), h('textarea', { rows: '14', readOnly: true, value: r.emailText }),
    h('div', { class: 'row' }, copyBtn(() => r.emailText, 'Email')),
  );
}

function needsKeyNote(): HTMLElement | null {
  return state?.key.unlocked ? null : h('div', { class: 'err' }, 'The signing key is locked. Open it under Keys first.');
}

// ---------- Keys ----------
function keysScreen(): HTMLElement {
  const s = state!;
  const root = h('div', {}, h('h2', {}, 'Signing key'), h('p', { class: 'lead' }, 'The private key is sealed with your passphrase on disk and held only in memory while unlocked. It locks itself after 15 minutes without activity.'));
  if (s.key.unlocked) {
    const line = `{ kid: '${s.key.kid}', publicKeyHex: '${s.key.publicKeyHex}', status: 'active', since: '${new Date().toISOString().slice(0, 10)}' },`;
    root.append(h('div', { class: 'card' },
      h('h3', {}, `Unlocked: key ${s.key.kid}`), h('div', { class: 'path' }, s.key.file ?? ''),
      h('label', {}, 'Public key (hex)'), h('div', { class: 'out' }, s.key.publicKeyHex ?? ''),
      h('div', { class: 'row' }, copyBtn(() => s.key.publicKeyHex ?? '', 'Public key')),
      h('label', {}, 'Key table entry for apps/service/src/license/keys.ts'), h('div', { class: 'out' }, line),
      h('div', { class: 'row' }, copyBtn(() => line, 'Entry'), h('button', { class: 'btn', onclick: async () => { await call('key.lock'); await refreshState(); render(); } }, 'Lock now')),
    ));
  }
  // open
  let openFile: string | null = s.settings.lastKeyFile;
  const openPath = h('span', { class: 'path' }, openFile ?? 'No file chosen');
  const openPass = h('input', { type: 'password', autocomplete: 'off' });
  const openOut = h('div');
  const doOpen = async (): Promise<void> => {
    openOut.replaceChildren();
    try {
      if (!openFile) throw new Error('Choose the key file first.');
      const r = await call<{ kid: string }>('key.open', { file: openFile, passphrase: openPass.value });
      openPass.value = '';
      toast(`Key ${r.kid} unlocked`);
      await refreshState();
      render();
    } catch (e) {
      openOut.append(errorBox(e));
    }
  };
  openPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doOpen(); });
  // create
  const kid = h('input', { type: 'text', value: 'A1', maxlength: '2', class: 'mono' });
  const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const bar = h('div');
  const strengthHint = h('div', { class: 'hint' }, 'At least 12 characters; a phrase of 4 or more unrelated words is best.');
  const matchHint = h('div', { class: 'hint' });
  let folder: string | null = null;
  const folderPath = h('span', { class: 'path' }, 'No folder chosen (use the encrypted USB drive, never a repository)');
  const createOut = h('div');
  const updateHints = (): void => {
    const st = passphraseStrength(p1.value);
    bar.className = st.level;
    bar.style.width = `${Math.min(100, Math.round((st.bits / 100) * 100)) || 4}%`;
    strengthHint.textContent = st.hint;
    strengthHint.className = `hint ${st.level === 'strong' ? 'ok' : st.level === 'fair' ? 'warn' : 'bad'}`;
    matchHint.textContent = p2.value === '' ? '' : p1.value === p2.value ? 'Passphrases match.' : 'Passphrases do not match.';
    matchHint.className = `hint ${p1.value === p2.value ? 'ok' : 'bad'}`;
  };
  p1.addEventListener('input', updateHints);
  p2.addEventListener('input', updateHints);
  const doCreate = async (): Promise<void> => {
    createOut.replaceChildren();
    try {
      if (!folder) throw new Error('Choose a folder for the key file first.');
      const r = await call<{ kid: string; publicKeyHex: string; file: string; keyTableEntry: string }>('key.create', {
        kid: kid.value.trim().toUpperCase(), passphrase: p1.value, passphraseConfirm: p2.value, folder,
      });
      p1.value = '';
      p2.value = '';
      await refreshState();
      render();
      toast(`Key ${r.kid} created and unlocked`);
    } catch (e) {
      createOut.append(errorBox(e));
    }
  };
  root.append(h('div', { class: 'grid2' },
    h('div', { class: 'card' },
      h('h3', {}, 'Open an existing sealed key'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const p = await call<string | null>('dialog.pickKeyFile'); if (p) { openFile = p; openPath.textContent = p; } } }, 'Browse…'), openPath),
      field('Passphrase', openPass),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => void doOpen() }, 'Unlock')),
      openOut),
    h('div', { class: 'card' },
      h('h3', {}, 'Create a new signing key pair'),
      field('Key id (kid, two characters A-Z/0-9)', kid),
      field('Passphrase', p1, false, h('div', {}, h('div', { class: 'meter' }, bar), strengthHint)),
      field('Passphrase again', p2, false, matchHint),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const p = await call<string | null>('dialog.pickFolder', { purpose: 'keyFolder' }); if (p) { folder = p; folderPath.textContent = p; } } }, 'Choose folder…'), folderPath),
      h('p', { class: 'hint' }, 'The passphrase cannot be recovered. Without it, the key file is useless; keep a second sealed copy on separate backup media.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => void doCreate() }, 'Create sealed key')),
      createOut),
  ));
  return root;
}

// ---------- Issue ----------
function issueScreen(): HTMLElement {
  const s = state!;
  const name = h('input', { type: 'text', maxlength: '64' });
  const email = h('input', { type: 'text', maxlength: '254' });
  const order = h('input', { type: 'text', maxlength: '128', placeholder: 'ORD-…' });
  const months = h('input', { type: 'number', min: '0', max: '999', value: '12' });
  const tier = h('select', {}, h('option', { value: 'standard' }, 'standard'), h('option', { value: 'pro' }, 'pro'));
  const lang = h('select', {}, h('option', { value: 'en' }, 'English first'), h('option', { value: 'id' }, 'Bahasa Indonesia first'));
  lang.value = s.settings.lang;
  const override = h('input', { type: 'text', maxlength: '500', placeholder: 'only for a second licence on the same order' });
  const out = h('div');
  let mcOk = false;
  const gen = h('button', { class: 'btn primary', disabled: true }, 'Generate Licence Key');
  const sync = (): void => { gen.disabled = !(mcOk && s.key.unlocked && name.value.trim() && email.value.trim()); };
  const mc = machineCodeInput((ok) => { mcOk = ok; sync(); });
  name.addEventListener('input', sync);
  email.addEventListener('input', sync);
  gen.addEventListener('click', async () => {
    out.replaceChildren();
    gen.disabled = true;
    try {
      const args: Record<string, unknown> = {
        name: name.value, email: email.value, updatesMonths: Number(months.value), machineCode: mc.input.value, tier: tier.value, lang: lang.value,
      };
      if (order.value.trim()) args.orderId = order.value.trim();
      if (override.value.trim()) args.override = override.value.trim();
      const r = await call<KeyResult>('licence.issue', args);
      out.append(keyResultView(r));
    } catch (e) {
      out.append(errorBox(e));
    } finally {
      sync();
    }
  });
  return h('div', {},
    h('h2', {}, 'Issue a licence'), h('p', { class: 'lead' }, 'Every key is bound to exactly one computer: the Creator\'s Machine Code is required. The audit log is appended automatically.'),
    needsKeyNote(),
    h('div', { class: 'card' },
      h('div', { class: 'grid2' }, field('Name', name), field('Email', email)),
      h('div', { class: 'grid2' }, field('Order id', order, true), field('Updates included (months)', months)),
      h('div', { class: 'grid2' }, field('Tier', tier), field('Email language order', lang)),
      mc.el,
      field('Override reason', override, true),
      h('div', { class: 'row' }, gen)),
    out);
}

// ---------- Licences ----------
interface Summary { lid: string; name: string; email: string; tier: string; kid: string; rev: number; machineCode: string; updatesUntil: string; orderRef: string; status: string; lastAction: string; lastTimestamp: string; rebindsLast12Months: number; rebindLimit: number }

function licencesScreen(): HTMLElement {
  const s = state!;
  const q = h('input', { type: 'search', placeholder: 'Search name, email, order, lid or Machine Code' });
  const tbody = h('tbody');
  const detail = h('div');
  const exportOut = h('div');
  let selected: string | null = null;
  const load = async (): Promise<void> => {
    try {
      const r = await call<{ licences: Summary[] }>('licence.list', { query: q.value });
      tbody.replaceChildren(...r.licences.map((l) => {
        const tr = h('tr', { class: l.lid === selected ? 'sel' : '' },
          h('td', { class: 'mono' }, l.lid.slice(0, 10), '…'), h('td', {}, l.name), h('td', {}, l.email),
          h('td', {}, h('span', { class: `pill ${l.status === 'active' ? 'ok' : 'bad'}` }, l.status)),
          h('td', {}, String(l.rev)), h('td', {}, l.updatesUntil), h('td', {}, `${l.rebindsLast12Months}/${l.rebindLimit}`), h('td', { class: 'small' }, `${l.lastAction} ${l.lastTimestamp.slice(0, 10)}`));
        tr.addEventListener('click', () => { selected = l.lid; void load(); showDetail(l); });
        return tr;
      }));
      if (r.licences.length === 0) tbody.append(h('tr', {}, h('td', { colspan: '8', class: 'small' }, q.value ? 'No match.' : `No licences yet in ${s.paths.auditPath}.`)));
    } catch (e) {
      tbody.replaceChildren(h('tr', {}, h('td', { colspan: '8' }, errorBox(e))));
    }
  };
  const showDetail = async (l: Summary): Promise<void> => {
    const res = h('div');
    const hist = await call<{ rows: Record<string, string | number>[] }>('licence.history', { lid: l.lid }).catch(() => ({ rows: [] as Record<string, string | number>[] }));
    const after = async (fn: () => Promise<KeyResult | Record<string, unknown>>): Promise<void> => {
      res.replaceChildren();
      try {
        const r = await fn();
        if ('key' in r) res.append(keyResultView(r as KeyResult));
        else res.append(h('div', { class: 'success' }, `Revoked ${String(r.lid)} from epoch ${String(r.epoch)} (${String(r.reason)}). Export revoked.json and publish it the same day.`));
        await load();
      } catch (e) {
        res.append(errorBox(e));
      }
    };
    const active = l.status === 'active';
    let rbOk = false;
    const rbOverride = h('input', { type: 'text', maxlength: '500', placeholder: 'required beyond 3 moves in 12 months, or to rebind to the same code' });
    const rbBtn = confirmBtn('Rebind…', 'Click again to rebind', () => after(() => {
      const a: Record<string, unknown> = { lid: l.lid, machineCode: rb.input.value, lang: s.settings.lang };
      if (rbOverride.value.trim()) a.override = rbOverride.value.trim();
      return call<KeyResult>('licence.rebind', a);
    }), 'btn');
    rbBtn.disabled = true;
    const rb = machineCodeInput((ok) => { rbOk = ok; rbBtn.disabled = !rbOk; });
    const rnMonths = h('input', { type: 'number', min: '0', max: '999', value: '12' });
    const rnOrder = h('input', { type: 'text', maxlength: '128', placeholder: 'ORD-…' });
    const rnBtn = confirmBtn('Renew…', 'Click again to renew', () => after(() => {
      const a: Record<string, unknown> = { lid: l.lid, updatesMonths: Number(rnMonths.value), lang: s.settings.lang };
      if (rnOrder.value.trim()) a.orderId = rnOrder.value.trim();
      return call<KeyResult>('licence.renew', a);
    }), 'btn');
    const rvReason = h('select', {}, h('option', { value: 'refund' }, 'refund'), h('option', { value: 'fraud' }, 'fraud / chargeback'));
    const rvNote = h('input', { type: 'text', maxlength: '500' });
    const rvBtn = confirmBtn('Revoke…', 'Click again to REVOKE (cannot be undone)', () => after(() => {
      const a: Record<string, unknown> = { lid: l.lid, reason: rvReason.value };
      if (rvNote.value.trim()) a.note = rvNote.value.trim();
      return call('licence.revoke', a);
    }));
    detail.replaceChildren(h('div', { class: 'card' },
      h('h3', {}, `${l.name} · ${l.lid}`),
      h('div', { class: 'small' }, `${l.email} · ${l.tier} · key ${l.kid} · rev ${l.rev} · updates until ${l.updatesUntil} · moves ${l.rebindsLast12Months}/${l.rebindLimit} in 12 months`),
      h('div', { class: 'small mono' }, l.machineCode),
      h('table', {}, h('thead', {}, h('tr', {}, ...['time (UTC)', 'action', 'rev', 'kid', 'updates until', 'order', 'reason', 'note'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...hist.rows.map((r) => h('tr', {}, ...['timestamp_utc', 'action', 'rev', 'kid', 'updates_until', 'order_ref', 'reason', 'operator_note'].map((k) => h('td', { class: 'small' }, String(r[k] ?? ''))))))),
      active ? h('div', { class: 'grid2' },
        h('div', {}, h('h3', {}, 'Rebind to a new computer'), rb.el, field('Override reason', rbOverride, true), h('div', { class: 'row' }, rbBtn)),
        h('div', {}, h('h3', {}, 'Renew updates'), field('Months to add', rnMonths), field('Order id', rnOrder, true), h('div', { class: 'row' }, rnBtn),
          h('h3', {}, 'Revoke'), field('Reason', rvReason), field('Note', rvNote, true), h('div', { class: 'row' }, rvBtn)),
      ) : h('p', { class: 'hint bad' }, 'This licence is revoked; issue a new licence for a new purchase.'),
      needsKeyNote(),
      res));
  };
  q.addEventListener('input', debounce(() => void load(), 200));
  const doExport = async (folder?: string): Promise<void> => {
    exportOut.replaceChildren();
    try {
      const r = await call<{ out: string; sig: string; entries: number; generatedAt: string; kid: string }>('revocations.export', folder ? { folder } : {});
      exportOut.append(h('div', { class: 'success' }, `revoked.json: ${r.entries} entries, generatedAt ${r.generatedAt}, signed with ${r.kid}`),
        h('div', { class: 'row' }, h('span', { class: 'path' }, `${r.out} (+ .sig)`), h('button', { class: 'btn', onclick: () => void call('dialog.openPath', { path: r.out }) }, 'Show in folder')));
    } catch (e) {
      exportOut.append(errorBox(e));
    }
  };
  void load();
  return h('div', {},
    h('h2', {}, 'Licences'), h('p', { class: 'lead' }, `From the audit log ${s.paths.auditPath}`),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, q, h('button', { class: 'btn', onclick: () => void doExport() }, 'Export revoked.json'),
        h('button', { class: 'btn', onclick: async () => { const p = await call<string | null>('dialog.pickFolder', { purpose: 'export' }); if (p) await doExport(p); } }, 'Export to folder…')),
      exportOut,
      h('table', {}, h('thead', {}, h('tr', {}, ...['lid', 'name', 'email', 'status', 'rev', 'updates until', 'moves', 'last'].map((t) => h('th', {}, t)))), tbody)),
    detail);
}

// ---------- Verify ----------
const CODE_TEXT: Record<string, string> = {
  'EM-5002': 'Signature not valid (tampered key, or a revoked signing key).',
  'EM-5003': 'Bound to a different computer than this Machine Code.',
  'EM-5004': 'Revoked by the workspace revoked.json.',
  'EM-5005': 'Updates period ended before the build date.',
  'EM-5006': 'Not a well-formed Expertmotion key.',
  'EM-5009': 'Signed with a key id this app does not know.',
};
function verifyScreen(): HTMLElement {
  const key = h('textarea', { rows: '4', placeholder: 'EM1-…', spellcheck: 'false' });
  const mc = h('textarea', { rows: '2', class: 'mono', placeholder: 'MC1-… (optional)', spellcheck: 'false' });
  const out = h('div');
  const run = async (): Promise<void> => {
    out.replaceChildren();
    try {
      const args: Record<string, unknown> = { key: key.value };
      if (mc.value.trim()) args.machineCode = mc.value.trim();
      const r = await call<{ valid: boolean; code: string | null; kid: string | null; payload: unknown; fingerprint: { compared: number; matched: number } | null; checked: Record<string, boolean>; revocation: { note: string } }>('licence.verify', args);
      out.append(h('div', { class: 'card' },
        h('div', { class: r.valid ? 'success' : 'err' }, r.valid ? 'VALID' : `NOT VALID: ${r.code ?? ''} ${r.code ? CODE_TEXT[r.code] ?? '' : ''}`),
        h('p', { class: 'small' }, `Checked: signature${r.checked.fingerprint ? ', Machine Code' : ' (Machine Code not given)'}${r.checked.revocation ? ', revocation list' : ''}. ${r.revocation.note}`),
        r.fingerprint ? h('p', { class: 'small' }, `Fingerprint components matched: ${r.fingerprint.matched} of ${r.fingerprint.compared}`) : null,
        r.payload ? h('div', {}, h('label', {}, 'Decoded payload'), h('div', { class: 'out' }, JSON.stringify(r.payload, null, 2))) : null));
    } catch (e) {
      out.append(errorBox(e));
    }
  };
  return h('div', {},
    h('h2', {}, 'Verify a key'), h('p', { class: 'lead' }, 'Offline check with the public keys of the key files used here; works while the signing key is locked.'),
    h('div', { class: 'card' }, field('Licence Key', key), field('Machine Code', mc, true), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => void run() }, 'Verify'))),
    out);
}

// ---------- Settings ----------
function settingsScreen(): HTMLElement {
  const s = state!;
  const out = h('div');
  const ws = h('span', { class: 'path' }, s.settings.workspaceDir);
  const sig = h('input', { type: 'text', maxlength: '200', value: s.settings.signature });
  const lang = h('select', {}, h('option', { value: 'en' }, 'English first'), h('option', { value: 'id' }, 'Bahasa Indonesia first'));
  lang.value = s.settings.lang;
  const policy = h('select', {}, h('option', { value: 'strict' }, 'Strict: refuse signing while online (same rule as the CLI)'), h('option', { value: 'warn' }, 'Warn only: show a banner, allow signing'));
  policy.value = s.settings.networkPolicy;
  const save = async (args: Record<string, unknown>): Promise<void> => {
    out.replaceChildren();
    try {
      await call('settings.update', args);
      await refreshState();
      toast('Saved');
      render();
    } catch (e) {
      out.append(errorBox(e));
    }
  };
  return h('div', {},
    h('h2', {}, 'Settings'),
    h('div', { class: 'card' },
      h('h3', {}, 'Workspace'), h('p', { class: 'small' }, 'Audit log, .emlicense files and revoked.json live here. Back it up to the encrypted media with the key.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const p = await call<string | null>('dialog.pickFolder', { purpose: 'workspace' }); if (p) await save({ workspaceDir: p }); } }, 'Change…'), ws),
      h('div', { class: 'small' }, `Audit: ${s.paths.auditPath}`), h('div', { class: 'small' }, `Licence files: ${s.paths.outDir}`), h('div', { class: 'small' }, `Revocations: ${s.paths.revokedPath}`)),
    h('div', { class: 'card' },
      h('h3', {}, 'Network policy'),
      h('p', { class: 'small' }, s.network.online ? `Network interfaces up now: ${s.network.up.join(', ')}` : 'No network interface is up.'),
      policy, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => void save({ networkPolicy: policy.value }) }, 'Save policy'))),
    h('div', { class: 'card' },
      h('h3', {}, 'Delivery email'), field('Signature line', sig), field('Default language order', lang),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => void save({ signature: sig.value, lang: lang.value }) }, 'Save'))),
    out);
}

// ---------- shell ----------
const SCREENS: Record<string, () => HTMLElement> = { keys: keysScreen, issue: issueScreen, licences: licencesScreen, verify: verifyScreen, settings: settingsScreen };
function render(): void {
  if (!state) return;
  $('screen').replaceChildren(SCREENS[currentTab]!());
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === currentTab);
}

async function boot(): Promise<void> {
  $('tabs').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button')?.dataset.tab;
    if (t && SCREENS[t]) { currentTab = t; void refreshState().then(render); }
  });
  let lastTouch = 0;
  const touch = (): void => {
    const n = Date.now();
    if (n - lastTouch > 20_000) { lastTouch = n; void call('activity.touch').catch(() => undefined); }
  };
  window.addEventListener('keydown', touch, true);
  window.addEventListener('pointerdown', touch, true);
  window.emAdmin.onLocked((reason) => {
    toast(reason === 'idle' ? 'Locked after 15 minutes without activity' : 'Key locked');
    void refreshState().then(render);
  });
  setInterval(() => void refreshState().catch(() => undefined), 20_000);
  await refreshState();
  if (state?.key.unlocked) currentTab = 'issue';
  render();
}
void boot();
