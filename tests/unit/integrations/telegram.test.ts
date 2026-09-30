import { describe, expect, it } from 'vitest';
import { TELEGRAM_MAX_MESSAGE_CHARS, fitTelegramMessage, getTelegramBot, getTelegramChats, sendTelegramMessage } from '../../../src/integrations/telegram/client.js';
import { redactString } from '../../../src/security/redact.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';

// Telegram Bot API adapter (src/integrations/telegram/client.ts), offline with a fake fetch.
// The token below is SYNTHETIC and has the documented "<bot id>:<secret>" shape.
const TOKEN = '123456789:SYNTHETIC_fake_token_for_tests_only_000';
const API = 'https://api.telegram.org';

describe('Telegram sendMessage', () => {
  it('posts plain text with link previews off to /bot<token>/sendMessage', async () => {
    const f = fakeFetch([match('POST', `${API}/bot${TOKEN}/sendMessage`, () => jsonResponse({ ok: true, result: { message_id: 42 } }))]);
    const r = await sendTelegramMessage(f, TOKEN, '-1001234567890', 'seo-agent: demo-site, week 2026-W39\nPlan: ACTION');
    expect(r).toEqual({ ok: true, value: { messageId: 42 } });
    expect(f.calls).toHaveLength(1);
    const body = JSON.parse(f.calls[0]!.body!) as Record<string, unknown>;
    expect(body).toEqual({ chat_id: -1001234567890, text: 'seo-agent: demo-site, week 2026-W39\nPlan: ACTION', link_preview_options: { is_disabled: true } });
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('maps a rejected token, an unknown chat, and rate limiting to honest codes without echoing the token', async () => {
    const cases: Array<[Response, string]> = [
      [jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401), 'TELEGRAM_UNAUTHORIZED'],
      [jsonResponse({ ok: false, error_code: 404, description: 'Not Found' }, 404), 'TELEGRAM_UNAUTHORIZED'],
      [jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400), 'TELEGRAM_CHAT_UNAVAILABLE'],
      [jsonResponse({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }, 403), 'TELEGRAM_CHAT_UNAVAILABLE'],
      [jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }, 429), 'TELEGRAM_RATE_LIMITED'],
      [jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: message text is empty' }, 400), 'TELEGRAM_REJECTED'],
    ];
    for (const [res, code] of cases) {
      const r = await sendTelegramMessage(fakeFetch([() => res]), TOKEN, '123', 'x');
      expect(r.ok, code).toBe(false);
      if (r.ok) continue;
      expect(r.code).toBe(code);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      if (code === 'TELEGRAM_RATE_LIMITED') expect(r.retryAfterSeconds).toBe(7);
    }
  });

  it('a network failure whose error quotes the URL never leaks the token, and is sent only once', async () => {
    let calls = 0;
    const failing = async (input: string | URL) => {
      calls++;
      throw new Error(`fetch failed: connect ECONNREFUSED for ${String(input)}`);
    };
    const r = await sendTelegramMessage(failing, TOKEN, '123', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TELEGRAM_UNREACHABLE');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain('SYNTHETIC_fake_token');
    expect(calls).toBe(1);
  });

  it('cuts messages to the Telegram limit', () => {
    const long = 'x'.repeat(TELEGRAM_MAX_MESSAGE_CHARS + 50);
    const cut = fitTelegramMessage(long);
    expect([...cut]).toHaveLength(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(cut.endsWith('…')).toBe(true);
    expect(fitTelegramMessage('short')).toBe('short');
  });
});

describe('Telegram getMe (free token check)', () => {
  it('returns the bot username', async () => {
    const f = fakeFetch([match('GET', `${API}/bot${TOKEN}/getMe`, () => jsonResponse({ ok: true, result: { id: 123456789, is_bot: true, username: 'synthetic_seo_bot' } }))]);
    expect(await getTelegramBot(f, TOKEN)).toEqual({ ok: true, value: { username: 'synthetic_seo_bot' } });
  });
});

describe('Telegram token redaction', () => {
  it('masks bot tokens, also inside Bot API URLs', () => {
    expect(redactString(`token ${TOKEN} here`)).not.toContain('SYNTHETIC_fake_token');
    const url = redactString(`${API}/bot${TOKEN}/sendMessage`);
    expect(url).not.toContain('SYNTHETIC_fake_token');
    expect(url).toContain('/bot[REDACTED]/sendMessage');
    // Ordinary "digits:text" such as times or ids are untouched.
    expect(redactString('at 12:30 job 123456:done')).toBe('at 12:30 job 123456:done');
  });
});

describe('Telegram getUpdates (chat discovery)', () => {
  it('returns each chat once, with its id, type, and name, never message text', async () => {
    const f = fakeFetch([
      match('GET', `https://api.telegram.org/bot${TOKEN}/getUpdates`, () =>
        jsonResponse({
          ok: true,
          result: [
            { update_id: 1, message: { message_id: 1, text: '/start secret words', chat: { id: 111222333, type: 'private', first_name: 'Synthetic', username: 'synthetic_owner' } } },
            { update_id: 2, message: { message_id: 2, text: 'again', chat: { id: 111222333, type: 'private', first_name: 'Synthetic' } } },
            { update_id: 3, channel_post: { message_id: 3, text: 'post', chat: { id: -1001234567890, type: 'channel', title: 'Synthetic SEO' } } },
          ],
        }),
      ),
    ]);
    const r = await getTelegramChats(f, TOKEN);
    expect(r).toEqual({
      ok: true,
      value: [
        { id: '111222333', type: 'private', name: 'Synthetic', username: 'synthetic_owner' },
        { id: '-1001234567890', type: 'channel', name: 'Synthetic SEO', username: null },
      ],
    });
    expect(JSON.stringify(r)).not.toContain('secret words');
  });
});
