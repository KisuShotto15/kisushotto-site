// P2P Repricing Bot — Fly.io worker
// Config via environment variables (fly secrets set ...)

const CFG = {
  url:            process.env.BOT_URL            || 'https://kisushotto-site.vercel.app/api/binance-bot',
  token:          process.env.BOT_TOKEN          || '',
  adNo:           process.env.BOT_AD_NO          || '',
  myNick:         process.env.BOT_NICK           || '',
  increment:      parseFloat(process.env.BOT_INCREMENT)        || 0.001,
  maxGap:         parseFloat(process.env.BOT_MAX_GAP)          || 1.0,
  limitThreshold: parseFloat(process.env.BOT_LIMIT_THRESHOLD)  || 10000,
  sellPrice:      parseFloat(process.env.BOT_SELL_PRICE)       || 0,
  minSpread:      parseFloat(process.env.BOT_MIN_SPREAD)       || 0.5,
  minLimit:       parseFloat(process.env.BOT_MIN_LIMIT)        || 0,
  interval:       parseInt(process.env.BOT_INTERVAL)           || 30,
};

const PROXY         = 'https://kisushotto-site.vercel.app/api/p2p-search';
const VERCEL_SECRET = 'ptk-2025-kisu';

const BOT = {
  currentPrice:    0,
  adNumber:        null,
  myMinLimit:      0,
  ceiling:         0,
  cachedAd:        null,
  cachedAdAt:      0,
  appliedMinLimit: 0,
  cycles:          0,
};

function log(msg) {
  const ts = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${ts}] ${msg}`);
}

async function botCallWorker(path, body) {
  const r = await fetch(CFG.url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bot-Token': CFG.token },
    body:    JSON.stringify({ path, params: body || {} }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Worker ' + r.status + (data.error ? ': ' + data.error : ''));
  return data;
}

async function botGetMyAd() {
  const data = await botCallWorker('/my-ads');
  const ads  = Array.isArray(data.data) ? data.data
             : Array.isArray(data.data?.data) ? data.data.data
             : null;
  if (!ads?.length) throw new Error('Sin anuncios');

  if (CFG.adNo) {
    const byId = ads.find(a => String(a.adNumber || a.advNo) === CFG.adNo);
    if (!byId) throw new Error('Ad ' + CFG.adNo + ' no encontrado');
    const isLive = byId.advStatus === 'LIVE' || byId.advStatus === 'ONLINE'
                || byId.advStatus === 1 || byId.adStatus === 1;
    if (!isLive) return null;
    const surplus = parseFloat(byId.surplusAmount || byId.tradableQuantity || 0);
    if (surplus > 0 && surplus < 100) byId.__noFunds = true;
    return byId;
  }

  return ads.find(a =>
    a.tradeType === 'BUY' &&
    (a.asset === 'USDT' || a.cryptoCurrency === 'USDT') &&
    (a.fiatUnit === 'VES' || a.fiatCurrency === 'VES' || a.fiat === 'VES') &&
    (a.advStatus === 'LIVE' || a.advStatus === 'ONLINE' || a.advStatus === 1 || a.adStatus === 1)
  ) || null;
}

async function fetchTier(transAmount, maxPages = 2) {
  async function onePage(page) {
    const r = await fetch(PROXY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': VERCEL_SECRET },
      body:    JSON.stringify({
        asset: 'USDT', fiat: 'VES', merchantCheck: false,
        page, rows: 20, tradeType: 'SELL',
        transAmount, payTypes: ['BancoDeVenezuela'],
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d.data || [];
  }
  const results = await Promise.allSettled(
    Array.from({ length: maxPages }, (_, i) => onePage(i + 1))
  );
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

function mapAds(raw) {
  return raw.map(item => ({
    price:    parseFloat(item.adv.price),
    minVES:   parseFloat(item.adv.minSingleTransAmount),
    avail:    parseFloat(item.adv.tradableQuantity),
    merchant: item.advertiser.nickName,
    payTypes: (item.adv.tradeMethods || []).map(m => m.identifier),
    badges:   item.advertiser.badges,
  }))
  .filter(a => a.badges?.length > 0)
  .sort((a, b) => b.price - a.price);
}

async function botUpdatePrice(adNumber, price) {
  const data = await botCallWorker('/update-ad', { advNo: adNumber, price: parseFloat(price.toFixed(3)) });
  if (data.code && data.code !== '000000')
    throw new Error(data.message || 'codigo ' + data.code);
}

async function botUpdateMinLimit(adNumber, minAmount) {
  const data = await botCallWorker('/update-limit', { advNo: adNumber, minSingleTransAmount: parseFloat(minAmount) });
  if (data.code && data.code !== '000000')
    throw new Error(data.message || 'limite codigo ' + data.code);
}

async function botCycle() {
  BOT.cycles++;
  try {
    // Actualizar limite minimo si cambio en config
    if (CFG.minLimit > 0 && CFG.minLimit !== BOT.appliedMinLimit && BOT.adNumber) {
      try {
        await botUpdateMinLimit(BOT.adNumber, CFG.minLimit);
        BOT.appliedMinLimit = CFG.minLimit;
        BOT.myMinLimit      = CFG.minLimit;
        BOT.cachedAd        = null;
        log('Limite minimo → ' + CFG.minLimit + ' VES');
      } catch(e) {
        log('⚠ Limite: ' + e.message);
      }
    }

    // Anuncio con cache de 2 min
    const now = Date.now();
    let ad;
    if (BOT.cachedAd && (now - BOT.cachedAdAt) < 120_000) {
      ad = BOT.cachedAd;
    } else {
      ad = await botGetMyAd();
      if (ad) { BOT.cachedAd = ad; BOT.cachedAdAt = now; }
    }

    if (!ad)            { log('Anuncio pausado — esperando'); return; }
    if (ad.__noFunds)   { log('Fondos insuficientes (<100 USDT)'); return; }

    BOT.adNumber   = ad.adNumber || ad.advNo;
    if (!BOT.currentPrice) BOT.currentPrice = parseFloat(ad.price);
    BOT.myMinLimit = parseFloat(ad.minSingleTransAmount);

    if (!CFG.sellPrice) throw new Error('Configura BOT_SELL_PRICE');
    BOT.ceiling = CFG.sellPrice * (1 - CFG.minSpread / 100);

    // Mercado
    const market      = mapAds(await fetchTier(BOT.myMinLimit + CFG.limitThreshold, 3));
    const competitors = market.filter(a =>
      a.merchant !== CFG.myNick &&
      a.payTypes.includes('BancoDeVenezuela') &&
      a.minVES < (BOT.myMinLimit + CFG.limitThreshold) &&
      a.avail >= 150
    );

    const above = competitors.filter(a => a.price > BOT.currentPrice && a.price <= BOT.ceiling);
    const below = competitors.filter(a => a.price < BOT.currentPrice);

    let targetPrice = null, reason = '';

    if (BOT.currentPrice > BOT.ceiling) {
      targetPrice = BOT.ceiling;
      reason      = 'sobre techo';
    } else if (above.length > 0) {
      const inGap = above.filter(a => (a.price - BOT.currentPrice) <= CFG.maxGap);
      if (inGap.length > 0) {
        inGap.sort((a, b) => b.price - a.price);
        targetPrice = inGap[0].price + CFG.increment;
        reason      = inGap[0].merchant + ' @ ' + inGap[0].price.toFixed(3);
      } else {
        above.sort((a, b) => a.price - b.price);
        log('En espera — mas cercano: ' + above[0].merchant + ' @ ' + above[0].price.toFixed(3));
        return;
      }
    } else if (below.length > 0) {
      below.sort((a, b) => b.price - a.price);
      const proposed = below[0].price + CFG.increment;
      if (proposed < BOT.currentPrice) {
        targetPrice = proposed;
        reason      = 'ahorro vs ' + below[0].merchant + ' @ ' + below[0].price.toFixed(3);
      }
    }

    if (targetPrice === null) {
      log('Optimo — precio: ' + BOT.currentPrice.toFixed(3) + ' | arriba: ' + above.length + ' | abajo: ' + below.length);
      return;
    }

    if (targetPrice > BOT.ceiling) { targetPrice = BOT.ceiling; reason += ' [techo]'; }
    if (Math.abs(targetPrice - BOT.currentPrice) < 0.001) return;

    await botUpdatePrice(BOT.adNumber, targetPrice);
    const dir = targetPrice > BOT.currentPrice ? '↑' : '↓';
    log(dir + ' ' + BOT.currentPrice.toFixed(3) + ' → ' + targetPrice.toFixed(3) + ' Bs  |  ' + reason);
    BOT.currentPrice = targetPrice;

  } catch(e) {
    log('Error: ' + e.message);
  }
}

// Arranque
if (!CFG.token)     { console.error('ERROR: BOT_TOKEN no configurado'); process.exit(1); }
if (!CFG.sellPrice) { console.error('ERROR: BOT_SELL_PRICE no configurado'); process.exit(1); }

log('Bot iniciado — intervalo: ' + CFG.interval + 's | adNo: ' + (CFG.adNo || 'auto') +
    ' | sell: ' + CFG.sellPrice + ' | spread: ' + CFG.minSpread + '% | gap: ' + CFG.maxGap);

botCycle().then(() => setInterval(botCycle, CFG.interval * 1000));
