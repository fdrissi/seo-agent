import { describe, expect, it } from 'vitest';
import { resolveApprover, validateApproverName } from '../../../src/approvals/approver.js';
import { DEMO_APPROVER } from '../../../src/demo/index.js';

const refused = (n: string) => expect(() => validateApproverName(n), n).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

describe('human approver identity', () => {
  it('accepts human names and defaults to the OS user', () => {
    expect(validateApproverName(' Alice Example ')).toBe('Alice Example');
    expect(validateApproverName("o'neil.test")).toBe("o'neil.test");
    expect(resolveApprover(undefined, () => 'alice')).toBe('alice');
    expect(resolveApprover('Bob', () => 'alice')).toBe('Bob');
  });

  it('refuses automation identities', () => {
    for (const n of ['system', 'scheduler', 'LLM', 'model', 'agent', 'AI assistant', 'seo-agent', 'claude', 'gpt', 'owner:system', 'bot', 'cron']) {
      expect(() => validateApproverName(n)).toThrow();
    }
  });

  it('refuses empty or malformed names', () => {
    expect(() => validateApproverName('')).toThrow(/explicit human approver/);
    expect(() => resolveApprover(undefined, () => '')).toThrow();
    expect(() => validateApproverName('<script>')).toThrow();
    expect(() => validateApproverName('a'.repeat(200))).toThrow();
  });
});

describe('approver names are asserted, so obvious automation and account names are refused (D3-01)', () => {
  it('refuses the anonymous "owner" and generic account or role names as the whole name, in any case', () => {
    for (const n of ['owner', 'Owner', 'OWNER', ' owner ', 'owner:owner', 'admin', 'Administrator', 'root', 'Root', 'node', 'runner', 'daemon', 'www-data', 'www_data', 'ubuntu', 'ec2-user', 'service', 'user', 'User', 'default']) refused(n);
    expect(() => validateApproverName('owner')).toThrow(/generic account or role name/);
    // Only the whole name: a person whose name contains such a word is still accepted.
    expect(validateApproverName('Test Owner')).toBe('Test Owner');
    expect(validateApproverName('Rootham')).toBe('Rootham');
    expect(validateApproverName('Node Tester')).toBe('Node Tester');
  });

  it('normalizes with NFKC and refuses mixed-script and look-alike names', () => {
    // Fullwidth "claude" is "claude" after NFKC.
    expect(() => validateApproverName('\uff43\uff4c\uff41\uff55\uff44\uff45')).toThrow(/"claude" is reserved for automation/);
    // Mathematical bold "root" is "root" after NFKC.
    refused('\u{1d42b}\u{1d428}\u{1d428}\u{1d42d}');
    // Cyrillic capital Es (U+0421) in front of Latin "laude": two scripts.
    expect(() => validateApproverName('\u0421laude')).toThrow(/mixes letters from different scripts \(Cyrillic, Latin\)/);
    // Greek epsilon in "system", Cyrillic o in "owner".
    refused('syst\u03b5m');
    refused('\u043ewner');
    // An all-Cyrillic look-alike is caught by the confusables skeleton.
    refused('\u0441\u043e\u0440\u0456\u04cf\u043e\u0442'); // "copilot"
    // Accents do not hide a reserved word.
    refused('Cl\u00e0ude');
    refused('R\u00f6\u00f6t');
  });

  it('refuses automation words inside concatenated names, with apostrophes, and with version numbers', () => {
    for (const n of ['claudecode', 'ClaudeCode', 'Claude.Code', 'seoagent', 'SeoAgent', 'myclaude', 'anthropic-team', 'OpenAI', 'chatgpt4', 'codex-runner', 'GitHubActions', 'github-actions', 'agent007', 'Agent 007', 'agent_7', 'gpt4o', 'bot2', "claude's", "Claude's review"]) refused(n);
  });

  it('keeps real names valid: short words are never matched inside a word', () => {
    for (const n of ['Alice', 'Kai', 'Abbott', 'Jobson', 'Cliff', 'Botha', 'Aiden', 'José', "O'Brien", "D'Angelo", 'Claudette Colbert', 'Claudia', 'Agenta', 'Magenta Smith', 'Test Owner', 'Mary-Jane Watson', 'Анна Иванова', '山田 はなこ', 'Wang 王', 'Νίκος']) {
      expect(validateApproverName(n), n).toBe(n.normalize('NFKC'));
    }
    // The demo persona (synthetic) stays valid.
    expect(validateApproverName(DEMO_APPROVER)).toBe('Demo Approver - synthetic persona');
  });

  it('records the NFKC form of the name', () => {
    expect(validateApproverName('\uff21lice')).toBe('Alice');
    expect(validateApproverName('Jose\u0301')).toBe('Jos\u00e9');
  });
});

describe('resolveApprover refuses a service-account operating-system user (D3-01)', () => {
  it('refuses node, runner, root, daemon, www-data, ubuntu, ec2-user, and nobody without --as, and names --as in the hint', () => {
    for (const u of ['node', 'runner', 'root', 'daemon', 'www-data', 'ubuntu', 'ec2-user', 'nobody', 'Runner']) {
      expect(() => resolveApprover(undefined, () => u), u).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/is a service account, not a named human/), hint: expect.stringMatching(/Pass --as "<your name>"/) }),
      );
      expect(() => resolveApprover('', () => u), u).toThrow(/service account/);
    }
    // An explicit --as is what such an environment must pass; it is validated as usual.
    expect(resolveApprover('Alice', () => 'node')).toBe('Alice');
    expect(() => resolveApprover('node', () => 'alice')).toThrow(/generic account or role name/);
  });

  it('an OS user refused for another reason also points to --as; a failing user lookup is an empty name', () => {
    expect(() => resolveApprover(undefined, () => 'admin')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', hint: expect.stringMatching(/Pass --as "<your name>"/) }));
    expect(() => resolveApprover(undefined, () => 'claude')).toThrow(/reserved for automation/);
    expect(() =>
      resolveApprover(undefined, () => {
        throw new Error('no passwd entry');
      }),
    ).toThrow(/explicit human approver name is required/);
    expect(resolveApprover(undefined, () => 'alice-dev')).toBe('alice-dev');
  });
});
