import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { isWithin, safeResolve } from '../security/paths.js';
import { VAULT_FOLDERS } from './types.js';

/**
 * Filesystem safety for the vault.
 *
 * - Every path is vault-relative POSIX, validated, and resolved with
 *   `safeResolve` (rejects absolute paths, `..`, NUL, symlink escapes).
 * - In addition, NO component inside the vault may be a symlink, and every
 *   parent must be a real directory (checked with lstat on each component).
 * - Writes are atomic: temp file in the same directory + fsync + rename (or a
 *   hard link for create-only writes, which fails instead of overwriting).
 *   A failure at any step removes the temp file and leaves the target intact.
 */

export type PathPurpose = 'generated' | 'read' | 'link' | 'system';

const FIRST_SEGMENTS = new Set(VAULT_FOLDERS.map((f) => f.split('/')[0]!));
/** Top-level folders the generator may never write into. */
export const HUMAN_ONLY_FOLDERS: ReadonlySet<string> = new Set(['01 Business', 'Templates']);
const SYSTEM_FOLDER = '14 System Logs';

/** Validate a vault-relative note path. Returns the normalized POSIX path. */
export function validateVaultRelPath(relPath: string, purpose: PathPurpose, opts: { requireMd?: boolean } = {}): string {
  if (typeof relPath !== 'string' || relPath.length === 0) throw new AppError('UNSAFE_PATH', 'Empty vault path');
  if (relPath.includes('\0')) throw new AppError('UNSAFE_PATH', 'Vault path contains a NUL byte');
  if (relPath.includes('\\')) throw new AppError('UNSAFE_PATH', `Vault paths use forward slashes only: ${JSON.stringify(relPath)}`);
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) throw new AppError('UNSAFE_PATH', `Absolute paths are not allowed in the vault: ${JSON.stringify(relPath)}`);
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') throw new AppError('UNSAFE_PATH', `Path traversal or empty segment in vault path: ${JSON.stringify(relPath)}`);
    if (seg.startsWith('.')) throw new AppError('UNSAFE_PATH', `Hidden files and folders (such as .obsidian) are never written: ${JSON.stringify(relPath)}`);
    if (/[\u0000-\u001f]/.test(seg)) throw new AppError('UNSAFE_PATH', `Control characters in vault path: ${JSON.stringify(relPath)}`);
  }
  if (relPath.length > 400) throw new AppError('UNSAFE_PATH', 'Vault path is too long');
  if ((opts.requireMd ?? purpose !== 'read') && !relPath.toLowerCase().endsWith('.md')) {
    throw new AppError('UNSAFE_PATH', `Vault notes must be Markdown files ending in .md: ${JSON.stringify(relPath)}`);
  }
  if (purpose === 'generated' || purpose === 'system') {
    if (/[[\]|#^]|%%/.test(relPath)) throw new AppError('UNSAFE_PATH', `Characters that break wikilinks are not allowed in generated note paths: ${JSON.stringify(relPath)}`);
    const first = segments[0]!;
    if (segments.length < 2 || !FIRST_SEGMENTS.has(first)) {
      throw new AppError('UNSAFE_PATH', `Generated notes must live inside a standard vault folder (${[...FIRST_SEGMENTS].join(', ')}): ${JSON.stringify(relPath)}`);
    }
    if (HUMAN_ONLY_FOLDERS.has(first)) {
      throw new AppError('POLICY_DENIED', `"${first}" is human-maintained; seo-agent never writes generated notes there: ${JSON.stringify(relPath)}`);
    }
    if (purpose === 'generated' && first === SYSTEM_FOLDER) {
      throw new AppError('POLICY_DENIED', `"${SYSTEM_FOLDER}" is append-only; use appendSystemLog: ${JSON.stringify(relPath)}`);
    }
  }
  return relPath;
}

export function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Ensure the vault root for a site exists as a real directory (not a symlink).
 * `vaultRoot` is the workspace `vault/` directory; `vaultDir` must be inside it.
 */
export function ensureVaultDir(vaultRoot: string, vaultDir: string, create: boolean): void {
  if (!isWithin(path.resolve(vaultRoot), path.resolve(vaultDir))) throw new AppError('UNSAFE_PATH', `Vault directory is outside the workspace vault root: ${vaultDir}`);
  if (create) mkdirSync(vaultRoot, { recursive: true, mode: 0o700 });
  const rootStat = lstatOrNull(vaultRoot);
  if (rootStat && rootStat.isSymbolicLink()) throw new AppError('UNSAFE_PATH', `The workspace vault root is a symlink; refusing to write: ${vaultRoot}`);
  const st = lstatOrNull(vaultDir);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new AppError('UNSAFE_PATH', `Site vault path is not a real directory: ${vaultDir}`);
    return;
  }
  if (create) {
    try {
      mkdirSync(vaultDir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const again = lstatSync(vaultDir);
    if (again.isSymbolicLink() || !again.isDirectory()) throw new AppError('UNSAFE_PATH', `Site vault path is not a real directory: ${vaultDir}`);
  }
}

/**
 * Resolve a validated vault-relative path to an absolute path, checking every
 * existing component with lstat: parents must be real directories, nothing may
 * be a symlink. With `createParents`, missing parent directories are created
 * one component at a time (re-checked after creation).
 */
export function resolveInVault(vaultDir: string, relPath: string, opts: { createParents: boolean }): string {
  const abs = safeResolve(vaultDir, relPath);
  const base = path.resolve(vaultDir);
  if (!isWithin(base, abs) || abs === base) throw new AppError('UNSAFE_PATH', `Path escapes the vault: ${JSON.stringify(relPath)}`);
  const segments = relPath.split('/');
  let current = base;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]!);
    const st = lstatOrNull(current);
    if (st) {
      if (st.isSymbolicLink()) throw new AppError('UNSAFE_PATH', `Refusing to write through a symlinked folder in the vault: ${segments.slice(0, i + 1).join('/')}`);
      if (!st.isDirectory()) throw new AppError('UNSAFE_PATH', `A vault path component is not a directory: ${segments.slice(0, i + 1).join('/')}`);
      continue;
    }
    if (!opts.createParents) continue;
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const created = lstatSync(current);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new AppError('UNSAFE_PATH', `A vault path component is not a real directory: ${segments.slice(0, i + 1).join('/')}`);
  }
  const leaf = lstatOrNull(abs);
  if (leaf && leaf.isSymbolicLink()) throw new AppError('UNSAFE_PATH', `Refusing to read or write a symlinked note: ${JSON.stringify(relPath)}`);
  if (leaf && !leaf.isFile()) throw new AppError('UNSAFE_PATH', `Vault path is not a regular file: ${JSON.stringify(relPath)}`);
  // Final belt-and-braces check of the real parent location.
  const parent = path.dirname(abs);
  if (existsSync(parent)) {
    const realParent = realpathSync(parent);
    const realBase = realpathSync(base);
    if (!isWithin(realBase, realParent)) throw new AppError('UNSAFE_PATH', `Path resolves outside the vault: ${JSON.stringify(relPath)}`);
  }
  return abs;
}

/** Read a regular file inside the vault (no symlinks). Returns null when missing. */
export function readVaultFile(vaultDir: string, relPath: string): string | null {
  const abs = resolveInVault(vaultDir, relPath, { createParents: false });
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

export class ConcurrentModificationError extends AppError {
  constructor(file: string) {
    super('CONFLICT', `File changed on disk while it was being updated: ${file}`);
    this.name = 'ConcurrentModificationError';
  }
}

export interface AtomicWriteHooks {
  /** Called after the temp file is written and fsynced, before commit (tests inject failures here). */
  afterTempWrite?: (tmpPath: string) => void;
  /** Called right after the new content is in place, before returning (tests simulate a crash after the rename here). */
  afterCommit?: (absPath: string) => void;
}

export interface AtomicWriteOptions {
  mode?: number;
  /** Fail (EEXIST) instead of replacing an existing file. */
  noOverwrite?: boolean;
  /** When set, the current file content must equal this string at commit time (optimistic concurrency). */
  expectedCurrent?: string;
  hooks?: AtomicWriteHooks;
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* not supported on every platform/filesystem; the rename itself is still atomic */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Atomic write: temp file (same dir) + fsync + rename/link. Never leaves a partial target. */
export function atomicWriteFile(absPath: string, content: string, opts: AtomicWriteOptions = {}): void {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmp, 'wx', opts.mode ?? 0o600);
  let committed = false;
  try {
    try {
      const buf = Buffer.from(content, 'utf8');
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    opts.hooks?.afterTempWrite?.(tmp);
    if (opts.expectedCurrent !== undefined) {
      const current = existsSync(absPath) ? readFileSync(absPath, 'utf8') : null;
      if (current !== opts.expectedCurrent) throw new ConcurrentModificationError(absPath);
    }
    if (opts.noOverwrite) {
      try {
        linkSync(tmp, absPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw new AppError('CONFLICT', `Refusing to overwrite existing file: ${absPath}`);
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw err;
        // Filesystem without hard links: best-effort create-only rename.
        if (existsSync(absPath)) throw new AppError('CONFLICT', `Refusing to overwrite existing file: ${absPath}`);
        renameSync(tmp, absPath);
        committed = true;
      }
      if (!committed) {
        committed = true;
        unlinkSync(tmp);
      }
    } else {
      renameSync(tmp, absPath);
      committed = true;
    }
    fsyncDir(dir);
    opts.hooks?.afterCommit?.(absPath);
  } finally {
    if (!committed || existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Append one chunk to a file (O_APPEND) and fsync. The file must be a regular file (no symlink). */
export function appendDurable(absPath: string, content: string): void {
  const st = lstatOrNull(absPath);
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new AppError('UNSAFE_PATH', `Refusing to append to a non-regular file: ${absPath}`);
  const fd = openSync(absPath, 'a', 0o600);
  try {
    const buf = Buffer.from(content, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** List temp files left in a directory (used by tests and `vault check`). */
export function listTempFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\..+\.tmp-\d+-[0-9a-f]+$/.test(f));
}
