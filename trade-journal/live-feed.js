// live-feed.js — velas en vivo directo del exchange por WebSocket.
// El terminal pide el historial una sola vez (/exec/market) y desde ahi el
// navegador se conecta al WebSocket publico del exchange: el VWAP, las bandas,
// el RSI y el estocastico se recalculan aqui sin peticiones a Vercel ni al worker.

import { snapshot, utcAnchor, nyOpenAnchor } from '../workers/trade-journal-worker/src/indicators.js';
import { nyParts } from '../workers/trade-journal-worker/src/risk.js';

const MAX_CANDLES = 2000;
const RECALC_MS = 1000;

function wsUrl(exchange, market, symbol, interval) {
  if (exchange === 'bitget') return 'wss://ws.bitget.com/v2/ws/public';
  const s = symbol.toLowerCase();
  if (market === 'coinm') return `wss://dstream.binance.com/ws/${s}@kline_${interval}`;
  return market === 'futures'
    ? `wss://fstream.binance.com/ws/${s}@kline_${interval}`
    : `wss://stream.binance.com:9443/ws/${s}@kline_${interval}`;
}

export class LiveFeed {
  constructor({ onUpdate, onStatus }) {
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.ws = null;
    this.timer = null;
    this.ping = null;
    this.retry = 0;
    this.cfg = null;
  }

  // cfg: { exchange, market, symbol, interval, anchor, candles: [[t,o,h,l,c,v], ...] }
  start(cfg) {
    this.stop();
    this.cfg = cfg;
    this.candles = cfg.candles.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    this.anchorOf = cfg.anchor === 'ny' ? nyOpenAnchor(nyParts) : utcAnchor;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer); clearInterval(this.ping); clearTimeout(this.reconnectT);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch { /* ya cerrado */ } }
    this.ws = null;
  }

  connect() {
    const { exchange, market, symbol, interval } = this.cfg;
    let ws;
    try { ws = new WebSocket(wsUrl(exchange, market, symbol, interval)); }
    catch { this.onStatus?.('off'); return; }
    this.ws = ws;
    this.onStatus?.('connecting');

    ws.onopen = () => {
      this.retry = 0;
      if (exchange === 'bitget') {
        ws.send(JSON.stringify({ op: 'subscribe', args: [{
          instType: market === 'futures' ? 'USDT-FUTURES' : 'SPOT', channel: `candle${interval}`, instId: symbol,
        }] }));
        // Bitget corta la conexion si no recibe ping en 2 min
        this.ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25000);
      }
      this.onStatus?.('live');
    };

    ws.onmessage = e => {
      if (e.data === 'pong') return;
      let d; try { d = JSON.parse(e.data); } catch { return; }
      if (exchange === 'bitget') {
        if (d.event === 'error') { this.onStatus?.('off'); return; }
        for (const r of d.data || []) this.merge({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
      } else if (d.k) {
        const k = d.k;
        this.merge({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
      }
    };

    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.stopped) return;
      this.onStatus?.('reconnecting');
      const wait = Math.min(30000, 1000 * 2 ** this.retry++);
      this.reconnectT = setTimeout(() => this.connect(), wait);
    };
  }

  merge(k) {
    const list = this.candles;
    const last = list[list.length - 1];
    if (!last || k.t > last.t) list.push(k);
    else {
      // Actualiza la vela en curso o, si es un dato atrasado, la que corresponda
      const i = list.findIndex(x => x.t === k.t);
      if (i >= 0) list[i] = k; else return;
    }
    if (list.length > MAX_CANDLES) list.splice(0, list.length - MAX_CANDLES);
    this.schedule();
  }

  // Recalcula como mucho una vez por segundo aunque lleguen muchos mensajes
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const snap = snapshot(this.candles, this.anchorOf);
      if (snap) this.onUpdate?.(snap);
    }, RECALC_MS);
  }
}
