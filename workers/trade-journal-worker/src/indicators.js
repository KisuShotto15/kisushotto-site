// indicators.js — VWAP con 3 desviaciones, RSI y RSI estocastico.
// Velas: [{t (ms), o, h, l, c, v}] en orden ascendente.

// VWAP anclado: se reinicia en cada ancla. 'utc' = 00:00 UTC (la sesion por
// defecto de TradingView en cripto); 'ny' = apertura de Wall Street 09:30 NY.
// Bandas = VWAP ± k·σ, con σ la desviacion estandar ponderada por volumen.
export function vwapBands(candles, anchorOf) {
  let anchor = null, pv = 0, pv2 = 0, vol = 0;
  const out = [];
  for (const k of candles) {
    const a = anchorOf(k.t);
    if (a !== anchor) { anchor = a; pv = 0; pv2 = 0; vol = 0; }
    const tp = (k.h + k.l + k.c) / 3;
    pv  += tp * k.v;
    pv2 += tp * tp * k.v;
    vol += k.v;
    const vwap = vol > 0 ? pv / vol : tp;
    const sd   = vol > 0 ? Math.sqrt(Math.max(0, pv2 / vol - vwap * vwap)) : 0;
    out.push({ t: k.t, vwap, sd });
  }
  return out;
}

export const utcAnchor = t => Math.floor(t / 86400000);

// Ancla en la apertura de NY: las velas antes de las 09:30 pertenecen a la sesion anterior
export function nyOpenAnchor(nyParts) {
  return t => {
    const { date, minutes } = nyParts(t);
    return minutes >= 570 ? date : `${date}-pre`;
  };
}

// RSI de Wilder (RMA), como el ta.rsi de TradingView
export function rsi(values, len) {
  const out = new Array(values.length).fill(null);
  if (values.length <= len) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= len; loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (len - 1) + Math.max(d, 0)) / len;
    loss = (loss * (len - 1) + Math.max(-d, 0)) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function sma(values, len) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (i < len - 1) continue;
    let s = 0, ok = true;
    for (let j = i - len + 1; j <= i; j++) { if (values[j] == null) { ok = false; break; } s += values[j]; }
    if (ok) out[i] = s / len;
  }
  return out;
}

// RSI estocastico por defecto de TradingView: RSI 14, estocastico 14, K 3, D 3
export function stochRsi(closes, { rsiLen = 14, stochLen = 14, k = 3, d = 3 } = {}) {
  const r = rsi(closes, rsiLen);
  const raw = r.map((v, i) => {
    if (v == null || i < rsiLen + stochLen - 1) return null;
    const win = r.slice(i - stochLen + 1, i + 1);
    const lo = Math.min(...win), hi = Math.max(...win);
    return hi === lo ? 0 : (v - lo) / (hi - lo) * 100;
  });
  const K = sma(raw, k);
  const D = sma(K, d);
  return { k: K, d: D };
}

// Resumen para el ticket de orden: donde esta el precio respecto a las bandas
export function snapshot(candles, anchorOf) {
  if (!candles.length) return null;
  const bands = vwapBands(candles, anchorOf);
  const closes = candles.map(k => k.c);
  const r6 = rsi(closes, 6);
  const st = stochRsi(closes);
  const i = candles.length - 1;
  const { vwap, sd } = bands[i];
  const price = closes[i];
  const kNow = st.k[i], dNow = st.d[i], kPrev = st.k[i - 1], dPrev = st.d[i - 1];
  let cross = null;
  if (kPrev != null && dPrev != null && kNow != null && dNow != null) {
    if (kPrev <= dPrev && kNow > dNow) cross = 'up';
    if (kPrev >= dPrev && kNow < dNow) cross = 'down';
  }
  return {
    price, vwap, sd,
    bands: [1, 2, 3].map(n => ({ n, up: vwap + n * sd, dn: vwap - n * sd })),
    sigma: sd > 0 ? (price - vwap) / sd : 0,
    rsi6: r6[i],
    stoch_k: kNow, stoch_d: dNow, stoch_cross: cross,
    t: candles[i].t,
  };
}
