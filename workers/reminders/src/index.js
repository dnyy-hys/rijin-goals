import { sendPush } from './push.js';

function localClock(date, timezone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (name) => parts.find((item) => item.type === name)?.value || '00';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

async function remindUser(user, env, now) {
  let local;
  try { local = localClock(now, user.timezone); }
  catch { console.error(`[reminder] invalid timezone for user ${user.id}`); return; }
  if (local.minute < 18 * 60 || local.minute >= 24 * 60 || user.last_reminded_date === local.date) return;

  const incomplete = await env.DB.prepare('SELECT COUNT(*) AS count FROM tasks WHERE user_id=? AND local_date=? AND completed=0').bind(user.id, local.date).first();
  if (!incomplete.count) return;
  const subscriptions = await env.DB.prepare('SELECT id,subscription_json FROM push_subscriptions WHERE user_id=?').bind(user.id).all();
  if (!subscriptions.results.length) {
    await env.DB.prepare("UPDATE users SET last_reminder_status='no_subscription',last_reminder_error='没有可用的浏览器推送订阅。' WHERE id=?").bind(user.id).run();
    return;
  }

  const attemptAt = now.toISOString();
  const claimed = await env.DB.prepare(`INSERT INTO reminder_deliveries(user_id,local_date,attempt_at) VALUES(?,?,?)
    ON CONFLICT(user_id,local_date) DO UPDATE SET attempt_at=excluded.attempt_at
    WHERE accepted_at IS NULL AND attempt_at<?`)
    .bind(user.id, local.date, attemptAt, new Date(now.getTime() - 10 * 60_000).toISOString()).run();
  if (!claimed.meta.changes) return;
  await env.DB.prepare("UPDATE users SET last_reminder_attempt_at=?,last_reminder_status='sending',last_reminder_error=NULL WHERE id=?").bind(attemptAt,user.id).run();

  const payload = {
    title: '今天还有一点点',
    body: `还有 ${incomplete.count} 项行动未打卡。慢慢来，完成一项也算前进。`,
    url: '/?view=today',
    tag: `rijin-${local.date}`,
  };
  const outcomes = await Promise.allSettled(subscriptions.results.map(async (record) => {
    try { await sendPush(JSON.parse(record.subscription_json), payload, env); return true; }
    catch (error) {
      if ([404, 410].includes(error.status)) await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=? AND user_id=?').bind(record.id, user.id).run();
      throw error;
    }
  }));
  if (outcomes.some((result) => result.status === 'fulfilled')) {
    await env.DB.batch([
      env.DB.prepare('UPDATE reminder_deliveries SET accepted_at=? WHERE user_id=? AND local_date=?').bind(attemptAt,user.id,local.date),
      env.DB.prepare("UPDATE users SET last_reminded_date=?,last_reminder_status='accepted',last_reminder_error=NULL WHERE id=?").bind(local.date, user.id),
    ]);
    return;
  }
  const failure = outcomes.find((result) => result.status === 'rejected')?.reason;
  const status = Number.isInteger(failure?.status) ? `推送服务返回 HTTP ${failure.status}` : '推送服务暂时不可用';
  await env.DB.prepare("UPDATE users SET last_reminder_status='failed',last_reminder_error=? WHERE id=?").bind(status, user.id).run();
  console.error(`[reminder] delivery not accepted for user ${user.id}: ${status}`);
}

export async function dispatchReminders(env, now = new Date()) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) throw new Error('Web Push secrets are not configured on the reminder Worker.');
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now.toISOString()).run();
  const users = await env.DB.prepare('SELECT id,timezone,last_reminded_date,last_reminder_attempt_at FROM users WHERE reminder_enabled=1').all();
  for (const user of users.results) await remindUser(user, env, now);
}

export default {
  async scheduled(_event, env, context) {
    context.waitUntil(dispatchReminders(env));
  },
};
