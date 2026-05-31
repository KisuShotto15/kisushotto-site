const CACHE = 'ks-notes-v7';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(async () => {
        // Force reload all open tabs so they get fresh JS immediately
        const all = await self.clients.matchAll({ type: 'window' });
        all.forEach(c => c.navigate(c.url));
      })
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Recordatorio', body: 'Tienes una nota' }; }
  const title = data.title || 'Notas';
  const body  = data.body  || '';
  const tag   = data.noteId ? `notes-${data.noteId}` : 'notes';
  const url   = data.noteId ? `/?note=${encodeURIComponent(data.noteId)}` : '/';
  e.waitUntil(self.registration.showNotification(title, {
    body, tag,
    icon: '/images/notes-icon.svg',
    badge: '/icons/notes-192.png',
    data: { url },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification?.data?.url || '/'));
});

self.addEventListener('sync', e => {
  if (e.tag === 'notes-flush') {
    e.waitUntil((async () => {
      const cs = await self.clients.matchAll({ includeUncontrolled: true });
      for (const c of cs) c.postMessage({ type: 'flush-queue' });
    })());
  }
});

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  const url = new URL(e.request.url);
  // Network-first for app files so deploys take effect immediately
  if (url.origin === self.location.origin &&
      (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
