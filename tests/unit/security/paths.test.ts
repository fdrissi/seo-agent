import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isWithin, safeFileSegment, safeResolve } from '../../../src/security/paths.js';

let root: string;
let base: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-paths-'));
  base = path.join(root, 'vault');
  outside = path.join(root, 'outside');
  mkdirSync(path.join(base, 'notes'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.txt'), 'outside');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const unsafe = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe('UNSAFE_PATH');
    return;
  }
  throw new Error('expected UNSAFE_PATH');
};

describe('safeResolve', () => {
  it('resolves ordinary relative paths inside the base (existing or not)', () => {
    expect(safeResolve(base, 'notes/a.md')).toBe(path.join(base, 'notes', 'a.md'));
    expect(safeResolve(base, 'new/dir/b.md')).toBe(path.join(base, 'new', 'dir', 'b.md'));
    expect(safeResolve(base, './notes/../notes/c.md')).toBe(path.join(base, 'notes', 'c.md'));
    expect(safeResolve(base, '..hidden-looking-name.md')).toBe(path.join(base, '..hidden-looking-name.md'));
  });

  it('rejects traversal out of the base', () => {
    unsafe(() => safeResolve(base, '../outside/secret.txt'));
    unsafe(() => safeResolve(base, 'notes/../../outside/x.md'));
    unsafe(() => safeResolve(base, '..'));
  });

  it('rejects absolute paths (POSIX and Windows drive forms) and NUL bytes', () => {
    unsafe(() => safeResolve(base, '/etc/passwd'));
    unsafe(() => safeResolve(base, path.join(base, 'notes', 'a.md')));
    unsafe(() => safeResolve(base, 'C:\\Windows\\system32'));
    unsafe(() => safeResolve(base, 'c:/x'));
    unsafe(() => safeResolve(base, 'notes/a.md\0.png'));
  });

  it('rejects a symlinked directory that escapes the base', () => {
    symlinkSync(outside, path.join(base, 'escape'));
    unsafe(() => safeResolve(base, 'escape/secret.txt'));
    unsafe(() => safeResolve(base, 'escape/new-file.md'));
  });

  it('rejects a symlinked file that points outside the base', () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(base, 'notes', 'link.md'));
    unsafe(() => safeResolve(base, 'notes/link.md'));
  });

  it('rejects dangling symlinks, which a write would follow to an arbitrary location', () => {
    symlinkSync(path.join(outside, 'created-by-attacker.txt'), path.join(base, 'notes', 'dangling.md'));
    unsafe(() => safeResolve(base, 'notes/dangling.md'));
    symlinkSync(path.join(outside, 'missing-dir'), path.join(base, 'dangling-dir'));
    unsafe(() => safeResolve(base, 'dangling-dir/new.md'));
  });

  it('allows symlinks that stay inside the base', () => {
    writeFileSync(path.join(base, 'notes', 'real.md'), 'x');
    symlinkSync(path.join(base, 'notes', 'real.md'), path.join(base, 'alias.md'));
    symlinkSync(path.join(base, 'notes'), path.join(base, 'notes-link'));
    expect(safeResolve(base, 'alias.md')).toBe(path.join(base, 'alias.md'));
    expect(safeResolve(base, 'notes-link/new.md')).toBe(path.join(base, 'notes-link', 'new.md'));
  });

  it('works when the base itself is reached through a symlink (e.g. macOS /var -> /private/var)', () => {
    const linkedBase = path.join(root, 'vault-link');
    symlinkSync(base, linkedBase);
    expect(safeResolve(linkedBase, 'notes/a.md')).toBe(path.join(linkedBase, 'notes', 'a.md'));
    expect(realpathSync(path.dirname(safeResolve(linkedBase, 'notes/a.md')))).toBe(realpathSync(path.join(base, 'notes')));
  });

  it('works when the base does not exist yet', () => {
    const fresh = path.join(root, 'not-created');
    expect(safeResolve(fresh, 'a/b.md')).toBe(path.join(fresh, 'a', 'b.md'));
    unsafe(() => safeResolve(fresh, '../outside/secret.txt'));
  });
});

describe('isWithin / safeFileSegment', () => {
  it('isWithin distinguishes siblings, parents, and "..name" children', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b', '/a/b/..c')).toBe(true);
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/x/y')).toBe(false);
  });

  it('safeFileSegment strips separators and reserved characters', () => {
    expect(safeFileSegment('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe('a b c d e f g h i j k l m n');
    expect(safeFileSegment('...hidden')).toBe('hidden');
    expect(safeFileSegment('   ')).toBe('untitled');
    expect(safeFileSegment('x'.repeat(300)).length).toBe(120);
    expect(safeFileSegment('tab\tnewline\n')).toBe('tab newline');
  });

  it('safeFileSegment never returns a hidden (dot-prefixed) name, even after separators collapse (A9-03)', () => {
    expect(safeFileSegment('. . . x')).toBe('x');
    expect(safeFileSegment('../../../../../x')).toBe('x');
    expect(safeFileSegment('.. .. .. x')).toBe('x');
    expect(safeFileSegment(' .\u200B. x')).toBe('x');
    expect(safeFileSegment('. . .')).toBe('untitled');
    expect(safeFileSegment('a\u0085b')).toBe('a b');
  });
});
