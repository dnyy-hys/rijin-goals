import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';
import { createRequestContext } from './request-context.js';
import { validPushSubscription } from './push-subscription.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(DATA_DIR, 'daybyday.sqlite'));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const { secureRequest, verifyOrigin, clientIp } = createRequestContext({
  publicOrigin: process.env.PUBLIC_ORIGIN,
  trustProxy: process.env.TRUST_PROXY,
});
if (process.env.NODE_ENV === 'production' && (!process.env.PUBLIC_ORIGIN || !process.env.VAPID_SUBJECT)) {
  throw new Error('Production requires PUBLIC_ORIGIN and a real VAPID_SUBJECT contact.');
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH, { timeout: 5000 });
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    reminder_enabled INTEGER NOT NULL DEFAULT 0,
    last_reminded_date TEXT,
    last_reminder_attempt_at TEXT,
    last_reminder_status TEXT,
    last_reminder_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    deadline TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS goals_user_idx ON goals(user_id, created_at);
  CREATE TABLE IF NOT EXISTS milestones (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS milestones_goal_idx ON milestones(goal_id, position);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    local_date TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_user_date_idx ON tasks(user_id, local_date, completed);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    subscription_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON push_subscriptions(user_id);
`);

const existingUserColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
if (!existingUserColumns.has('last_reminder_status')) db.exec('ALTER TABLE users ADD COLUMN last_reminder_status TEXT');
if (!existingUserColumns.has('last_reminder_error')) db.exec('ALTER TABLE users ADD COLUMN last_reminder_error TEXT');

const settingGet = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const settingSet = db.prepare('INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function getVapidKeys() {
  let publicKey = settingGet.get('vapid_public')?.value;
  let privateKey = settingGet.get('vapid_private')?.value;
  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    settingSet.run('vapid_public', publicKey);
    settingSet.run('vapid_private', privateKey);
  }
  return { publicKey, privateKey };
}

const vapid = getVapidKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

const authWindows = new Map();
function allowAuthAttempt(req, action, maximum, windowMs) {
  const key = `${action}:${clientIp(req)}`;
  const now = Date.now();
  let record = authWindows.get(key);
  if (!record || now - record.startedAt >= windowMs) record = { startedAt: now, count: 0 };
  if (record.count >= maximum) {
    authWindows.set(key, record);
    return false;
  }
  record.count += 1;
  authWindows.set(key, record);
  if (authWindows.size > 2000) {
    for (const [entryKey, entry] of authWindows) if (now - entry.startedAt >= windowMs) authWindows.delete(entryKey);
  }
  return true;
}

const nowIso = () => new Date().toISOString();
const makeId = () => randomBytes(16).toString('hex');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const validTimezone = (timezone) => {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); return true; }
  catch { return false; }
};

function dateTimeInZone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '00';
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    minute: Number(pick('hour')) * 60 + Number(pick('minute')),
  };
}

function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password, saved) {
  const [salt, hash] = String(saved || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index > -1 ? [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())] : ['', ''];
  }).filter(([key]) => key));
}

function setSessionCookie(res, req, token) {
  const attributes = [`session=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=2592000'];
  if (secureRequest(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res, req) {
  const attributes = ['session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secureRequest(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function currentUser(req) {
  const token = cookies(req).session;
  if (!token) return null;
  const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(digest(token));
  if (!session || session.expires_at < nowIso()) {
    if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
    return null;
  }
  return db.prepare('SELECT id, email, timezone, reminder_enabled, last_reminder_attempt_at, last_reminder_status, last_reminder_error FROM users WHERE id = ?').get(session.user_id) || null;
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1024 * 1024) throw Object.assign(new Error('请求内容过大。'), { status: 413 });
  }
  if (!data) return {};
  try { return JSON.parse(data); }
  catch { throw Object.assign(new Error('请求格式无效。'), { status: 400 }); }
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) json(res, 401, { error: '登录状态已失效，请重新登录。' });
  return user;
}

function createSession(userId, req, res) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES(?, ?, ?, ?)')
    .run(digest(token), userId, expiresAt, nowIso());
  setSessionCookie(res, req, token);
}

function getTasks(userId, localDate) {
  return db.prepare(`
    SELECT t.id, t.title, t.local_date AS localDate, t.completed, t.completed_at AS completedAt,
           t.goal_id AS goalId, t.milestone_id AS milestoneId,
           g.title AS goalTitle, m.title AS milestoneTitle
    FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id AND g.user_id = t.user_id
    LEFT JOIN milestones m ON m.id = t.milestone_id AND m.user_id = t.user_id
    WHERE t.user_id = ? AND t.local_date = ?
    ORDER BY t.completed ASC, t.created_at ASC
  `).all(userId, localDate).map((task) => ({ ...task, completed: Boolean(task.completed) }));
}

function getGoals(userId) {
  const goals = db.prepare('SELECT id, title, description, deadline, created_at AS createdAt FROM goals WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  const getMilestones = db.prepare('SELECT id, title, position, completed, completed_at AS completedAt FROM milestones WHERE user_id = ? AND goal_id = ? ORDER BY position ASC, created_at ASC');
  const getTaskTotals = db.prepare('SELECT COUNT(*) AS total, SUM(completed) AS completed FROM tasks WHERE user_id = ? AND goal_id = ?');
  return goals.map((goal) => {
    const milestones = getMilestones.all(userId, goal.id).map((item) => ({ ...item, completed: Boolean(item.completed) }));
    const taskTotals = getTaskTotals.get(userId, goal.id);
    const total = milestones.length || Number(taskTotals.total || 0);
    const completed = milestones.length ? milestones.filter((item) => item.completed).length : Number(taskTotals.completed || 0);
    return { ...goal, milestones, progress: total ? Math.round((completed / total) * 100) : 0, progressDone: completed, progressTotal: total };
  });
}

function getHistory(userId, timezone, month) {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) throw Object.assign(new Error('月份格式无效。'), { status: 400 });
  const first = `${year}-${String(monthNumber).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const last = `${year}-${String(monthNumber).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const rows = db.prepare(`
    SELECT local_date AS date, COUNT(*) AS total, SUM(completed) AS completed
    FROM tasks WHERE user_id = ? AND local_date >= ? AND local_date <= ? GROUP BY local_date
  `).all(userId, first, last);
  const days = Object.fromEntries(rows.map((row) => [row.date, { total: Number(row.total), completed: Number(row.completed || 0) }]));
  return { month: `${year}-${String(monthNumber).padStart(2, '0')}`, timezone, days, lastDay, firstWeekday: new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() };
}

function getDaySummary(userId, date) {
  const row = db.prepare('SELECT COUNT(*) AS total, SUM(completed) AS completed FROM tasks WHERE user_id = ? AND local_date = ?').get(userId, date);
  return { date, total: Number(row.total || 0), completed: Number(row.completed || 0) };
}

function getBootstrap(user) {
  const today = dateTimeInZone(new Date(), user.timezone).date;
  const days = [];
  const [year, month, day] = today.split('-').map(Number);
  const localDate = new Date(Date.UTC(year, month - 1, day));
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(localDate);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    days.push(getDaySummary(user.id, key));
  }
  return {
    user: { id: user.id, email: user.email, timezone: user.timezone, reminderEnabled: Boolean(user.reminder_enabled) },
    today,
    tasks: getTasks(user.id, today),
    goals: getGoals(user.id),
    week: days,
  };
}

function insertGoal(userId, body) {
  const title = String(body.title || '').trim().slice(0, 120);
  if (!title) throw Object.assign(new Error('请填写目标名称。'), { status: 400 });
  const id = makeId();
  const description = String(body.description || '').trim().slice(0, 1000);
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(body.deadline || '') ? body.deadline : null;
  const milestones = Array.isArray(body.milestones) ? body.milestones.map((item) => String(item).trim().slice(0, 120)).filter(Boolean).slice(0, 12) : [];
  const stamp = nowIso();
  const insert = db.prepare('INSERT INTO goals(id, user_id, title, description, deadline, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)');
  const insertMilestone = db.prepare('INSERT INTO milestones(id, user_id, goal_id, title, position, created_at) VALUES(?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    insert.run(id, userId, title, description, deadline, stamp, stamp);
    milestones.forEach((name, position) => insertMilestone.run(makeId(), userId, id, name, position, stamp));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return id;
}

function insertTask(userId, body, timezone) {
  const title = String(body.title || '').trim().slice(0, 180);
  if (!title) throw Object.assign(new Error('请填写行动内容。'), { status: 400 });
  const localDate = /^\d{4}-\d{2}-\d{2}$/.test(body.localDate || '') ? body.localDate : dateTimeInZone(new Date(), timezone).date;
  const goalId = body.goalId ? String(body.goalId) : null;
  const milestoneId = body.milestoneId ? String(body.milestoneId) : null;
  if (goalId && !db.prepare('SELECT id FROM goals WHERE id = ? AND user_id = ?').get(goalId, userId)) throw Object.assign(new Error('找不到这个长期目标。'), { status: 404 });
  if (milestoneId && !db.prepare('SELECT id FROM milestones WHERE id = ? AND user_id = ? AND goal_id IS ?').get(milestoneId, userId, goalId)) throw Object.assign(new Error('这个阶段不属于所选目标。'), { status: 400 });
  const id = makeId();
  db.prepare('INSERT INTO tasks(id, user_id, goal_id, milestone_id, title, local_date, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, goalId, milestoneId, title, localDate, nowIso());
  return id;
}

async function routeApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';
  if (!verifyOrigin(req) && method !== 'GET' && method !== 'HEAD') return json(res, 403, { error: '请求来源校验失败。请刷新页面后重试。' });

  if (pathname === '/api/health' && method === 'GET') return json(res, 200, { ok: true, service: 'daybyday' });
  if (pathname === '/api/bootstrap' && method === 'GET') {
    const user = currentUser(req);
    return json(res, 200, user ? getBootstrap(user) : { user: null });
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    if (!allowAuthAttempt(req, 'register', 8, 60 * 60_000)) return json(res, 429, { error: '创建账号的尝试次数过多，请稍后再试。' }, { 'Retry-After': '3600' });
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const timezone = validTimezone(body.timezone) ? body.timezone : 'Asia/Shanghai';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(res, 400, { error: '请输入有效的邮箱地址。' });
    if (password.length < 10 || password.length > 200) return json(res, 400, { error: '密码长度需为 10 至 200 位。' });
    const id = makeId();
    try {
      db.prepare('INSERT INTO users(id, email, password_hash, timezone, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(id, email, passwordHash(password), timezone, nowIso());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: '这个邮箱已经注册，可以直接登录。' });
      throw error;
    }
    createSession(id, req, res);
    return json(res, 201, getBootstrap(db.prepare('SELECT id, email, timezone, reminder_enabled FROM users WHERE id = ?').get(id)));
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    if (!allowAuthAttempt(req, 'login', 20, 15 * 60_000)) return json(res, 429, { error: '尝试次数过多，请 15 分钟后再试。' }, { 'Retry-After': '900' });
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (password.length > 200) return json(res, 401, { error: '邮箱或密码不正确。' });
    const user = db.prepare('SELECT id, email, password_hash, timezone, reminder_enabled FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (!user || !passwordMatches(password, user.password_hash)) return json(res, 401, { error: '邮箱或密码不正确。' });
    createSession(user.id, req, res);
    return json(res, 200, getBootstrap(user));
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = cookies(req).session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
    clearSessionCookie(res, req);
    return json(res, 200, { ok: true });
  }

  const user = requireUser(req, res);
  if (!user) return;

  if (pathname === '/api/goals' && method === 'POST') {
    const body = await readJson(req);
    const id = insertGoal(user.id, body);
    return json(res, 201, { goal: getGoals(user.id).find((goal) => goal.id === id) });
  }

  if (pathname.startsWith('/api/goals/') && method === 'PATCH') {
    const id = decodeURIComponent(pathname.slice('/api/goals/'.length));
    const body = await readJson(req);
    const goal = db.prepare('SELECT id FROM goals WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!goal) return json(res, 404, { error: '找不到这个目标。' });
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return json(res, 400, { error: '目标名称不能为空。' });
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(body.deadline || '') ? body.deadline : null;
    db.prepare('UPDATE goals SET title = ?, description = ?, deadline = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(title, String(body.description || '').trim().slice(0, 1000), deadline, nowIso(), id, user.id);
    return json(res, 200, { goal: getGoals(user.id).find((item) => item.id === id) });
  }

  if (pathname.startsWith('/api/goals/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/goals/'.length));
    const result = db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(id, user.id);
    if (!result.changes) return json(res, 404, { error: '找不到这个目标。' });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/milestones' && method === 'POST') {
    const body = await readJson(req);
    const goalId = String(body.goalId || '');
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return json(res, 400, { error: '请填写阶段名称。' });
    const goal = db.prepare('SELECT id FROM goals WHERE id = ? AND user_id = ?').get(goalId, user.id);
    if (!goal) return json(res, 404, { error: '找不到所属的长期目标。' });
    const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM milestones WHERE goal_id = ? AND user_id = ?').get(goalId, user.id).next;
    const id = makeId();
    db.prepare('INSERT INTO milestones(id, user_id, goal_id, title, position, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(id, user.id, goalId, title, position, nowIso());
    return json(res, 201, { milestone: getGoals(user.id).find((item) => item.id === goalId).milestones.find((item) => item.id === id) });
  }

  if (pathname.startsWith('/api/milestones/') && method === 'PATCH') {
    const id = decodeURIComponent(pathname.slice('/api/milestones/'.length));
    const body = await readJson(req);
    const milestone = db.prepare('SELECT id, completed FROM milestones WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!milestone) return json(res, 404, { error: '找不到这个阶段。' });
    if (typeof body.completed === 'boolean') {
      db.prepare('UPDATE milestones SET completed = ?, completed_at = ? WHERE id = ? AND user_id = ?')
        .run(body.completed ? 1 : 0, body.completed ? nowIso() : null, id, user.id);
    }
    if (typeof body.title === 'string') {
      const title = body.title.trim().slice(0, 120);
      if (!title) return json(res, 400, { error: '阶段名称不能为空。' });
      db.prepare('UPDATE milestones SET title = ? WHERE id = ? AND user_id = ?').run(title, id, user.id);
    }
    return json(res, 200, { goals: getGoals(user.id) });
  }

  if (pathname.startsWith('/api/milestones/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/milestones/'.length));
    const result = db.prepare('DELETE FROM milestones WHERE id = ? AND user_id = ?').run(id, user.id);
    if (!result.changes) return json(res, 404, { error: '找不到这个阶段。' });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/tasks' && method === 'POST') {
    const body = await readJson(req);
    const id = insertTask(user.id, body, user.timezone);
    return json(res, 201, { task: getTasks(user.id, body.localDate || dateTimeInZone(new Date(), user.timezone).date).find((task) => task.id === id) });
  }

  if (pathname.startsWith('/api/tasks/') && method === 'PATCH') {
    const id = decodeURIComponent(pathname.slice('/api/tasks/'.length));
    const body = await readJson(req);
    const task = db.prepare('SELECT id, local_date FROM tasks WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!task) return json(res, 404, { error: '找不到这项行动。' });
    if (typeof body.completed === 'boolean') {
      db.prepare('UPDATE tasks SET completed = ?, completed_at = ? WHERE id = ? AND user_id = ?')
        .run(body.completed ? 1 : 0, body.completed ? nowIso() : null, id, user.id);
    }
    return json(res, 200, { task: getTasks(user.id, task.local_date).find((item) => item.id === id), bootstrap: getBootstrap(user) });
  }

  if (pathname.startsWith('/api/tasks/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/tasks/'.length));
    const result = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(id, user.id);
    if (!result.changes) return json(res, 404, { error: '找不到这项行动。' });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/history' && method === 'GET') {
    const date = dateTimeInZone(new Date(), user.timezone).date;
    const month = url.searchParams.get('month') || date.slice(0, 7);
    return json(res, 200, getHistory(user.id, user.timezone, month));
  }

  if (pathname === '/api/day' && method === 'GET') {
    const requested = url.searchParams.get('date') || dateTimeInZone(new Date(), user.timezone).date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return json(res, 400, { error: '日期格式无效。' });
    const tasks = getTasks(user.id, requested);
    return json(res, 200, { date: requested, tasks, summary: getDaySummary(user.id, requested) });
  }

  if (pathname === '/api/settings' && method === 'GET') {
    const subscriptions = db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?').get(user.id).count;
    return json(res, 200, {
      timezone: user.timezone,
      reminderEnabled: Boolean(user.reminder_enabled),
      subscriptionCount: Number(subscriptions),
      notificationConfigured: Boolean(vapid.publicKey && vapid.privateKey),
      publicKey: vapid.publicKey,
      reminderTime: '18:00',
      lastReminderAt: user.last_reminder_attempt_at,
      lastReminderStatus: user.last_reminder_status,
      lastReminderError: user.last_reminder_error,
    });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJson(req);
    const timezone = String(body.timezone || '');
    if (!validTimezone(timezone)) return json(res, 400, { error: '请选择有效的时区。' });
    const enabled = Boolean(body.reminderEnabled);
    const subscriptionCount = db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?').get(user.id).count;
    if (enabled && !subscriptionCount) return json(res, 409, { error: '请先在这台设备开启浏览器通知。' });
    db.prepare('UPDATE users SET timezone = ?, reminder_enabled = ? WHERE id = ?').run(timezone, enabled ? 1 : 0, user.id);
    const fresh = db.prepare('SELECT id, email, timezone, reminder_enabled FROM users WHERE id = ?').get(user.id);
    return json(res, 200, { user: { id: fresh.id, email: fresh.email, timezone: fresh.timezone, reminderEnabled: Boolean(fresh.reminder_enabled) } });
  }

  if (pathname === '/api/push/subscribe' && method === 'POST') {
    const body = await readJson(req);
    const subscription = body.subscription;
    if (!validPushSubscription(subscription)) {
      return json(res, 400, { error: '浏览器没有返回受支持的有效推送订阅，请使用最新版 Chrome、Edge、Firefox 或 Safari。' });
    }
    db.prepare(`INSERT INTO push_subscriptions(id, user_id, endpoint, subscription_json, created_at)
      VALUES(?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription_json = excluded.subscription_json`)
      .run(makeId(), user.id, subscription.endpoint, JSON.stringify(subscription), nowIso());
    return json(res, 201, { ok: true });
  }

  if (pathname === '/api/push/unsubscribe' && method === 'POST') {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE users SET reminder_enabled = 0 WHERE id = ?').run(user.id);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/push/test' && method === 'POST') {
    const subscriptions = db.prepare('SELECT id, subscription_json FROM push_subscriptions WHERE user_id = ?').all(user.id);
    if (!subscriptions.length) return json(res, 409, { error: '还没有开启这台设备的通知。' });
    const payload = JSON.stringify({ title: '日进 · 提醒测试', body: '通知已连通。每天 18:00，如还有未完成的行动，我们会提醒你。', url: '/?view=today' });
    const results = await Promise.allSettled(subscriptions.map(async (record) => {
      const sub = JSON.parse(record.subscription_json);
      try { await webpush.sendNotification(sub, payload, { TTL: 60, urgency: 'normal' }); return true; }
      catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(record.id, user.id);
        throw error;
      }
    }));
    const sent = results.some((result) => result.status === 'fulfilled');
    if (!sent) return json(res, 502, { error: '推送服务暂时无法送达，请稍后重新开启通知。' });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: '没有找到这个接口。' });
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2' })[ext] || 'application/octet-stream';
}

async function serveStatic(req, res, url) {
  let requestPath;
  try { requestPath = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  if (requestPath === '/') requestPath = '/index.html';
  const resolved = path.resolve(PUBLIC_DIR, `.${requestPath}`);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) throw new Error('Not a file');
    res.writeHead(200, {
      'Content-Type': mimeType(resolved),
      'Cache-Control': /\.(html|css|js|webmanifest)$/.test(resolved) ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; img-src 'self' data:; manifest-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; frame-ancestors 'none'; form-action 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    fs.createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function sendDailyReminders() {
  const users = db.prepare('SELECT id, timezone, last_reminded_date, last_reminder_attempt_at, last_reminder_status FROM users WHERE reminder_enabled = 1').all();
  for (const user of users) {
    let local;
    try { local = dateTimeInZone(new Date(), user.timezone); }
    catch { continue; }
    if (local.minute < 18 * 60 || local.minute >= 24 * 60 || user.last_reminded_date === local.date) continue;
    const recentAttempt = user.last_reminder_attempt_at && Date.now() - Date.parse(user.last_reminder_attempt_at) < 120_000;
    if (recentAttempt) continue;
    const incomplete = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE user_id = ? AND local_date = ? AND completed = 0').get(user.id, local.date).count;
    if (!incomplete) continue;
    const subscriptions = db.prepare('SELECT id, subscription_json FROM push_subscriptions WHERE user_id = ?').all(user.id);
    if (!subscriptions.length) {
      if (user.last_reminder_status !== 'no_subscription') db.prepare('UPDATE users SET last_reminder_status = ?, last_reminder_error = ? WHERE id = ?').run('no_subscription', '没有可用的浏览器推送订阅。', user.id);
      continue;
    }
    const attemptAt = nowIso();
    db.prepare('UPDATE users SET last_reminder_attempt_at = ?, last_reminder_status = ?, last_reminder_error = NULL WHERE id = ?').run(attemptAt, 'sending', user.id);
    const payload = JSON.stringify({
      title: '今天还有一点点',
      body: `还有 ${incomplete} 项行动未打卡。慢慢来，完成一项也算前进。`,
      url: '/?view=today',
      tag: `daybyday-${local.date}`,
    });
    const results = await Promise.allSettled(subscriptions.map(async (record) => {
      const subscription = JSON.parse(record.subscription_json);
      try { await webpush.sendNotification(subscription, payload, { TTL: 1800, urgency: 'normal', topic: `daybyday-${local.date}` }); return true; }
      catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(record.id, user.id);
        throw error;
      }
    }));
    if (results.some((result) => result.status === 'fulfilled')) {
      db.prepare('UPDATE users SET last_reminded_date = ?, last_reminder_status = ?, last_reminder_error = NULL WHERE id = ?').run(local.date, 'accepted', user.id);
      console.log(`[reminder] queued for user ${user.id} on ${local.date}`);
    } else {
      const failure = results.find((result) => result.status === 'rejected')?.reason;
      const reason = Number.isInteger(failure?.statusCode) ? `推送服务返回 HTTP ${failure.statusCode}` : '推送服务暂时不可用';
      db.prepare('UPDATE users SET last_reminder_status = ?, last_reminder_error = ? WHERE id = ?').run('failed', reason, user.id);
      console.warn(`[reminder] failed for user ${user.id} on ${local.date}: ${reason}`);
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) await routeApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    const status = Number(error.status || 500);
    if (!res.headersSent) json(res, status, { error: status === 500 ? '暂时遇到一点问题，请重试。' : error.message });
    else res.destroy();
    if (status >= 500) console.error('[server]', error);
  }
});

let stopping = false;
let reminderRun;
function runReminders() {
  if (stopping || reminderRun) return;
  reminderRun = sendDailyReminders()
    .catch((error) => console.error('[reminder scheduler]', error))
    .finally(() => { reminderRun = null; });
}

server.listen(PORT, HOST, () => {
  console.log(`日进 is running at http://${HOST}:${PORT}`);
  console.log('Persistent data:', DB_PATH);
  runReminders();
});

const reminderTimer = setInterval(runReminders, 30_000);
reminderTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(reminderTimer);
    // Let in-flight HTTP requests and push attempts finish before closing SQLite.
    server.close(async () => {
      if (reminderRun) await reminderRun;
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25_000).unref();
  });
}
