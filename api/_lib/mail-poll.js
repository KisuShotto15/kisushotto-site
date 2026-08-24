// Lee por IMAP (App Password de Gmail, requiere 2FA activo en esa cuenta) los correos
// de confirmacion de Binance Pay y reconcilia pagos de suscripcion automaticamente.
// Se llama best-effort desde bot-tick.js; nunca debe tumbar el tick si falla.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { sql } from './db.js';
import { markPaid } from './subscriptions.js';
import { parsePaymentReceivedEmail } from './binancepay-email.js';

const POLL_THROTTLE_MS = 2 * 60 * 1000; // no vale la pena chequear el correo mas seguido
const BINANCE_FROM_RE = /@ses\.binance\.com$/i;

async function shouldPoll() {
  const rows = await sql`SELECT checked_at FROM email_payment_state WHERE id = 1`;
  const last = rows[0] && rows[0].checked_at ? new Date(rows[0].checked_at).getTime() : 0;
  return Date.now() - last >= POLL_THROTTLE_MS;
}

// Matchea por nick del pagador (el Payment Link es de monto fijo: el monto solo no
// alcanza para distinguir dos pagos simultaneos de distintos usuarios).
async function reconcilePayment(hit) {
  const subs = await sql`SELECT user_id FROM subscriptions WHERE binance_nick = ${hit.senderNick}`;
  if (!subs.length) return false;
  const userId = subs[0].user_id;
  const inv = await sql`
    SELECT id FROM payment_invoices
    WHERE user_id = ${userId} AND status IN ('pending', 'pending_review')
    ORDER BY created_at DESC LIMIT 1`;
  if (!inv.length) return false;
  return markPaid(inv[0].id, userId, null);
}

export async function checkPaymentEmails() {
  const user = process.env.GMAIL_IMAP_USER;
  const pass = process.env.GMAIL_IMAP_APP_PASSWORD;
  if (!user || !pass) return { skipped: 'no-config' };
  if (!(await shouldPoll())) return { skipped: 'throttled' };

  const state = await sql`SELECT last_uid FROM email_payment_state WHERE id = 1`;
  const lastUid = Number((state[0] && state[0].last_uid) || 0);

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false,
  });

  let matched = 0, maxUid = lastUid, seen = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      if (!lastUid) {
        // Primer arranque: no barrer el historial completo del buzon (podria ser miles
        // de correos viejos). Solo marca el checkpoint en el presente y arranca desde ahi.
        maxUid = Math.max((client.mailbox && client.mailbox.uidNext || 1) - 1, 0);
      } else {
        const range = `${lastUid + 1}:*`;
        for await (const msg of client.fetch(range, { envelope: true, source: true }, { uid: true })) {
          if (msg.uid > maxUid) maxUid = msg.uid;
          const from = (msg.envelope && msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address) || '';
          if (!BINANCE_FROM_RE.test(from)) continue;
          seen++;
          const subject = (msg.envelope && msg.envelope.subject) || '';
          const parsed = await simpleParser(msg.source).catch(() => null);
          const text = (parsed && (parsed.text || parsed.html)) || '';
          const hit = parsePaymentReceivedEmail({ subject, text });
          if (hit && (await reconcilePayment(hit))) matched++;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  await sql`UPDATE email_payment_state SET last_uid = ${maxUid}, checked_at = now() WHERE id = 1`;
  return { seen, matched, lastUid: maxUid };
}
