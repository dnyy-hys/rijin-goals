const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const checkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
const arrowLeft = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const arrowRight = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

const app = {
  user: null,
  today: '',
  tasks: [],
  goals: [],
  week: [],
  view: 'today',
  settings: null,
  historyMonth: '',
  history: null,
  selectedHistoryDate: '',
  selectedHistoryDay: null,
  authMode: 'login',
  confirmAction: null,
  serviceWorker: null,
  deviceSubscribed: false,
  loading: false,
};

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
}

function formatDate(date, options = { month: 'long', day: 'numeric', weekday: 'long' }) {
  const target = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }).format(target);
}

function shortDate(date) {
  return formatDate(date, { month: 'numeric', day: 'numeric' }, 'UTC');
}

function nowClock() {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
}

function isoDate(date) {
  const year = date.getFullYear();
  return `${year}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function toast(message, kind = 'good') {
  const node = document.createElement('div');
  node.className = `toast ${kind === 'good' ? 'is-good' : ''}`;
  node.textContent = message;
  $('#toastRegion').append(node);
  window.setTimeout(() => node.remove(), 4300);
}

async function api(path, options = {}) {
  const init = { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } };
  const response = await fetch(path, init);
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '暂时遇到一点问题，请重试。');
  return data;
}

async function refresh() {
  const data = await api('/api/bootstrap');
  app.user = data.user;
  app.today = data.today || '';
  app.tasks = data.tasks || [];
  app.goals = data.goals || [];
  app.week = data.week || [];
  return data;
}

function setView(view, updateUrl = true) {
  app.view = ['today', 'goals', 'history', 'settings'].includes(view) ? view : 'today';
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('view', app.view);
    window.history.pushState({ view: app.view }, '', url);
  }
  $$('.nav-item, .mobile-nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === app.view));
  render();
  if (app.view === 'history') loadHistory();
  if (app.view === 'settings') loadSettings();
}

function updateUserChrome() {
  const chip = $('#userChip');
  if (!app.user) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  $('#userEmail').textContent = app.user.email;
  $('#userAvatar').textContent = (app.user.email.split('@')[0] || '进').slice(0, 1).toUpperCase();
}

function goalById(id) { return app.goals.find((goal) => goal.id === id); }

function render() {
  if (!app.user) {
    renderSignedOut();
    return;
  }
  $('#appShell').classList.remove('is-signed-out');
  $('.mobile-nav').hidden = false;
  updateUserChrome();
  $$('.nav-item, .mobile-nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === app.view));
  const view = $('#viewRoot');
  if (app.view === 'today') view.innerHTML = renderToday();
  else if (app.view === 'goals') view.innerHTML = renderGoals();
  else if (app.view === 'history') view.innerHTML = renderHistory();
  else view.innerHTML = renderSettings();
  $('#rightPanel').hidden = app.view !== 'today';
  if (app.view === 'today') renderRightPanel();
  bindViewActions();
}

function renderSignedOut() {
  $('#appShell').classList.add('is-signed-out');
  $('.mobile-nav').hidden = true;
  $('#rightPanel').hidden = true;
  $('#rightPanel').innerHTML = '';
  $('#userChip').hidden = true;
  $('#viewRoot').innerHTML = `<section class="welcome-view">
    <span class="eyebrow">A QUIET PLACE FOR WHAT MATTERS</span>
    <div class="welcome-seal" aria-hidden="true">日<br />进</div>
    <h1>把想去的地方，<br /><em>走成今天的一小步。</em></h1>
    <p>为长期愿望找到方向，也为今天留下一点行动。慢慢来，每一步都算数。</p>
    <div class="welcome-actions"><button class="button button-primary" type="button" data-action="auth-register">开始记录</button><button class="button button-quiet" type="button" data-action="auth-login">已有账号 · 登录</button></div>
    <div class="welcome-footnote"><span>01 / 长期目标拆解</span><span>02 / 每日行动打卡</span><span>03 / 进度回望</span></div>
  </section>`;
  bindActions($('#viewRoot'));
  updateUserChrome();
}

function renderToday() {
  const completed = app.tasks.filter((task) => task.completed).length;
  const total = app.tasks.length;
  const progress = total ? Math.round(completed / total * 100) : 0;
  const headingDate = app.today ? formatDate(app.today, { month: 'long', day: 'numeric', weekday: 'long' }, app.user.timezone) : '';
  const welcome = !app.goals.length && !app.tasks.length;
  const taskContent = total ? `
    <div class="today-progress"><span>今天完成</span><strong>${completed}</strong><span>/ ${total}</span><span class="progress-label">项行动</span><div class="progress-track" aria-label="今日完成 ${progress}%"><div class="progress-fill" style="width:${progress}%"></div></div></div>
    <ul class="task-list" aria-label="今日行动">${app.tasks.map(renderTask).join('')}</ul>
    <div class="add-task-row"><button class="text-button add-task-button" type="button" data-action="add-task"><span class="plus">+</span> 添加一项行动</button></div>
  ` : `
    <section class="empty-day">
      <div class="empty-illustration"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-8-4.4-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.6-8 11-8 11Z"/><path d="M8.5 12h7m-3.5-3.5v7"/></svg></div>
      <h2>${welcome ? '从一个小小的行动开始' : '今天的纸页，还空着'}</h2>
      <p>${welcome ? '不必一次想得很远。先写下一件今天愿意完成的小事，也可以先种下一个长期目标。' : '给今天添一件具体的小事。完成后，回来轻轻点一下。'}</p>
      <button class="button button-primary" type="button" data-action="add-task">写下今天的第一步</button>
      ${welcome ? '<button class="text-button" type="button" data-action="add-goal">先设定一个长期目标</button>' : ''}
    </section>
  `;
  return `
    <header class="view-heading">
      <div><span class="eyebrow">ONE SMALL STEP · ${escapeHtml(app.today)}</span><h1>今天，做一点</h1><p>专注当下，积累复利。</p></div>
      <div class="heading-date"><strong>${escapeHtml(headingDate)}</strong>${escapeHtml(app.user.timezone)}</div>
    </header>
    <div class="section-kicker">今日行动<small>${total ? `${completed} / ${total}` : '留一点空间给自己'}</small></div>
    ${taskContent}
    <p class="today-quote"><span class="quote-star" aria-hidden="true">✦</span> 微小的行动，带来持续的改变。 <em>给自己一点时间</em></p>
  `;
}

function renderTask(task) {
  const context = [task.goalTitle, task.milestoneTitle].filter(Boolean).map(escapeHtml).join(' · ');
  return `<li class="task-row ${task.completed ? 'is-complete' : ''}" data-task-id="${escapeHtml(task.id)}">
    <button class="check-button" type="button" data-action="toggle-task" aria-label="${task.completed ? '取消完成' : '标记完成'}：${escapeHtml(task.title)}" aria-pressed="${task.completed}">${checkIcon}</button>
    <div class="task-copy"><div class="task-title">${escapeHtml(task.title)}</div><div class="task-subtitle">${context ? `<span class="task-link">${context}</span>` : task.completed ? '今天的一步，已经记下' : '待完成'}</div></div>
    <div class="task-actions"><span class="task-time">${task.completed && task.completedAt ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: app.user.timezone }).format(new Date(task.completedAt)) : ''}</span><span class="task-state">${task.completed ? '已完成' : '待完成'}</span><button class="icon-button task-delete" type="button" data-action="delete-task" aria-label="删除行动：${escapeHtml(task.title)}" title="删除"><span aria-hidden="true">×</span></button></div>
  </li>`;
}

function renderMiniTrack(goal) {
  if (!goal.milestones.length) return `<div class="goal-meta"><span>累计行动</span><b>${goal.progressDone} / ${goal.progressTotal || 0}</b><span class="meta-dot">•</span><span>${goal.progressTotal ? '已有日常行动关联' : '还没有阶段'}</span></div>`;
  const nextIndex = goal.milestones.findIndex((milestone) => !milestone.completed);
  const shownMilestones = goal.milestones.length > 5 ? [...goal.milestones.slice(0, 4), goal.milestones.at(-1)] : goal.milestones;
  const nodes = shownMilestones.map((milestone, index) => {
    const actualIndex = goal.milestones.findIndex((item) => item.id === milestone.id);
    return `<div class="mini-node ${milestone.completed ? 'is-done' : actualIndex === nextIndex ? 'is-next' : ''}" title="${escapeHtml(milestone.title)}"><span class="mini-dot"></span><span class="mini-title">${escapeHtml(milestone.title)}</span><span class="mini-status">${milestone.completed ? '已完成' : actualIndex === nextIndex ? '进行中' : '未开始'}</span></div>`;
  }).join('');
  const done = goal.milestones.filter((item) => item.completed).length;
  return `<div class="milestone-track" style="--count:${shownMilestones.length};--progress-width:${goal.progress}%">${nodes}</div><div class="goal-meta"><span>里程碑</span><b>${done} / ${goal.milestones.length}</b>${goal.deadline ? `<span class="meta-dot">•</span><span>预计 ${escapeHtml(shortDate(goal.deadline))}</span>` : ''}</div>`;
}

function renderRightPanel() {
  const panel = $('#rightPanel');
  const goals = app.goals.slice(0, 3);
  const goalBlock = goals.length ? goals.map((goal, index) => `<article class="goal-preview">
      <div class="goal-preview-top"><span class="goal-index">${String(index + 1).padStart(2, '0')}</span><span class="goal-preview-name" title="${escapeHtml(goal.title)}">${escapeHtml(goal.title)}</span><strong class="goal-percent">${goal.progress}%</strong></div>
      ${goal.deadline ? `<div class="goal-deadline">目标日期：${escapeHtml(goal.deadline.replaceAll('-', ' / '))}</div>` : ''}
      ${renderMiniTrack(goal)}
    </article>`).join('') : `<div class="right-empty">还没有长期目标。<br />把心里那个愿望，拆成几个看得见的阶段。<br /><button class="text-button" type="button" data-action="add-goal">＋ 设定第一个目标</button></div>`;
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  const days = app.week.map((day, index) => {
    const completedDay = day.total > 0 && day.completed === day.total;
    const isToday = day.date === app.today;
    const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
    const partial = day.completed > 0 && !completedDay;
    return `<div class="week-day ${completedDay ? 'has-progress' : ''} ${partial ? 'is-partial' : ''} ${isToday ? 'is-today' : ''}" title="${day.completed} / ${day.total} 项完成"><span class="week-name">${weekdays[(weekday + 6) % 7]}</span><span class="week-check">${completedDay ? checkIcon : partial ? '·' : ''}</span><span class="week-date">${escapeHtml(shortDate(day.date))}</span></div>`;
  }).join('');
  const best = app.week.filter((day) => day.total > 0 && day.completed === day.total).length;
  const notification = app.user.reminderEnabled ? '' : `<div class="notification-nudge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 13h4"/></svg><span>晚上 6 点还没打卡？<a href="/?view=settings" data-action="go-notifications">开启温柔提醒</a></span></div>`;
  panel.innerHTML = `<section class="aside-section"><div class="aside-header"><h2>长期目标</h2><button class="text-button" type="button" data-action="add-goal">＋ 添加</button></div><div class="goal-preview-list">${goalBlock}</div>${app.goals.length > 3 ? '<div class="aside-header" style="margin:16px 0 0"><a href="/?view=goals" data-action="go-goals">查看全部目标 →</a></div>' : ''}</section>
    <section class="aside-section week-section"><div class="aside-header"><h2>近七天打卡</h2><a href="/?view=history" data-action="go-history">看记录 →</a></div><div class="week-grid">${days}</div><p class="week-summary">近七天完整完成 <strong>${best}</strong> <span class="muted">/ 7 天</span></p>${notification}</section>`;
  bindActions(panel);
}

function renderGoals() {
  const body = app.goals.length ? app.goals.map((goal, index) => {
    const milestones = goal.milestones.length ? `<ul class="milestone-list">${goal.milestones.map((milestone) => `<li class="milestone-item ${milestone.completed ? 'is-done' : ''}" data-milestone-id="${escapeHtml(milestone.id)}"><button class="milestone-toggle" type="button" data-action="toggle-milestone" aria-label="${milestone.completed ? '标记未完成' : '标记完成'}：${escapeHtml(milestone.title)}" aria-pressed="${milestone.completed}">${checkIcon}</button><span class="milestone-name">${escapeHtml(milestone.title)}</span><button class="icon-button milestone-remove" type="button" data-action="delete-milestone" aria-label="删除阶段：${escapeHtml(milestone.title)}" title="删除阶段"><span aria-hidden="true">×</span></button></li>`).join('')}</ul>` : `<p class="history-empty">还没有阶段。把目标拆成几步，会更容易知道下一步从哪里开始。</p>`;
    return `<article class="goal-card" data-goal-id="${escapeHtml(goal.id)}">
      <header class="goal-card-header"><span class="goal-card-index">${String(index + 1).padStart(2, '0')}</span><div class="goal-card-copy"><h2 class="goal-card-title">${escapeHtml(goal.title)}</h2><div class="goal-card-meta"><span>${goal.deadline ? `目标日期 <strong>${escapeHtml(goal.deadline)}</strong>` : '按自己的节奏前进'}</span><span>·</span><span>总体进度 <strong>${goal.progress}%</strong></span></div>${goal.description ? `<p class="goal-card-description">${escapeHtml(goal.description)}</p>` : ''}</div><div class="goal-card-actions"><button class="icon-button" type="button" data-action="edit-goal" aria-label="编辑目标" title="编辑目标"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15l-0 5Z"/></svg></button><button class="icon-button" type="button" data-action="delete-goal" aria-label="删除目标" title="删除目标"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg></button></div></header>
      <div class="goal-progress-line" aria-label="总体进度 ${goal.progress}%"><span style="width:${goal.progress}%"></span></div>
      <div class="history-list-header"><h2>阶段与里程碑</h2><span>${goal.milestones.length} 个阶段</span></div>
      ${milestones}
      <footer class="goal-card-footer"><button class="text-button" type="button" data-action="add-milestone">＋ 添加阶段</button><button class="text-button milestone-task" type="button" data-action="add-linked-task">＋ 关联今日行动</button><span class="goal-progress-caption">${goal.progressDone} / ${goal.progressTotal || 0} 已完成</span></footer>
    </article>`;
  }).join('') : `<section class="goals-empty"><div class="empty-illustration"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/><path d="m13 11 7-7"/></svg></div><h2>你想去的地方，可以慢慢说清楚</h2><p>先给愿望一个名字，再用几个阶段把它拆开。每一天的行动，都能和它连起来。</p><button class="button button-primary" type="button" data-action="add-goal">设定第一个长期目标</button></section>`;
  return `<header class="view-heading"><div><span class="eyebrow">GROW AT YOUR OWN PACE</span><h1>长期目标</h1><p>把远方拆开，每一步都有回响。</p></div><button class="button button-primary heading-action" type="button" data-action="add-goal"><span aria-hidden="true">＋</span> 新目标</button></header><div class="view-content">${body}</div>`;
}

function historyCalendar() {
  if (!app.history) return '<div class="history-empty">正在整理你的打卡记录…</div>';
  const { firstWeekday, lastDay, days, month } = app.history;
  const [year, monthNumber] = month.split('-').map(Number);
  const startOffset = (firstWeekday + 6) % 7;
  const cells = [];
  for (let offset = 0; offset < 42; offset += 1) {
    const day = offset - startOffset + 1;
    if (day < 1 || day > lastDay) {
      cells.push('<div class="calendar-cell calendar-day is-outside" aria-hidden="true"></div>');
      continue;
    }
    const date = `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const summary = days[date] || { total: 0, completed: 0 };
    const pct = summary.total ? Math.round(summary.completed / summary.total * 100) : 0;
    const today = date === app.today;
    const selected = date === app.selectedHistoryDate;
    cells.push(`<button class="calendar-cell calendar-day ${today ? 'is-today' : ''} ${selected ? 'is-selected' : ''}" type="button" data-action="select-history-date" data-date="${date}" aria-label="${date}，完成 ${summary.completed} 项，共 ${summary.total} 项" aria-pressed="${selected}"><span class="calendar-number">${day}</span>${summary.total ? `<span class="calendar-bar"><span style="width:${pct}%"></span></span><span class="calendar-count">${summary.completed}/${summary.total}</span>` : '<span class="calendar-count">&nbsp;</span>'}</button>`);
  }
  return `<div class="calendar">${['一', '二', '三', '四', '五', '六', '日'].map((day) => `<div class="calendar-cell calendar-label">${day}</div>`).join('')}${cells.join('')}</div>`;
}

function renderHistory() {
  const date = app.historyMonth || app.today.slice(0, 7);
  const [year, month] = date.split('-').map(Number);
  const label = `${year} 年 ${String(month).padStart(2, '0')} 月`;
  const summaries = app.history?.days || {};
  const values = Object.values(summaries);
  const totalChecks = values.reduce((sum, item) => sum + item.completed, 0);
  const taskCount = values.reduce((sum, item) => sum + item.total, 0);
  const perfectDays = values.filter((item) => item.total > 0 && item.completed === item.total).length;
  const selected = app.selectedHistoryDate || app.today;
  const selectedDay = app.selectedHistoryDay;
  const grouped = selectedDay?.tasks || [];
  const groupTasks = grouped.length ? grouped.map((task) => `<div class="history-row"><span class="history-check">${checkIcon}</span><span class="history-row-title">${escapeHtml(task.title)}</span><span class="history-row-context">${escapeHtml([task.goalTitle, task.milestoneTitle].filter(Boolean).join(' · '))}</span><span class="history-row-time">${task.completedAt ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: app.user.timezone }).format(new Date(task.completedAt)) : '—'}</span></div>`).join('') : '<p class="history-empty">这一天还没有行动记录。给自己留白，也是一种安排。</p>';
  return `<header class="view-heading"><div><span class="eyebrow">SMALL STEPS, REMEMBERED</span><h1>完成记录</h1><p>回头看，你已经走了这么多。</p></div><div class="heading-date"><strong>${app.history ? `${perfectDays} 天` : '—'}</strong>本月完整完成</div></header><div class="history-toolbar"><span class="month-label">${label}</span><div class="month-controls"><button type="button" data-action="history-prev" aria-label="上一个月">${arrowLeft}</button><button type="button" data-action="history-next" aria-label="下一个月">${arrowRight}</button></div></div>${historyCalendar()}<div class="history-summary"><strong>${totalChecks}</strong><span>项行动已完成</span><span>·</span><span>共安排 ${taskCount} 项</span></div><section class="history-list"><header class="history-list-header"><h2>${escapeHtml(formatDate(selected, { month: 'long', day: 'numeric', weekday: 'long' }, 'UTC'))}</h2><span>${selectedDay ? `${selectedDay.summary.completed} / ${selectedDay.summary.total} 完成` : '选择一天查看'}</span></header>${groupTasks}</section>`;
}

function renderSettings() {
  const settings = app.settings;
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const subscribed = Boolean(app.deviceSubscribed && settings?.subscriptionCount);
  let statusText = '尚未开启';
  let statusClass = '';
  let description = '我们会在你所在时区的 18:00 检查当天行动。若还有未完成项，会尝试发送一次浏览器推送；全部完成则安静略过。';
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusText = '不支持'; statusClass = 'is-warn'; description = '当前浏览器不支持 Web Push。你仍然可以正常使用目标与打卡功能。建议使用最新版 Chrome、Edge、Firefox 或 Safari。';
  } else if (permission === 'denied') {
    statusText = '权限被拒'; statusClass = 'is-warn'; description = '浏览器已阻止通知。请到地址栏的站点权限或浏览器设置中重新允许通知，再返回这里开启。';
  } else if (app.user?.reminderEnabled && subscribed) {
    statusText = '已开启'; statusClass = 'is-on'; description = '已保存这台设备的推送订阅。每天 18:00（按所选时区），若仍有未完成行动，后台会尝试发送一次提醒。';
  } else if (app.user?.reminderEnabled && !subscribed) {
    statusText = '需重新开启'; statusClass = 'is-warn'; description = '账号设置为开启，但这台设备的推送订阅已不存在。请重新开启浏览器通知以恢复提醒。';
  } else if (permission === 'granted' && !subscribed) {
    statusText = '可以开启'; statusClass = 'is-on'; description = '浏览器已允许通知。点击开启后，会为这台设备建立推送订阅。';
  }
  const timezone = settings?.timezone || app.user?.timezone || localTimezone();
  let deliveryStatus = '还没有后台发送记录。提醒仅在当天存在未完成行动时尝试发送。';
  let deliveryAlertClass = '';
  if (settings?.lastReminderStatus) {
    const stamp = settings.lastReminderAt ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: settings.timezone || timezone }).format(new Date(settings.lastReminderAt)) : '';
    if (settings.lastReminderStatus === 'accepted') deliveryStatus = `最近一次（${stamp}）：推送服务已接受消息；这不代表浏览器或操作系统已经显示通知。`;
    else if (settings.lastReminderStatus === 'failed') { deliveryStatus = `最近一次（${stamp}）未获推送服务接受${settings.lastReminderError ? `：${settings.lastReminderError}` : ''}。后台会在今天稍后重试。`; deliveryAlertClass = 'is-error'; }
    else if (settings.lastReminderStatus === 'sending') { deliveryStatus = `最近一次发送（${stamp}）结果暂未确认。`; deliveryAlertClass = 'is-error'; }
    else if (settings.lastReminderStatus === 'no_subscription') { deliveryStatus = '没有可用的浏览器推送订阅，请在这台设备重新开启提醒。'; deliveryAlertClass = 'is-error'; }
  }
  const reminderEnabled = Boolean(app.user?.reminderEnabled && subscribed);
  return `<header class="view-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h1>设置</h1><p>找到适合自己的节奏。</p></div></header>
    <div class="view-content">
      <section class="settings-group"><h2>每日提醒</h2><p>每天晚上 6 点，在你所在的时间里，轻轻提醒还没完成的行动。</p><div class="settings-row"><div class="settings-row-copy"><strong>浏览器推送</strong><span>${escapeHtml(description)}</span></div><span class="status-pill ${statusClass}">${statusText}</span></div><div class="settings-actions">${reminderEnabled ? '<button class="button button-quiet" type="button" data-action="disable-push">关闭全部提醒</button><button class="button button-outline" type="button" data-action="test-push">发送测试提醒</button>' : `<button class="button button-primary" type="button" data-action="enable-push" ${(!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window) || permission === 'denied') ? 'disabled' : ''}>${permission === 'denied' ? '请先在浏览器设置允许' : !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window) ? '此浏览器不支持推送' : '开启 18:00 提醒'}</button>`}</div><p class="settings-hint">提醒只在当天确有未完成的行动时发出；如当天全部完成，不会打扰你。推送可能受到操作系统、省电模式和网络状况影响。</p><p class="notice ${deliveryAlertClass}">${escapeHtml(deliveryStatus)}</p></section>
      <section class="settings-group"><h2>所在地时间</h2><p>用于判断每天的 18:00。跨时区旅行时，可以在这里调整。</p><label class="field-label timezone-label" for="timezoneSelect">提醒时区</label><input id="timezoneSelect" class="timezone-select" type="text" list="timezoneOptionList" autocomplete="off" spellcheck="false" aria-describedby="timezoneHint" value="${escapeHtml(timezone)}" /><datalist id="timezoneOptionList">${timezoneOptions(timezone)}</datalist><div class="settings-actions"><button class="button button-outline" type="button" data-action="save-timezone">保存时区</button></div><p class="settings-hint" id="timezoneHint">当前设备检测到：${escapeHtml(localTimezone())}。可输入或选择 IANA 时区名称；系统按当地日历处理夏令时。</p></section>
      <section class="settings-group"><h2>账户与隐私</h2><div class="account-card"><span class="avatar">${escapeHtml((app.user.email.split('@')[0] || '进').slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(app.user.email)}</strong><span>你的目标、记录和提醒设置仅对这个账号可见。</span></div></div><div class="settings-actions"><button class="button button-quiet" type="button" data-action="logout">退出登录</button></div></section>
      <p class="notice">推送需要浏览器允许通知，并且服务器持续运行。若浏览器不支持、权限被拒、设备离线或推送订阅失效，我们会显示当前状态，不会将失败说成已送达。</p>
    </div>`;
}

function timezoneOptions(selected) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney', 'Europe/London', 'Europe/Paris', 'America/Los_Angeles', 'America/New_York', 'UTC']; }
  if (selected && !zones.includes(selected)) zones.unshift(selected);
  if (!zones.includes('UTC')) zones.push('UTC');
  return zones.map((zone) => `<option value="${escapeHtml(zone)}" ${zone === selected ? 'selected' : ''}>${escapeHtml(zone.replaceAll('_', ' '))}</option>`).join('');
}

function bindViewActions() {
  bindActions($('#viewRoot'));
}

function bindActions(root = document) {
  root.querySelectorAll('[data-action]').forEach((element) => {
    if (element.dataset.bound) return;
    element.dataset.bound = 'true';
    element.addEventListener('click', async (event) => {
        const action = element.dataset.action;
      const row = element.closest('[data-task-id], [data-goal-id], [data-milestone-id]');
      try {
        if (action === 'auth-register') { setAuthMode('register'); $('#authDialog').showModal(); }
        else if (action === 'auth-login') { setAuthMode('login'); $('#authDialog').showModal(); }
        else if (action === 'add-task') openTaskDialog();
        else if (action === 'add-goal') openGoalDialog();
        else if (action === 'go-notifications') { event.preventDefault(); setView('settings'); }
        else if (action === 'go-goals') { event.preventDefault(); setView('goals'); }
        else if (action === 'go-history') { event.preventDefault(); setView('history'); }
        else if (action === 'toggle-task') await toggleTask(row.dataset.taskId);
        else if (action === 'delete-task') await deleteTask(row.dataset.taskId);
        else if (action === 'edit-goal') openGoalDialog(goalById(row.dataset.goalId));
        else if (action === 'delete-goal') confirmDeleteGoal(row.dataset.goalId);
        else if (action === 'add-milestone') openMilestoneDialog(row.dataset.goalId);
        else if (action === 'toggle-milestone') await toggleMilestone(row.dataset.milestoneId, element.getAttribute('aria-pressed') !== 'true');
        else if (action === 'delete-milestone') await deleteMilestone(row.dataset.milestoneId);
        else if (action === 'add-linked-task') openTaskDialog({ goalId: row.dataset.goalId });
        else if (action === 'history-prev' || action === 'history-next') await shiftHistory(action === 'history-prev' ? -1 : 1);
        else if (action === 'select-history-date') await selectHistoryDate(element.dataset.date);
        else if (action === 'enable-push') await enablePush(element);
        else if (action === 'disable-push') await disablePush(element);
        else if (action === 'test-push') await testPush(element);
        else if (action === 'save-timezone') await saveTimezone(element);
        else if (action === 'logout') await logout();
      } catch (error) {
        toast(error.message || '操作没有完成，请稍后重试。', 'error');
      }
    });
  });
}

function openTaskDialog(options = {}) {
  const form = $('#taskForm');
  form.reset();
  $('#taskError').textContent = '';
  $('#taskDate').value = options.date || app.today || isoDate(new Date());
  const goalSelect = $('#taskGoal');
  goalSelect.innerHTML = '<option value="">暂不关联</option>' + app.goals.map((goal) => `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.title)}</option>`).join('');
  if (options.goalId) goalSelect.value = options.goalId;
  updateTaskMilestones(options.milestoneId || '');
  $('#taskDialog').showModal();
  window.setTimeout(() => $('#taskTitle').focus(), 40);
}

function updateTaskMilestones(selected = '') {
  const goal = goalById($('#taskGoal').value);
  const wrap = $('#taskMilestoneWrap');
  wrap.hidden = !goal?.milestones.length;
  $('#taskMilestone').innerHTML = '<option value="">暂不关联</option>' + (goal?.milestones || []).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join('');
  $('#taskMilestone').value = selected;
}

function openGoalDialog(goal = null) {
  const form = $('#goalForm');
  form.reset();
  $('#goalError').textContent = '';
  $('#goalEditId').value = goal?.id || '';
  $('#goalDialogTitle').textContent = goal ? '调整长期目标' : '设定一个长期目标';
  $('#goalMilestonesFields').hidden = Boolean(goal);
  $('#goalTitle').value = goal?.title || '';
  $('#goalDescription').value = goal?.description || '';
  $('#goalDeadline').value = goal?.deadline || '';
  $('#goalMilestones').value = '';
  $('#goalDialog').showModal();
  window.setTimeout(() => $('#goalTitle').focus(), 40);
}

function openMilestoneDialog(goalId) {
  const goal = goalById(goalId);
  if (!goal) return;
  $('#milestoneForm').reset();
  $('#milestoneError').textContent = '';
  $('#milestoneForm').dataset.goalId = goalId;
  $('#milestoneGoalLabel').textContent = goal.title;
  $('#milestoneDialog').showModal();
  window.setTimeout(() => $('#milestoneTitle').focus(), 40);
}

async function toggleTask(id) {
  const task = app.tasks.find((item) => item.id === id);
  if (!task) return;
  const result = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ completed: !task.completed }) });
  app.tasks = result.bootstrap.tasks;
  app.goals = result.bootstrap.goals;
  app.week = result.bootstrap.week;
  app.user = result.bootstrap.user;
  render();
  toast(task.completed ? '行动已恢复为待完成。' : '做得好，这一步已经记下。');
}

async function deleteTask(id) {
  await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refresh(); render(); toast('这项行动已移除。');
}

async function toggleMilestone(id, completed) {
  const result = await api(`/api/milestones/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ completed }) });
  app.goals = result.goals;
  render(); toast(completed ? '阶段完成，离目标又近了一点。' : '阶段已重新打开。');
}

async function deleteMilestone(id) {
  await api(`/api/milestones/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refresh(); render(); toast('阶段已删除。');
}

function confirmDeleteGoal(id) {
  const goal = goalById(id);
  if (!goal) return;
  $('#confirmTitle').textContent = `删除「${goal.title}」？`;
  $('#confirmText').textContent = '相关阶段会删除；每日行动记录会保留，但会解除与此目标的关联。目标删除后无法恢复。';
  app.confirmAction = async () => {
    await api(`/api/goals/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await refresh(); render(); toast('目标和相关内容已删除。');
  };
  $('#confirmDialog').showModal();
}

async function loadHistory() {
  if (!app.historyMonth) app.historyMonth = (app.today || isoDate(new Date())).slice(0, 7);
  if (!app.selectedHistoryDate) app.selectedHistoryDate = app.today || isoDate(new Date());
  app.history = null;
  app.selectedHistoryDay = null;
  render();
  try {
    app.history = await api(`/api/history?month=${encodeURIComponent(app.historyMonth)}`);
    app.selectedHistoryDay = await api(`/api/day?date=${encodeURIComponent(app.selectedHistoryDate)}`);
  } catch (error) { toast(error.message, 'error'); }
  render();
}

async function selectHistoryDate(date) {
  app.selectedHistoryDate = date;
  app.selectedHistoryDay = await api(`/api/day?date=${encodeURIComponent(date)}`);
  render();
}

async function shiftHistory(direction) {
  const [year, month] = app.historyMonth.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + direction, 1));
  app.historyMonth = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  app.history = null;
  app.selectedHistoryDate = '';
  await loadHistory();
}

async function loadSettings() {
  try {
    app.settings = await api('/api/settings');
    await registerServiceWorkerIfPossible();
    try {
      const registration = await navigator.serviceWorker?.getRegistration('/');
      app.deviceSubscribed = Boolean(await registration?.pushManager?.getSubscription());
    } catch { app.deviceSubscribed = false; }
    render();
  } catch (error) { toast(error.message, 'error'); }
}

async function saveTimezone(button) {
  const previous = button.textContent;
  button.disabled = true;
  try {
    const timezone = $('#timezoneSelect').value;
    const updated = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ timezone, reminderEnabled: Boolean(app.user.reminderEnabled) }) });
    app.user = updated.user;
    await refresh();
    app.settings = await api('/api/settings');
    render(); toast('提醒时区已保存。');
  } finally { button.disabled = false; button.textContent = previous; }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function getServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('这款浏览器不支持 Service Worker，暂时无法使用关闭网页后的提醒。');
  if (!window.isSecureContext) throw new Error('浏览器推送需要 HTTPS 安全连接。localhost 开发地址除外。');
  app.serviceWorker = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

async function registerServiceWorkerIfPossible() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    app.serviceWorker = app.serviceWorker || await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return app.serviceWorker;
  } catch { return null; }
}

async function enablePush(button) {
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) throw new Error('当前浏览器不支持浏览器推送提醒。');
  if (!window.isSecureContext) throw new Error('开启浏览器推送需要 HTTPS 安全连接。');
  if (Notification.permission === 'denied') throw new Error('浏览器已拒绝通知。请先在浏览器设置中重新允许，再回来开启。');
  button.disabled = true;
  const original = button.textContent;
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission === 'denied' ? '你拒绝了通知权限。可以在浏览器站点设置中重新允许。' : '还没有获得通知权限，因此没有开启提醒。');
    const registration = await getServiceWorker();
    app.settings ||= await api('/api/settings');
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(app.settings.publicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) });
    app.deviceSubscribed = true;
    const timezone = $('#timezoneSelect')?.value || app.settings.timezone || localTimezone();
    const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ timezone, reminderEnabled: true }) });
    app.user = result.user;
    app.settings = await api('/api/settings');
    await refresh();
    render();
    toast('提醒已开启。每天 18:00，我们会在有未完成行动时尝试提醒。');
  } catch (error) {
    toast(error.message || '没有成功开启提醒。', 'error');
  } finally { button.disabled = false; button.textContent = original; }
}

async function disablePush(button) {
  button.disabled = true;
  try {
    const registration = await navigator.serviceWorker?.getRegistration('/');
    const subscription = await registration?.pushManager?.getSubscription();
    await api('/api/push/unsubscribe', { method: 'POST', body: '{}' });
    if (subscription) await subscription.unsubscribe().catch(() => false);
    app.deviceSubscribed = false;
    await refresh();
    app.settings = await api('/api/settings');
    render();
    toast('这个账号在所有设备上的每日提醒都已关闭。');
  } finally { button.disabled = false; }
}

async function testPush(button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '正在发送…';
  try {
    await api('/api/push/test', { method: 'POST', body: '{}' });
    toast('推送服务已接受测试消息。若设备或系统拦截通知，可能仍不会显示。');
  } finally { button.disabled = false; button.textContent = original; }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  app.user = null; app.goals = []; app.tasks = []; app.week = [];
  app.view = 'today';
  const url = new URL(window.location.href);
  url.searchParams.set('view', 'today');
  window.history.replaceState({ view: 'today' }, '', url);
  render();
  updateUserChrome();
  toast('你已安全退出。');
}

function setAuthMode(mode) {
  app.authMode = mode;
  const isLogin = mode === 'login';
  $('#authTitle').textContent = isLogin ? '欢迎回来' : '从今天开始';
  $('#authLead').textContent = isLogin ? '让每一次小小的坚持，都看得见。' : '创建你的私人空间，慢慢走向想去的地方。';
  $('#authSubmit').textContent = isLogin ? '登录' : '创建账号';
  $('#authSwitch').textContent = isLogin ? '还没有账号？创建一个' : '已经有账号？直接登录';
  $('#authPassword').autocomplete = isLogin ? 'current-password' : 'new-password';
  $('#authPassword').value = '';
  $('#authError').textContent = '';
}

async function submitAuth(event) {
  event.preventDefault();
  const button = $('#authSubmit');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = app.authMode === 'login' ? '正在登录…' : '正在创建…';
  $('#authError').textContent = '';
  const body = Object.fromEntries(new FormData($('#authForm')));
  body.timezone = localTimezone();
  try {
    const result = await api(app.authMode === 'login' ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
    app.user = result.user;
    app.today = result.today;
    app.tasks = result.tasks || [];
    app.goals = result.goals || [];
    app.week = result.week || [];
    $('#authDialog').close();
    updateUserChrome();
    const urlView = new URLSearchParams(window.location.search).get('view');
    app.view = ['today', 'goals', 'history', 'settings'].includes(urlView) ? urlView : 'today';
    render();
    if (app.view === 'history') loadHistory();
    if (app.view === 'settings') loadSettings();
    if (app.goals.length === 0 && app.tasks.length === 0) toast('欢迎来到日进。今天先从一小步开始。');
  } catch (error) { $('#authError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = original; }
}

async function submitTask(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData($('#taskForm')));
  $('#taskError').textContent = '';
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    $('#taskDialog').close();
    await refresh();
    if (app.view === 'today' && body.localDate === app.today) render();
    else if (app.view === 'history') await loadHistory();
    toast('行动已记下。');
  } catch (error) { $('#taskError').textContent = error.message; }
}

async function submitGoal(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData($('#goalForm')));
  const editId = body.editId;
  $('#goalError').textContent = '';
  try {
    if (editId) await api(`/api/goals/${encodeURIComponent(editId)}`, { method: 'PATCH', body: JSON.stringify(body) });
    else {
      body.milestones = body.milestones.split('\n').map((item) => item.trim()).filter(Boolean);
      await api('/api/goals', { method: 'POST', body: JSON.stringify(body) });
    }
    $('#goalDialog').close();
    await refresh(); render();
    if (app.view === 'today') renderRightPanel();
    toast(editId ? '目标信息已更新。' : '长期目标已种下。接下来可以把阶段变成今天的行动。');
  } catch (error) { $('#goalError').textContent = error.message; }
}

async function submitMilestone(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData($('#milestoneForm')));
  body.goalId = $('#milestoneForm').dataset.goalId;
  $('#milestoneError').textContent = '';
  try {
    await api('/api/milestones', { method: 'POST', body: JSON.stringify(body) });
    $('#milestoneDialog').close();
    await refresh(); render();
    toast('新阶段已添加。');
  } catch (error) { $('#milestoneError').textContent = error.message; }
}

async function init() {
  document.documentElement.lang = 'zh-CN';
  try { await refresh(); }
  catch (error) { toast(error.message, 'error'); }
  const initialView = new URLSearchParams(window.location.search).get('view');
  app.view = ['today', 'goals', 'history', 'settings'].includes(initialView) ? initialView : 'today';
  $$('.nav-item, .mobile-nav-item').forEach((item) => item.addEventListener('click', () => setView(item.dataset.view)));
  $('#mobileSettings').addEventListener('click', () => setView('settings'));
  $('#logoutButton').addEventListener('click', logout);
  $('#authForm').addEventListener('submit', submitAuth);
  $('#authSwitch').addEventListener('click', () => setAuthMode(app.authMode === 'login' ? 'register' : 'login'));
  $('#taskForm').addEventListener('submit', submitTask);
  $('#goalForm').addEventListener('submit', submitGoal);
  $('#milestoneForm').addEventListener('submit', submitMilestone);
  $('#taskGoal').addEventListener('change', () => updateTaskMilestones());
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  $('#confirmDialog').addEventListener('close', async (event) => {
    if (event.target.returnValue !== 'confirm' || !app.confirmAction) return;
    const action = app.confirmAction;
    app.confirmAction = null;
    try { await action(); } catch (error) { toast(error.message, 'error'); }
  });
  $('#confirmDelete').addEventListener('click', (event) => { event.preventDefault(); $('#confirmDialog').close('confirm'); });
  $$('.modal').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));
  window.addEventListener('popstate', async () => {
    const view = new URLSearchParams(window.location.search).get('view') || 'today';
    app.view = view;
    render();
    if (view === 'history') await loadHistory();
    if (view === 'settings') await loadSettings();
  });
  if (!app.user) {
    setAuthMode('login');
    renderSignedOut();
  } else {
    render();
    if (app.view === 'history') loadHistory();
    if (app.view === 'settings') loadSettings();
    registerServiceWorkerIfPossible();
  }
}

init();
