// Port puro (sin DOM) del algoritmo de reprice del cliente (botCycle).
// Entrada: { ad, marketRaw, cfg } → salida: { targetPrice|null, reason, ceiling, currentPrice, myMinLimit, competitors }.
const GENERIC_PAY_IDS = ['OtherPayments', 'SpecificBank'];
const EPS = 1e-9; // tolerancia float: el techo (sellPrice * factor) rara vez es exacto en binario

// Techo redondeado a 3 decimales SIN excederlo: toFixed puede redondear hacia
// arriba (838.9996 → "839.000") y dejar el precio publicado sobre el techo real.
function capCeil(ceiling) {
  let c = Number(ceiling.toFixed(3));
  if (c > ceiling + EPS) c = Number((c - 0.001).toFixed(3));
  return c;
}

function mapAds(raw, verifiedOnly) {
  return raw.map(item => ({
    advNo:    item.adv.advNo,
    price:    parseFloat(item.adv.price),
    minVES:   parseFloat(item.adv.minSingleTransAmount),
    maxVES:   parseFloat(item.adv.maxSingleTransAmount),
    avail:    parseFloat(item.adv.tradableQuantity),
    merchant: item.advertiser.nickName,
    payTypes: (item.adv.tradeMethods || []).map(m => m.identifier),
    badges:   item.advertiser.badges,
  })).filter(a => !verifiedOnly || (a.badges && a.badges.length > 0));
}

export function adPayTypes(ad) {
  return (ad.tradeMethods || []).map(m => m.identifier)
    .filter(id => id && GENERIC_PAY_IDS.indexOf(id) === -1);
}

export function computeReprice({ ad, marketRaw, cfg }) {
  const currentPrice = parseFloat(ad.price);
  const myMinLimit   = parseFloat(ad.minSingleTransAmount);
  const myAdvNo      = String(ad.advNo || ad.adNumber);
  const commission   = cfg.commission || 0;
  const increment    = cfg.increment || 0.001;
  const maxGap       = cfg.maxGap != null ? cfg.maxGap : 1.0;
  const threshold    = cfg.limitThreshold || 0;
  const ceiling      = cfg.sellPrice * (1 - (cfg.minSpread + commission) / 100);

  const myPays = adPayTypes(ad).length ? adPayTypes(ad) : (cfg.payTypes && cfg.payTypes.length ? cfg.payTypes : []);
  const market = mapAds(marketRaw, cfg.verifiedOnly !== false);

  const competitors = market.filter(a => {
    const match = myPays.length ? myPays.some(p => (a.payTypes || []).indexOf(p) !== -1) : true;
    return String(a.advNo) !== myAdvNo &&
           a.merchant !== cfg.myNick &&
           match &&
           a.minVES < (myMinLimit + threshold) &&
           a.avail >= 150;
  });

  const above = competitors.filter(a => a.price > currentPrice && a.price <= ceiling + EPS);
  const below = competitors.filter(a => a.price < currentPrice);

  let targetPrice = null;
  let reason = '';

  if (currentPrice > ceiling + EPS) {
    // Sobre el techo: reposicionar contra el mejor competidor valido bajo el techo,
    // no solo recortar al techo (si no, con un competidor sobre el techo el bot
    // quedaba pegado al techo ignorando a los de abajo).
    const belowCeil = competitors.filter(a => a.price <= ceiling + EPS);
    if (belowCeil.length > 0) {
      belowCeil.sort((a, b) => b.price - a.price);
      targetPrice = Math.min(belowCeil[0].price + increment, capCeil(ceiling));
      reason = '↓ sobre techo, vs ' + belowCeil[0].merchant + ' @ ' + belowCeil[0].price.toFixed(3);
    } else {
      targetPrice = capCeil(ceiling);
      reason = '↓ precio sobre techo → ' + ceiling.toFixed(3);
    }
  } else if (above.length > 0) {
    const inGap = above.filter(a => (a.price - currentPrice) <= maxGap);
    if (inGap.length > 0) {
      inGap.sort((a, b) => b.price - a.price);
      targetPrice = inGap[0].price + increment;
      reason = '↑ ' + inGap[0].merchant + ' @ ' + inGap[0].price.toFixed(3);
    } else {
      above.sort((a, b) => a.price - b.price);
      reason = 'En espera (gap > ' + maxGap + ' Bs) — ' + above[0].merchant + ' @ ' + above[0].price.toFixed(3);
      return { targetPrice: null, reason, ceiling, currentPrice, myMinLimit, competitors: competitors.length };
    }
  } else if (below.length > 0) {
    below.sort((a, b) => b.price - a.price);
    const best = below[0];
    const proposed = best.price + increment;
    if (proposed < currentPrice) {
      targetPrice = proposed;
      reason = '↓ ahorro vs ' + best.merchant + ' @ ' + best.price.toFixed(3);
    }
  }

  if (targetPrice === null) {
    return { targetPrice: null, reason: 'Posición óptima', ceiling, currentPrice, myMinLimit, competitors: competitors.length };
  }
  if (targetPrice > ceiling + EPS) { targetPrice = capCeil(ceiling); reason += ' [techo]'; }
  if (Math.abs(targetPrice - currentPrice) < 0.001 - EPS) {
    return { targetPrice: null, reason: 'Posición óptima', ceiling, currentPrice, myMinLimit, competitors: competitors.length };
  }
  return { targetPrice, reason, ceiling, currentPrice, myMinLimit, competitors: competitors.length };
}
