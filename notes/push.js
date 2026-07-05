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
    // Validar la clave ANTES de suscribir para distinguir "clave mal generada"
    // de "el navegador no pudo registrarse con el push service".
    const rawKey = urlBase64ToUint8Array(key);
    if (rawKey.length !== 65 || rawKey[0] !== 0x04) {
      throw new Error('La clave VAPID_PUBLIC del servidor no es valida (debe ser un punto P-256 sin comprimir, 65 bytes en base64url). Regenera el par con "npx web-push generate-vapid-keys" y sube ambos secrets.');
    }
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: rawKey,
      });
    } catch (e) {
      // AbortError con clave valida = el navegador no llego a su push service.
      // En Brave esto pasa cuando "Usar servicios de Google para mensajes
      // push" esta desactivado (asi viene por defecto).
      if (e.name === 'AbortError') {
        throw new Error('El navegador no pudo registrarse con el servicio de push. Si usas Brave: abre brave://settings/privacy, activa "Usar servicios de Google para mensajes push" y reinicia el navegador.');
      }
      throw new Error(`Error al suscribir al push service: ${e.message}`);
    }
  }
  await apiSetPush(sub.toJSON());
  return sub;
}
