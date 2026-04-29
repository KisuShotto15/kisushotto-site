const CACHE = 'ks-hub-v5';
const PRECACHE = ['/', '/manifest.json', '/icons/icon-192x192.png', '/icons/icon-512x512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Recordatorio', body: 'Tienes una nota' }; }
  const title = data.title || 'Notas';
  const body  = data.body  || '';
  const tag   = data.noteId ? `notes-${data.noteId}` : 'notes';
  const url   = data.noteId ? `/notes/?note=${encodeURIComponent(data.noteId)}` : '/notes/';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    icon: '/images/notes-icon.svg',
    badge: '/icons/icon-192x192.png',
    data: { url },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification?.data?.url
    || (e.notification.tag?.startsWith('notes') ? '/notes/' : '/habits/');
  e.waitUntil(clients.openWindow(target));
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
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
