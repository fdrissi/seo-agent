import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ScriptedPromptIO, SetupInterruptedError, createTerminalPromptIO } from '../../../src/setup/prompt-io.js';

const SECRET = 'sk-synthetic-hidden-input-7c6b5a';

function streams(tty: boolean) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (d: Buffer) => (written += d.toString('utf8')));
  if (tty) {
    Object.assign(input, { isTTY: true, setRawMode: () => input });
    Object.assign(output, { isTTY: true, columns: 80 });
  }
  return { input, output, written: () => written };
}

describe('terminal prompt IO', () => {
  it('queues piped lines so every question gets its own answer', async () => {
    const s = streams(false);
    const io = createTerminalPromptIO({ input: s.input, output: s.output });
    s.input.write('first\nsecond\n');
    expect(await io.ask('Q1: ', { key: 'a' })).toBe('first');
    expect(await io.ask('Q2: ', { key: 'b' })).toBe('second');
    io.close();
  });

  it('never echoes a secret typed in an interactive terminal', async () => {
    const s = streams(true);
    const io = createTerminalPromptIO({ input: s.input, output: s.output });
    const visible = io.ask('Name: ', { key: 'name' });
    s.input.write('visible-answer\r');
    expect(await visible).toBe('visible-answer');
    const hidden = io.askSecret('API key (input hidden): ', { key: 'secret' });
    for (const ch of SECRET) s.input.write(ch);
    s.input.write('\r');
    expect(await hidden).toBe(SECRET);
    io.close();
    await new Promise((r) => setImmediate(r));
    expect(s.written()).toContain('API key (input hidden): ');
    expect(s.written()).toContain('visible-answer');
    expect(s.written()).not.toContain(SECRET);
    expect(s.written()).not.toContain(SECRET.slice(0, 6));
  });

  it('end of input (Ctrl+D / closed pipe) interrupts the pending question', async () => {
    const s = streams(false);
    const io = createTerminalPromptIO({ input: s.input, output: s.output });
    const pending = io.ask('Q: ', { key: 'q' });
    s.input.end();
    await expect(pending).rejects.toBeInstanceOf(SetupInterruptedError);
    await expect(io.ask('again: ', { key: 'q2' })).rejects.toBeInstanceOf(SetupInterruptedError);
  });
});

describe('scripted prompt IO', () => {
  it('answers by key, repeats the last answer, and keeps hidden answers out of the transcript', async () => {
    const io = new ScriptedPromptIO({ a: ['bad', 'good'], s: SECRET });
    expect(await io.ask('A? ', { key: 'a' })).toBe('bad');
    expect(await io.ask('A? ', { key: 'a' })).toBe('good');
    expect(await io.ask('A? ', { key: 'a' })).toBe('good');
    expect(await io.ask('unknown? ', { key: 'x' })).toBe('');
    expect(await io.askSecret('S? ', { key: 's' })).toBe(SECRET);
    expect(io.output()).not.toContain(SECRET);
    expect(io.asked.find((a) => a.key === 's')?.hidden).toBe(true);
  });

  it('simulates interruptions', async () => {
    const io = new ScriptedPromptIO({ a: '1' }, { interruptAt: 'b' });
    await io.ask('A? ', { key: 'a' });
    await expect(io.ask('B? ', { key: 'b' })).rejects.toBeInstanceOf(SetupInterruptedError);
    const strict = new ScriptedPromptIO({}, { fallback: 'interrupt' });
    await expect(strict.ask('?', { key: 'z' })).rejects.toBeInstanceOf(SetupInterruptedError);
  });
});
