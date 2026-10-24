import { describe, expect, it } from 'vitest';
import { crashFileName, dataLayout, directoriesToCreate, logFiles } from '../src/lib/data-dir.js';

describe('data-dir layout (ARCHITECTURE §8, DEPLOYMENT §5)', () => {
  const layout = dataLayout('C:\\Users\\x\\AppData\\Roaming', '\\');

  it('places everything under %APPDATA%\\Expertmotion', () => {
    expect(layout.root).toBe('C:\\Users\\x\\AppData\\Roaming\\Expertmotion');
    expect(layout.keyring).toBe('C:\\Users\\x\\AppData\\Roaming\\Expertmotion\\data\\keyring.bin');
    expect(layout.media).toContain('\\Expertmotion\\media');
    expect(layout.logs).toContain('\\Expertmotion\\logs');
  });

  it('lists the directories to create (files excluded)', () => {
    const dirs = directoriesToCreate(layout);
    expect(dirs).toContain(layout.tmp);
    expect(dirs).toContain(layout.checkpoints);
    expect(dirs).not.toContain(layout.keyring);
    expect(dirs).not.toContain(layout.settings);
  });

  it('names the three log files', () => {
    const files = logFiles(layout, '\\');
    expect(files.shell.endsWith('\\logs\\shell.log')).toBe(true);
    expect(files.service.endsWith('\\logs\\service.log')).toBe(true);
    expect(files.engine.endsWith('\\logs\\engine.log')).toBe(true);
  });

  it('builds a timestamped crash file name', () => {
    expect(crashFileName('shell', '20261024-131500')).toBe('crash-shell-20261024-131500.txt');
  });
});
