/* 日进的后台推送入口。浏览器在网站关闭时收到推送后，也可由此展示通知。 */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; }
  catch { message = { body: event.data?.text() || '' }; }

  const title = message.title || '日进 · 还有一步';
  const options = {
    body: message.body || '今天还有行动没有打卡。',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: message.tag || 'daybyday-reminder',
    renotify: false,
    data: { url: message.url || '/?view=today' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || '/?view=today', self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        await client.focus();
        if ('navigate' in client && client.url !== destination) await client.navigate(destination);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(destination);
  })());
});
