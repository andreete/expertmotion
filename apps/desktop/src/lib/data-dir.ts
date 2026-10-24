/**
 * Data-directory layout under %APPDATA%\Expertmotion (ARCHITECTURE.md §8, DEPLOYMENT §5).
 * Pure path math; the Shell creates these on first run (DEPLOYMENT §8 task 2).
 */
import { DATA_DIR_NAME } from './constants.js';

export interface DataLayout {
  root: string;
  data: string;
  keyring: string;
  checkpoints: string;
  media: string;
  outputs: string;
  models: string;
  tmp: string;
  logs: string;
  settings: string;
}

export interface LogFiles {
  shell: string;
  service: string;
  engine: string;
}

/** Joins with the given separator; keeps the module free of `node:path` platform coupling in tests. */
function join(sep: string, ...parts: string[]): string {
  return parts.join(sep);
}

/** Builds the full data layout from the app-data base (e.g. `C:\\Users\\x\\AppData\\Roaming`). */
export function dataLayout(appData: string, sep = '\\'): DataLayout {
  const root = join(sep, appData, DATA_DIR_NAME);
  const data = join(sep, root, 'data');
  return {
    root,
    data,
    keyring: join(sep, data, 'keyring.bin'),
    checkpoints: join(sep, data, 'checkpoints'),
    media: join(sep, root, 'media'),
    outputs: join(sep, root, 'outputs'),
    models: join(sep, root, 'models'),
    tmp: join(sep, root, 'tmp'),
    logs: join(sep, root, 'logs'),
    settings: join(sep, root, 'settings.json'),
  };
}

/** Directories that must exist before the Service starts (keyring.bin and settings.json are files). */
export function directoriesToCreate(layout: DataLayout): string[] {
  return [layout.root, layout.data, layout.checkpoints, layout.media, layout.outputs, layout.models, layout.tmp, layout.logs];
}

export function logFiles(layout: DataLayout, sep = '\\'): LogFiles {
  return {
    shell: join(sep, layout.logs, 'shell.log'),
    service: join(sep, layout.logs, 'service.log'),
    engine: join(sep, layout.logs, 'engine.log'),
  };
}

/** Timestamped crash-file name (DEPLOYMENT §14), e.g. `crash-shell-20261024-131500.txt`. */
export function crashFileName(process: 'shell' | 'service', ts: string): string {
  return `crash-${process}-${ts}.txt`;
}
