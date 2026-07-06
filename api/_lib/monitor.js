// Port puro (sin DOM) de checkAlerts del cliente: spread, sobrecomprado y debilidad.
// Entrada: { mayRaw, smallRaw, cfg, priceHist, cooldowns, now, silent }.
// Salida: { alerts:[{type,title,desc}], priceHist, cooldowns, bestMay }.
const COOLDOWN_MS = 5 * 60000;
const TREND_CD_MS = 20 * 60000;
const HIST24_MS = 25 * 3600 * 1000;

// Serie comprimida de 24h (1 punto cada ~5 min) para el sparkline. La alimentan tanto
// el tick del servidor como el latido del cliente (app abierta), asi nunca queda hueca.
export function pushHist24(hist, ts, price) {
  if (!price) return Array.isArray(hist) ? hist : [];
  const arr = Array.isArray(hist) ? hist.slice() : [];
  const last = arr[arr.length - 1];
  if (!last || ts - last.ts >= 4.5 * 60000) arr.push({ ts, price });
  while (arr.length && ts - arr[0].ts > HIST24_MS) arr.shift();
  return arr;
}

// Serie larga (1 punto cada ~30 min) para la pagina de historial. Sin limite de
// retencion: se guarda indefinidamente (~0.5-1 MB/ano, despreciable para Neon).
export function pushHistLong(hist, ts, price) {
  if (!price) return Array.isArray(hist) ? hist : [];
  const arr = Array.isArray(hist) ? hist.slice() : [];
  const last = arr[arr.length - 1];
  if (!last || ts - last.ts >= 30 * 60000) arr.push({ ts, price });
  return arr;
}

// ── Series por metodo de pago ─────────────────────────
// hist24/hist_long guardan { pay: [{ts,price}] } para que cambiar de metodo no
// contamine el grafico. Formato legado (array plano) = serie de BDV.
const LEGACY_PAY = 'BancoDeVenezuela';
export function histMap(h) {
  if (Array.isArray(h)) return { [LEGACY_PAY]: h };
  return (h && typeof h === 'object') ? h : {};
}
export function pushHist24Pay(hist, pay, ts, price) {
  const m = histMap(hist);
  m[pay] = pushHist24(m[pay], ts, price);
  return m;
}
export function pushHistLongPay(hist, pay, ts, price) {
  const m = histMap(hist);
  m[pay] = pushHistLong(m[pay], ts, price);
  return m;
}

// Velas OHLC por HORA, por metodo de pago. Cada observacion de precio (tick del
// servidor ~30s o latido del cliente ~28s) actualiza la vela de su bucket horario.
export function pushOhlcPay(hist, pay, ts, price) {
  const m = histMap(hist);
  if (!price) return m;
  const arr = Array.isArray(m[pay]) ? m[pay].slice() : [];
  const t = Math.floor(ts / 3600000) * 3600000;
  const last = arr[arr.length - 1];
  if (last && last.t === t) {
    arr[arr.length - 1] = { t, o: last.o, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price };
  } else {
    arr.push({ t, o: price, h: price, l: price, c: price });
  }
  m[pay] = arr;
  return m;
}

// Disponibilidad minima (USDT) para considerar un anuncio creible (mayorista real).
// Evita que un listing fantasma contamine bestMay (grafico) ni dispare falsas alertas.
const MIN_AVAIL = 2000;

// Escapa HTML para Telegram (parse_mode HTML): un nick con < o & haria que
// Telegram rechace el mensaje completo y la alerta se pierda.
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mapBest(raw, verifiedOnly) {
  return raw.map(item => ({
    price: parseFloat(item.adv.price),
    avail: parseFloat(item.adv.tradableQuantity),
    merchant: item.advertiser.nickName,
    badges: item.advertiser.badges,
  })).filter(a => a.price > 0 && a.avail >= MIN_AVAIL && (!verifiedOnly || (a.badges && a.badges.length > 0)))
    .sort((a, b) => b.price - a.price);
}

export function computeAlerts({ mayRaw, smallRaw, cfg, priceHist, cooldowns, now, silent }) {
  now = now || Date.now();
  const verifiedOnly = cfg.verifiedOnly !== false;
  const may = mapBest(mayRaw, verifiedOnly);
  const small = mapBest(smallRaw, verifiedOnly);
  const cd = { ...(cooldowns || {}) };
  const hist = Array.isArray(priceHist) ? priceHist.slice() : [];
  const alerts = [];

  const bestMay = may[0] ? may[0].price : null;
  const bestSmall = small[0] ? small[0].price : null;
  if (!bestMay) return { alerts, priceHist: hist, cooldowns: cd, bestMay: null };

  if (!silent) {
    const commission = cfg.commission || 0;
    const spreadThr = cfg.spreadThr != null ? cfg.spreadThr : 0.5;
    const overboughtThr = cfg.overboughtThr != null ? cfg.overboughtThr : 1.0;
    const weaknessThr = cfg.weaknessThr != null ? cfg.weaknessThr : 0.5;

    // Spread mayorista vs compra
    if (bestSmall) {
      const spread = (bestMay - bestSmall) / bestMay * 100;
      const spreadNet = spread - commission;
      const evalSpread = commission > 0 ? spreadNet : spread;
      const netLabel = commission > 0 ? ' (neto ' + spreadNet.toFixed(3) + '%)' : '';
      if (evalSpread >= spreadThr && (!cd.spread || now - cd.spread > COOLDOWN_MS)) {
        cd.spread = now;
        alerts.push({
          type: 'spread',
          title: '💰 Spread ' + spread.toFixed(3) + '%' + netLabel + ' — OPORTUNIDAD',
          desc: 'Mayorista: ' + bestMay.toFixed(2) + ' Bs (' + escHtml(may[0].merchant) + ') → Compra: ' +
                bestSmall.toFixed(2) + ' Bs · Dif: ' + (bestMay - bestSmall).toFixed(2) + ' Bs/USDT',
        });
      }
    }

    // Momentum 10 min (sobrecomprado / debilidad)
    if (hist.length > 1) {
      let ref10 = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        const age = now - hist[i].ts;
        // Solo una referencia real de ~10 min. Si la mas reciente "≥9 min" tiene >18 min,
        // hubo un hueco (relevo/pausa): no hay momentum valido → evita falsas alertas.
        if (age >= 9 * 60000) { if (age <= 18 * 60000) ref10 = hist[i].price; break; }
      }
      if (ref10 !== null) {
        const chg = (bestMay - ref10) / ref10 * 100;
        if (chg > overboughtThr) {
          if (!cd.ob || now - cd.ob > COOLDOWN_MS) {
            cd.ob = now;
            alerts.push({ type: 'overbought', title: '🔴 Mercado sobrecomprado',
              desc: '+' + chg.toFixed(3) + '% en 10 min · Precio actual: ' + bestMay.toFixed(2) + ' Bs' });
          }
        } else { cd.ob = 0; }
        if (chg < -weaknessThr) {
          if (!cd.wk || now - cd.wk > COOLDOWN_MS) {
            cd.wk = now;
            alerts.push({ type: 'weakness', title: '🔵 Debilidad en el mercado',
              desc: chg.toFixed(3) + '% en 10 min · Precio actual: ' + bestMay.toFixed(2) + ' Bs' });
          }
        } else { cd.wk = 0; }
      }
    }

    // Tendencia sostenida (~1h): cambio grande confirmado a mitad de ventana (filtra picos sueltos)
    const sustainThr = cfg.sustainThr != null ? cfg.sustainThr : 1.5;
    if (hist.length > 2) {
      let ref60 = null, ref30 = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        const age = now - hist[i].ts;
        if (ref30 === null && age >= 25 * 60000 && age <= 40 * 60000) ref30 = hist[i].price;
        if (ref60 === null && age >= 50 * 60000 && age <= 75 * 60000) ref60 = hist[i].price;
        if (ref30 !== null && ref60 !== null) break;
      }
      if (ref60 !== null && ref30 !== null) {
        const chg60 = (bestMay - ref60) / ref60 * 100;
        const chg30 = (bestMay - ref30) / ref30 * 100;
        if (Math.abs(chg60) >= sustainThr && Math.sign(chg30) === Math.sign(chg60)) {
          if (!cd.tr || now - cd.tr > TREND_CD_MS) {
            cd.tr = now;
            const up = chg60 > 0;
            alerts.push({
              type: up ? 'overbought' : 'weakness',
              title: up ? '📈 Tendencia alcista sostenida' : '📉 Tendencia bajista sostenida',
              desc: (up ? '+' : '') + chg60.toFixed(2) + '% en 1h · Precio actual: ' + bestMay.toFixed(2) + ' Bs',
            });
          }
        } else { cd.tr = 0; }
      }
    }
  }

  // Mantener historial de precio (mejor mayorista) para el momentum.
  hist.push({ ts: now, price: bestMay });
  while (hist.length > 200) hist.shift();

  return { alerts, priceHist: hist, cooldowns: cd, bestMay };
}
