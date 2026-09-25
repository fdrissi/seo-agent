import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/**
 * Prompt IO for the setup wizard. The wizard only talks to this interface, so
 * tests drive it with a scripted implementation and the CLI uses the terminal
 * one (node:readline/promises).
 *
 * Secrets are read with `askSecret`: the typed characters are never echoed,
 * never added to readline history, and never returned to any transcript.
 */

export interface PromptMeta {
  /** Stable key of the question (e.g. "site.url", "conversions.primaryEvents[0].name"). */
  key: string;
}

export interface PromptIO {
  /** Informational output. Callers never pass secret values here. */
  print(text: string): void;
  /** One visible line of input. Rejects with SetupInterruptedError on EOF or Ctrl+C. */
  ask(question: string, meta: PromptMeta): Promise<string>;
  /** One hidden line of input (not echoed). Rejects with SetupInterruptedError on EOF or Ctrl+C. */
  askSecret(question: string, meta: PromptMeta): Promise<string>;
  close(): void;
}

/** The wizard was interrupted (Ctrl+C, end of input, or a scripted stop). Progress up to the last answer is saved. */
export class SetupInterruptedError extends Error {
  constructor(message = 'Setup was interrupted.') {
    super(message);
    this.name = 'SetupInterruptedError';
  }
}

/** Output stream wrapper that can be muted while a secret is typed. */
class MutableOutput extends Writable {
  muted = false;
  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }
  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) {
      if (typeof chunk === 'string') this.target.write(chunk, encoding);
      else this.target.write(chunk);
    }
    callback();
  }
}

export interface TerminalPromptOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Terminal prompt IO. Lines are queued, so piped input (one answer per line)
 * works as well as an interactive terminal. While a secret is read, the
 * output stream readline echoes into is muted.
 */
export function createTerminalPromptIO(opts: TerminalPromptOptions = {}): PromptIO {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const muted = new MutableOutput(output);
  const terminal = Boolean((input as { isTTY?: boolean }).isTTY && (output as { isTTY?: boolean }).isTTY);
  const rl = createInterface({ input, output: muted, terminal, historySize: 0 });
  const lines: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  let closed = false;
  rl.on('line', (line) => {
    const w = waiters.shift();
    if (w) w.resolve(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const w of waiters.splice(0)) w.reject(new SetupInterruptedError());
  });
  // Ctrl+C: stop the wizard cleanly; answers given so far are already saved.
  rl.on('SIGINT', () => rl.close());

  const nextLine = (): Promise<string> => {
    if (lines.length) return Promise.resolve(lines.shift()!);
    if (closed) return Promise.reject(new SetupInterruptedError());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  return {
    print(text: string) {
      output.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    ask(question: string) {
      if (closed) return Promise.reject(new SetupInterruptedError());
      rl.setPrompt(question);
      rl.prompt();
      return nextLine();
    },
    async askSecret(question: string) {
      if (closed) throw new SetupInterruptedError();
      output.write(question);
      rl.setPrompt('');
      muted.muted = true;
      try {
        rl.prompt();
        return await nextLine();
      } finally {
        muted.muted = false;
        output.write('\n');
      }
    },
    close() {
      if (!closed) rl.close();
    },
  };
}

export type ScriptedAnswer = string | string[];

export interface ScriptedPromptOptions {
  /** Answer used for keys missing from the script: '' (accept the default) or 'interrupt' (simulate Ctrl+C). */
  fallback?: 'default' | 'interrupt';
  /** Simulate an interruption when this key is asked (before answering it). */
  interruptAt?: string;
}

/**
 * Deterministic prompt IO for tests and embedding. Answers are looked up by
 * the question key; an array answers repeated questions with the same key in
 * order (for example re-prompts after invalid input). Hidden answers are
 * never written to the transcript.
 */
export class ScriptedPromptIO implements PromptIO {
  readonly transcript: string[] = [];
  readonly asked: Array<{ key: string; question: string; hidden: boolean }> = [];
  private readonly answers = new Map<string, string[]>();
  private readonly fallback: 'default' | 'interrupt';
  private readonly interruptAt: string | undefined;

  constructor(answers: Record<string, ScriptedAnswer> = {}, opts: ScriptedPromptOptions = {}) {
    for (const [k, v] of Object.entries(answers)) this.answers.set(k, Array.isArray(v) ? [...v] : [v]);
    this.fallback = opts.fallback ?? 'default';
    this.interruptAt = opts.interruptAt;
  }

  print(text: string): void {
    this.transcript.push(text);
  }

  private next(key: string): string {
    if (this.interruptAt === key) throw new SetupInterruptedError(`Scripted interruption at ${key}`);
    const queue = this.answers.get(key);
    if (queue && queue.length) {
      const v = queue.length > 1 ? queue.shift()! : queue[0]!;
      return v;
    }
    if (this.fallback === 'interrupt') throw new SetupInterruptedError(`No scripted answer for ${key}`);
    return '';
  }

  async ask(question: string, meta: PromptMeta): Promise<string> {
    this.asked.push({ key: meta.key, question, hidden: false });
    this.transcript.push(question);
    const answer = this.next(meta.key);
    this.transcript.push(answer);
    return answer;
  }

  async askSecret(question: string, meta: PromptMeta): Promise<string> {
    this.asked.push({ key: meta.key, question, hidden: true });
    this.transcript.push(question);
    const answer = this.next(meta.key);
    this.transcript.push('[hidden input]');
    return answer;
  }

  close(): void {
    /* nothing to release */
  }

  /** Keys asked so far (in order). */
  keys(): string[] {
    return this.asked.map((a) => a.key);
  }

  output(): string {
    return this.transcript.join('\n');
  }
}
