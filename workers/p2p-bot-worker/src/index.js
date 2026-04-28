const TOKEN = '151322';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function auth(request) {
  return request.headers.get('Authorization') === `Bearer ${TOKEN}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!auth(request)) return json({ error: 'Unauthorized' }, 401);

    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const key  = path === '/enabled' ? 'p2p-bot-enabled' : 'p2p-bot-config';

    if (request.method === 'GET') {
      const raw = await env.P2P_BOT_KV.get(key);
      return json({ data: raw ? JSON.parse(raw) : null });
    }

    if (request.method === 'POST') {
      const body = await request.text();
      await env.P2P_BOT_KV.put(key, body);
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  },
};
