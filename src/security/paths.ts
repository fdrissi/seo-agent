import { lstatSync, readlinkSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';

/** lstat-based existence: true for dangling symlinks too (existsSync follows links). */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `relative` inside `base`, rejecting absolute paths, `..` traversal,
 * NUL bytes, and symlinks that escape the base directory. Used for every vault,
 * export, raw-store, and workspace write.
 *
 * Dangling symlinks anywhere between the base and the target are rejected:
 * writing through one would create a file wherever the link points.
 */
export function safeResolve(base: string, relative: string): string {
  if (relative.includes('\0')) throw new AppError('UNSAFE_PATH', 'Path contains a NUL byte');
  if (path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative)) {
    throw new AppError('UNSAFE_PATH', `Absolute paths are not allowed here: ${relative}`);
  }
  const baseAbs = path.resolve(base);
  const target = path.resolve(baseAbs, relative);
  if (!isWithin(baseAbs, target)) throw new AppError('UNSAFE_PATH', `Path escapes its base directory: ${relative}`);

  // Symlink escape check: walk existing ancestors and compare real paths.
  const baseReal = existsSync(baseAbs) ? realpathSync(baseAbs) : baseAbs;
  let probe = target;
  while (!lexists(probe) && probe !== baseAbs && probe !== path.dirname(probe)) probe = path.dirname(probe);
  if (lexists(probe)) {
    if (!existsSync(probe)) {
      // The deepest existing entry is a symlink whose target does not exist.
      const linkTarget = path.resolve(path.dirname(probe), readlinkSync(probe));
      throw new AppError('UNSAFE_PATH', `Refusing to write through a dangling symlink (${path.relative(baseAbs, probe) || '.'} -> ${linkTarget}): ${relative}`);
    }
    const real = realpathSync(probe);
    if (!isWithin(baseReal, real)) throw new AppError('UNSAFE_PATH', `Path resolves outside its base via a symlink: ${relative}`);
  }
  if (lexists(target) && lstatSync(target).isSymbolicLink()) {
    const real = realpathSync(target);
    if (!isWithin(baseReal, real)) throw new AppError('UNSAFE_PATH', `Refusing to follow a symlink out of the base: ${relative}`);
  }
  return target;
}

export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  // "..foo" is a legitimate child name; only ".." itself or "../..." escapes.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * File-name-safe segment (no separators, no reserved or invisible characters,
 * never a hidden name). Leading dots and whitespace are stripped until none
 * remain AFTER separators collapse to spaces, so untrusted names such as
 * ". . . x", "../../../../../x", or ".. .. .. x" become "x" instead of a
 * hidden (dot-prefixed) file.
 */
export function safeFileSegment(name: string, maxLength = 120): string {
  const cleaned = String(name ?? '')
    .normalize('NFC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, maxLength)
    .trim();
  return cleaned || 'untitled';
}
