// Ganancia REALIZADA: empareja compras contra ventas por FIFO sobre la tabla orders.
// El P&L del panel es potencial (lo que ganaria el anuncio si se llena); esto es lo
// que efectivamente entro, con su margen real y su tiempo de ciclo de capital.
//
// Matematica de un lote (q USDT comprados a buy y vendidos despues a sell):
//   Bs ganados      = q * (sell - buy)
//   en USDT         = q * (sell - buy) / sell   (lo que esos Bs vuelven a comprar)
//   comision        = q * commission / 100      (Binance solo cobra al comprar)
// El margen neto asi definido es comparable 1:1 con el minSpread configurado en el bot,
// porque el techo del bot es sell * (1 - (minSpread + commission) / 100).

const EPS = 1e-9;

function isBuy(tradeType) {
  return String(tradeType || '').toUpperCase().indexOf('BUY') >= 0;
}

// orders: filas {trade_type, amount, price, created_at} en orden cronologico ascendente.
// Devuelve los lotes cerrados y el inventario que quedo abierto (comprado sin vender).
export function fifoMatch(orders, commission = 0) {
  const queue = []; // inventario comprado pendiente de vender (FIFO)
  const lots = [];
  let unmatchedSell = 0; // vendido sin compra previa registrada (historial incompleto)

  for (const o of orders || []) {
    const q = parseFloat(o.amount);
    const p = parseFloat(o.price);
    if (!(q > EPS) || !(p > 0)) continue;
    const t = o.created_at ? new Date(o.created_at).getTime() : null;

    if (isBuy(o.trade_type)) { queue.push({ q, p, t }); continue; }

    let left = q;
    while (left > EPS && queue.length) {
      const b = queue[0];
      const take = Math.min(left, b.q);
      const grossVes = take * (p - b.p);
      const fee = take * commission / 100;
      lots.push({
        qty: take,
        buyPrice: b.p,
        sellPrice: p,
        buyAt: b.t,
        sellAt: t,
        holdSec: (b.t && t) ? (t - b.t) / 1000 : null,
        grossVes,
        grossUsdt: grossVes / p,
        feeUsdt: fee,
        netUsdt: grossVes / p - fee,
        marginPct: (p - b.p) / p * 100 - commission,
      });
      b.q -= take;
      left -= take;
      if (b.q <= EPS) queue.shift();
    }
    if (left > EPS) unmatchedSell += left;
  }

  let openQty = 0, openCost = 0;
  for (const b of queue) { openQty += b.q; openCost += b.q * b.p; }
  return { lots, openQty, openCost, openAvgPrice: openQty > EPS ? openCost / openQty : null, unmatchedSell };
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Resume un conjunto de lotes. El margen promedio va ponderado por cantidad
// (un lote de 5000 USDT pesa mas que uno de 50).
export function summarize(lots) {
  let qty = 0, gross = 0, fee = 0, net = 0, ves = 0, mw = 0;
  const holds = [];
  for (const l of lots || []) {
    qty += l.qty; gross += l.grossUsdt; fee += l.feeUsdt; net += l.netUsdt; ves += l.grossVes;
    mw += l.marginPct * l.qty;
    if (l.holdSec != null) holds.push(l.holdSec);
  }
  return {
    lots: (lots || []).length,
    qty, grossUsdt: gross, feeUsdt: fee, netUsdt: net, grossVes: ves,
    marginPct: qty > EPS ? mw / qty : null,
    medHoldSec: median(holds),
  };
}

// ── Ciclo de venta (espejo del anterior) ───────────────────────────
// Vender USDT alto y recomprarlo mas barato despues. Es el ciclo que evalua el
// motor de decision ("vendo ahora, recompro en N min"), asi que sirve para
// calificar sus veredictos contra el resultado real, sin marcar nada a mano.
export function fifoShort(orders, commission = 0) {
  const queue = []; // ventas pendientes de recompra
  const cycles = [];
  for (const o of orders || []) {
    const q = parseFloat(o.amount);
    const p = parseFloat(o.price);
    if (!(q > EPS) || !(p > 0)) continue;
    const t = o.created_at ? new Date(o.created_at).getTime() : null;

    if (!isBuy(o.trade_type)) { queue.push({ q, p, t, id: o.order_no }); continue; }

    let left = q;
    while (left > EPS && queue.length) {
      const s = queue[0];
      const take = Math.min(left, s.q);
      const grossPct = (s.p - p) / p;
      cycles.push({
        qty: take,
        sellId: s.id, sellPrice: s.p, sellAt: s.t,
        buyPrice: p, buyAt: t,
        minutes: (s.t && t) ? (t - s.t) / 60000 : null,
        grossPct,
        netPct: grossPct - commission / 100,
        netUsdt: take * grossPct - take * commission / 100,
      });
      s.q -= take;
      left -= take;
      if (s.q <= EPS) queue.shift();
    }
  }
  let openSellQty = 0;
  for (const s of queue) openSellQty += s.q;
  return { cycles, openSellQty };
}

// ── Spread vs llenado ──────────────────────────────────────────────
// La ganancia es spread x capital x rotaciones. Subir el spread sube el margen por
// orden pero baja el llenado, asi que el optimo maximiza USDT netos por hora, no el
// spread. expo: exposicion por spread (muestras de 5 min); fills: ordenes por spread.

export const SAMPLE_MIN = 5;
const MIN_HOURS = 6; // exposicion minima para tomar en serio un spread

export function spreadCurve(expo, fills, sampleMin = SAMPLE_MIN) {
  const by = new Map((fills || []).map(f => [Number(f.spread), f]));
  const curve = (expo || []).map(e => {
    const f = by.get(Number(e.spread)) || { n: 0, usdt: 0 };
    const hours = e.samples * sampleMin / 60;
    const usdtPerHour = hours > 0 ? f.usdt / hours : 0;
    return {
      spread: Number(e.spread), hours, samples: e.samples, orders: f.n, usdt: f.usdt,
      ordersPerHour: hours > 0 ? f.n / hours : 0,
      usdtPerHour,
      netPerHour: usdtPerHour * Number(e.spread) / 100,
    };
  });
  let best = null;
  for (const c of curve) if (c.hours >= MIN_HOURS && (!best || c.netPerHour > best.netPerHour)) best = c;
  return { curve, best };
}

// Reparto del tiempo: cada muestra son 5 min de bot encendido; lo que falta para
// completar el periodo es tiempo apagado, con el capital totalmente parado.
export function timeBudget(row, totalH = 7 * 24, sampleMin = SAMPLE_MIN) {
  const b = row || {};
  const h = n => (n || 0) * sampleMin / 60;
  const onH = h(b.samples);
  return {
    totalH, onH,
    offH: Math.max(0, totalH - onH),
    hiddenH: h(b.hidden),
    productiveH: h(b.productive),
    emptyH: Math.max(0, h(b.samples) - h(b.hidden) - h(b.productive)),
  };
}

// ── Ventanas de mercado ────────────────────────────────────────────
// El capital parado no es fuga si el mercado no pagaba: esto separa la espera
// justificada (no habia spread) de la oportunidad perdida (lo habia y no estabas).
// rows: por hora del dia, cubos de 5 min de mercado observado.
export function spreadWindows(rows, sampleMin = SAMPLE_MIN) {
  const h = n => (n || 0) * sampleMin / 60;
  let buckets = 0, withSpread = 0, taken = 0;
  const byHour = (rows || []).map(r => {
    buckets += r.buckets; withSpread += r.with_spread; taken += r.taken;
    return {
      hour: r.h, coveredH: h(r.buckets), withSpreadH: h(r.with_spread), takenH: h(r.taken),
      // Que tan seguido esa hora del dia ofrece margen trabajable.
      rate: r.buckets > 0 ? r.with_spread / r.buckets : 0,
    };
  });
  return {
    coveredH: h(buckets), withSpreadH: h(withSpread), takenH: h(taken),
    missedH: h(withSpread - taken),
    // De todo el tiempo observado, cuanto ofrecio spread; y de ese, cuanto aprovechaste.
    offerRate: buckets > 0 ? withSpread / buckets : null,
    catchRate: withSpread > 0 ? taken / withSpread : null,
    byHour,
  };
}

// Filtra lotes por fecha de venta (el momento en que la ganancia se realiza).
export function lotsSince(lots, sinceMs) {
  return (lots || []).filter(l => l.sellAt != null && l.sellAt >= sinceMs);
}
