/**
 * The closed IPC surface between the renderer and the main process. Every channel has an argument
 * schema; main rejects unknown channels, non-plain objects, unknown keys, wrong types and oversize
 * strings before any handler runs (validate.ts). The preload exposes exactly these channels.
 * Electron-free: imported by main, preload and the unit tests.
 */

export type Field =
  | { type: 'string'; max: number; optional?: boolean; pattern?: RegExp; oneOf?: readonly string[] }
  | { type: 'int'; min: number; max: number; optional?: boolean }
  | { type: 'boolean'; optional?: boolean };

export type Schema = Readonly<Record<string, Field>>;

const PATH: Field = { type: 'string', max: 4096 };
const MACHINE_CODE: Field = { type: 'string', max: 256 };
const LID: Field = { type: 'string', max: 32, pattern: /^[0-9A-Za-z]{26}$/ };
const PASSPHRASE: Field = { type: 'string', max: 1024 };
const REASON_TEXT: Field = { type: 'string', max: 500, optional: true };

/** channel → argument schema. Channel names are `em-admin:<area>.<verb>`. */
export const CHANNELS = {
  'em-admin:state.get': {},
  'em-admin:activity.touch': {},
  'em-admin:settings.update': {
    networkPolicy: { type: 'string', max: 8, optional: true, oneOf: ['strict', 'warn'] },
    signature: { type: 'string', max: 200, optional: true },
    lang: { type: 'string', max: 2, optional: true, oneOf: ['en', 'id'] },
    workspaceDir: { ...PATH, optional: true },
  },
  'em-admin:dialog.pickFolder': { purpose: { type: 'string', max: 16, oneOf: ['keyFolder', 'workspace', 'export'] } },
  'em-admin:dialog.pickKeyFile': {},
  'em-admin:dialog.openPath': { path: PATH },
  'em-admin:clipboard.write': { text: { type: 'string', max: 65536 } },
  'em-admin:key.create': {
    kid: { type: 'string', max: 2, pattern: /^[A-Z0-9]{2}$/ },
    passphrase: PASSPHRASE,
    passphraseConfirm: PASSPHRASE,
    folder: PATH,
  },
  'em-admin:key.open': { file: PATH, passphrase: PASSPHRASE },
  'em-admin:key.lock': {},
  'em-admin:machineCode.check': { machineCode: MACHINE_CODE },
  'em-admin:licence.issue': {
    name: { type: 'string', max: 256 },
    email: { type: 'string', max: 320 },
    orderId: { type: 'string', max: 128, optional: true },
    updatesMonths: { type: 'int', min: 0, max: 999 },
    machineCode: MACHINE_CODE,
    tier: { type: 'string', max: 8, optional: true, oneOf: ['standard', 'pro'] },
    override: REASON_TEXT,
    lang: { type: 'string', max: 2, optional: true, oneOf: ['en', 'id'] },
  },
  'em-admin:licence.list': { query: { type: 'string', max: 256, optional: true } },
  'em-admin:licence.history': { lid: LID },
  'em-admin:licence.rebind': { lid: LID, machineCode: MACHINE_CODE, override: REASON_TEXT, lang: { type: 'string', max: 2, optional: true, oneOf: ['en', 'id'] } },
  'em-admin:licence.renew': {
    lid: LID,
    updatesMonths: { type: 'int', min: 0, max: 999 },
    orderId: { type: 'string', max: 128, optional: true },
    lang: { type: 'string', max: 2, optional: true, oneOf: ['en', 'id'] },
  },
  'em-admin:licence.revoke': { lid: LID, reason: { type: 'string', max: 8, oneOf: ['refund', 'fraud'] }, note: REASON_TEXT },
  'em-admin:revocations.export': { folder: { ...PATH, optional: true } },
  'em-admin:licence.verify': { key: { type: 'string', max: 16384 }, machineCode: { ...MACHINE_CODE, optional: true } },
} as const satisfies Record<string, Schema>;

export type Channel = keyof typeof CHANNELS;
export const CHANNEL_NAMES = Object.keys(CHANNELS) as Channel[];

/** main → renderer push events (no arguments from the renderer). */
export const EVENTS = { locked: 'em-admin:event.locked' } as const;
