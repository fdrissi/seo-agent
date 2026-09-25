import os from 'node:os';
import { AppError } from '../core/errors.js';

/**
 * Human approver identity. Approvals are decided only through the CLI by a
 * named human: `--as <name>` or, when omitted, the operating-system user who
 * runs the command.
 *
 * The name is ASSERTED, not authenticated: whoever runs the CLI can type any
 * name. The checks below only refuse names that obviously denote automation
 * or an anonymous account, so an unattended process that passes its own
 * identity (system, scheduler, claude, agent007, the container user `node`,
 * a CI `runner`, ...) or no identity at all cannot record a "human" decision
 * by accident. They are not an access control:
 *
 * - normalized with NFKC first (fullwidth and other compatibility forms such
 *   as fullwidth "claude", U+FF43 U+FF4C ..., become "claude") and refused
 *   when the letters mix scripts (Latin with Cyrillic or Greek, as in
 *   "claude" spelled with a Cyrillic capital Es, U+0421); a small
 *   confusables skeleton (Cyrillic, Greek, and small-capital look-alikes, marks
 *   removed) is checked as well;
 * - automation words are refused as whole separator-delimited tokens (space,
 *   dot, underscore, @, dash, and apostrophe separate tokens, so "claude's" is
 *   refused); short words (ai, gpt, bot, job, cli) only ever as whole tokens,
 *   so real names such as Kai or Abbott stay valid;
 * - a few distinctive automation words of five or more letters (claude,
 *   anthropic, openai, chatgpt, codex, copilot, seoagent, githubactions) are
 *   also refused inside a word once separators are removed ("claudecode",
 *   "SeoAgent"), and so is "agent" followed by digits ("agent007");
 * - generic account and role names (owner, admin, root, node, runner, user,
 *   ...) are refused as the whole name;
 * - `resolveApprover` refuses a service-account operating-system user (the
 *   Docker image runs as `node`, GitHub-hosted CI as `runner`) instead of
 *   recording it: pass `--as "<your name>"`.
 */

/** Automation identities refused as a whole separator-delimited token (never as a substring). */
const RESERVED = new Set([
  'system',
  'scheduler',
  'cron',
  'cli',
  'job',
  'jobs',
  'worker',
  'automation',
  'automated',
  'auto',
  'bot',
  'robot',
  'llm',
  'model',
  'ai',
  'agent',
  'assistant',
  'claude',
  'gpt',
  'chatgpt',
  'openai',
  'anthropic',
  'codex',
  'copilot',
  'gateway',
  'seo-agent',
  'seo_agent',
  'unknown',
  'anonymous',
  'nobody',
  'none',
  'null',
  'undefined',
]);

/** Generic account and role names refused as the WHOLE name (case-insensitive): they name no person. */
const RESERVED_WHOLE_NAMES = ['owner', 'admin', 'administrator', 'root', 'node', 'runner', 'daemon', 'www-data', 'ubuntu', 'ec2-user', 'service', 'user', 'default'] as const;

/**
 * Distinctive automation words (five letters or more) refused anywhere in the
 * name once separators are removed ("claudecode", "seoagent"). Short words
 * (ai, gpt, bot, job, cli) are never matched inside a word: that would refuse
 * real names such as Kai or Abbott.
 */
const AUTOMATION_SUBSTRINGS = ['claude', 'anthropic', 'openai', 'chatgpt', 'codex', 'copilot', 'seoagent', 'githubactions'] as const;

/**
 * Given names that contain an automation word but denote a person
 * ("Claudette"). A whole token equal to one of them is left out of the
 * substring check only; it is still checked as a token.
 */
const GIVEN_NAMES_CONTAINING_AUTOMATION_WORDS = new Set(['claudette', 'claudel', 'claudelle', 'claudene', 'claudean']);

/** A whole token made of an automation word followed by a version or number ("gpt4o", "bot2", "agent007"). */
const AUTOMATION_TOKEN_RE = /^(?:gpt|llm|bot|agent|ai|model|claude|worker|job|cron)\d[a-z0-9]*$/;

/** Operating-system users that are service accounts, never a person (container, CI, and system users). */
const SERVICE_ACCOUNTS = new Set(['node', 'runner', 'root', 'daemon', 'www-data', 'ubuntu', 'ec2-user', 'nobody']);

const SEPARATORS_RE = /[\s._@'-]+/g;

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._@'-]{0,79}$/u;

/**
 * Scripts told apart by the mixed-script check. A letter in any other script
 * counts as "Other", so it cannot be mixed with Latin either.
 */
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Cherokee', 'Coptic', 'Lisu', 'Canadian_Aboriginal', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Bopomofo', 'Hebrew', 'Arabic', 'Devanagari', 'Thai'] as const;
const SCRIPT_RES = SCRIPTS.map((s) => [s, new RegExp(`^\\p{Script=${s}}$`, 'u')] as const);

/**
 * Script combinations that are one writing system (Unicode UTS #39 "highly
 * restrictive"): Japanese mixes Han, Hiragana, and Katakana; Chinese uses
 * Bopomofo; Korean mixes Hangul and Han; each may appear with Latin.
 */
const ALLOWED_SCRIPT_SETS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['Latin', 'Han', 'Hiragana', 'Katakana']),
  new Set(['Latin', 'Han', 'Bopomofo']),
  new Set(['Latin', 'Han', 'Hangul']),
];

/**
 * Look-alike letters mapped to the Latin letter they imitate (applied after
 * lowercasing and removing combining marks). A small curated subset of the
 * Unicode confusables: Cyrillic, Greek, Armenian, and Latin small capitals.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  '\u0430': 'a', '\u0432': 'b', '\u0441': 'c', '\u0501': 'd', '\u0435': 'e', '\u0433': 'r', '\u04bb': 'h', '\u043d': 'h', '\u0456': 'i', '\u0458': 'j', '\u043a': 'k', '\u04cf': 'l', '\u043c': 'm', '\u043f': 'n', '\u0438': 'u', '\u043e': 'o', '\u0440': 'p', '\u051b': 'q', '\u0455': 's', '\u0442': 't', '\u0443': 'y', '\u04af': 'y', '\u051d': 'w', '\u0445': 'x',
  // Greek
  '\u03b1': 'a', '\u03b2': 'b', '\u03f2': 'c', '\u03b5': 'e', '\u03b7': 'n', '\u03b9': 'i', '\u03ba': 'k', '\u03bc': 'u', '\u03bd': 'v', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x', '\u03b3': 'y', '\u03c9': 'w', '\u03b6': 'z',
  // Armenian
  '\u0585': 'o', '\u057d': 'u', '\u0578': 'n', '\u0570': 'h', '\u0581': 'g', '\u0566': 'q',
  // Latin small capitals and dotless i
  '\u0131': 'i', '\u0269': 'i', '\u0251': 'a', '\u0261': 'g', '\u1d00': 'a', '\u0299': 'b', '\u1d04': 'c', '\u1d05': 'd', '\u1d07': 'e', '\ua730': 'f', '\u0262': 'g', '\u029c': 'h', '\u026a': 'i', '\u1d0a': 'j', '\u1d0b': 'k', '\u029f': 'l', '\u1d0d': 'm', '\u0274': 'n', '\u1d0f': 'o', '\u1d18': 'p', '\u0280': 'r', '\ua731': 's', '\u1d1b': 't', '\u1d1c': 'u', '\u1d20': 'v', '\u1d21': 'w', '\u028f': 'y', '\u1d22': 'z',
};

/** Lowercase, drop combining marks, and map look-alike letters to Latin. */
function skeleton(lower: string): string {
  return [...lower.normalize('NFD').replace(/\p{M}+/gu, '')].map((ch) => CONFUSABLES[ch] ?? ch).join('');
}

/** The scripts of the letters in `n` (digits, spaces, and punctuation have none). */
function letterScripts(n: string): Set<string> {
  const found = new Set<string>();
  for (const ch of n) {
    if (!/\p{L}/u.test(ch)) continue;
    const hit = SCRIPT_RES.find(([, re]) => re.test(ch));
    found.add(hit ? hit[0] : 'Other');
  }
  return found;
}

function mixesScripts(scripts: Set<string>): boolean {
  if (scripts.size <= 1) return false;
  return !ALLOWED_SCRIPT_SETS.some((allowed) => [...scripts].every((s) => allowed.has(s)));
}

const stripSeparators = (s: string) => s.replace(SEPARATORS_RE, '');
const RESERVED_WHOLE = new Set<string>([...RESERVED_WHOLE_NAMES, ...RESERVED_WHOLE_NAMES.map(stripSeparators)]);

/** Why `form` (a lowercased name or its skeleton) denotes automation or an account, or null. */
function reservedReason(form: string): 'automation' | 'account' | null {
  const tokens = form.split(SEPARATORS_RE).filter(Boolean);
  if (RESERVED.has(form) || tokens.some((t) => RESERVED.has(t) || AUTOMATION_TOKEN_RE.test(t)) || /^(owner:)?(system|scheduler)/.test(form)) return 'automation';
  const joined = tokens.filter((t) => !GIVEN_NAMES_CONTAINING_AUTOMATION_WORDS.has(t)).join('');
  if (AUTOMATION_SUBSTRINGS.some((w) => joined.includes(w)) || /agent\d/.test(stripSeparators(form))) return 'automation';
  if (RESERVED_WHOLE.has(form) || RESERVED_WHOLE.has(stripSeparators(form))) return 'account';
  return null;
}

export function validateApproverName(name: string | undefined | null): string {
  const n = (name ?? '').normalize('NFKC').trim();
  if (!n) throw new AppError('VALIDATION_FAILED', 'An explicit human approver name is required.', { hint: 'Pass --as "<your name>" (defaults to your operating-system user).' });
  if (!NAME_RE.test(n)) throw new AppError('VALIDATION_FAILED', `Approver name "${n}" contains unsupported characters.`, { hint: 'Use letters, digits, spaces, dot, dash, underscore, apostrophe, or @ (max 80 chars).' });
  const scripts = letterScripts(n);
  if (mixesScripts(scripts)) {
    throw new AppError('VALIDATION_FAILED', `Approver name "${n}" mixes letters from different scripts (${[...scripts].sort().join(', ')}); look-alike names are refused.`, {
      hint: 'Write your name in one script.',
    });
  }
  const lower = n.toLowerCase();
  const reason = reservedReason(lower) ?? reservedReason(skeleton(lower));
  if (reason === 'automation') {
    throw new AppError('VALIDATION_FAILED', `"${n}" is reserved for automation and cannot approve or reject anything.`, { hint: 'Approvals must be decided by a named human.' });
  }
  if (reason === 'account') {
    throw new AppError('VALIDATION_FAILED', `"${n}" is reserved for automation and service accounts (a generic account or role name, not a person) and cannot approve or reject anything.`, {
      hint: 'Approvals must be decided by a named human: pass --as "<your name>".',
    });
  }
  return n;
}

const OS_USER_HINT = 'Pass --as "<your name>" (vault apply-business: --by "<your name>"); the operating-system user of a container or CI runner is not a person.';

/**
 * `--as` flag, else the OS user. Validated as a human name. A service-account
 * OS user (node, runner, root, ...) is refused rather than recorded as the
 * deciding human.
 */
export function resolveApprover(asFlag: string | undefined | null, osUser: () => string = defaultOsUser): string {
  if (asFlag !== undefined && asFlag !== null && asFlag !== '') return validateApproverName(asFlag);
  let user = '';
  try {
    user = osUser();
  } catch {
    user = '';
  }
  const shown = user.normalize('NFKC').trim();
  if (SERVICE_ACCOUNTS.has(shown.toLowerCase())) {
    throw new AppError('VALIDATION_FAILED', `The operating-system user "${shown}" is a service account, not a named human, and cannot approve or reject anything.`, { hint: OS_USER_HINT });
  }
  try {
    return validateApproverName(user);
  } catch (err) {
    if (err instanceof AppError && shown) throw new AppError(err.code, err.message, { hint: OS_USER_HINT, ...(err.details ? { details: err.details } : {}) });
    throw err;
  }
}

function defaultOsUser(): string {
  return os.userInfo().username;
}

/** Audit actor string for a human. */
export function ownerActor(name: string): string {
  return `owner:${name}`;
}
