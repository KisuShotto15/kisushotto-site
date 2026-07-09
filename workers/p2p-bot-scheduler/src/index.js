// Scheduler sub-minuto para el bot P2P.
// Un Durable Object con alarm() que se re-arma y dispara /api/bot-tick en Vercel.
// El cron de 1 min (scheduled) solo re-asegura la alarm (self-heal). CF no llama a Binance
// (esta bloqueado); solo dispara a Vercel, que si puede.
//
// Cadencia ADAPTATIVA (ahorra Fluid Active CPU en Vercel): /api/bot-tick responde
// { bots, monitors } y el DO elige el proximo intervalo:
//   bots > 0        → TICK_MS (18s, el reprice necesita cadencia)
//   solo monitors   → MONITOR_TICK_MS (30s, el refresh minimo del monitor es 30s)
//   nada habilitado → IDLE_TICK_MS (120s)
// GET /poke re-arma la alarm a +1s: lo llama Vercel al habilitar bot/monitor para
// no esperar el backoff idle.

async function ensure(env, path) {
  const id = env.SCHEDULER.idFromName('singleton');
  const stub = env.SCHEDULER.get(id);
  return stub.fetch('https://do/' + (path || 'ensure'));
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname === '/poke' ? 'poke' : 'ensure';
    await ensure(env, path);
    return new Response(path === 'poke' ? 'poked\n' : 'scheduler armado\n');
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensure(env));
  },
};

export class BotScheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // ensure: arma la alarm si no hay ninguna pendiente. poke: proxima alarm en 1s
  // (despierta del backoff idle sin esperar hasta 2 min).
  async fetch(request) {
    if (new URL(request.url).pathname === '/poke') {
      await this.state.storage.setAlarm(Date.now() + 1000);
      return new Response('poked');
    }
    const cur = await this.state.storage.getAlarm();
    if (cur === null) await this.state.storage.setAlarm(Date.now() + 1000);
    return new Response('ok');
  }

  async alarm() {
    const tickMs = parseInt(this.env.TICK_MS || '18000', 10);
    const monMs = parseInt(this.env.MONITOR_TICK_MS || '30000', 10);
    const idleMs = parseInt(this.env.IDLE_TICK_MS || '120000', 10);
    // Red de seguridad ANTES del fetch: si el DO muere a mitad, el loop continua.
    await this.state.storage.setAlarm(Date.now() + Math.max(tickMs, 60000));
    let next = tickMs;
    try {
      const r = await fetch(this.env.VERCEL_URL + '/api/bot-tick', {
        method: 'POST',
        headers: { 'x-bot-secret': this.env.BOT_TICK_SECRET || '', 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await r.json().catch(() => null);
      if (j && j.ok) next = j.bots > 0 ? tickMs : (j.monitors > 0 ? monMs : idleMs);
    } catch (_) {
      // error de red: reintenta a cadencia base
    }
    await this.state.storage.setAlarm(Date.now() + next);
  }
}
