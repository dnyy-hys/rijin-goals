import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createECDH } from 'node:crypto';
import webpush from 'web-push';
import { handleApi } from '../src/cloudflare-api.js';
import { dispatchReminders } from '../workers/reminders/src/index.js';

// Same SQL and D1-shaped prepared statements; runtime bundling is checked with Wrangler separately.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = await Promise.all(statements.map((statement) => statement.run())); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, sqlite };
}

test('Cloudflare API: registration, isolation, goals/milestones/tasks, check-in, history and logout', async () => {
  const { db, sqlite } = database();
  const env = { DB: db };
  async function call(path, { method = 'GET', body, cookie = '', origin = 'https://rijin.test' } = {}) {
    const request = new Request(`https://rijin.test${path}`, { method, headers: { origin, cookie, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1' }, body: body ? JSON.stringify(body) : undefined });
    const response = await handleApi(request, env);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  try {
    const account = (email) => ({ email, password: 'Rijin-password-123', timezone: 'Asia/Shanghai' });
    const one = await call('/api/auth/register', { method: 'POST', body: account('one@example.com') });
    const two = await call('/api/auth/register', { method: 'POST', body: account('two@example.com') });
    assert.equal(one.status, 201); assert.equal(two.status, 201);
    assert.match(one.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Secure/);
    assert.match(sqlite.prepare('SELECT password_hash FROM users LIMIT 1').get().password_hash, /^pbkdf2-sha256\$/);
    assert.equal((await call('/api/auth/login', { method: 'POST', body: account('one@example.com') })).status, 200);
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { ...account('one@example.com'), password: 'incorrect-password' } })).status, 401);
    assert.equal((await call('/api/goals', { method: 'POST', body: { title: 'Anonymous' } })).status, 401);
    assert.equal((await call('/api/goals', { method: 'POST', origin: 'https://evil.test', cookie: one.cookie, body: { title: 'CSRF' } })).status, 403);
    const goal = await call('/api/goals', { method: 'POST', cookie: one.cookie, body: { title: '学会法语', milestones: ['入门', '日常对话'] } });
    assert.equal(goal.status, 201); assert.equal(goal.data.goal.milestones.length, 2);
    const goalId = goal.data.goal.id, milestoneId = goal.data.goal.milestones[0].id;
    assert.equal((await call(`/api/goals/${goalId}`, { method: 'DELETE', cookie: two.cookie })).status, 404);
    const illegal = await call('/api/tasks', { method: 'POST', cookie: two.cookie, body: { title: '非法关联', goalId } });
    assert.equal(illegal.status, 404);
    const created = await call('/api/tasks', { method: 'POST', cookie: one.cookie, body: { title: '练习十分钟', goalId, milestoneId } });
    assert.equal(created.status, 201);
    const task = created.data.task;
    assert.equal((await call('/api/bootstrap', { cookie: two.cookie })).data.tasks.length, 0);
    assert.equal((await call(`/api/tasks/${task.id}`, { method: 'PATCH', cookie: two.cookie, body: { completed: true } })).status, 404);
    const checked = await call(`/api/tasks/${task.id}`, { method: 'PATCH', cookie: one.cookie, body: { completed: true } });
    assert.equal(checked.data.task.completed, true);
    assert.equal((await call(`/api/day?date=${task.localDate}`, { cookie: one.cookie })).data.summary.completed, 1);
    const month = await call(`/api/history?month=${task.localDate.slice(0, 7)}`, { cookie: one.cookie });
    assert.equal(month.data.days[task.localDate].completed, 1);
    assert.equal((await call(`/api/history?month=${task.localDate.slice(0, 7)}`, { cookie: two.cookie })).data.days[task.localDate], undefined);
    assert.equal((await call('/api/settings', { cookie: one.cookie })).data.notificationConfigured, false);
    assert.equal((await call('/api/settings', { method: 'PUT', cookie: one.cookie, body: { timezone: 'America/New_York', reminderEnabled: true } })).status, 409);
    assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: one.cookie })).status, 200);
    assert.equal((await call('/api/bootstrap', { cookie: one.cookie })).data.user, null);
  } finally { sqlite.close(); }
});

test('Cron: local 18:00, DST, no completed-task alerts, concurrent deduplication, failed/expired subscriptions', async () => {
  const { db, sqlite } = database();
  const keys = webpush.generateVAPIDKeys();
  const env = { DB: db, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' };
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const subscription = (suffix) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } });
  let calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers['content-encoding'], 'aes128gcm');
    assert.equal(options.redirect, 'error');
    return new Response('', { status: url.endsWith('/expired') ? 410 : url.endsWith('/failed') ? 503 : 201 });
  };
  function seed(userId, timezone, date, completed = 0, endpoint = userId) {
    sqlite.prepare('INSERT INTO users(id,email,password_hash,timezone,reminder_enabled,created_at) VALUES(?,?,?,?,1,?)').run(userId, `${userId}@example.com`, 'unused', timezone, '2026-01-01T00:00:00Z');
    sqlite.prepare('INSERT INTO tasks(id,user_id,title,local_date,completed,created_at) VALUES(?,?,?,?,?,?)').run(userId, userId, 'daily action', date, completed, '2026-01-01T00:00:00Z');
    sqlite.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint,subscription_json,created_at) VALUES(?,?,?,?,?)').run(userId,userId,subscription(endpoint).endpoint,JSON.stringify(subscription(endpoint)),'2026-01-01T00:00:00Z');
  }
  try {
    // New York is UTC-4 in July and UTC-5 in January.
    seed('summer', 'America/New_York', '2026-07-01');
    seed('done', 'America/New_York', '2026-07-01', 1);
    seed('early', 'America/Los_Angeles', '2026-07-01');
    seed('expired', 'America/New_York', '2026-07-01');
    seed('failed', 'America/New_York', '2026-07-01');
    await dispatchReminders(env, new Date('2026-07-01T21:55:00Z'));
    assert.equal(calls.length, 0);
    await Promise.all([dispatchReminders(env, new Date('2026-07-01T22:00:00Z')), dispatchReminders(env, new Date('2026-07-01T22:00:00Z'))]);
    assert.equal(calls.filter((url) => url.endsWith('/summer')).length, 1);
    assert.equal(sqlite.prepare('SELECT last_reminder_status FROM users WHERE id=?').get('summer').last_reminder_status, 'accepted');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?').get('expired').count, 0);
    assert.equal(sqlite.prepare('SELECT last_reminder_status FROM users WHERE id=?').get('failed').last_reminder_status, 'failed');
    assert.equal(calls.some((url) => url.endsWith('/done') || url.endsWith('/early')), false);
    await dispatchReminders(env, new Date('2026-07-01T22:05:00Z'));
    assert.equal(calls.filter((url) => url.endsWith('/summer')).length, 1);
    assert.equal(calls.filter((url) => url.endsWith('/failed')).length, 1, 'wait ten minutes before retry');
    await dispatchReminders(env, new Date('2026-07-01T22:10:01Z'));
    assert.equal(calls.filter((url) => url.endsWith('/failed')).length, 2);
    seed('winter', 'America/New_York', '2026-01-05');
    calls = [];
    await dispatchReminders(env, new Date('2026-01-05T22:55:00Z'));
    assert.equal(calls.length, 0);
    await dispatchReminders(env, new Date('2026-01-05T23:00:00Z'));
    assert.equal(calls.length, 1); assert.match(calls[0], /winter$/);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});
