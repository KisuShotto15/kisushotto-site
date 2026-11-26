// Entrada para Deno Deploy: el mismo relay que en Vercel, sin depender de el.
// Variable de entorno: RELAY_SECRET (la misma clave que el worker de Cloudflare).
import handler from './relay.js';

Deno.serve(async req => {
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method === 'GET') return json(200, { ok: true, relay: 'kisushotto' });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'json' }); }
  let status = 200, out = null;
  const res = { status(s) { status = s; return this; }, json(d) { out = d; return this; } };
  try { await handler({ method: req.method, headers: Object.fromEntries(req.headers), body }, res); }
  catch (e) { return json(500, { error: e.message }); }
  return json(status, out);
});
