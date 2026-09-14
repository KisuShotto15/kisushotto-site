// notes/api.js — fetch wrapper hitting the notes-worker.
//
// La identidad es el JWT del sitio. Antes viajaban tres cosas y ninguna servia:
// un token compartido escrito en este archivo (y por tanto publico), un email en
// una cabecera, y una sesion que el worker emitia para cualquier email sin
// verificar ninguna firma WebAuthn.
import { requireSession, makeAuthFetch } from '../shared/site-auth.js';

const DEFAULT_BASE = 'https://notes-worker.efrenalejandro2010.workers.dev';
const APP = { app: 'Notas', prefix: 'notes' };

export const cfg = {
  base: () => localStorage.getItem('notes_url') || DEFAULT_BASE,
};

let session = null;
let afetch = null;

// Hay que llamarlo antes que nada: no resuelve hasta que hay sesion.
export async function initAuth() {
  session = await requireSession(APP);
  afetch = makeAuthFetch(session, APP);
  return session;
}

export function getUserEmail() {
  return session ? session.email() : null;
}

async function api(path, opts = {}) {
  if (!afetch) throw new Error('Sin sesion. Inicia sesion de nuevo.');
  const url = cfg.base() + path;
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof ArrayBuffer) && !(opts.body instanceof Blob)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const res = await afetch(url, { ...opts, headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${txt}`);
  }
  const ct = res.headers.get('Content-Type') || '';
  return ct.includes('application/json') ? res.json() : res;
}

export const apiGetMe        = ()                 => api('/me');
export const apiSetPin       = (pin)              => api('/me/pin',         { method: 'POST', body: JSON.stringify({ pin }) });
export const apiVerifyPin    = (pin)              => api('/me/pin/verify',  { method: 'POST', body: JSON.stringify({ pin }) });
export const apiRegWebauthn  = (cid, pk)          => api('/me/webauthn/register', { method: 'POST', body: JSON.stringify({ credentialId: cid, publicKey: pk }) });
export const apiGetWebauthn  = ()                 => api('/me/webauthn');
export const apiListPasskeys = ()                 => api('/auth/passkeys');
export const apiAddPasskey   = (credId, name)     => api('/auth/passkeys', { method: 'POST', body: JSON.stringify({ credentialId: credId, deviceName: name }) });
export const apiRenamePasskey = (credId, name)    => api(`/auth/passkey/${encodeURIComponent(credId)}`, { method: 'PATCH', body: JSON.stringify({ deviceName: name }) });
export const apiDeletePasskey = (credId)          => api(`/auth/passkey/${encodeURIComponent(credId)}`, { method: 'DELETE' });
export const apiSetPush      = (sub)              => api('/me/push',        { method: 'POST', body: JSON.stringify(sub) });
export const apiVapid        = ()                 => api('/vapid');

export const apiSyncPull     = (since = 0, before = null) =>
  api(`/sync?since=${since}${before != null ? `&before=${before}` : ''}`);
export const apiSyncPush     = (payload)          => api('/sync',           { method: 'POST', body: JSON.stringify(payload) });

export const apiCreateNote   = (note)             => api('/notes',          { method: 'POST', body: JSON.stringify(note) });
export const apiUpdateNote   = (id, patch)        => api(`/notes/${id}`,    { method: 'PATCH', body: JSON.stringify(patch) });
export const apiTrashNote    = (id)               => api(`/notes/${id}`,    { method: 'DELETE' });
export const apiRestoreNote  = (id)               => api(`/notes/${id}/restore`, { method: 'POST' });
export const apiPurgeNote    = (id)               => api(`/notes/${id}/purge`,   { method: 'DELETE' });

export const apiShareNote    = (id, email, edit=true) => api(`/notes/${id}/share`, { method: 'POST', body: JSON.stringify({ email, can_edit: edit }) });
export const apiRevokeShare  = (id, email)        => api(`/notes/${id}/share/${encodeURIComponent(email)}`, { method: 'DELETE' });

export const apiCreateCat    = (cat)              => api('/categories',     { method: 'POST', body: JSON.stringify(cat) });
export const apiUpdateCat    = (id, patch)        => api(`/categories/${id}`,{ method: 'PATCH', body: JSON.stringify(patch) });
export const apiDeleteCat    = (id)               => api(`/categories/${id}`,{ method: 'DELETE' });

export async function apiUploadAttachment(noteId, blob, type = 'image') {
  const url = `${cfg.base()}/attachments/upload?note_id=${encodeURIComponent(noteId)}&type=${type}`;
  const res = await afetch(url, {
    method: 'POST',
    body: blob,
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiDeleteAttachment(id) {
  return api(`/attachments/${id}`, { method: 'DELETE' });
}

export function apiAttachmentUrl(id) {
  // Returns a string URL; consumer must add headers via fetch (we'll embed via blob for img/audio)
  return `${cfg.base()}/attachments/${id}`;
}

export async function apiAttachmentBlobUrl(id) {
  const res = await afetch(apiAttachmentUrl(id));
  if (!res.ok) throw new Error('Attachment fetch failed');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
