import type { AppContext } from '../../app/context.js';
import type { FetchLike, IntegrationStatus, StatusCheckOptions } from '../types.js';
import { getTelegramBot, type TelegramOptions } from './client.js';

/**
 * Honest status for Telegram notifications. Without `network`, only the
 * configuration is checked. With `network`, one free `getMe` call verifies
 * the token; no message is sent (`notify test` does that explicitly).
 */

export const TELEGRAM_SENDS = [
  'After each weekly run: the site ID, the ISO week, the plan status (action, n/a, or blocked), and the plan file name',
  'The planned action title only when notifications.telegram.includeActionTitle is true (it can name a page URL or a search query)',
  'Your TELEGRAM_BOT_TOKEN (to Telegram only, in the request path) and the configured chat ID',
];

const TOKEN_STEP = 'Create a bot with @BotFather, put its token in <workspace>/secrets/secrets.env as TELEGRAM_BOT_TOKEN (never in chat or the site config), then run `npm run cli -- notify test`.';

export async function telegramStatus(ctx: AppContext, opts: StatusCheckOptions & { fetch?: FetchLike } & TelegramOptions): Promise<IntegrationStatus> {
  const at = ctx.clock.now().toISOString();
  const base = { id: 'telegram' as const, sendsExternally: TELEGRAM_SENDS, checkedAt: at, networkChecked: false, chargeable: false };
  const cfg = ctx.config.notifications.telegram;
  if (!cfg.enabled) return { ...base, state: 'disabled', detail: 'notifications.telegram.enabled is false; nothing is sent.', nextStep: 'Set notifications.telegram.enabled: true and notifications.telegram.chatId to be notified after each weekly run.' };
  if (ctx.synthetic) return { ...base, state: 'fixture', detail: 'Demo mode: notifications are never sent for synthetic data.' };
  const token = ctx.secrets.get('TELEGRAM_BOT_TOKEN');
  if (!token) return { ...base, state: 'missing_credentials', detail: 'notifications.telegram is enabled but TELEGRAM_BOT_TOKEN is not set.', nextStep: TOKEN_STEP };
  if (!opts.network || ctx.offline) return { ...base, state: 'configured_unverified', detail: `Token and chat ID configured; no network check performed${ctx.offline ? ' (offline mode)' : ''}. \`npm run cli -- notify test\` sends a test message.` };
  const r = await getTelegramBot(opts.fetch ?? ctx.fetch, token, opts);
  if (r.ok) {
    return { ...base, networkChecked: true, state: 'ready', detail: `Bot token works${r.value.username ? ` (@${r.value.username})` : ''}. Delivery to the chat is only verified by \`npm run cli -- notify test\`.` };
  }
  const state = r.code === 'TELEGRAM_UNAUTHORIZED' ? 'permission_denied' : r.code === 'TELEGRAM_UNREACHABLE' ? 'unreachable' : 'degraded';
  return { ...base, networkChecked: true, state, detail: r.message, ...(r.nextStep ? { nextStep: r.nextStep } : {}) };
}
