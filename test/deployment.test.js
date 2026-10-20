import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('production proxy, multi-user isolation, restart and online backup', { timeout: 30000 }, async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'rijin-deploy-test-'));
  const dbPath = path.join(temporary, 'nested', 'goals.sqlite');
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const origin = 'https://goals.example.com';
  let child;
  let errors = '';
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DB_PATH: dbPath, PUBLIC_ORIGIN: origin, TRUST_PROXY: 'loopback', VAPID_SUBJECT: 'mailto:ops@example.com' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.on('data', (chunk) => { errors += chunk; });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Server stopped: ${errors}`);
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await delay(50);
    }
    throw new Error(`Server failed to start: ${errors}`);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  async function api(route, { method = 'GET', body, cookie = '', ip = '203.0.113.10', suppliedOrigin = origin, headers = {} } = {}) {
    const response = await fetch(`${base}${route}`, { method, headers: { Origin: suppliedOrigin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'goals.example.com', 'X-Forwarded-For': ip, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    return { status: response.status, data, setCookie: response.headers.get('set-cookie'), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    await start();
    const account = (email) => ({ email, password: 'Rijin-test-password-123', timezone: 'America/New_York' });
    const first = await api('/api/auth/register', { method: 'POST', body: account('one@example.com') });
    const second = await api('/api/auth/register', { method: 'POST', body: account('two@example.com'), ip: '203.0.113.11' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.match(first.setCookie, /HttpOnly/);
    assert.match(first.setCookie, /Secure/);
    const goal = await api('/api/goals', { method: 'POST', cookie: first.cookie, body: { title: '私密长期目标', milestones: ['第一阶段'] } });
    assert.equal(goal.status, 201);
    assert.equal((await api('/api/bootstrap', { cookie: second.cookie })).data.goals.length, 0);
    assert.equal((await api(`/api/goals/${goal.data.goal.id}`, { method: 'DELETE', cookie: second.cookie })).status, 404);
    const task = await api('/api/tasks', { method: 'POST', cookie: first.cookie, body: { title: '完成今天的一步', goalId: goal.data.goal.id } });
    assert.equal(task.status, 201);
    assert.equal((await api('/api/bootstrap', { cookie: second.cookie })).data.tasks.length, 0);
    assert.equal((await api('/api/goals', { method: 'POST', body: { title: '不能匿名写入' } })).status, 401);
    assert.equal((await api('/api/auth/login', { method: 'POST', suppliedOrigin: 'https://evil.example', headers: { 'X-Forwarded-Host': 'evil.example' }, body: account('one@example.com') })).status, 403);
    assert.equal((await api('/api/push/subscribe', { method: 'POST', cookie: first.cookie, body: { subscription: { endpoint: 'https://127.0.0.1/private', keys: {} } } })).status, 400);
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/deployment-test', keys: { auth: Buffer.alloc(16).toString('base64url'), p256dh: Buffer.alloc(65).toString('base64url') } };
    assert.equal((await api('/api/push/subscribe', { method: 'POST', cookie: first.cookie, body: { subscription } })).status, 201);
    const keyBefore = (await api('/api/settings', { cookie: first.cookie })).data.publicKey;
    for (let index = 0; index < 9; index += 1) {
      const result = await api('/api/auth/register', { method: 'POST', ip: `198.51.100.${index + 1}`, body: account(`visitor-${index}@example.com`) });
      assert.equal(result.status, 201, 'Visitors behind one proxy need independent rate limits');
    }
    for (let index = 0; index < 8; index += 1) {
      assert.equal((await api('/api/auth/register', { method: 'POST', ip: '192.0.2.1', body: account('invalid') })).status, 400);
    }
    assert.equal((await api('/api/auth/register', { method: 'POST', ip: '192.0.2.1', body: account('blocked@example.com') })).status, 429);
    const backupPath = path.join(temporary, 'snapshot.sqlite');
    execFileSync(process.execPath, ['scripts/backup.js', backupPath], { cwd: root, env: { ...process.env, DB_PATH: dbPath }, stdio: 'pipe' });
    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM users').get().count, 11);
      assert.equal(backupDb.prepare('SELECT title FROM goals').get().title, '私密长期目标');
      assert.equal(backupDb.prepare("SELECT value FROM app_settings WHERE key = 'vapid_public'").get().value, keyBefore);
    } finally { backupDb.close(); }
    const migrationPath = path.join(temporary, 'migration.sqlite');
    execFileSync(process.execPath, ['scripts/backup.js', migrationPath, '--new-origin'], { cwd: root, env: { ...process.env, DB_PATH: dbPath }, stdio: 'pipe' });
    const migrationDb = new DatabaseSync(migrationPath, { readOnly: true });
    try {
      assert.equal(migrationDb.prepare('SELECT COUNT(*) AS count FROM users').get().count, 11);
      assert.equal(migrationDb.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
      assert.equal(migrationDb.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get().count, 0);
      assert.equal(migrationDb.prepare('SELECT title FROM goals').get().title, '私密长期目标');
      assert.equal(migrationDb.prepare("SELECT value FROM app_settings WHERE key = 'vapid_public'").get().value, keyBefore);
    } finally { migrationDb.close(); }
    assert.equal((await api('/api/settings', { cookie: first.cookie })).data.subscriptionCount, 1, 'Migration must not change the source database');
    await stop();
    await start();
    assert.equal((await api('/api/bootstrap', { cookie: first.cookie })).data.goals[0].title, '私密长期目标');
    assert.equal((await api('/api/settings', { cookie: first.cookie })).data.publicKey, keyBefore);
    assert.equal((await api('/api/auth/login', { method: 'POST', body: account('one@example.com') })).status, 200);
    assert.equal((await fetch(`${base}/data/daybyday.sqlite`)).status, 404);
  } finally {
    await stop();
    rmSync(temporary, { recursive: true, force: true });
  }
});
