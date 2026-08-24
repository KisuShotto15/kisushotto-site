// Lee por IMAP (App Password de Gmail, requiere 2FA activo en esa cuenta) los correos
// de confirmacion de Binance Pay y reconcilia pagos de suscripcion automaticamente.
// Se llama best-effort desde bot-tick.js; nunca debe tumbar el tick si falla.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { sql, ensurePlanColumn } from './db.js';
import { markPaid } from './subscriptions.js';
import { parsePaymentReceivedEmail } from './binancepay-email.js';

const POLL_THROTTLE_MS = 2 * 60 * 1000; // no vale la pena chequear el correo mas seguido
const BINANCE_FROM_RE = /@ses\.binance\.com$/i;

async function shouldPoll() {
  const rows = await sql`SELECT checked_at FROM email_payment_state WHERE id = 1`;
  const last = rows[0] && rows[0].checked_at ? new Date(rows[0].checked_at).getTime() : 0;
  return Date.now() - last >= POLL_THROTTLE_MS;
}

// Vence las facturas abandonadas (alguien toco "Ya pague" sin pagar de verdad, o el
// plan equivocado). Corre en CADA poll, no solo cuando llega un correo — si nadie
// paga nunca, un "Ya pague" falso se quedaria pending_review para siempre y (por el
// matching FIFO de abajo) le robaria el pago a la proxima persona que si pague.
async function expireStale() {
  await sql`
    UPDATE payment_invoices SET status = 'expired'
    WHERE status IN ('pending', 'pending_review') AND created_at < now() - interval '48 hours'`;
}

// Sin nick registrado (menos friccion en el onboarding): matchea contra la factura
// pendiente MAS VIEJA de todo el sistema (FIFO). Con 1-2 usuarios y un "Ya pague"
// justo antes de pagar, la ambiguedad es minima.
async function reconcilePayment(hit) {
  const inv = await sql`
    SELECT id, user_id FROM payment_invoices
    WHERE status IN ('pending', 'pending_review')
    ORDER BY created_at ASC LIMIT 1`;
  if (!inv.length) return false;
  return markPaid(inv[0].id, inv[0].user_id, null);
}

export async function checkPaymentEmails() {
  if (!(await shouldPoll())) return { skipped: 'throttled' };
  await ensurePlanColumn();
  await expireStale(); // corre siempre, aunque el IMAP no este configurado todavia

  const user = process.env.GMAIL_IMAP_USER;
  const pass = process.env.GMAIL_IMAP_APP_PASSWORD;
  if (!user || !pass) {
    await sql`UPDATE email_payment_state SET checked_at = now() WHERE id = 1`; // respeta el throttle igual
    return { skipped: 'no-config' };
  }

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
