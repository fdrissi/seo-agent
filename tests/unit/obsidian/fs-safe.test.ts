import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendDurable, atomicWriteFile, listTempFiles, resolveInVault, validateVaultRelPath } from '../../../src/obsidian/fs-safe.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-vaultfs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validateVaultRelPath', () => {
  it.each([
    ['../escape.md', /traversal/],
    ['02 Website/../../escape.md', /traversal/],
    ['/etc/passwd.md', /Absolute/],
    ['C:/Windows/x.md', /Absolute/],
    ['02 Website\\Pages\\x.md', /forward slashes/],
    ['02 Website/Pages/x\0.md', /NUL/],
    ['.obsidian/workspace.md', /Hidden/],
    ['02 Website//x.md', /empty segment/],
  ])('rejects %s', (p, re) => {
    expect(() => validateVaultRelPath(p, 'generated')).toThrow(re);
  });

  it('refuses generated writes into human-only and append-only folders', () => {
    expect(() => validateVaultRelPath('01 Business/Business Profile.md', 'generated')).toThrow(/human-maintained/);
    expect(() => validateVaultRelPath('Templates/Page.md', 'generated')).toThrow(/human-maintained/);
    expect(() => validateVaultRelPath('14 System Logs/2026-01-01.md', 'generated')).toThrow(/append-only/);
    expect(() => validateVaultRelPath('Random Folder/x.md', 'generated')).toThrow(/standard vault folder/);
    expect(() => validateVaultRelPath('02 Website/Pages/a|b.md', 'generated')).toThrow(/break wikilinks/);
    expect(() => validateVaultRelPath('02 Website/Pages/page.txt', 'generated')).toThrow(/\.md/);
    expect(validateVaultRelPath('02 Website/Pages/Pricing.md', 'generated')).toBe('02 Website/Pages/Pricing.md');
    expect(validateVaultRelPath('01 Business/Business Profile.md', 'read')).toBe('01 Business/Business Profile.md');
  });
});

describe('resolveInVault (symlink escapes)', () => {
  it('rejects writing through a symlinked folder that points outside the vault', () => {
    const vault = path.join(dir, 'vault');
    const outside = path.join(dir, 'outside');
    mkdirSync(vault);
    mkdirSync(outside);
    symlinkSync(outside, path.join(vault, '02 Website'));
    expect(() => resolveInVault(vault, '02 Website/Pages/x.md', { createParents: true })).toThrow(/symlink|outside/i);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('rejects symlinked folders even when they point inside the vault', () => {
    const vault = path.join(dir, 'vault');
    mkdirSync(path.join(vault, 'real'), { recursive: true });
    symlinkSync(path.join(vault, 'real'), path.join(vault, '03 Keywords'));
    expect(() => resolveInVault(vault, '03 Keywords/x.md', { createParents: true })).toThrow(/symlink/i);
  });

  it('rejects a symlinked note file', () => {
    const vault = path.join(dir, 'vault');
    mkdirSync(path.join(vault, '03 Keywords'), { recursive: true });
    writeFileSync(path.join(dir, 'secret.md'), 'secret');
    symlinkSync(path.join(dir, 'secret.md'), path.join(vault, '03 Keywords', 'x.md'));
    expect(() => resolveInVault(vault, '03 Keywords/x.md', { createParents: false })).toThrow(/symlink|outside/i);
  });

  it('rejects a parent component that is a file, and creates real parents', () => {
    const vault = path.join(dir, 'vault');
    mkdirSync(vault);
    writeFileSync(path.join(vault, '03 Keywords'), 'not a dir');
    expect(() => resolveInVault(vault, '03 Keywords/x.md', { createParents: true })).toThrow(/not a directory/);
    const abs = resolveInVault(vault, '05 Content/Briefs/x.md', { createParents: true });
    expect(abs).toBe(path.join(vault, '05 Content', 'Briefs', 'x.md'));
  });
});

describe('atomicWriteFile', () => {
  it('writes, replaces, and never leaves temp files', () => {
    const f = path.join(dir, 'note.md');
    atomicWriteFile(f, 'one');
    atomicWriteFile(f, 'two');
    expect(readFileSync(f, 'utf8')).toBe('two');
    expect(listTempFiles(dir)).toEqual([]);
  });

  it('leaves the original intact and removes the temp file when the write fails before commit', () => {
    const f = path.join(dir, 'note.md');
    writeFileSync(f, 'original');
    expect(() =>
      atomicWriteFile(f, 'new content that must not appear', {
        hooks: {
          afterTempWrite: () => {
            throw new Error('simulated crash after temp write');
          },
        },
      }),
    ).toThrow(/simulated crash/);
    expect(readFileSync(f, 'utf8')).toBe('original');
    expect(readdirSync(dir)).toEqual(['note.md']);
  });

  it('leaves no partial file when the rename itself fails', () => {
    const target = path.join(dir, 'is-a-dir.md');
    mkdirSync(target);
    writeFileSync(path.join(target, 'child'), 'x');
    expect(() => atomicWriteFile(target, 'content')).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['is-a-dir.md']);
  });

  it('noOverwrite refuses to replace an existing file', () => {
    const f = path.join(dir, 'note.md');
    atomicWriteFile(f, 'first', { noOverwrite: true });
    expect(() => atomicWriteFile(f, 'second', { noOverwrite: true })).toThrow(/Refusing to overwrite/);
    expect(readFileSync(f, 'utf8')).toBe('first');
    expect(listTempFiles(dir)).toEqual([]);
  });

  it('expectedCurrent detects a concurrent modification and keeps the newer content', () => {
    const f = path.join(dir, 'note.md');
    writeFileSync(f, 'v1');
    expect(() =>
      atomicWriteFile(f, 'mine', {
        expectedCurrent: 'v1',
        hooks: { afterTempWrite: () => writeFileSync(f, 'edited by a human meanwhile') },
      }),
    ).toThrow(/changed on disk/);
    expect(readFileSync(f, 'utf8')).toBe('edited by a human meanwhile');
    expect(listTempFiles(dir)).toEqual([]);
  });
});

describe('appendDurable', () => {
  it('appends and refuses symlinks', () => {
    const f = path.join(dir, 'log.md');
    appendDurable(f, 'a\n');
    appendDurable(f, 'b\n');
    expect(readFileSync(f, 'utf8')).toBe('a\nb\n');
    const link = path.join(dir, 'link.md');
    symlinkSync(f, link);
    expect(() => appendDurable(link, 'c\n')).toThrow(/non-regular/);
  });
});
