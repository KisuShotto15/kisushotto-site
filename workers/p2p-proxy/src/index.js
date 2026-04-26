const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Secret',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

    const secret = request.headers.get('X-Api-Secret');
    if (env.API_SECRET && secret !== env.API_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }

    let bodyObj;
    try { bodyObj = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS }); }
    // Inject fields Binance requires to avoid 403
    const payload = JSON.stringify({ clientType: 'web', lang: 'en', ...bodyObj });
    const r = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://p2p.binance.com',
        'Referer': 'https://p2p.binance.com/es/trade/sell/USDT?fiat=VES',
      },
      body: payload,
    });
    const data = await r.text();
    return new Response(data, {
      status: r.status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  },
};
