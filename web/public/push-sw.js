/* Push only. No fetch handler, cache, authentication token or media storage. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function pushLink(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/notifications';
  const url = new URL(value, self.location.origin);
  if (url.origin !== self.location.origin) return '/notifications';
  if (/^\/live\?camera=[1-9]\d{0,9}&notice=[1-9]\d{0,15}$/.test(value) || value === '/settings#health' || value === '/settings#push') return url.href;
  return self.location.origin + '/notifications';
}
self.addEventListener('push', event => {
  let payload;
  try { payload = event.data.json(); } catch { return; }
  if (!payload || payload.version !== 1 || typeof payload.title !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.subscription_id)) return;
  event.waitUntil((async () => {
    // Reject a provider message queued before logout/expiry or for another login.
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    let live = false;
    try { live = (await fetch(`/api/operations/push/active/${payload.subscription_id}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })).status === 204; }
    catch { /* Offline or unverifiable sessions cannot display private alerts. */ }
    finally { clearTimeout(timer); }
    if (!live) return;
    return self.registration.showNotification(payload.title.slice(0, 100), {
    body: typeof payload.body === 'string' ? payload.body.slice(0, 140) : '',
    icon: '/brand/camera-mark.png', badge: '/brand/camera-mark.png',
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 80) : 'camera-station',
    renotify: false, silent: payload.silent === true, data: { url: pushLink(payload.url) },
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = pushLink(event.notification.data?.url?.replace(self.location.origin, ''));
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try { await client.navigate(target); return await client.focus(); }
      catch { /* A tab may close between enumeration and navigation. */ }
    }
    return self.clients.openWindow(target);
  })());
});
