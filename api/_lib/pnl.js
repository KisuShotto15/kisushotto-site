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

// Filtra lotes por fecha de venta (el momento en que la ganancia se realiza).
export function lotsSince(lots, sinceMs) {
  return (lots || []).filter(l => l.sellAt != null && l.sellAt >= sinceMs);
}
