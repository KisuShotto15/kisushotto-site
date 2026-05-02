// notes/push.js — Web Push subscription via service worker.

import { apiVapid, apiSetPush } from './api.js';

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

export async function ensurePushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push no disponible en este navegador');
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permiso de notificaciones denegado');

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await apiVapid();
    if (!key) throw new Error('VAPID_PUBLIC no configurada en el servidor. Ejecuta: wrangler secret put VAPID_PUBLIC');
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    } catch (e) {
      throw new Error(`Error al suscribir al push service: ${e.message}. Verifica que VAPID_PUBLIC sea una clave EC P-256 válida en base64url.`);
    }
  }
  await apiSetPush(sub.toJSON());
  return sub;
}
