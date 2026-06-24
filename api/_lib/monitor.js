// Port puro (sin DOM) de checkAlerts del cliente: spread, sobrecomprado y debilidad.
// Entrada: { mayRaw, smallRaw, cfg, priceHist, cooldowns, now, silent }.
// Salida: { alerts:[{type,title,desc}], priceHist, cooldowns, bestMay }.
const COOLDOWN_MS = 5 * 60000;

function mapBest(raw, verifiedOnly) {
  return raw.map(item => ({
    price: parseFloat(item.adv.price),
    merchant: item.advertiser.nickName,
    badges: item.advertiser.badges,
  })).filter(a => !verifiedOnly || (a.badges && a.badges.length > 0))
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
          desc: 'Mayorista: ' + bestMay.toFixed(2) + ' Bs (' + may[0].merchant + ') → Compra: ' +
                bestSmall.toFixed(2) + ' Bs · Dif: ' + (bestMay - bestSmall).toFixed(2) + ' Bs/USDT',
        });
      }
    }

    // Momentum 10 min (sobrecomprado / debilidad)
    if (hist.length > 1) {
      let ref10 = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (now - hist[i].ts >= 9 * 60000) { ref10 = hist[i].price; break; }
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
  }

  // Mantener historial de precio (mejor mayorista) para el momentum.
  hist.push({ ts: now, price: bestMay });
  while (hist.length > 200) hist.shift();

  return { alerts, priceHist: hist, cooldowns: cd, bestMay };
}
