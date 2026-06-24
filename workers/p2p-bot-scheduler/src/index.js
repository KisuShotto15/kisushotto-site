// Scheduler sub-minuto para el bot P2P.
// Un Durable Object con alarm() que se re-arma cada TICK_MS y dispara /api/bot-tick en Vercel.
// El cron de 1 min (scheduled) solo re-asegura la alarm (self-heal). CF no llama a Binance
// (esta bloqueado); solo dispara a Vercel, que si puede.

async function ensure(env) {
  const id = env.SCHEDULER.idFromName('singleton');
  const stub = env.SCHEDULER.get(id);
  return stub.fetch('https://do/ensure');
}

export default {
  async fetch(request, env) {
    await ensure(env);
    return new Response('scheduler armado\n');
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

  // Arma la alarm si no hay ninguna pendiente.
  async fetch() {
    const cur = await this.state.storage.getAlarm();
    if (cur === null) await this.state.storage.setAlarm(Date.now() + 1000);
    return new Response('ok');
  }

  async alarm() {
    const tickMs = parseInt(this.env.TICK_MS || '18000', 10);
    // Re-armar primero: si el fetch falla, el loop continua igual.
    await this.state.storage.setAlarm(Date.now() + tickMs);
    try {
      await fetch(this.env.VERCEL_URL + '/api/bot-tick', {
        method: 'POST',
        headers: { 'x-bot-secret': this.env.BOT_TICK_SECRET || '', 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch (_) {
      // se reintenta en la proxima alarm
    }
  }
}
