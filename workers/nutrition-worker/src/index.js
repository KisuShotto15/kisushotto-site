const TOKEN = '151322';
const KV_KEY = 'nutrition-state';

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

    if (!auth(request)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    if (request.method === 'GET') {
      const raw = await env.NUTRITION_KV.get(KV_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return json({ data });
    }

    if (request.method === 'POST') {
      const body = await request.text();
      await env.NUTRITION_KV.put(KV_KEY, body);
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  },
};
