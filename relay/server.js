// Servidor para Google Cloud Run: el mismo relay que en Vercel, sin depender de el.
// Cloud Run da el puerto en PORT. Solo atiende POST /api/exchange-relay (y / para probar).
import http from 'node:http';
import handler from './relay.js';

const server = http.createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'GET') return send(200, { ok: true, relay: 'kisushotto' });
  if (!['/api/exchange-relay', '/'].includes(new URL(req.url, 'http://x').pathname)) return send(404, { error: 'ruta' });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2e6) return send(413, { error: 'muy grande' }); }
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'json' }); }
  let status = 200;
  const shim = { status(s) { status = s; return this; }, json(d) { send(status, d); return this; } };
  try { await handler({ method: req.method, headers: req.headers, body }, shim); }
  catch (e) { send(500, { error: e.message }); }
});
server.listen(process.env.PORT || 8080);
