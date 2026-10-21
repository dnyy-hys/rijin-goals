const encoder = new TextEncoder();
const DAY = 86400000;
const iso = () => new Date().toISOString();
const id = () => crypto.randomUUID().replaceAll('-', '');
const hex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
const digest = async (value) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const validTimezone = (value) => { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; } };

function localClock(date, timezone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (name) => parts.find((item) => item.type === name)?.value || '00';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', ...headers } });
}

async function bodyOf(request) {
  const text = await request.text();
  if (text.length > 1_000_000) throw Object.assign(new Error('请求内容过大。'), { status: 413 });
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('请求格式无效。'), { status: 400 }); }
}

function cookie(request, name) {
  for (const piece of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = piece.trim().split('=');
    if (key === name) { try { return decodeURIComponent(rest.join('=')); } catch { return null; } }
  }
  return null;
}

function sessionCookie(token, maxAge) {
  return `session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

async function getUser(request, db) {
  const token = cookie(request, 'session');
  if (!token) return null;
  const session = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').bind(await digest(token)).first();
  if (!session || session.expires_at < iso()) {
    if (session) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(token)).run();
    return null;
  }
  return db.prepare('SELECT id, email, timezone, reminder_enabled, last_reminder_attempt_at, last_reminder_status, last_reminder_error FROM users WHERE id = ?').bind(session.user_id).first();
}

async function createSession(userId, db) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...tokenBytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const stamp = iso();
  await db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES(?, ?, ?, ?)').bind(await digest(token), userId, new Date(Date.now() + 30 * DAY).toISOString(), stamp).run();
  return token;
}

async function passwordHash(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  // Keep the work factor within the CPU budget of Cloudflare Pages Functions.
  // The salt is random per account and the rate limiter protects auth endpoints.
  const result = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120000 }, key, 256);
  const to64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `pbkdf2-sha256$120000$${to64(salt)}$${to64(result)}`;
}

async function passwordMatches(password, saved) {
  const [algorithm, rounds, saltText, expectedText] = String(saved || '').split('$');
  if (algorithm !== 'pbkdf2-sha256' || Number(rounds) !== 120000 || !saltText || !expectedText) return false;
  const from64 = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
  const salt = from64(saltText);
  const actualText = await passwordHash(password, salt);
  const actual = actualText.split('$')[3];
  let mismatch = actual.length ^ expectedText.length;
  for (let index = 0; index < Math.max(actual.length, expectedText.length); index += 1) mismatch |= (actual.charCodeAt(index) || 0) ^ (expectedText.charCodeAt(index) || 0);
  return mismatch === 0;
}

async function authAllowed(request, db, action, limit, windowMs) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const bucket = `${action}:${await digest(ip)}`;
  const now = Date.now();
  await db.prepare('DELETE FROM auth_attempts WHERE window_started_at < ?').bind(now - DAY).run();
  await db.prepare('INSERT INTO auth_attempts(bucket, count, window_started_at) VALUES(?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = CASE WHEN window_started_at <= ? THEN 1 ELSE count + 1 END, window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END')
    .bind(bucket, now, now - windowMs, now - windowMs).run();
  const row = await db.prepare('SELECT count FROM auth_attempts WHERE bucket = ?').bind(bucket).first();
  return row.count <= limit;
}

async function getTasks(userId, date, db) {
  const { results } = await db.prepare(`SELECT t.id, t.title, t.local_date AS localDate, t.completed, t.completed_at AS completedAt,
      t.goal_id AS goalId, t.milestone_id AS milestoneId, g.title AS goalTitle, m.title AS milestoneTitle
    FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id AND g.user_id = t.user_id
    LEFT JOIN milestones m ON m.id = t.milestone_id AND m.user_id = t.user_id
    WHERE t.user_id = ? AND t.local_date = ? ORDER BY t.completed ASC, t.created_at ASC`).bind(userId, date).all();
  return results.map((task) => ({ ...task, completed: Boolean(task.completed) }));
}

async function getGoals(userId, db) {
  const { results: goals } = await db.prepare('SELECT id, title, description, deadline, created_at AS createdAt FROM goals WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
  return Promise.all(goals.map(async (goal) => {
    const { results: milestones } = await db.prepare('SELECT id, title, position, completed, completed_at AS completedAt FROM milestones WHERE user_id = ? AND goal_id = ? ORDER BY position, created_at').bind(userId, goal.id).all();
    const totals = await db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(completed), 0) AS completed FROM tasks WHERE user_id = ? AND goal_id = ?').bind(userId, goal.id).first();
    const total = milestones.length || totals.total;
    const completed = milestones.length ? milestones.filter((item) => item.completed).length : totals.completed;
    return { ...goal, milestones: milestones.map((item) => ({ ...item, completed: Boolean(item.completed) })), progress: total ? Math.round(completed / total * 100) : 0, progressDone: completed, progressTotal: total };
  }));
}

async function summary(userId, date, db) {
  const row = await db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(completed), 0) AS completed FROM tasks WHERE user_id = ? AND local_date = ?').bind(userId, date).first();
  return { date, total: Number(row.total), completed: Number(row.completed) };
}

async function bootstrap(user, db) {
  const today = localClock(new Date(), user.timezone).date;
  const anchor = new Date(`${today}T00:00:00Z`);
  const week = await Promise.all(Array.from({ length: 7 }, (_, index) => {
    const date = new Date(anchor.getTime() - (6 - index) * DAY).toISOString().slice(0, 10);
    return summary(user.id, date, db);
  }));
  return { user: { id: user.id, email: user.email, timezone: user.timezone, reminderEnabled: Boolean(user.reminder_enabled) }, today, tasks: await getTasks(user.id, today, db), goals: await getGoals(user.id, db), week };
}

async function history(userId, timezone, month, db) {
  const match = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw Object.assign(new Error('月份格式无效。'), { status: 400 });
  const year = Number(match[1]), monthNumber = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const first = `${match[1]}-${match[2]}-01`, last = `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`;
  const { results } = await db.prepare('SELECT local_date AS date, COUNT(*) AS total, COALESCE(SUM(completed), 0) AS completed FROM tasks WHERE user_id = ? AND local_date BETWEEN ? AND ? GROUP BY local_date').bind(userId, first, last).all();
  return { month: `${match[1]}-${match[2]}`, timezone, days: Object.fromEntries(results.map((row) => [row.date, { total: Number(row.total), completed: Number(row.completed) }])), lastDay, firstWeekday: new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() };
}

function validPushSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== 'string') return false;
  try {
    const url = new URL(subscription.endpoint);
    const host = url.hostname;
    const supported = ['fcm.googleapis.com', 'android.googleapis.com', 'web.push.apple.com'].includes(host) || host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');
    const validKey = (value, length) => { try { return typeof value === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(value) && atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)).length === length; } catch { return false; } };
    return supported && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && !url.hash && validKey(subscription.keys?.auth, 16) && validKey(subscription.keys?.p256dh, 65);
  } catch { return false; }
}

function pushConfigured(env) { return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT); }

export async function handleApi(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method, db = env.DB;
  if (!['GET', 'HEAD'].includes(method) && request.headers.get('origin') !== url.origin) return json({ error: '请求来源校验失败。请刷新页面后重试。' }, 403);
  try {
    if (path === '/api/health' && method === 'GET') return json({ ok: true, service: 'rijin-goals' });
    if (path === '/api/bootstrap' && method === 'GET') {
      const user = await getUser(request, db);
      return json(user ? await bootstrap(user, db) : { user: null });
    }
    if (path === '/api/auth/register' && method === 'POST') {
      if (!await authAllowed(request, db, 'register', 8, 3600000)) return json({ error: '创建账号的尝试次数过多，请稍后再试。' }, 429, { 'retry-after': '3600' });
      const data = await bodyOf(request), email = String(data.email || '').trim().toLowerCase(), password = String(data.password || ''), timezone = validTimezone(data.timezone) ? data.timezone : 'Asia/Shanghai';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: '请输入有效的邮箱地址。' }, 400);
      if (password.length < 10 || password.length > 200) return json({ error: '密码长度需为 10 至 200 位。' }, 400);
      const userId = id();
      try { await db.prepare('INSERT INTO users(id,email,password_hash,timezone,created_at) VALUES(?,?,?,?,?)').bind(userId, email, await passwordHash(password), timezone, iso()).run(); }
      catch (error) { if (String(error.message).includes('UNIQUE')) return json({ error: '这个邮箱已经注册，可以直接登录。' }, 409); throw error; }
      const token = await createSession(userId, db), user = await db.prepare('SELECT id,email,timezone,reminder_enabled FROM users WHERE id=?').bind(userId).first();
      return json(await bootstrap(user, db), 201, { 'set-cookie': sessionCookie(token, 2592000) });
    }
    if (path === '/api/auth/login' && method === 'POST') {
      if (!await authAllowed(request, db, 'login', 20, 900000)) return json({ error: '尝试次数过多，请 15 分钟后再试。' }, 429, { 'retry-after': '900' });
      const data = await bodyOf(request), email = String(data.email || '').trim().toLowerCase(), password = String(data.password || '');
      const user = password.length <= 200 ? await db.prepare('SELECT id,email,password_hash,timezone,reminder_enabled FROM users WHERE email=? COLLATE NOCASE').bind(email).first() : null;
      if (!user || !await passwordMatches(password, user.password_hash)) return json({ error: '邮箱或密码不正确。' }, 401);
      const token = await createSession(user.id, db);
      return json(await bootstrap(user, db), 200, { 'set-cookie': sessionCookie(token, 2592000) });
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = cookie(request, 'session'); if (token) await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    }

    const user = await getUser(request, db);
    if (!user) return json({ error: '登录状态已失效，请重新登录。' }, 401);
    if (path === '/api/goals' && method === 'POST') {
      const data = await bodyOf(request), title = String(data.title || '').trim().slice(0,120);
      if (!title) return json({ error: '请填写目标名称。' }, 400);
      const goalId = id(), stamp = iso(), milestones = Array.isArray(data.milestones) ? data.milestones.map((x) => String(x).trim().slice(0,120)).filter(Boolean).slice(0,12) : [];
      const statements = [db.prepare('INSERT INTO goals(id,user_id,title,description,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(goalId,user.id,title,String(data.description||'').trim().slice(0,1000),/^\d{4}-\d{2}-\d{2}$/.test(data.deadline||'')?data.deadline:null,stamp,stamp), ...milestones.map((name,position)=>db.prepare('INSERT INTO milestones(id,user_id,goal_id,title,position,created_at) VALUES(?,?,?,?,?,?)').bind(id(),user.id,goalId,name,position,stamp))];
      await db.batch(statements); return json({ goal: (await getGoals(user.id,db)).find((goal)=>goal.id===goalId) },201);
    }
    if (path.startsWith('/api/goals/') && ['PATCH','DELETE'].includes(method)) {
      const goalId = decodeURIComponent(path.slice('/api/goals/'.length));
      if (method === 'DELETE') { const result = await db.prepare('DELETE FROM goals WHERE id=? AND user_id=?').bind(goalId,user.id).run(); return result.meta.changes ? json({ok:true}) : json({error:'找不到这个目标。'},404); }
      const data = await bodyOf(request), title = String(data.title||'').trim().slice(0,120);
      if (!title) return json({error:'目标名称不能为空。'},400);
      const result = await db.prepare('UPDATE goals SET title=?,description=?,deadline=?,updated_at=? WHERE id=? AND user_id=?').bind(title,String(data.description||'').trim().slice(0,1000),/^\d{4}-\d{2}-\d{2}$/.test(data.deadline||'')?data.deadline:null,iso(),goalId,user.id).run();
      if (!result.meta.changes) return json({error:'找不到这个目标。'},404);
      return json({goal:(await getGoals(user.id,db)).find((goal)=>goal.id===goalId)});
    }
    if (path === '/api/milestones' && method === 'POST') {
      const data = await bodyOf(request), goalId = String(data.goalId||''), title = String(data.title||'').trim().slice(0,120);
      if (!title) return json({error:'请填写阶段名称。'},400);
      if (!await db.prepare('SELECT id FROM goals WHERE id=? AND user_id=?').bind(goalId,user.id).first()) return json({error:'找不到所属的长期目标。'},404);
      const row = await db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM milestones WHERE goal_id=? AND user_id=?').bind(goalId,user.id).first(), milestoneId=id();
      await db.prepare('INSERT INTO milestones(id,user_id,goal_id,title,position,created_at) VALUES(?,?,?,?,?,?)').bind(milestoneId,user.id,goalId,title,row.next,iso()).run();
      const goal=(await getGoals(user.id,db)).find((item)=>item.id===goalId); return json({milestone:goal.milestones.find((item)=>item.id===milestoneId)},201);
    }
    if (path.startsWith('/api/milestones/') && ['PATCH','DELETE'].includes(method)) {
      const milestoneId=decodeURIComponent(path.slice('/api/milestones/'.length));
      if (method==='DELETE') { const result=await db.prepare('DELETE FROM milestones WHERE id=? AND user_id=?').bind(milestoneId,user.id).run(); return result.meta.changes?json({ok:true}):json({error:'找不到这个阶段。'},404); }
      const data=await bodyOf(request), existing=await db.prepare('SELECT id FROM milestones WHERE id=? AND user_id=?').bind(milestoneId,user.id).first(); if(!existing)return json({error:'找不到这个阶段。'},404);
      if(typeof data.completed==='boolean')await db.prepare('UPDATE milestones SET completed=?,completed_at=? WHERE id=? AND user_id=?').bind(data.completed?1:0,data.completed?iso():null,milestoneId,user.id).run();
      if(typeof data.title==='string'){const title=data.title.trim().slice(0,120);if(!title)return json({error:'阶段名称不能为空。'},400);await db.prepare('UPDATE milestones SET title=? WHERE id=? AND user_id=?').bind(title,milestoneId,user.id).run();}
      return json({goals:await getGoals(user.id,db)});
    }
    if (path === '/api/tasks' && method === 'POST') {
      const data=await bodyOf(request),title=String(data.title||'').trim().slice(0,180),localDate=/^\d{4}-\d{2}-\d{2}$/.test(data.localDate||'')?data.localDate:localClock(new Date(),user.timezone).date,goalId=data.goalId?String(data.goalId):null,milestoneId=data.milestoneId?String(data.milestoneId):null;
      if(!title)return json({error:'请填写行动内容。'},400);
      if(goalId&&!await db.prepare('SELECT id FROM goals WHERE id=? AND user_id=?').bind(goalId,user.id).first())return json({error:'找不到这个长期目标。'},404);
      if(milestoneId&&!await db.prepare('SELECT id FROM milestones WHERE id=? AND user_id=? AND goal_id IS ?').bind(milestoneId,user.id,goalId).first())return json({error:'这个阶段不属于所选目标。'},400);
      const taskId=id();await db.prepare('INSERT INTO tasks(id,user_id,goal_id,milestone_id,title,local_date,created_at) VALUES(?,?,?,?,?,?,?)').bind(taskId,user.id,goalId,milestoneId,title,localDate,iso()).run();
      return json({task:(await getTasks(user.id,localDate,db)).find((task)=>task.id===taskId)},201);
    }
    if (path.startsWith('/api/tasks/') && ['PATCH','DELETE'].includes(method)) {
      const taskId=decodeURIComponent(path.slice('/api/tasks/'.length)), task=await db.prepare('SELECT id,local_date FROM tasks WHERE id=? AND user_id=?').bind(taskId,user.id).first();if(!task)return json({error:'找不到这项行动。'},404);
      if(method==='DELETE'){await db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').bind(taskId,user.id).run();return json({ok:true});}
      const data=await bodyOf(request);if(typeof data.completed==='boolean')await db.prepare('UPDATE tasks SET completed=?,completed_at=? WHERE id=? AND user_id=?').bind(data.completed?1:0,data.completed?iso():null,taskId,user.id).run();
      return json({task:(await getTasks(user.id,task.local_date,db)).find((item)=>item.id===taskId),bootstrap:await bootstrap(user,db)});
    }
    if (path === '/api/history' && method === 'GET') return json(await history(user.id,user.timezone,url.searchParams.get('month')||localClock(new Date(),user.timezone).date.slice(0,7),db));
    if (path === '/api/day' && method === 'GET') {
      const date=url.searchParams.get('date')||localClock(new Date(),user.timezone).date;if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({error:'日期格式无效。'},400);
      return json({date,tasks:await getTasks(user.id,date,db),summary:await summary(user.id,date,db)});
    }
    if(path==='/api/settings'&&method==='GET'){
      const count=await db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?').bind(user.id).first();
      return json({timezone:user.timezone,reminderEnabled:Boolean(user.reminder_enabled),subscriptionCount:Number(count.count),notificationConfigured:pushConfigured(env),publicKey:env.VAPID_PUBLIC_KEY||'',reminderTime:'18:00',lastReminderAt:user.last_reminder_attempt_at,lastReminderStatus:user.last_reminder_status,lastReminderError:user.last_reminder_error});
    }
    if(path==='/api/settings'&&method==='PUT'){
      const data=await bodyOf(request),timezone=String(data.timezone||'');if(!validTimezone(timezone))return json({error:'请选择有效的时区。'},400);
      const enabled=Boolean(data.reminderEnabled),count=await db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?').bind(user.id).first();if(enabled&&!count.count)return json({error:'请先在这台设备开启浏览器通知。'},409);
      await db.prepare('UPDATE users SET timezone=?,reminder_enabled=? WHERE id=?').bind(timezone,enabled?1:0,user.id).run();return json({user:{id:user.id,email:user.email,timezone,reminderEnabled:enabled}});
    }
    if(path==='/api/push/subscribe'&&method==='POST'){
      if(!pushConfigured(env))return json({error:'服务器尚未配置 Web Push 密钥，请联系管理员。'},503);
      const data=await bodyOf(request),sub=data.subscription;if(!validPushSubscription(sub))return json({error:'浏览器没有返回受支持的有效推送订阅。'},400);
      await db.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint,subscription_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,subscription_json=excluded.subscription_json,created_at=excluded.created_at').bind(id(),user.id,sub.endpoint,JSON.stringify(sub),iso()).run();return json({ok:true},201);
    }
    if(path==='/api/push/unsubscribe'&&method==='POST'){
      await db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').bind(user.id).run();await db.prepare('UPDATE users SET reminder_enabled=0 WHERE id=?').bind(user.id).run();return json({ok:true});
    }
    if(path==='/api/push/test'&&method==='POST'){
      if(!pushConfigured(env))return json({error:'服务器尚未配置 Web Push 密钥。'},503);
      const subs=await db.prepare('SELECT id,subscription_json FROM push_subscriptions WHERE user_id=?').bind(user.id).all();if(!subs.results.length)return json({error:'还没有开启这台设备的通知。'},409);
      const {sendPush}=await import('../workers/reminders/src/push.js');const results=await Promise.allSettled(subs.results.map(async (record)=>{
        try { return await sendPush(JSON.parse(record.subscription_json),{title:'日进 · 提醒测试',body:'通知已连通。每天 18:00，如还有未完成的行动，我们会提醒你。',url:'/?view=today'},env); }
        catch(error) { if([404,410].includes(error.status))await db.prepare('DELETE FROM push_subscriptions WHERE id=? AND user_id=?').bind(record.id,user.id).run();throw error; }
      }));
      if(!results.some((result)=>result.status==='fulfilled'))return json({error:'推送服务暂时无法送达，请稍后重新开启通知。'},502);
      return json({ok:true});
    }
    return json({error:'没有找到这个接口。'},404);
  } catch(error) {
    const status=Number(error.status)||500;
    if(status>=500)console.error('[api]',error);
    return json({error:status===500?'暂时遇到一点问题，请重试。':error.message},status);
  }
}
