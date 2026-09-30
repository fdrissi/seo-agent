import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import { recordAudit } from '../../database/audit.js';
import { getTelegramChats, sendTelegramMessage } from '../../integrations/telegram/client.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `notify chats | test`
 *
 * Sends one test message through the configured notification channel
 * (Telegram), so the owner can confirm delivery before relying on it for
 * unattended weekly runs. Weekly runs notify on their own (src/plans/publish.ts).
 */

export function register(program: Command, cli: CliRuntime): void {
  const notify = program.command('notify').description('Notifications after weekly runs (Telegram)');

  notify
    .command('chats')
    .description('List the chats that wrote to your bot in the last 24 hours, with the IDs to use for notifications.telegram.chatId (free, read-only; never shows message text)')
    .action(
      cli.action(async (_opts: Record<string, never>, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        if (ctx.offline) throw new AppError('OFFLINE', 'Offline mode: Telegram was not contacted.');
        const token = ctx.secrets.get('TELEGRAM_BOT_TOKEN');
        if (!token) {
          throw new AppError('CREDENTIALS_MISSING', 'TELEGRAM_BOT_TOKEN is not set.', {
            hint: 'Create a bot with @BotFather and put its token in <workspace>/secrets/secrets.env as TELEGRAM_BOT_TOKEN (never paste it into a chat).',
          });
        }
        const r = await getTelegramChats(ctx.fetch, token);
        if (!r.ok) throw new AppError(r.code === 'TELEGRAM_UNAUTHORIZED' ? 'PERMISSION_DENIED' : r.code === 'TELEGRAM_RATE_LIMITED' ? 'RATE_LIMITED' : 'PROVIDER_ERROR', r.message, { ...(r.nextStep ? { hint: r.nextStep } : {}), details: { telegramCode: r.code } });
        const result = { chats: r.value };
        cli.print(g, result, (x: typeof result) =>
          x.chats.length
            ? ['Chats that wrote to the bot recently (use the id as notifications.telegram.chatId):', ...x.chats.map((c) => `  ${c.id.padEnd(16)} ${c.type.padEnd(10)} ${c.name ?? ''}${c.username ? ` (@${c.username})` : ''}`)].join('\n')
            : 'No chat wrote to the bot in the last 24 hours. Open the chat with your bot in Telegram, send /start (or add the bot to your group or channel and post there), then run this again.',
        );
      }),
    );

  notify
    .command('test')
    .description('Send one test message to notifications.telegram.chatId (free; nothing else is sent). --dry-run shows the message without sending it.')
    .action(
      cli.action(async (_opts: Record<string, never>, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        const cfg = ctx.config.notifications.telegram;
        if (!cfg.enabled || !cfg.chatId) {
          throw new AppError('INTEGRATION_DISABLED', 'Telegram notifications are not configured for this site.', {
            hint: 'Set notifications.telegram.enabled: true and notifications.telegram.chatId in the site config (docs/ACCESS_SETUP.md, "Telegram notifications").',
          });
        }
        const text = `seo-agent: test message for site ${ctx.siteId}. Weekly plan notifications will arrive in this chat.`;
        if (g.dryRun) {
          const result = { dryRun: true, sent: false, chatId: cfg.chatId, text };
          cli.print(g, result, (r: typeof result) => `Dry run: would send to chat ${r.chatId}:\n${r.text}`);
          return;
        }
        if (ctx.synthetic) throw new AppError('INTEGRATION_DISABLED', 'Demo sites never send notifications.');
        if (ctx.offline) throw new AppError('OFFLINE', 'Offline mode: no message was sent.');
        const token = ctx.secrets.get('TELEGRAM_BOT_TOKEN');
        if (!token) {
          throw new AppError('CREDENTIALS_MISSING', 'TELEGRAM_BOT_TOKEN is not set.', {
            hint: 'Create a bot with @BotFather and put its token in <workspace>/secrets/secrets.env as TELEGRAM_BOT_TOKEN (never paste it into a chat).',
          });
        }
        const r = await sendTelegramMessage(ctx.fetch, token, cfg.chatId, text);
        recordAudit(ctx.db, {
          siteId: ctx.siteId,
          actor: 'cli',
          eventType: r.ok ? 'notification.test_sent' : 'notification.test_failed',
          subjectType: 'site',
          subjectId: ctx.siteId,
          details: r.ok ? { channel: 'telegram', messageId: r.value.messageId } : { channel: 'telegram', code: r.code, httpStatus: r.httpStatus, message: r.message },
          at: ctx.clock.now(),
        });
        if (!r.ok) {
          const code = r.code === 'TELEGRAM_UNAUTHORIZED' ? 'PERMISSION_DENIED' : r.code === 'TELEGRAM_RATE_LIMITED' ? 'RATE_LIMITED' : 'PROVIDER_ERROR';
          throw new AppError(code, r.message, { ...(r.nextStep ? { hint: r.nextStep } : {}), details: { telegramCode: r.code } });
        }
        const result = { sent: true, chatId: cfg.chatId, messageId: r.value.messageId };
        cli.print(g, result, (x: typeof result) => `Test message sent to chat ${x.chatId}. Check Telegram.`);
      }),
    );
}
