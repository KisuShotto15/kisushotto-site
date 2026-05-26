// notes/api.js — fetch wrapper hitting the notes-worker.

const DEFAULT_BASE  = 'https://notes-worker.efrenalejandro2010.workers.dev';
const DEFAULT_TOKEN = '151322';

export const cfg = {
  base:  () => localStorage.getItem('notes_url')   || DEFAULT_BASE,
  token: () => localStorage.getItem('notes_token') || DEFAULT_TOKEN,
};

export function getUserEmail() {
  const override = localStorage.getItem('notes_user');
  if (override) return override;

  const raw = document.cookie.split(';').map(c => c.trim())
    .find(c => c.startsWith('CF_Authorization='));
  if (!raw) return null;
  try {
    const tok = raw.split('=').slice(1).join('=');
    const payload = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email || null;
  } catch {
    return null;
  }
}

async function api(path, opts = {}) {
  const email = getUserEmail();
  if (!email) throw new Error('Sin identidad de usuario. Abre la app desde el dominio protegido.');
  const url = cfg.base() + path;
  const headers = {
    'Authorization': `Bearer ${cfg.token()}`,
    'X-User-Email':  email,
    ...(opts.headers || {}),
  };
  if (!(opts.body instanceof ArrayBuffer) && !(opts.body instanceof Blob)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const res = await fetch(url, { ...opts, headers });
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
export const apiSetPush      = (sub)              => api('/me/push',        { method: 'POST', body: JSON.stringify(sub) });
export const apiVapid        = ()                 => api('/vapid');

export const apiSyncPull     = (since = 0)        => api(`/sync?since=${since}`);
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
  const res = await fetch(url, {
    method: 'POST',
    body: blob,
    headers: {
      'Authorization': `Bearer ${cfg.token()}`,
      'X-User-Email':  getUserEmail(),
      'Content-Type':  blob.type || 'application/octet-stream',
    },
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
  const res = await fetch(apiAttachmentUrl(id), {
    headers: {
      'Authorization': `Bearer ${cfg.token()}`,
      'X-User-Email':  getUserEmail(),
    },
  });
  if (!res.ok) throw new Error('Attachment fetch failed');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
