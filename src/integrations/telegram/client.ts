import { errorMessage } from '../../core/errors.js';
import { redactString } from '../../security/redact.js';
import type { FetchLike } from '../types.js';

/**
 * Telegram Bot API (https://core.telegram.org/bots/api), used only to send
 * weekly-run notifications. Free; no budget reservation applies.
 *
 * - The bot token is part of the request PATH (`/bot<token>/<method>`), so it
 *   never appears in a message built here: errors name the method, the HTTP
 *   status, and Telegram's own description (redacted), never the URL.
 * - One attempt per message. A failed notification is recorded, never
 *   retried blindly (a retry after an ambiguous failure could send twice).
 * - Plain text only (no parse_mode), so text from search data or pages can
 *   never turn into formatting or links, and link previews are off.
 */

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** Telegram rejects messages longer than this (characters, after entity parsing). */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
const DEFAULT_TIMEOUT_MS = 10_000;

export type TelegramErrorCode = 'TELEGRAM_UNAUTHORIZED' | 'TELEGRAM_CHAT_UNAVAILABLE' | 'TELEGRAM_RATE_LIMITED' | 'TELEGRAM_REJECTED' | 'TELEGRAM_UNREACHABLE';

export type TelegramResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: TelegramErrorCode; httpStatus: number | null; message: string; nextStep: string | null; retryAfterSeconds: number | null };

export interface TelegramOptions {
  endpoint?: string;
  timeoutMs?: number;
}

const TOKEN_STEP = 'Create a new token with @BotFather (/token or /revoke), put it in <workspace>/secrets/secrets.env as TELEGRAM_BOT_TOKEN (never in chat or the site config), then run `npm run cli -- notify test`.';
const CHAT_STEP =
  'Open the chat with your bot in Telegram and send /start (a bot cannot start a conversation), or add the bot to the group or channel. Then check notifications.telegram.chatId and run `npm run cli -- notify test`.';

interface BotApiResponse {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

async function callBotApi<T>(fetch: FetchLike, token: string, method: string, body: Record<string, unknown> | null, opts: TelegramOptions): Promise<TelegramResult<T>> {
  const url = `${opts.endpoint ?? TELEGRAM_API_BASE}/bot${token}/${method}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // The error of a failed fetch can quote the URL, which contains the token.
    const detail = redactString(errorMessage(err).split(token).join('[REDACTED]'));
    return { ok: false, code: 'TELEGRAM_UNREACHABLE', httpStatus: null, message: `Telegram ${method} failed before a response: ${detail}`, nextStep: 'Check the network connection; the message was not sent.', retryAfterSeconds: null };
  }
  let parsed: BotApiResponse | null = null;
  try {
    parsed = (await res.json()) as BotApiResponse;
  } catch {
    parsed = null;
  }
  if (res.ok && parsed?.ok === true) return { ok: true, value: parsed.result as T };
  const description = redactString(String(parsed?.description ?? `HTTP ${res.status}`).split(token).join('[REDACTED]')).slice(0, 300);
  const status = parsed?.error_code ?? res.status;
  if (status === 401 || status === 404) {
    // Telegram answers 404 for a malformed token and 401 for a revoked or unknown one.
    return { ok: false, code: 'TELEGRAM_UNAUTHORIZED', httpStatus: res.status, message: `Telegram rejected the bot token (${description}).`, nextStep: TOKEN_STEP, retryAfterSeconds: null };
  }
  if (status === 429) {
    const retry = parsed?.parameters?.retry_after;
    return { ok: false, code: 'TELEGRAM_RATE_LIMITED', httpStatus: res.status, message: `Telegram rate-limited the bot (${description}).`, nextStep: 'Wait and try again later; nothing was sent.', retryAfterSeconds: typeof retry === 'number' ? retry : null };
  }
  if (status === 403 || (status === 400 && /chat not found|chat_id is empty|user not found|peer_id_invalid/i.test(description))) {
    return { ok: false, code: 'TELEGRAM_CHAT_UNAVAILABLE', httpStatus: res.status, message: `Telegram cannot deliver to that chat (${description}).`, nextStep: CHAT_STEP, retryAfterSeconds: null };
  }
  return { ok: false, code: 'TELEGRAM_REJECTED', httpStatus: res.status, message: `Telegram ${method} was rejected (${description}).`, nextStep: null, retryAfterSeconds: null };
}

/** Cut a message to Telegram's limit (the tail is replaced by an ellipsis). */
export function fitTelegramMessage(text: string): string {
  const chars = [...text];
  return chars.length <= TELEGRAM_MAX_MESSAGE_CHARS ? text : `${chars.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - 1).join('')}…`;
}

/** Send one plain-text message. */
export async function sendTelegramMessage(fetch: FetchLike, token: string, chatId: string, text: string, opts: TelegramOptions = {}): Promise<TelegramResult<{ messageId: number | null }>> {
  // chat_id is "Integer or String"; numeric ids have at most 52 significant bits, so a JS number holds them exactly.
  const chat = /^-?\d{1,16}$/.test(chatId) ? Number(chatId) : chatId;
  const r = await callBotApi<{ message_id?: number }>(fetch, token, 'sendMessage', { chat_id: chat, text: fitTelegramMessage(text), link_preview_options: { is_disabled: true } }, opts);
  return r.ok ? { ok: true, value: { messageId: typeof r.value?.message_id === 'number' ? r.value.message_id : null } } : r;
}

/** Free, read-only token check (`getMe`): the bot's username when the token works. */
export async function getTelegramBot(fetch: FetchLike, token: string, opts: TelegramOptions = {}): Promise<TelegramResult<{ username: string | null }>> {
  const r = await callBotApi<{ username?: string }>(fetch, token, 'getMe', null, opts);
  return r.ok ? { ok: true, value: { username: typeof r.value?.username === 'string' ? r.value.username : null } } : r;
}

export interface TelegramChat {
  id: string;
  type: string;
  /** Group or channel title, or the user's first name; null when Telegram sends none. */
  name: string | null;
  username: string | null;
}

interface UpdateChat {
  id?: number;
  type?: string;
  title?: string;
  first_name?: string;
  username?: string;
}

/**
 * Chats that recently wrote to the bot (`getUpdates`; free and read-only, no
 * offset is confirmed, so nothing is consumed). Only chat identities are
 * returned, never message text. Telegram keeps updates for 24 hours, and
 * `getUpdates` does not work while the bot has a webhook.
 */
export async function getTelegramChats(fetch: FetchLike, token: string, opts: TelegramOptions = {}): Promise<TelegramResult<TelegramChat[]>> {
  const r = await callBotApi<unknown[]>(fetch, token, 'getUpdates', null, opts);
  if (!r.ok) return r;
  const chats = new Map<string, TelegramChat>();
  for (const u of Array.isArray(r.value) ? r.value : []) {
    const upd = (u ?? {}) as Record<string, { chat?: UpdateChat } | undefined>;
    for (const key of ['message', 'edited_message', 'channel_post', 'my_chat_member', 'chat_member']) {
      const c = upd[key]?.chat;
      if (!c || typeof c.id !== 'number') continue;
      const id = String(c.id);
      if (!chats.has(id)) chats.set(id, { id, type: c.type ?? 'unknown', name: c.title ?? c.first_name ?? null, username: c.username ?? null });
    }
  }
  return { ok: true, value: [...chats.values()] };
}
