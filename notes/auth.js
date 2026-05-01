// notes/auth.js — PIN modal + WebAuthn helpers.
// Session unlock keeps locked notes accessible for 1 minute.

import { apiSetPin, apiVerifyPin, apiRegWebauthn, apiGetWebauthn } from './api.js';

const SESSION_KEY = 'notes_unlocked_until';
const SESSION_MS = 1 * 60 * 1000;

export function isSessionUnlocked() {
  const until = parseInt(localStorage.getItem(SESSION_KEY) || '0', 10);
  return until > Date.now();
}

export function lockSession() {
  localStorage.removeItem(SESSION_KEY);
}

function markUnlocked() {
  localStorage.setItem(SESSION_KEY, String(Date.now() + SESSION_MS));
}

// ── PIN ───────────────────────────────────────────────────────────────────
export async function setPin(pin) {
  return apiSetPin(pin);
}

export async function verifyPin(pin) {
  const res = await apiVerifyPin(pin);
  if (res.valid) markUnlocked();
  return res.valid;
}

// ── WebAuthn (platform passkey) ──────────────────────────────────────────
function b64urlEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

export async function isWebauthnAvailable() {
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function registerWebauthn(email) {
  if (!await isWebauthnAvailable()) {
    throw new Error('Tu dispositivo no soporta autenticación biométrica.');
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userIdBytes = new TextEncoder().encode(email);

  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Notas — KS', id: location.hostname },
      user: {
        id: userIdBytes,
        name: email,
        displayName: email,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7  }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
      attestation: 'none',
    },
  });

  if (!cred) throw new Error('Registro cancelado');
  const credentialId = b64urlEncode(cred.rawId);
  // Store credential ID server-side (we use presence as proof during get())
  await apiRegWebauthn(credentialId, null);
  localStorage.setItem('notes_webauthn_id', credentialId);
  return credentialId;
}

export async function unlockWithWebauthn() {
  if (!await isWebauthnAvailable()) return false;
  let credId = localStorage.getItem('notes_webauthn_id');
  if (!credId) {
    try {
      const info = await apiGetWebauthn();
      credId = info.credentialId;
      if (credId) localStorage.setItem('notes_webauthn_id', credId);
    } catch { /* ignore */ }
  }
  if (!credId) return false;

  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const allowCredentials = [{
      type: 'public-key',
      id: b64urlDecode(credId),
      transports: ['internal'],
    }];
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        timeout: 60000,
        userVerification: 'required',
        allowCredentials,
        rpId: location.hostname,
      },
    });
    if (!assertion) return false;
    markUnlocked();
    return true;
  } catch {
    return false;
  }
}
