/* EVE Chat local notification service worker v0.9.0 */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type !== 'eve-show-notification') return;
  event.waitUntil(self.registration.showNotification(data.title || 'EVE Chat', data.options || {}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || './';
  event.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(async clients => {
    for (const client of clients) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type:'eve-notification-click', url:target, data });
        return client;
      }
    }
    return self.clients.openWindow ? self.clients.openWindow(target) : null;
  }));
});
