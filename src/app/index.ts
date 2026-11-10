// App Worker entry: dashboard (fetch), ping consumer (queue), evaluator (scheduled, every minute).

import { canaryToken } from '../shared/token';
import { sendPendingAlerts } from './alerts';
import { consumeBatch } from './consumer';
import { runEvaluator } from './evaluator';
import { connect } from './pg';
import { runRetentionIfDue } from './retention';
import { createApp, type AppEnv } from './routes';
import { makeSender } from './sender';

const app = createApp((env) => connect(env.HYPERDRIVE.connectionString));

/** Our own dead man's switch: tell an external monitor that the evaluator ran (or ran unhealthy). */
async function heartbeat(env: AppEnv, ok: boolean): Promise<void> {
  if (!env.EVALUATOR_HEARTBEAT_URL) return;
  const url = env.EVALUATOR_HEARTBEAT_URL.replace(/\/$/, '') + (ok ? '' : '/fail');
  await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => {});
}

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<unknown>, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    const { db, close } = connect(env.HYPERDRIVE.connectionString);
    try {
      const canary = await canaryToken(env.TOKEN_SECRET);
      const result = await consumeBatch(db, batch.messages.map((m) => m.body), Date.now(), canary, env.APP_URL);
      if (result.alertsQueued) {
        await sendPendingAlerts(db, makeSender(env), Date.now()).catch((err) => console.error('alert_send_failed', String(err)));
      }
    } catch (err) {
      // Typically the database is unreachable. Keep the pings in the queue and retry with backoff
      // (30s doubling to 15 min, up to max_retries = 100: roughly a day of buffering). Nothing is
      // lost, and when the batch finally lands late the consumer records a monitoring gap.
      const attempts = Math.max(1, ...batch.messages.map((m) => m.attempts));
      const delaySeconds = Math.min(30 * 2 ** (attempts - 1), 900);
      console.error('consume_failed', `attempt=${attempts}`, `retry_in=${delaySeconds}s`, String(err));
      batch.retryAll({ delaySeconds });
    } finally {
      ctx.waitUntil(close().catch(() => {}));
    }
  },

  async scheduled(_ctrl: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    const { db, close } = connect(env.HYPERDRIVE.connectionString);
    try {
      if (!env.TOKEN_SECRET) throw new Error('config_error TOKEN_SECRET is not set on the app Worker');
      const now = Date.now();
      const canary = await canaryToken(env.TOKEN_SECRET);
      const summary = await runEvaluator(db, {
        now,
        appUrl: env.APP_URL,
        sendCanary: async () => {
          const res = await env.INGEST.fetch(new Request(`https://ingest.internal/p/${canary}`, { method: 'POST' }));
          if (!res.ok) throw new Error(`ingest responded ${res.status}`);
        },
      });
      await sendPendingAlerts(db, makeSender(env), Date.now()).catch((err) => console.error('alert_send_failed', String(err)));
      await runRetentionIfDue(db, now).catch((err) => console.error('retention_failed', String(err)));

      if (summary.ran) {
        const starting = summary.health?.note === 'first_run' || summary.health?.note === 'warming_up';
        const ok = summary.errors === 0 && (summary.health?.healthy === true || starting);
        if (!ok) console.error('evaluator_unhealthy', JSON.stringify(summary.health), summary.errors);
        await heartbeat(env, ok);
      }
    } catch (err) {
      console.error('evaluator_failed', String(err));
      await heartbeat(env, false);
      throw err;
    } finally {
      ctx.waitUntil(close().catch(() => {}));
    }
  },
} satisfies ExportedHandler<AppEnv>;
