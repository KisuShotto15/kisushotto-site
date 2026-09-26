/* P2P Decision Engine — VES/USDT
 * L1 Snapshot · L2 History · L3 Signals · L4 Score+Decide
 * No deps. Pure functions on snapshots. Stateless except history ring buffer.
 */
(function (root) {
  'use strict';

  var FEE_BUY     = 0.00175;
  var MIN_NET     = 0.003;
  var HIST_CAP    = 30;
  var ABS_WIN_MS  = 3 * 60 * 1000;
  var MOM_WIN_MS  = 5 * 60 * 1000;
  var REV_WIN_MS  = 20 * 60 * 1000;

  // ── Snapshot ────────────────────────────────────────
  function buildSnapshot(ST) {
    return {
      ts: Date.now(),
      may:   (ST.mayoristas || []).slice(0, 20),
      small: (ST.smallAds   || []).slice(0, 20),
      buy:   (ST.buyAds     || []).slice(0, 10)
    };
  }

  // Flicker tracker: per-merchant transition count over last N snapshots
  var FLICKER_WINDOW = 10;
  var FLICKER_THRESHOLD = 4;   // ≥4 appear/disappear transitions → flicker
  var flickerState = {};       // merchant → { trans: number, lastPresent: bool }

  function updateFlicker(history) {
    if (history.length < 2) return;
    var seen = {};
    var len = Math.min(history.length, FLICKER_WINDOW);
    var startIdx = history.length - len;
    // build presence sets per snapshot
    var presence = [];
    for (var i = startIdx; i < history.length; i++) {
      var set = {};
      var may = history[i].may || [];
      for (var j = 0; j < may.length; j++) set[may[j].merchant] = true;
      presence.push(set);
      Object.keys(set).forEach(function (m) { seen[m] = true; });
    }
    var newState = {};
    Object.keys(seen).forEach(function (m) {
      var trans = 0, prev = presence[0][m] || false;
      for (var k = 1; k < presence.length; k++) {
        var cur = presence[k][m] || false;
        if (cur !== prev) trans++;
        prev = cur;
      }
      newState[m] = { trans: trans, lastPresent: prev };
    });
    flickerState = newState;
  }

  function isFlicker(merchant) {
    var s = flickerState[merchant];
    return s && s.trans >= FLICKER_THRESHOLD;
  }

  function pushSnapshot(history, ST) {
    history.push(buildSnapshot(ST));
    while (history.length > HIST_CAP) history.shift();
    updateFlicker(history);
    return history[history.length - 1];
  }

  // closest snapshot to (now - deltaMs), tolerance ±50%
  function snapAt(history, deltaMs) {
    if (!history.length) return null;
    var target = Date.now() - deltaMs;
    var best = null, bestDiff = Infinity;
    for (var i = 0; i < history.length - 1; i++) {
      var d = Math.abs(history[i].ts - target);
      if (d < bestDiff) { bestDiff = d; best = history[i]; }
    }
    if (best && bestDiff <= deltaMs * 0.6) return best;
    return null;
  }

  // ── Filters ─────────────────────────────────────────
  function isMajor(a, rank) {
    return rank < 10
      && a.avail  >= 10000
      && a.badges && a.badges.length > 0
      && !isFlicker(a.merchant);
  }

  function majors(may) {
    var out = [];
    for (var i = 0; i < may.length; i++) {
      if (isMajor(may[i], i)) out.push(may[i]);
    }
    return out;
  }

  // troll filter: top1 way above top2 with negligible avail
  function sanitize(may) {
    if (may.length < 2) return may;
    if (may[0].price > may[1].price * 1.005 && may[0].avail < 5000) {
      return may.slice(1);
    }
    return may;
  }

  // Cuanto se vacio (absorbido) y cuanto se repuso (replenish) de un top-N previo,
  // buscando cada comerciante en la lista actual completa. Sirve igual para
  // mayoristas (presion de venta) que para recompra (presion de compra).
  function absorbTop(curFullList, prevTopN) {
    var curMap = {};
    for (var i = 0; i < curFullList.length; i++) curMap[curFullList[i].merchant] = curFullList[i];
    var absorbed = 0, replen = 0, prevTotal = 0;
    for (var p = 0; p < prevTopN.length; p++) {
      var pm = prevTopN[p];
      prevTotal += pm.avail;
      var cur = curMap[pm.merchant];
      if (!cur)                      absorbed += pm.avail;
      else if (cur.avail < pm.avail) absorbed += (pm.avail - cur.avail);
      else                           replen   += (cur.avail - pm.avail);
    }
    return {
      absRate: prevTotal > 0 ? absorbed / prevTotal : 0,
      replenishRate: prevTotal > 0 ? replen / prevTotal : 0,
      prevTotal: prevTotal
    };
  }

  // ── Features ────────────────────────────────────────
  function computeFeatures(ST, history, buyLimit) {
    var snap = history[history.length - 1];
    if (!snap) return null;

    var may   = sanitize(snap.may);
    var small = snap.small || [];
    var buy   = snap.buy || [];
    var maj   = majors(may);

    if (may.length < 3 || !small.length) {
      return { degraded: true, reason: 'thin book', spreadNet: 0 };
    }

    // pSell = best mayorista price (where user sells USDT).
    // pRebuy = smallAds[0] = expected post-drawdown price where user rebuys.
    //   Rationale: when mayoristas drain, price falls to smallAds level.
    //   Using buyAds[0] would be wrong: those are merchants SELLING USDT
    //   (naturally higher price = negative spread, permanent HIGH RISK).
    var pSell  = may[0].price;
    var pRebuy = small[0].price;

    // 1. Spread
    var spreadGross = (pSell - pRebuy) / pRebuy;
    var spreadNet   = spreadGross - FEE_BUY;

    // 2. LA — liquidity above (sellable in profitable zone)
    var threshold = pRebuy * (1 + FEE_BUY + 0.003);
    var LA = 0;
    for (var i = 0; i < maj.length; i++) {
      if (maj[i].price >= threshold) LA += maj[i].avail;
    }

    // 3. LB — liquidity at rebuy level, filtered to user's configured buy limit
    var LB = 0, lbCap = pRebuy * 1.0015;
    for (var j = 0; j < small.length; j++) {
      var ad = small[j];
      var inRange = !buyLimit || (ad.minVES <= buyLimit && ad.maxVES >= buyLimit);
      if (ad.price <= lbCap && inRange) LB += ad.avail;
    }

    // 4. HHI on top5 majors
    var top5 = maj.slice(0, 5);
    var totalTop = 0;
    for (var k = 0; k < top5.length; k++) totalTop += top5[k].avail;
    var HHI = 0;
    if (totalTop > 0) {
      for (var k2 = 0; k2 < top5.length; k2++) {
        var s = top5[k2].avail / totalTop;
        HHI += s * s;
      }
    }

    // 5. Absorption (top5 vs 3 min ago)
    var prev = snapAt(history, ABS_WIN_MS);
    var absRate3m = 0, replenishRate = 0, prevTop5USDT = 0;
    if (prev) {
      var prevTop = majors(sanitize(prev.may)).slice(0, 5);
      var a = absorbTop(may, prevTop);
      absRate3m = a.absRate; replenishRate = a.replenishRate; prevTop5USDT = a.prevTotal;
    }

    // 5b. Recompra: mismo calculo sobre "small". Un drenaje rapido de los niveles
    // de recompra puede ser señal temprana de que a los mayoristas les queda
    // espacio para bajar precio (se van quedando sin piso de compradores debajo).
    // No es determinista, pero suma como otra pieza del veredicto.
    var buyAbsRate3m = 0, buyReplenishRate = 0;
    if (prev) {
      var b = absorbTop(small, (prev.small || []).slice(0, 5));
      buyAbsRate3m = b.absRate; buyReplenishRate = b.replenishRate;
    }

    // 6. Liquidity gaps. Recorre TODOS los mayoristas solidos (isMajor ya los topa
    // en 10), no solo los primeros 6: un libro fragmentado mas abajo (el salto
    // grande casi nunca esta en el top 3-4) es de las mejores señales de que hay
    // poco piso real debajo del mejor precio.
    var gaps = [], gapMax = 0, gapBigCnt = 0;
    for (var g = 0; g < maj.length - 1; g++) {
      var d = maj[g].price - maj[g + 1].price;
      gaps.push(d);
      if (d > gapMax) gapMax = d;
      if (d >= 1) gapBigCnt++;
    }
    var gapMaxRel = pSell > 0 ? gapMax / pSell : 0;

    // 7. Weakness composite
    var topUSDT = totalTop;
    var priceDirAdj = 0;
    if (prev && prev.may.length >= 3 && may.length >= 3) {
      var curAvg  = (may[0].price  + may[1].price  + may[2].price)  / 3;
      var prevAvg = (prev.may[0].price + prev.may[1].price + prev.may[2].price) / 3;
      priceDirAdj = (curAvg - prevAvg) / prevAvg;
    }
    var weakness =
        (topUSDT < 40000 ? 0.4 : 0)
      + (gapBigCnt >= 2  ? 0.3 : 0)
      + (priceDirAdj < -0.0005 ? 0.3 : 0);

    // 8. Momentum
    var prev5 = snapAt(history, MOM_WIN_MS);
    var priceMom = 0;
    if (prev5 && prev5.may.length) {
      priceMom = (pSell - prev5.may[0].price) / prev5.may[0].price;
    }
    var flowMom = prevTop5USDT > 0 ? (((replenishRate * prevTop5USDT) * -1) + (absRate3m * prevTop5USDT)) / prevTop5USDT : 0;
    // simpler: absorption minus replenishment, signed
    flowMom = absRate3m - replenishRate;
    var pmComp = Math.max(-1, Math.min(1, priceMom / 0.005));
    var fmComp = Math.max(-1, Math.min(1, flowMom * 4)); // scale 0.25 → 1
    var momentum = 0.5 * pmComp + 0.5 * fmComp;

    // 9. Reversal probability
    var revProb = 0;
    var hi20 = pSell;
    for (var h = 0; h < history.length; h++) {
      if (history[h].ts < Date.now() - REV_WIN_MS) continue;
      if (history[h].may[0] && history[h].may[0].price > hi20) hi20 = history[h].may[0].price;
    }
    var near = (hi20 - pSell) / hi20 < 0.001;
    var prevPrev = snapAt(history, ABS_WIN_MS * 2);
    var flowDecel = false;
    if (prev && prevPrev) {
      // compute earlier window absRate
      var earlyMaj = majors(sanitize(prevPrev.may)).slice(0, 5);
      var midMap = {};
      for (var ii = 0; ii < prev.may.length; ii++) midMap[prev.may[ii].merchant] = prev.may[ii];
      var earlyAbs = 0, earlyTotal = 0;
      for (var jj = 0; jj < earlyMaj.length; jj++) {
        earlyTotal += earlyMaj[jj].avail;
        var midC = midMap[earlyMaj[jj].merchant];
        if (!midC)                        earlyAbs += earlyMaj[jj].avail;
        else if (midC.avail < earlyMaj[jj].avail) earlyAbs += (earlyMaj[jj].avail - midC.avail);
      }
      var earlyRate = earlyTotal > 0 ? earlyAbs / earlyTotal : 0;
      flowDecel = absRate3m < earlyRate * 0.6 && earlyRate > 0.05;
    }
    revProb = Math.max(0, Math.min(1,
        0.4 * (near ? 1 : 0)
      + 0.4 * (flowDecel ? 1 : 0)
      + 0.2 * (weakness > 0.5 ? 1 : 0)
    ));

    // 10. Tape events (vs last snapshot)
    var last = history.length >= 2 ? history[history.length - 2] : null;
    var events = { rapidDeplete: false, top1Gone: false, priceDropTop: false };
    if (last && last.may[0] && may[0]) {
      if (last.may[0].merchant === may[0].merchant
          && last.may[0].avail > 0
          && (may[0].avail / last.may[0].avail) <= 0.7) {
        events.rapidDeplete = true;
      }
      if (last.may[0].merchant !== may[0].merchant) events.top1Gone = true;
      if ((may[0].price - last.may[0].price) / last.may[0].price <= -0.002) events.priceDropTop = true;
    }

    return {
      degraded: false,
      pSell: pSell, pRebuy: pRebuy,
      spreadGross: spreadGross, spreadNet: spreadNet,
      LA: LA, LB: LB,
      HHI: HHI, topUSDT: topUSDT, majorCount: maj.length,
      absRate3m: absRate3m, replenishRate: replenishRate, prevTop5USDT: prevTop5USDT,
      buyAbsRate3m: buyAbsRate3m, buyReplenishRate: buyReplenishRate,
      gapMaxRel: gapMaxRel, gapBigCnt: gapBigCnt,
      weakness: weakness, priceDirAdj: priceDirAdj,
      priceMom: priceMom, flowMom: flowMom, momentum: momentum,
      revProb: revProb, hi20: hi20,
      events: events,
      avgMajorOrder: maj.length ? topUSDT / Math.min(maj.length, 5) : 0
    };
  }

  // Debug helper: window.DE.dump() to inspect last computation
  function dump(ST, history) {
    var F = computeFeatures(ST, history);
    var S = score(F);
    console.log('[DE] features:', F);
    console.log('[DE] score:', S);
    console.log('[DE] history len:', history.length);
    if (history.length) {
      var snap = history[history.length - 1];
      console.log('[DE] last snap may[0]:', snap.may[0]);
      console.log('[DE] last snap small[0]:', snap.small && snap.small[0]);
      console.log('[DE] last snap buy[0]:', snap.buy && snap.buy[0]);
    }
    return { F: F, S: S };
  }

  // ── Score ───────────────────────────────────────────
  var WEIGHTS = {
    spread: 30, liqRatio: 12, conc: 8, abs: 15,
    mom: 10, weak: 7, gap: 10, rev: 8, tape: 5, drain: 8
  };

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  function score(F, weightsOverride) {
    if (!F || F.degraded) return { raw: 0, parts: {}, vetoes: ['degraded book'] };

    var parts = {
      spread:   clamp01((F.spreadNet - 0.003) / 0.005) * 100,
      liqRatio: clamp01(F.LA / (F.LA + F.LB + 1)) * 100,
      conc:     (1 - clamp01((F.HHI - 0.2) / 0.5)) * 100,
      abs:      clamp01(F.absRate3m / 0.25) * 100,
      mom:      clamp01((F.momentum + 1) / 2) * 100,
      weak:     (1 - clamp01(F.weakness)) * 100,
      gap:      (1 - clamp01(F.gapMaxRel / 0.003)) * 100,
      rev:      F.revProb * 100,
      tape:     (F.events && F.events.rapidDeplete && F.events.priceDropTop) ? 100 : 0,
      // Drenaje de recompra: recompra vaciandose rapido = posible espacio para que
      // mayoristas bajen precio pronto = mas urgencia de vender ya. Peso moderado
      // (8, igual que "rev") porque es una senal que no siempre se cumple.
      drain:    clamp01(F.buyAbsRate3m / 0.30) * 100
    };

    var W = weightsOverride || WEIGHTS;
    var num = 0, den = 0;
    for (var k in W) {
      num += W[k] * parts[k];
      den += W[k];
    }
    var raw = num / den;

    // Vetoes
    var vetoes = [];
    if (F.spreadNet < 0.0025) vetoes.push('spread neto < 0.25%');
    if (F.topUSDT < 25000 && F.LB < 30000) vetoes.push('liquidez insuficiente ambos lados');
    if (F.priceMom < -0.004 && F.absRate3m < 0.05) vetoes.push('precio cae sin absorción');
    if (F.events.top1Gone && F.events.priceDropTop) vetoes.push('pared cayó (trampa)');
    if (F.majorCount < 3) vetoes.push('menos de 3 mayoristas solidos');

    return { raw: raw, parts: parts, vetoes: vetoes };
  }

  // ── Decide ──────────────────────────────────────────
  function decide(F, S) {
    if (!F || F.degraded) {
      return { score: null, label: 'WAIT', color: 'gray',
               reasons: { pos: [], neg: ['libro sin datos suficientes'] }, conflicts: [], rebuy: null };
    }
    if (S.vetoes.length) {
      return { score: 0, label: 'HIGH RISK', color: 'red',
               reasons: { pos: [], neg: S.vetoes }, conflicts: [], rebuy: null };
    }
    if (F.spreadNet < MIN_NET) {
      return { score: Math.round(S.raw), label: 'DO NOT SELL', color: 'red',
               reasons: { pos: [], neg: ['spread neto ' + (F.spreadNet * 100).toFixed(2) + '% < 0.30%'] },
               conflicts: [], rebuy: null };
    }

    var label, color;
    var raw = S.raw;
    if (raw >= 80 && F.absRate3m >= 0.20)              { label = 'STRONG SELL';  color = 'green-strong'; }
    else if (raw >= 65)                                 { label = 'SELL';         color = 'green'; }
    else if (raw >= 50 && F.LA > 2 * F.avgMajorOrder)   { label = 'PARTIAL SELL'; color = 'amber'; }
    else if (raw >= 35)                                 { label = 'WAIT';         color = 'gray'; }
    else                                                { label = 'DO NOT SELL';  color = 'red'; }

    // Reasons
    var pos = [], neg = [];
    if (F.spreadNet >= 0.004)  pos.push('spread ' + (F.spreadNet * 100).toFixed(2) + '% neto');
    else                       pos.push('spread ' + (F.spreadNet * 100).toFixed(2) + '% (apenas)');
    if (F.absRate3m >= 0.20)   pos.push('absorbió ' + (F.absRate3m * 100).toFixed(0) + '% del top 5 en 3 min');
    else if (F.absRate3m >= 0.10) pos.push('absorción ' + (F.absRate3m * 100).toFixed(0) + '%');
    if (F.momentum >= 0.3)     pos.push('impulso al alza +' + F.momentum.toFixed(2));
    if (F.LA > F.LB * 1.5)     pos.push('liquidez para vender ' + (F.LA / Math.max(F.LB, 1)).toFixed(1) + 'x la de recomprar');
    if (F.events.rapidDeplete) pos.push('el primero se vació rápido');
    if (F.buyAbsRate3m >= 0.30) pos.push('recompra se vació ' + (F.buyAbsRate3m * 100).toFixed(0) + '% en 3 min — posible espacio para que bajen precio');

    if (F.HHI > 0.5)           neg.push('oferta concentrada en pocos (' + F.HHI.toFixed(2) + ')');
    if (F.gapBigCnt >= 2)      neg.push(F.gapBigCnt + ' huecos grandes de precio');
    if (F.weakness > 0.4)      neg.push('debilidad ' + F.weakness.toFixed(2));
    if (F.momentum < -0.2)     neg.push('impulso a la baja ' + F.momentum.toFixed(2));
    if (F.revProb >= 0.6)      neg.push('probabilidad de reversión ' + (F.revProb * 100).toFixed(0) + '%');
    if (F.LB < 20000)          neg.push('poca liquidez para recomprar (' + Math.round(F.LB) + ')');

    var conflicts = [];
    if (F.HHI > 0.5 && F.absRate3m >= 0.20)
      conflicts.push('oferta concentrada pero absorción fuerte');
    if (F.momentum >= 0.3 && F.revProb >= 0.6)
      conflicts.push('impulso al alza pero reversión probable');

    // Rebuy ETA
    var rebuy = null;
    if (label === 'STRONG SELL' || label === 'SELL' || label === 'PARTIAL SELL') {
      var fillPerMin = (F.absRate3m * F.prevTop5USDT) / 3;
      var minutesToDrain = fillPerMin > 0 ? (F.LA * 0.5) / fillPerMin : 12;
      var wmin = Math.max(3, Math.min(12, Math.round(minutesToDrain * (1 - F.revProb * 0.4))));
      var wmax = Math.min(20, Math.max(wmin + 2, wmin + 5 + Math.round((1 - F.revProb) * 5)));
      var conf = Math.max(0.3, Math.min(0.9, 0.5 + 0.5 * F.revProb - F.gapMaxRel * 100 * 0.3));
      rebuy = { min: wmin, max: wmax, conf: conf };
    }

    return {
      score: Math.round(raw),
      label: label, color: color,
      reasons: { pos: pos, neg: neg },
      conflicts: conflicts,
      rebuy: rebuy
    };
  }

  // ── Public ──────────────────────────────────────────
  root.DE = {
    buildSnapshot: buildSnapshot,
    pushSnapshot:  pushSnapshot,
    computeFeatures: computeFeatures,
    score: score,
    decide: decide,
    WEIGHTS: WEIGHTS,
    FEE_BUY: FEE_BUY,
    MIN_NET: MIN_NET
  };
  // expose for journal flicker tracker
  root.DE.isMajor = isMajor;
  root.DE.sanitize = sanitize;
  root.DE.majors = majors;
  root.DE.dump = dump;
})(typeof window !== 'undefined' ? window : globalThis);
/* P2P Decision Journal — IndexedDB persistence + offline learner.
 * Stores: every decision (capped 500), trades (user actions + outcomes).
 * Public: window.DJ
 */
(function (root) {
  'use strict';

  var DB_NAME = 'p2p-monitor';
  var DB_VER  = 1;
  var STORE_DEC   = 'decisions';
  var STORE_TRADE = 'trades';
  var DEC_CAP     = 500;
  var FEE_BUY     = 0.00175;
  var SUCCESS_NET = 0.003;

  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_DEC)) {
          var s = db.createObjectStore(STORE_DEC, { keyPath: 'id', autoIncrement: true });
          s.createIndex('ts', 'ts');
          s.createIndex('label', 'label');
        }
        if (!db.objectStoreNames.contains(STORE_TRADE)) {
          var t = db.createObjectStore(STORE_TRADE, { keyPath: 'id', autoIncrement: true });
          t.createIndex('ts', 'ts');
          t.createIndex('status', 'status');
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
    return dbPromise;
  }

  function tx(store, mode) {
    return openDB().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function promisify(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

  // ── Decisions (auto-logged) ─────────────────────────
  function recordDecision(decision, features) {
    if (!decision || decision.score == null) return Promise.resolve(null);
    var row = {
      ts: Date.now(),
      score: decision.score,
      label: decision.label,
      reasons: decision.reasons,
      conflicts: decision.conflicts,
      rebuy: decision.rebuy,
      features: features ? {
        spreadNet: features.spreadNet, LA: features.LA, LB: features.LB,
        HHI: features.HHI, topUSDT: features.topUSDT,
        absRate3m: features.absRate3m, replenishRate: features.replenishRate,
        gapMaxRel: features.gapMaxRel, gapBigCnt: features.gapBigCnt,
        weakness: features.weakness, momentum: features.momentum,
        priceMom: features.priceMom, revProb: features.revProb,
        pSell: features.pSell, pRebuy: features.pRebuy
      } : null
    };
    return tx(STORE_DEC, 'readwrite').then(function (s) {
      return promisify(s.add(row));
    }).then(function (id) {
      maybeTrim();
      return id;
    }).catch(function () { return null; });
  }

  var trimDebounce = 0;
  function maybeTrim() {
    if (trimDebounce) return;
    trimDebounce = setTimeout(function () {
      trimDebounce = 0;
      tx(STORE_DEC, 'readwrite').then(function (s) {
        promisify(s.count()).then(function (n) {
          if (n <= DEC_CAP) return;
          var toDelete = n - DEC_CAP;
          var idx = s.index('ts');
          var cur = idx.openCursor();
          cur.onsuccess = function (e) {
            var c = e.target.result;
            if (c && toDelete > 0) { c.delete(); toDelete--; c.continue(); }
          };
        });
      });
    }, 30000);
  }

  function listDecisions(limit) {
    limit = limit || 100;
    return tx(STORE_DEC, 'readonly').then(function (s) {
      return new Promise(function (resolve) {
        var out = [];
        var idx = s.index('ts');
        var cur = idx.openCursor(null, 'prev');
        cur.onsuccess = function (e) {
          var c = e.target.result;
          if (c && out.length < limit) { out.push(c.value); c.continue(); }
          else resolve(out);
        };
      });
    });
  }

  // ── Trades (user actions + outcomes) ───────────────
  function createTrade(decision, features, qty, sellPrice) {
    var row = {
      ts: Date.now(),
      status: 'open',          // open → closed | abandoned
      qty: qty,
      sellPrice: sellPrice,
      decisionScore: decision ? decision.score : null,
      decisionLabel: decision ? decision.label : null,
      features: features ? Object.assign({}, features, { events: undefined }) : null,
      rebuy: null,             // {price, ts, minutesElapsed, netPct, success}
      promptedAt: null
    };
    delete row.features?.events;
    return tx(STORE_TRADE, 'readwrite').then(function (s) {
      return promisify(s.add(row));
    });
  }

  function getTrade(id) {
    return tx(STORE_TRADE, 'readonly').then(function (s) {
      return promisify(s.get(id));
    });
  }

  function updateTrade(id, patch) {
    return tx(STORE_TRADE, 'readwrite').then(function (s) {
      return promisify(s.get(id)).then(function (row) {
        if (!row) return null;
        Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
        return promisify(s.put(row));
      });
    });
  }

  function recordRebuy(id, rebuyPrice) {
    return getTrade(id).then(function (t) {
      if (!t) return null;
      var minutesElapsed = (Date.now() - t.ts) / 60000;
      var grossPct = (t.sellPrice - rebuyPrice) / rebuyPrice;
      var netPct   = grossPct - FEE_BUY;
      var success  = netPct >= SUCCESS_NET ? 'win'
                   : netPct >= 0           ? 'neutral'
                   :                         'loss';
      return updateTrade(id, {
        status: 'closed',
        rebuy: {
          price: rebuyPrice,
          ts: Date.now(),
          minutesElapsed: Math.round(minutesElapsed * 10) / 10,
          grossPct: grossPct,
          netPct: netPct,
          success: success
        }
      }).then(function () { return success; });
    });
  }

  function abandonTrade(id, note) {
    return updateTrade(id, { status: 'abandoned', note: note || null });
  }

  function listTrades(limit) {
    limit = limit || 50;
    return tx(STORE_TRADE, 'readonly').then(function (s) {
      return new Promise(function (resolve) {
        var out = [];
        var idx = s.index('ts');
        var cur = idx.openCursor(null, 'prev');
        cur.onsuccess = function (e) {
          var c = e.target.result;
          if (c && out.length < limit) { out.push(c.value); c.continue(); }
          else resolve(out);
        };
      });
    });
  }

  function openTrades() {
    return listTrades(50).then(function (all) {
      return all.filter(function (t) { return t.status === 'open'; });
    });
  }

  // ── Learner ────────────────────────────────────────
  // Pearson correlation between a feature value and a binary success label
  function pearson(xs, ys) {
    var n = xs.length;
    if (n < 5) return 0;
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var num = 0, dx = 0, dy = 0;
    for (var j = 0; j < n; j++) {
      var a = xs[j] - mx, b = ys[j] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    if (dx === 0 || dy === 0) return 0;
    return num / Math.sqrt(dx * dy);
  }

  var FEATURE_KEYS = ['spreadNet', 'LA', 'LB', 'HHI', 'absRate3m',
                      'gapMaxRel', 'weakness', 'momentum', 'revProb', 'topUSDT'];

  function stats() {
    return listTrades(500).then(function (trades) {
      var closed = trades.filter(function (t) { return t.status === 'closed' && t.rebuy; });
      var wins  = closed.filter(function (t) { return t.rebuy.success === 'win'; });
      var loss  = closed.filter(function (t) { return t.rebuy.success === 'loss'; });
      var n = closed.length;

      var avgNet  = n ? closed.reduce(function (a, t) { return a + t.rebuy.netPct; }, 0) / n : 0;
      var avgMin  = n ? closed.reduce(function (a, t) { return a + t.rebuy.minutesElapsed; }, 0) / n : 0;
      var winRate = n ? wins.length / n : null;

      // Feature correlation with success (1=win, 0=loss/neutral)
      var corrs = {};
      if (n >= 8) {
        FEATURE_KEYS.forEach(function (k) {
          var xs = [], ys = [];
          closed.forEach(function (t) {
            if (t.features && t.features[k] != null) {
              xs.push(t.features[k]);
              ys.push(t.rebuy.success === 'win' ? 1 : 0);
            }
          });
          corrs[k] = pearson(xs, ys);
        });
      }

      // Suggested weight adjustments (only with sufficient sample)
      var suggestions = [];
      if (n >= 20 && root.DE) {
        var W = root.DE.WEIGHTS;
        var meanIR = 0, m = 0;
        Object.keys(corrs).forEach(function (k) { if (corrs[k] !== 0) { meanIR += Math.abs(corrs[k]); m++; } });
        if (m > 0) meanIR /= m;
        var keyMap = { spreadNet: 'spread', absRate3m: 'abs', momentum: 'mom',
                       HHI: 'conc', revProb: 'rev', weakness: 'weak', gapMaxRel: 'gap' };
        Object.keys(corrs).forEach(function (k) {
          var wk = keyMap[k]; if (!wk || !W[wk]) return;
          var ir = Math.abs(corrs[k]);
          if (ir < 0.15) return;
          var delta = 0.15 * (ir - meanIR);
          var newW = Math.max(1, Math.round(W[wk] * (1 + delta)));
          if (newW !== W[wk]) {
            suggestions.push({ feature: k, weightKey: wk, current: W[wk], suggested: newW, ir: corrs[k] });
          }
        });
      }

      return {
        n: n,
        wins: wins.length,
        losses: loss.length,
        neutrals: n - wins.length - loss.length,
        winRate: winRate,
        avgNetPct: avgNet,
        avgMinutesToRebuy: avgMin,
        correlations: corrs,
        suggestions: suggestions,
        openCount: trades.filter(function (t) { return t.status === 'open'; }).length
      };
    });
  }

  // ── Backtest ───────────────────────────────────────
  // Replay closed trades against an alternative weight set.
  // Returns: per-strategy {n, score-net correlation, top-quartile win rate, recommended count}.
  function spearman(xs, ys) {
    var n = xs.length;
    if (n < 5) return 0;
    function ranks(arr) {
      var idx = arr.map(function (v, i) { return [v, i]; });
      idx.sort(function (a, b) { return a[0] - b[0]; });
      var r = new Array(n);
      for (var i = 0; i < n; i++) r[idx[i][1]] = i + 1;
      return r;
    }
    var rx = ranks(xs), ry = ranks(ys);
    return pearson(rx, ry);
  }

  function backtest(weightsOverride) {
    if (!root.DE) return Promise.resolve(null);
    return listTrades(500).then(function (trades) {
      var closed = trades.filter(function (t) {
        return t.status === 'closed' && t.rebuy && t.features && t.features.spreadNet != null;
      });
      if (closed.length < 5) return { n: closed.length, insufficient: true };

      var rows = closed.map(function (t) {
        var s = root.DE.score(t.features, weightsOverride || null);
        var threshold = s.raw >= 50;       // would have been recommended (PARTIAL+ in current rules)
        return {
          score: s.raw,
          netPct: t.rebuy.netPct,
          minutes: t.rebuy.minutesElapsed,
          win: t.rebuy.success === 'win',
          recommended: threshold && s.vetoes.length === 0
        };
      });

      var n = rows.length;
      var avgNet = rows.reduce(function (a, r) { return a + r.netPct; }, 0) / n;
      var winRate = rows.filter(function (r) { return r.win; }).length / n;

      // Score → netPct correlations
      var pe = pearson(rows.map(function (r) { return r.score; }), rows.map(function (r) { return r.netPct; }));
      var sp = spearman(rows.map(function (r) { return r.score; }), rows.map(function (r) { return r.netPct; }));

      // Top quartile by score
      var sorted = rows.slice().sort(function (a, b) { return b.score - a.score; });
      var q = Math.max(1, Math.round(n / 4));
      var topQ = sorted.slice(0, q);
      var topQwin = topQ.filter(function (r) { return r.win; }).length / topQ.length;
      var topQnet = topQ.reduce(function (a, r) { return a + r.netPct; }, 0) / topQ.length;

      // Score buckets
      var buckets = { '<35': 0, '35-49': 0, '50-64': 0, '65-79': 0, '>=80': 0 };
      var bucketWin = { '<35': 0, '35-49': 0, '50-64': 0, '65-79': 0, '>=80': 0 };
      rows.forEach(function (r) {
        var k = r.score < 35 ? '<35'
              : r.score < 50 ? '35-49'
              : r.score < 65 ? '50-64'
              : r.score < 80 ? '65-79'
              : '>=80';
        buckets[k]++;
        if (r.win) bucketWin[k]++;
      });

      return {
        n: n,
        winRate: winRate,
        avgNetPct: avgNet,
        scoreNetPearson: pe,
        scoreNetSpearman: sp,
        topQuartileWinRate: topQwin,
        topQuartileAvgNet: topQnet,
        buckets: buckets,
        bucketWinRate: Object.keys(buckets).reduce(function (acc, k) {
          acc[k] = buckets[k] > 0 ? bucketWin[k] / buckets[k] : null;
          return acc;
        }, {}),
        recommendedCount: rows.filter(function (r) { return r.recommended; }).length
      };
    });
  }

  // ── Probabilistic rebuy ETA ───────────────────────
  // From historical closed (non-abandoned) trades, compute P(rebuy ≤ k min) for k buckets.
  function rebuyDistribution() {
    return listTrades(500).then(function (trades) {
      var times = trades
        .filter(function (t) { return t.status === 'closed' && t.rebuy && t.rebuy.minutesElapsed != null; })
        .map(function (t) { return t.rebuy.minutesElapsed; });
      if (times.length < 8) return null;
      var thresholds = [3, 5, 8, 12, 20];
      var p = thresholds.map(function (k) {
        var hits = times.filter(function (m) { return m <= k; }).length;
        return { k: k, p: hits / times.length };
      });
      times.sort(function (a, b) { return a - b; });
      var median = times[Math.floor(times.length / 2)];
      return { n: times.length, probs: p, medianMin: median };
    });
  }

  function applySuggestions(suggestions) {
    if (!root.DE || !suggestions) return;
    suggestions.forEach(function (s) {
      if (root.DE.WEIGHTS[s.weightKey] != null) {
        root.DE.WEIGHTS[s.weightKey] = s.suggested;
      }
    });
    try {
      localStorage.setItem('p2p-de-weights', JSON.stringify(root.DE.WEIGHTS));
    } catch (e) {}
  }

  function loadPersistedWeights() {
    if (!root.DE) return;
    try {
      var raw = localStorage.getItem('p2p-de-weights');
      if (!raw) return;
      var w = JSON.parse(raw);
      Object.keys(w).forEach(function (k) {
        if (root.DE.WEIGHTS[k] != null) root.DE.WEIGHTS[k] = w[k];
      });
    } catch (e) {}
  }

  // ── Public ─────────────────────────────────────────
  root.DJ = {
    recordDecision: recordDecision,
    listDecisions: listDecisions,
    createTrade: createTrade,
    getTrade: getTrade,
    recordRebuy: recordRebuy,
    abandonTrade: abandonTrade,
    updateTrade: updateTrade,
    listTrades: listTrades,
    openTrades: openTrades,
    stats: stats,
    backtest: backtest,
    rebuyDistribution: rebuyDistribution,
    applySuggestions: applySuggestions,
    loadPersistedWeights: loadPersistedWeights,
    FEE_BUY: FEE_BUY,
    SUCCESS_NET: SUCCESS_NET
  };

  loadPersistedWeights();
})(typeof window !== 'undefined' ? window : globalThis);
// ── Moneda fiat + métodos de pago por moneda ──────────
var FIATS = ['VES', 'USD'];
var ACTIVE_FIAT = 'VES';
var PAY_METHODS_BY_FIAT = {
  VES: [
    { id: 'BancoDeVenezuela', label: 'BDV' },
    { id: 'Provincial',       label: 'Provincial' },
    { id: 'Mercantil',        label: 'Mercantil' },
    { id: 'Banesco',          label: 'Banesco' },
    { id: 'Bancamiga',        label: 'Bancamiga' },
    { id: 'BNCBancoNacional', label: 'BNC' },
    { id: 'PagoMovil',        label: 'Pago Móvil' }
  ],
  USD: [
    { id: 'Zinli',     label: 'Zinli' },
    { id: 'WallyTech', label: 'Wally Tech' },
    { id: 'Zelle',     label: 'Zelle' }
  ]
};
var PAY_METHODS = PAY_METHODS_BY_FIAT.VES; // lista activa (segun ACTIVE_FIAT)
var PAY_SEL = { VES: 'BancoDeVenezuela', USD: 'Zinli' }; // ultimo metodo elegido por moneda
var ACTIVE_PAY = 'BancoDeVenezuela';
// Sufijo de moneda para los displays del monitor (el bot es siempre VES/Bs)
function fiatSuf() { return ACTIVE_FIAT === 'VES' ? ' Bs' : ' $'; }
// Identifiers genéricos (catch-all) que NO deben usarse para filtrar competidores
// BANK = Bank Transfer (legítimo, lo usa el usuario junto a BDV) → no se filtra
var GENERIC_PAY_IDS = ['OtherPayments', 'SpecificBank'];
// Aliases: identifiers alternativos que Binance puede devolver para el mismo método
var PAY_ALIASES = {
  'BNC':                     'BNCBancoNacional',
  'BancoNacionalDeCredito':  'BNCBancoNacional',
  'BNCBank':                 'BNCBancoNacional',
  'BANK':                    'BANK'
};

function payLabel(id) {
  var canonical = PAY_ALIASES[id] || id;
  for (var f in PAY_METHODS_BY_FIAT) {
    var list = PAY_METHODS_BY_FIAT[f];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === canonical) return list[i].label;
    }
  }
  if (canonical === 'BANK') return 'Bank Transfer';
  return id;
}

function renderPaySelect() {
  var sel = document.getElementById('pay-method-select');
  if (sel) {
    sel.innerHTML = PAY_METHODS.map(function(m){
      return '<option value="' + m.id + '"' + (m.id === ACTIVE_PAY ? ' selected' : '') + '>' + m.label + '</option>';
    }).join('');
  }
  syncFiltersChip();
}

// Chip de filtros (movil): resume moneda, metodo de pago y verificados en una
// linea, y despliega .top-controls como panel. En escritorio no se muestra.
function syncFiltersChip() {
  var el = document.getElementById('filters-chip-txt');
  if (!el) return;
  var pay = (PAY_METHODS.filter(function(m){ return m.id === ACTIVE_PAY; })[0] || {}).label || '';
  var ver = CFG.verifiedOnly !== false;
  el.innerHTML = '<b>' + ACTIVE_FIAT + '/USDT</b><span class="fc-sep"> · </span>' + pay +
    (ver ? '<span class="fc-sep"> · </span><i>✓</i>' : '');
}

function toggleFiltersChip(ev) {
  if (ev) ev.stopPropagation();
  var p = document.getElementById('top-controls');
  if (p) p.classList.toggle('open');
}

function toggleMoreActions(ev) {
  if (ev) ev.stopPropagation();
  var c = document.getElementById('icon-cluster');
  if (c) c.classList.toggle('open');
}

function renderFiatSelect() {
  var fs = document.getElementById('fiat-select');
  if (fs) {
    fs.innerHTML = FIATS.map(function(f){
      return '<option value="' + f + '"' + (f === ACTIVE_FIAT ? ' selected' : '') + '>' + f + '</option>';
    }).join('');
  }
  var np = document.getElementById('nav-pair');
  if (np) np.textContent = ACTIVE_FIAT + '/USDT';
  syncFiltersChip();
}

function loadPayMethod() {
  try {
    var ps = JSON.parse(localStorage.getItem('p2p_pay_by_fiat') || 'null');
    if (ps) {
      Object.assign(PAY_SEL, ps);
    } else {
      // Migracion desde la clave legada (solo VES)
      var saved = localStorage.getItem('p2p_pay_method');
      if (saved && PAY_METHODS_BY_FIAT.VES.some(function(m){ return m.id === saved; })) PAY_SEL.VES = saved;
    }
    var f = localStorage.getItem('p2p_fiat');
    if (f && PAY_METHODS_BY_FIAT[f]) ACTIVE_FIAT = f;
  } catch(e) {}
  PAY_METHODS = PAY_METHODS_BY_FIAT[ACTIVE_FIAT];
  var cur = PAY_SEL[ACTIVE_FIAT];
  ACTIVE_PAY = PAY_METHODS.some(function(m){ return m.id === cur; }) ? cur : PAY_METHODS[0].id;
  PAY_SEL[ACTIVE_FIAT] = ACTIVE_PAY;
  renderPaySelect();
  renderFiatSelect();
}

// Reset comun al cambiar de metodo o de moneda: los precios no son comparables
// entre series distintas (momentum de alertas, cooldowns y max/min de sesion).
function resetLocalSeries() {
  try {
    ST.priceHist = [];
    COOLDOWN = {};
  } catch(e) {}
}

function persistPaySel() {
  try {
    localStorage.setItem('p2p_pay_by_fiat', JSON.stringify(PAY_SEL));
    localStorage.setItem('p2p_fiat', ACTIVE_FIAT);
    if (ACTIVE_FIAT === 'VES') localStorage.setItem('p2p_pay_method', PAY_SEL.VES); // legado
  } catch(e) {}
}

function setPayMethod(id) {
  if (id === ACTIVE_PAY) return;
  // El bot corre server-side con los metodos de SU anuncio: cambiar el selector
  // del monitor no le afecta, se puede revisar otros metodos con el bot prendido.
  ACTIVE_PAY = id;
  PAY_SEL[ACTIVE_FIAT] = id;
  resetLocalSeries();
  persistPaySel();
  if (typeof fetchOnce === 'function') fetchOnce();
  saveUserSettings();
}

// Defaults de los 3 filtros de monto por moneda (USD: sin filtro, orden nativo de Binance)
var FIAT_FILTER_DEFAULTS = {
  VES: { may: 2000000, small: 59999, buy: 2000000 },
  USD: { may: 0, small: 0, buy: 0 }
};

function setFiat(id) {
  if (id === ACTIVE_FIAT || !PAY_METHODS_BY_FIAT[id]) return;
  // Guardar los filtros de la moneda saliente y cargar los de la entrante
  CFG.fiatFilters = CFG.fiatFilters || {};
  CFG.fiatFilters[ACTIVE_FIAT] = { may: CFG.mayAmount, small: CFG.smallAmount, buy: CFG.buyAmount };
  ACTIVE_FIAT = id;
  var f = CFG.fiatFilters[id] || FIAT_FILTER_DEFAULTS[id];
  CFG.mayAmount = f.may; CFG.smallAmount = f.small; CFG.buyAmount = f.buy;
  try { localStorage.setItem('p2p_cfg2', JSON.stringify(CFG)); } catch(e) {}
  PAY_METHODS = PAY_METHODS_BY_FIAT[id];
  var cur = PAY_SEL[id];
  ACTIVE_PAY = PAY_METHODS.some(function(m){ return m.id === cur; }) ? cur : PAY_METHODS[0].id;
  PAY_SEL[id] = ACTIVE_PAY;
  renderPaySelect();
  renderFiatSelect();
  resetLocalSeries();
  persistPaySel();
  syncFilterInputs();
  if (typeof renderSparkline === 'function') try { renderSparkline(); } catch(e) {}
  if (typeof fetchOnce === 'function') fetchOnce();
  saveUserSettings();
}

function updateBotPriceColor() {
  var el = document.getElementById('bot-cur-price');
  if (!el || !BOT.currentPrice || !BOT.ceiling) return;
  var ratio = BOT.currentPrice / BOT.ceiling;
  if (ratio > 1)         el.style.color = '#E24B4A';
  else if (ratio > 0.98) el.style.color = '#F0B90B';
  else if (ratio < 0.85) el.style.color = '#1D9E75';
  else                   el.style.color = 'var(--gold)';
}

function updateBotPayBadge() {
  var el = document.getElementById('bot-pay-badge');
  if (!el) return;
  if (BOT.adPayTypes && BOT.adPayTypes.length) {
    // Solo el primer metodo: el anuncio suele llevar el banco + "Bank Transfer"
    // generico y el chip se hacia larguisimo. La lista completa va en el tooltip.
    var labels = BOT.adPayTypes.map(payLabel);
    el.textContent = labels[0];
    el.title = labels.join(' · ');
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

// ── Config ────────────────────────────────────────────
var CFG = {
  // 15s por defecto: a 10s la vista abierta gastaba ~50% mas invocaciones de Vercel
  // (cada refresh pasa por /api/p2p-search) sin diferencia practica. El minimo sigue
  // siendo 10s para quien lo quiera bajar a mano.
  interval: 15,
  spreadThr: 0.5,
  overboughtThr: 1.0,
  weaknessThr: 0.5,
  sustainThr: 1.5,       // Tendencia sostenida (~1h) en %
  mayAmount:   2000000,  // Monto a filtrar en sección Mayoristas (VES)
  smallAmount: 59999,    // Monto a filtrar en sección Ref. Compra (VES)
  commission:  0.0,      // Comisión Binance por anuncio (%)
  buyAmount:   2000000,  // Monto mínimo para Sección Compra (VES)
  verifiedOnly: true,    // Solo comerciantes con insignia (aplica a monitor y bot)
  monQuietStart: '00:00',// Monitor 24/7: inicio del silencio nocturno (America/Caracas)
  monQuietEnd:   '07:00',// Monitor 24/7: fin del silencio nocturno
  monSummary:    '08:00',// Monitor 24/7: hora del resumen diario por Telegram (Caracas)
  shortMode: true         // ON (defecto) = Mayoristas/Recompra arriba; OFF = Verde/Mayoristas
};

// Unico punto donde vive el origen del backend: el resto se deriva de aqui.
var API_BASE = 'https://kisushotto-site.vercel.app';

// Diagnostico del primer arranque: separa "la app tardo en pedir" de "el servidor
// tardo en responder". Se muestra una sola vez, junto a la hora de actualizacion.
var BOOT = { t0: (window.performance && performance.now()) || 0, asked: null, got: null, shown: false };
function bootMark(k) { if (BOOT[k] === null) BOOT[k] = Math.round(performance.now() - BOOT.t0); }
var PROXY = API_BASE + '/api/p2p-search';
var BOT_API = API_BASE + '/api/binance-bot';

// ── Sesion (multi-usuario) ────────────────────────────
var SESSION = { token: null, email: null };
try {
  var _s = JSON.parse(localStorage.getItem('p2p_session') || 'null');
  if (_s && _s.token) SESSION = _s;
} catch(e) {}

function saveSession() { try { localStorage.setItem('p2p_session', JSON.stringify(SESSION)); } catch(e) {} }

// ── Sync de preferencias por cuenta (last-write-wins) ──
var _saveSettingsT = null;
function saveUserSettings() {
  if (!SESSION.token) return;
  clearTimeout(_saveSettingsT);
  _saveSettingsT = setTimeout(function() {
    var data = { cfg: CFG, bot: BOT_CFG, pay: PAY_SEL.VES, paySel: PAY_SEL, fiat: ACTIVE_FIAT };
    botCallWorker('/settings-save', { data: data }).catch(function(){});
  }, 800);
}

async function loadUserSettings() {
  if (!SESSION.token) return;
  try {
    var d = await botCallWorker('/settings-get');
    var s = d && d.data;
    if (!s) return;
    if (s.cfg) localStorage.setItem('p2p_cfg2', JSON.stringify(s.cfg));
    if (s.bot) localStorage.setItem('p2p_bot_cfg', JSON.stringify(s.bot));
    if (s.pay) localStorage.setItem('p2p_pay_method', s.pay);
    if (s.paySel) localStorage.setItem('p2p_pay_by_fiat', JSON.stringify(s.paySel));
    if (s.fiat) localStorage.setItem('p2p_fiat', s.fiat);
    // Reusar los loaders existentes para repintar inputs desde localStorage
    loadConfig(); syncFilterInputs(); loadBotConfig(); loadPayMethod();
    updateCommissionLabels(); updateVerToggle(); botUpdateCeiling();
    if (ST.running) fetchOnce();
  } catch(e) {}
}

async function apiPost(path, body, auth) {
  var headers = { 'Content-Type': 'application/json' };
  if (auth && SESSION.token) headers['Authorization'] = 'Bearer ' + SESSION.token;
  // 20s: binance-connect valida contra Binance + cold start de Vercel; con 8s el
  // cliente abortaba con "Timeout" antes de que el servidor terminara.
  var r = await fetchRetry(API_BASE + path, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) }, 20000);
  var d = await r.json().catch(function(){ return {}; });
  if (!r.ok) { var err = new Error(d.error || ('HTTP ' + r.status)); err.data = d; throw err; }
  return d;
}

function gateStatus(msg, color) {
  var st = document.getElementById('gate-st');
  if (st) { st.textContent = msg; st.style.color = color; }
}

async function authRegister() {
  var email = document.getElementById('gate-email').value.trim();
  var pass  = document.getElementById('gate-pass').value;
  if (!email || pass.length < 8) { gateStatus('⚠ Email y contraseña (min 8)', 'var(--red)'); return; }
  gateStatus('Creando cuenta...', 'var(--text-3)');
  try {
    var d = await apiPost('/api/auth/register', { email: email, password: pass });
    if (d.emailError) gateStatus('Cuenta creada, pero no se pudo enviar el email: ' + d.emailError, 'var(--red)');
    else gateStatus('✓ Revisa tu email para verificar la cuenta', '#1D9E75');
  } catch(e) { gateStatus('⚠ ' + e.message, 'var(--red)'); }
}

async function authLogin() {
  var email = document.getElementById('gate-email').value.trim();
  var pass  = document.getElementById('gate-pass').value;
  gateStatus('Entrando...', 'var(--text-3)');
  try {
    var d = await apiPost('/api/auth/login', { email: email, password: pass });
    SESSION = { token: d.token, email: email }; saveSession();
    gateStatus('✓ Sesión iniciada', '#1D9E75');
    enterApp(); refreshAuthUI();
  } catch(e) {
    if (e.data && e.data.needVerify) {
      gateStatus('Verifica tu email. ', 'var(--red)');
      var st = document.getElementById('gate-st');
      var a = document.createElement('a');
      a.href = '#'; a.textContent = 'Reenviar verificación';
      a.style.cssText = 'color:var(--gold);text-decoration:none';
      a.onclick = function(){ authResend(); return false; };
      st.appendChild(a);
    } else gateStatus('⚠ ' + e.message, 'var(--red)');
  }
}

async function authForgot() {
  var email = document.getElementById('gate-email').value.trim();
  if (!email) { gateStatus('Escribe tu email arriba primero', 'var(--text-3)'); return; }
  gateStatus('Enviando enlace...', 'var(--text-3)');
  try {
    await apiPost('/api/auth/forgot-password', { email: email });
    gateStatus('Si el email existe, te enviamos un enlace para restablecer', '#1D9E75');
  } catch(e) { gateStatus('⚠ ' + e.message, 'var(--red)'); }
}

async function authResend() {
  var email = document.getElementById('gate-email').value.trim();
  if (!email) { gateStatus('Escribe tu email arriba primero', 'var(--text-3)'); return; }
  gateStatus('Reenviando...', 'var(--text-3)');
  try {
    await apiPost('/api/auth/resend-verification', { email: email });
    gateStatus('Si la cuenta existe y no está verificada, te reenviamos el email', '#1D9E75');
  } catch(e) { gateStatus('⚠ ' + e.message, 'var(--red)'); }
}

function resetStatus(msg, color) {
  var st = document.getElementById('reset-st');
  if (st) { st.textContent = msg; st.style.color = color; }
}

async function authResetPassword() {
  var pass = document.getElementById('reset-pass').value;
  if (pass.length < 8) { resetStatus('Mínimo 8 caracteres', 'var(--red)'); return; }
  resetStatus('Cambiando...', 'var(--text-3)');
  try {
    var d = await apiPost('/api/auth/reset-password', { token: window._resetToken, password: pass });
    if (d.token) { SESSION = { token: d.token, email: d.email }; saveSession(); resetStatus('✓ Listo', '#1D9E75'); cleanAuthUrl(); enterApp(); refreshAuthUI(); }
    else { resetStatus('✓ Contraseña cambiada, inicia sesión', '#1D9E75'); showLoginForm(); }
  } catch(e) { resetStatus('⚠ ' + e.message, 'var(--red)'); }
}

function showLoginForm() {
  document.getElementById('gate-form').style.display = '';
  document.getElementById('gate-reset').style.display = 'none';
}

function cleanAuthUrl() {
  try { history.replaceState(null, '', location.pathname); } catch(e) {}
}

// Procesa ?verify=TOKEN y ?reset=TOKEN del enlace de email. Devuelve true si manejo algo.
async function handleAuthLinks() {
  var q = new URLSearchParams(location.search);
  var verify = q.get('verify'), reset = q.get('reset');
  if (verify) {
    document.getElementById('login-gate').style.display = 'flex';
    gateStatus('Verificando...', 'var(--text-3)');
    try {
      var d = await apiPost('/api/auth/verify-email', { token: verify });
      cleanAuthUrl();
      if (d.token) { SESSION = { token: d.token, email: d.email }; saveSession(); gateStatus('✓ Email verificado', '#1D9E75'); enterApp(); refreshAuthUI(); }
      else gateStatus('✓ Email verificado, inicia sesión', '#1D9E75');
    } catch(e) { cleanAuthUrl(); gateStatus('⚠ ' + e.message, 'var(--red)'); }
    return true;
  }
  if (reset) {
    window._resetToken = reset;
    document.getElementById('login-gate').style.display = 'flex';
    showLoginForm();
    document.getElementById('gate-form').style.display = 'none';
    document.getElementById('gate-reset').style.display = '';
    return true;
  }
  return false;
}

function authLogout() {
  SESSION = { token: null, email: null }; saveSession();
  try { if (ST.running) toggleMonitor(); } catch(e) {}
  var g = document.getElementById('login-gate');
  if (g) g.style.display = 'flex';
  refreshAuthUI();
}

function enterApp() {
  var g = document.getElementById('login-gate');
  if (g) g.style.display = 'none';
  if (!window._appBooted) {
    window._appBooted = true;
    // Primero que nada: si el 24/7 estaba encendido la ultima vez, pedir el libro YA.
    // Antes el primer fetch esperaba a /monitor-state, encadenando dos cold starts de
    // Vercel antes de pintar un solo merchant (~10s en el primer arranque).
    try {
      if (localStorage.getItem('p2p_mon24') === '1' && !ST.running) {
        ST.fromCache = true;
        startMonitorView();
      }
    } catch(e) {}
    try { initTabs(); } catch(e) {} try { loadUserSettings(); } catch(e) {} try { hydrateBotState(); } catch(e) {} try { hydrateMon24(); } catch(e) {} try { loadOrderStats(); } catch(e) {} try { loadSubscription(); } catch(e) {} try { checkAdminPending(); } catch(e) {} try { tgRefreshLink(); } catch(e) {} }
}

// ── Suscripcion (Binance Pay) ───────────────────────────
var SUB = { subscription: null, invoice: null, plans: null, selectedPlan: 'monthly' };
var _subPollT = null;

function daysLeft(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
}

function renderSubBadge() {
  var b = document.getElementById('sub-badge');
  if (!b) return;
  var s = SUB.subscription;
  if (!s || s.status === 'not_started') { b.style.display = 'none'; return; }
  if (s.status === 'active') {
    // Vencida pero dentro de la cortesia: hay que verlo, todavia se puede renovar
    // sin perder nada. Y en los ultimos 3 dias, cuenta regresiva.
    if (subInGrace()) { b.style.display = ''; b.textContent = '!'; b.style.color = 'var(--red)'; return; }
    var d = daysLeft(s.current_period_end);
    if (d > 3) { b.style.display = 'none'; return; }
    b.style.display = ''; b.textContent = d + 'd'; b.style.color = 'var(--gold)';
    return;
  }
  b.style.display = '';
  if (s.status === 'trialing') { b.textContent = daysLeft(s.trial_end) + 'd'; b.style.color = 'var(--text-2)'; }
  else { b.textContent = '!'; b.style.color = 'var(--red)'; }
}

// Debe coincidir con GRACE_DAYS del backend (api/_lib/subscriptions.js): si el
// cliente corta antes que el servidor, apaga el monitor de alguien que si tiene paso.
var GRACE_MS = 1 * 24 * 3600 * 1000;

// Vigente = prueba sin vencer, o periodo pagado sin vencer (mas la cortesia). El
// estado solo no basta: una prueba que caduco se queda en 'trialing' con trial_end pasado.
function subActive() {
  var s = SUB.subscription;
  if (!s) return false;
  var now = Date.now();
  if (s.status === 'trialing') return !!s.trial_end && new Date(s.trial_end).getTime() > now;
  if (s.status === 'active') return !!s.current_period_end && new Date(s.current_period_end).getTime() > now - GRACE_MS;
  return false;
}

// Ya vencio pero sigue andando por la cortesia.
function subInGrace() {
  var s = SUB.subscription;
  if (!s || s.status !== 'active' || !s.current_period_end) return false;
  return new Date(s.current_period_end).getTime() <= Date.now() && subActive();
}

// Puerta de entrada al monitor y al bot. Si todavia no se sabe el estado, lo pide
// antes de decidir (el cold start de /status tardaba y dejaba pasar a cualquiera).
async function requireSub() {
  if (subActive()) return true;
  if (!SUB.subscription) { try { await loadSubscription(); } catch (e) {} }
  if (subActive()) return true;
  openSubModal();
  return false;
}

function selectSubPlan(plan) {
  SUB.selectedPlan = plan;
  renderSubModal();
}

// Nunca deja navegar a un href vacio ("#") — si el link del plan no esta
// configurado, avisa en vez de mandar al usuario de vuelta a la app (que es
// exactamente lo que pasaba: el <a href="#"> recargaba la SPA y parecia que
// "no hacia nada"/volvia al monitor).
function onSubPayLinkClick(e) {
  var plan = SUB.selectedPlan || 'monthly';
  var info = SUB.plans && SUB.plans[plan];
  if (!info || !info.link) {
    e.preventDefault();
    alert('El link de pago del plan ' + (plan === 'annual' ? 'anual' : 'mensual') + ' todavía no está configurado.');
    return false;
  }
  return true;
}

// El boton de avisar el pago esta siempre visible, pero desactivado hasta que haya
// nombre: antes dependia de haber tocado el link en esa misma sesion, asi que al
// volver de Binance con la app recargada no habia forma de avisar.
function renderPaidBtn() {
  var btn = document.getElementById('sub-paid-btn');
  var help = document.getElementById('sub-paid-help');
  var nickEl = document.getElementById('sub-nick');
  if (!btn) return;
  var hasNick = !!(nickEl && nickEl.value.trim());
  btn.disabled = !hasNick;
  btn.style.opacity = hasNick ? '' : '.45';
  btn.style.cursor = hasNick ? '' : 'not-allowed';
  if (help) {
    help.textContent = hasNick
      ? 'Se activa sola en menos de un minuto.'
      : 'Pega el Order ID arriba para poder avisar.';
  }
}

// Cuantos meses de regalo trae el plan anual, calculado de los precios reales para
// que no mienta si cambian.
function renderSaveBadge() {
  var el = document.getElementById('sub-save-badge');
  if (!el || !SUB.plans) return;
  var m = Number(SUB.plans.monthly && SUB.plans.monthly.price);
  var a = Number(SUB.plans.annual && SUB.plans.annual.price);
  if (!m || !a) { el.textContent = ''; return; }
  var free = Math.round(12 - a / m);
  el.textContent = free > 0 ? (free === 1 ? '1 mes gratis' : free + ' meses gratis') : '';
}

function renderSubModal() {
  var line = document.getElementById('sub-status-line');
  var startBlock = document.getElementById('sub-start-block');
  var payBlock = document.getElementById('sub-pay-block');
  var pendBlock = document.getElementById('sub-pending-block');
  var priceEl = document.getElementById('sub-price');
  var linkEl = document.getElementById('sub-pay-link');
  var mBtn = document.getElementById('sub-plan-monthly');
  var aBtn = document.getElementById('sub-plan-annual');
  var paidBtn = document.getElementById('sub-paid-btn');
  if (!line) return;
  var s = SUB.subscription, inv = SUB.invoice;
  if (s) {
    if (s.status === 'trialing') line.textContent = 'Prueba gratis: ' + daysLeft(s.trial_end) + ' día(s) restantes';
    else if (s.status === 'active') line.textContent = 'Activa hasta ' + new Date(s.current_period_end).toLocaleDateString('es-VE');
    else if (s.status === 'not_started') line.textContent = 'Prueba gratis disponible';
    else line.textContent = 'Sin suscripción activa';
  } else {
    // El cold start de la funcion tarda; "—" parecia la app colgada.
    line.textContent = 'Cargando…';
  }
  // Nada que mostrar hasta saber en que estado esta: evita el parpadeo del bloque
  // de pago mientras carga.
  if (!s) {
    var vb = document.getElementById('sub-value');
    if (vb) vb.style.display = 'none';
    if (startBlock) startBlock.style.display = 'none';
    if (payBlock) payBlock.style.display = 'none';
    if (pendBlock) pendBlock.style.display = 'none';
    return;
  }
  var plan = SUB.selectedPlan || 'monthly';
  var info = (SUB.plans && SUB.plans[plan]) || {};
  if (priceEl) priceEl.textContent = (info.price || '—') + ' ' + (info.currency || 'USDT');
  var perEl = document.getElementById('sub-period');
  if (perEl) perEl.textContent = plan === 'annual' ? '/ año' : '/ mes';
  if (linkEl) linkEl.href = info.link || '#';
  // Solo se rellena si esta vacio: renderSubModal corre en cada poll y no debe
  // pisar lo que el usuario esta escribiendo.
  var nickEl = document.getElementById('sub-nick');
  if (nickEl && !nickEl.value && s && s.binance_nick) nickEl.value = s.binance_nick;
  if (mBtn) mBtn.classList.toggle('btn-gold', plan === 'monthly');
  if (aBtn) aBtn.classList.toggle('btn-gold', plan === 'annual');
  renderPaidBtn();
  renderSaveBadge();

  var notStarted = s && s.status === 'not_started';
  var reviewing = inv && inv.status === 'pending_review';
  // Con el periodo pagado y holgado no hay nada que cobrar. Pero en los ultimos 3
  // dias (y durante la cortesia) el bloque de pago vuelve: es justo cuando el
  // usuario quiere renovar, y markPaid encadena el periodo nuevo sin regalar dias.
  var justPaid = s && s.status === 'active' && inv && inv.status === 'paid' &&
    daysLeft(s.current_period_end) > 3 && !subInGrace();
  var rejected = inv && inv.status === 'rejected';
  var rejEl = document.getElementById('sub-rejected-note');
  if (rejEl) rejEl.style.display = rejected ? '' : 'none';
  var graceEl = document.getElementById('sub-grace-note');
  if (graceEl) {
    graceEl.style.display = subInGrace() ? '' : 'none';
    var gd = document.getElementById('sub-grace-days');
    if (gd && subInGrace()) {
      var left = Math.max(1, Math.ceil((new Date(s.current_period_end).getTime() + GRACE_MS - Date.now()) / 86400000));
      gd.textContent = left === 1 ? '1 día' : left + ' días';
    }
  }
  // El "que incluye" se muestra justo cuando el usuario esta decidiendo: sin
  // empezar la prueba, o con la prueba vencida y el pago por delante.
  var valueBox = document.getElementById('sub-value');
  if (valueBox) valueBox.style.display = subActive() && !notStarted ? 'none' : '';
  if (startBlock) startBlock.style.display = notStarted ? '' : 'none';
  if (payBlock) payBlock.style.display = (!notStarted && !reviewing && !justPaid) ? '' : 'none';
  if (pendBlock) pendBlock.style.display = (!notStarted && reviewing) ? '' : 'none';
}

// Modo prueba del admin: con ?subtest=1 la app pide el estado real de suscripcion
// en vez de la exencion de admin, para poder recorrer el flujo (trial, pago).
try {
  if (/[?&]subtest=1/.test(location.search)) sessionStorage.setItem('p2p_subtest', '1');
  else if (/[?&]subtest=0/.test(location.search)) sessionStorage.removeItem('p2p_subtest');
} catch (e) {}
function subTestMode() {
  try { return sessionStorage.getItem('p2p_subtest') === '1'; } catch (e) { return false; }
}

async function loadSubscription() {
  if (!SESSION.token) return;
  try {
    var d = await apiPost('/api/payments/status' + (subTestMode() ? '?test=1' : ''), {}, true);
    SUB.subscription = d.subscription; SUB.invoice = d.invoice; SUB.plans = d.plans;
    renderSubBadge(); renderSubModal();
    // Punto de cierre unico: el monitor puede haber arrancado antes de conocer el
    // estado (arranque optimista desde cache, hidratacion del 24/7). Si no hay
    // suscripcion vigente, se apaga aca.
    if (!subActive() && ST.running) { stopMonitorView(); monitorServerDisable(); }
    if (d.invoice && d.invoice.status === 'pending_review') schedulePoll(); else stopPoll();
    if (!window._trialPromptShown && d.subscription && d.subscription.status === 'not_started') {
      window._trialPromptShown = true;
      openSubModal();
    }
  } catch (e) {}
}

function schedulePoll() { if (!_subPollT) _subPollT = setInterval(loadSubscription, 8000); }
function stopPoll() { if (_subPollT) { clearInterval(_subPollT); _subPollT = null; } }

// El boton solo se muestra si /admin-pending responde 200 (o sea, si el usuario es
// ADMIN_EMAIL) — asi no hay que conocer ese email del lado del cliente.
// admin-pending responde 403 a quien no es el dueño, asi que el propio resultado
// dice si estamos ante el admin. Es lo que decide que partes del panel se ven.
var IS_ADMIN = false;

// Secciones que solo tienen sentido para el dueño (metricas a medio cocinar, log
// de diagnostico). Nunca al reves: si no se sabe, no se muestran.
function renderAdminOnly() {
  var els = document.querySelectorAll('.admin-only');
  for (var i = 0; i < els.length; i++) els[i].style.display = IS_ADMIN ? '' : 'none';
}

async function checkAdminPending() {
  if (!SESSION.token) return;
  var btn = document.getElementById('btn-admin-pay');
  var badge = document.getElementById('admin-pay-badge');
  if (!btn) return;
  try {
    var d = await apiPost('/api/payments/admin-pending', {}, true);
    var n = (d.invoices || []).length;
    IS_ADMIN = true;
    btn.style.display = '';
    if (badge) { badge.textContent = n; badge.style.display = n > 0 ? '' : 'none'; }
  } catch (e) {
    // 403 = no es el dueño. Nadie se vuelve admin a mitad de sesion, asi que el
    // sondeo se apaga para siempre: repetirlo cada minuto solo quemaba una
    // invocacion Vercel por usuario y por minuto para recibir el mismo 403.
    IS_ADMIN = false;
    btn.style.display = 'none';
    stopAdminPoll();
  }
  renderAdminOnly();
}
// Modal dentro de la app (no una pagina aparte): el host devuelve el index del
// monitor para rutas que no existen, asi que un .html suelto nunca cargaria.
function goAdminPending() {
  var m = document.getElementById('admin-pay-modal');
  if (m) m.style.display = 'flex';
  modalOpened('admin-pay-modal');
  renderAdminPending();
  renderPayProbe();
}

// Dice si el historial de Binance Pay es accesible con las claves del dueño, que es
// de lo que depende que los pagos se confirmen solos.
async function renderPayProbe() {
  var el = document.getElementById('admin-pay-probe');
  if (!el) return;
  el.textContent = 'Comprobando…';
  var d;
  try {
    d = await apiPost('/api/payments/pay-probe', {}, true);
  } catch (e) {
    el.innerHTML = '<span style="color:var(--red)">Error: ' + e.message + '</span>';
    return;
  }
  if (!d.ok) {
    el.innerHTML = '<span style="color:var(--red)">No disponible</span>' +
      '<div style="font-size:11px;color:var(--text-3);margin-top:4px">' +
      (d.reason || '') + (d.code ? ' (' + d.code + ')' : '') + '</div>';
    return;
  }
  var det = d.last && d.last.length
    ? d.last.map(function (t) {
        var quien = t.payer
          ? ' — ' + (t.payerFields || []).map(function (k) { return k + ': ' + t.payer[k]; }).join(', ')
          : ' — sin payerInfo';
        var id = t.txId ? '<br><span style="color:var(--gold)">API txId: ' + t.txId + '</span>' : '';
        return t.amount + ' ' + t.currency + ' · ' + new Date(t.when).toLocaleString('es-VE') + quien + id;
      }).join('<br>')
    : 'sin movimientos en 24h';
  el.innerHTML = '<span style="color:#1D9E75">✓ Historial accesible</span> · ' +
    d.total + ' en 24h (' + d.incoming + ' entrantes)' +
    '<div style="font-size:11px;color:var(--text-2);margin-top:4px">' + det + '</div>';
}

function closeAdminPayModal() {
  var m = document.getElementById('admin-pay-modal');
  if (m) m.style.display = 'none';
  modalClosed('admin-pay-modal');
}

async function renderAdminPending() {
  var box = document.getElementById('admin-pay-list');
  if (!box) return;
  box.textContent = 'Cargando…';
  var d;
  try {
    d = await apiPost('/api/payments/admin-pending', {}, true);
  } catch (e) {
    box.textContent = 'Error: ' + e.message;
    return;
  }
  var invoices = d.invoices || [];
  if (!invoices.length) { box.textContent = 'No hay pagos pendientes.'; return; }
  box.innerHTML = '';
  invoices.forEach(function (inv) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);text-align:left';
    var when = new Date(inv.created_at).toLocaleString('es-VE');
    var info = document.createElement('div');
    info.innerHTML = '<div style="font-weight:600">' + inv.email + '</div>' +
      '<div style="font-size:12px;color:var(--text-3)">' + inv.plan + ' · ' + when + '</div>';
    var right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:10px;flex-shrink:0';
    var amt = document.createElement('span');
    amt.style.cssText = 'font-weight:600;color:var(--gold)';
    amt.textContent = inv.amount + ' ' + inv.currency;
    var btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = 'Confirmar';
    btn.onclick = function () { resolveAdminPayment('admin-confirm', inv.id, btn); };
    var rej = document.createElement('button');
    rej.className = 'btn btn-sm';
    rej.textContent = 'Rechazar';
    rej.onclick = function () {
      if (!window.confirm('¿Rechazar el pago de ' + inv.email + '?')) return;
      resolveAdminPayment('admin-reject', inv.id, rej);
    };
    right.appendChild(amt); right.appendChild(btn); right.appendChild(rej);
    row.appendChild(info); row.appendChild(right);
    box.appendChild(row);
  });
}

// Reset de testing: deja a todos los usuarios (menos el admin) como recien
// registrados, para volver a probar el flujo de prueba gratis y pago.
async function resetAllSubs(btn) {
  if (!window.confirm('Borrar suscripciones y facturas de TODOS los usuarios menos el admin. ¿Seguro?')) return;
  btn.disabled = true;
  var label = btn.textContent;
  btn.textContent = '…';
  try {
    var d = await apiPost('/api/payments/admin-reset-subs', {}, true);
    alert('Listo: ' + d.subscriptions + ' suscripción(es) y ' + d.invoices + ' factura(s) borradas.');
    renderAdminPending();
    checkAdminPending();
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function resolveAdminPayment(action, invoiceId, btn) {
  var label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await apiPost('/api/payments/' + action, { invoiceId: invoiceId }, true);
    await renderAdminPending();
    checkAdminPending();
  } catch (e) {
    alert('Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Cola de facturas por revisar: solo la ve el dueño, y es trabajo manual suyo — no
// necesita cadencia de segundos. 5 min, y solo con la pestaña visible (en segundo
// plano no hay badge que mirar). checkAdminPending lo apaga del todo si no es admin.
var _adminPollT = null;
function startAdminPoll() {
  if (_adminPollT) return;
  _adminPollT = setInterval(function () {
    if (document.visibilityState === 'visible') checkAdminPending();
  }, 5 * 60000);
}
function stopAdminPoll() {
  if (_adminPollT) { clearInterval(_adminPollT); _adminPollT = null; }
}
startAdminPoll();

// ── Boton atras de Android ───────────────────────────────
// Instalada como app, con un modal abierto el boton atras cerraba la aplicacion
// entera. Cada modal abierto empuja una entrada al historial, y atras la consume
// cerrando ese modal en vez de salir.
var MODAL_STACK = [];
var _modalSelfBack = 0;

function modalOpened(id) {
  if (MODAL_STACK.indexOf(id) !== -1) return;
  MODAL_STACK.push(id);
  try { history.pushState({ p2pModal: id }, ''); } catch (e) {}
}

// Cierre pedido desde la app (boton Cerrar, click fuera): deshace su entrada del
// historial. El popstate que eso dispara no debe cerrar nada mas, de ahi el contador.
function modalClosed(id) {
  var i = MODAL_STACK.indexOf(id);
  if (i === -1) return;
  MODAL_STACK.splice(i, 1);
  _modalSelfBack++;
  try { history.back(); } catch (e) { _modalSelfBack--; }
}

window.addEventListener('popstate', function() {
  if (_modalSelfBack > 0) { _modalSelfBack--; return; }
  var id = MODAL_STACK.pop();
  if (!id) return;
  var m = document.getElementById(id);
  if (m) m.style.display = 'none';
});

function openSubModal() {
  var m = document.getElementById('sub-modal');
  if (m) m.style.display = 'flex';
  modalOpened('sub-modal');
  loadSubscription();
}
function closeSubModal() {
  var m = document.getElementById('sub-modal');
  if (m) m.style.display = 'none';
  modalClosed('sub-modal');
}

// ── Primeros pasos ──────────────────────────────────────
// Activar la prueba dejaba al usuario dentro de la app sin Binance, sin Telegram y
// sin nada que le dijera por donde seguir. Esta lista se abre al empezar la prueba
// y queda a mano en el engranaje.

// Si hay llaves de Binance guardadas. Lo mantienen refreshAuthUI y binanceConnect.
var BNC = { connected: false };

function renderOnboard() {
  // Sin bot de Telegram configurado en el servidor no tiene sentido pedirlo, y el
  // paso desaparece — por eso los numeros se asignan sobre los pasos visibles, para
  // no dejar un hueco (1, 3) que parece un error.
  var st2 = document.getElementById('ob-step-2');
  if (st2) st2.style.display = TGLINK.available ? '' : 'none';

  var pasos = [
    ['ob-n-1', 'ob-btn-1', !!BNC.connected, true],
    ['ob-n-2', 'ob-btn-2', !!TGLINK.linked, !!TGLINK.available],
    ['ob-n-3', 'ob-btn-3', !!ST.running, true],
  ].filter(function(p) { return p[3]; });

  pasos.forEach(function(p, i) {
    var n = document.getElementById(p[0]);
    var b = document.getElementById(p[1]);
    if (n) { n.classList.toggle('done', p[2]); n.textContent = p[2] ? '✓' : String(i + 1); }
    if (b) b.style.display = p[2] ? 'none' : '';
  });
  var sub = document.getElementById('onboard-sub');
  if (sub) {
    var faltan = pasos.filter(function(p){ return !p[2]; }).length;
    sub.textContent = !faltan ? 'Ya tienes todo conectado.'
      : (pasos.length === 3 ? 'Tres cosas y queda trabajando solo.' : 'Un par de cosas y queda trabajando solo.');
  }
}

function openOnboard() {
  var m = document.getElementById('onboard-modal');
  if (m) m.style.display = 'flex';
  modalOpened('onboard-modal');
  renderOnboard();
  // Estado fresco: pudo conectar cualquiera de las dos cosas en otro momento.
  try { tgRefreshLink(); } catch (e) {}
  try { refreshAuthUI(); } catch (e) {}
}
function closeOnboard() {
  var m = document.getElementById('onboard-modal');
  if (m) m.style.display = 'none';
  modalClosed('onboard-modal');
}

function onboardGoBinance() {
  closeOnboard();
  try { showTab('bot', 'l'); } catch (e) {}
  var p = document.getElementById('bot-gear-popup');
  if (p) p.style.display = 'block';
  openApiKeyModal();
}
function onboardGoTelegram() {
  // No cierra la lista: tgConnect abre Telegram aparte y al volver se ve el tilde.
  var b = document.getElementById('ob-btn-2');
  if (b) { b.disabled = true; b.textContent = 'Abriendo Telegram…'; }
  try { tgConnect(); } catch (e) {}
  setTimeout(function() {
    if (b && !TGLINK.linked) { b.disabled = false; b.textContent = 'Conectar Telegram'; }
  }, 8000);
}
async function onboardGoMonitor() {
  closeOnboard();
  try { showTab('mercado', 'r'); } catch (e) {}
  if (!ST.running) await toggleMonitor();
  renderOnboard();
}

// Unico lugar donde vive el contacto de soporte: sale en el muro de acceso y en
// los terminos. Cambiar aca y ya.
var SOPORTE = { label: 'Telegram @KisuShotto15', url: 'https://t.me/KisuShotto15' };

function renderSoporte() {
  var el = document.getElementById('legal-contact');
  if (!el) return;
  if (SOPORTE.url) {
    var a = document.createElement('a');
    a.href = SOPORTE.url; a.target = '_blank'; a.rel = 'noopener';
    a.style.color = 'var(--gold)';
    a.textContent = SOPORTE.label;
    el.textContent = '';
    el.appendChild(a);
  } else {
    el.textContent = SOPORTE.label || 'escríbenos desde la app';
  }
}
function openSupport() {
  if (SOPORTE.url) window.open(SOPORTE.url, '_blank', 'noopener');
  else openLegalModal();
}

function openLegalModal() {
  renderSoporte();
  var m = document.getElementById('legal-modal');
  if (m) m.style.display = 'flex';
  modalOpened('legal-modal');
}
function closeLegalModal() {
  var m = document.getElementById('legal-modal');
  if (m) m.style.display = 'none';
  modalClosed('legal-modal');
}

function openApiKeyModal() {
  var m = document.getElementById('apikey-modal');
  if (m) m.style.display = 'flex';
  modalOpened('apikey-modal');
}
function closeApiKeyModal() {
  var m = document.getElementById('apikey-modal');
  if (m) m.style.display = 'none';
  modalClosed('apikey-modal');
}

async function startTrialClick() {
  var btn = document.getElementById('sub-start-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Activando...'; }
  try {
    var d = await apiPost('/api/payments/start-trial', {}, true);
    SUB.subscription = d.subscription;
    renderSubBadge(); renderSubModal();
    // Momento exacto en que el usuario queda dentro sin nada configurado.
    closeSubModal();
    openOnboard();
  } catch (e) {
    alert('No se pudo activar la prueba: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Comenzar prueba gratis'; }
  }
}

async function markSubPaid() {
  var btn = document.getElementById('sub-paid-btn');
  var nickEl = document.getElementById('sub-nick');
  var nick = nickEl ? nickEl.value.trim() : '';
  // Sin nombre no se puede confirmar el pago solo: el monto no distingue esta
  // suscripcion de cualquier otro cobro de USDT que entre a la vez.
  if (!nick) {
    alert('Pega el Order ID del pago (o tu nickname de Binance) para poder identificarlo.');
    if (nickEl) nickEl.focus();
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
  try {
    await apiPost('/api/payments/set-nick', { nick: nick }, true);
    await apiPost('/api/payments/mark-pending', { plan: SUB.selectedPlan || 'monthly' }, true);
    // mark-pending ya intenta confirmar de una (por si el correo llego antes del click):
    // recargar el estado completo en vez de parchear a mano, para que "pagado al toque"
    // tambien refresque la suscripcion (no solo la factura).
    await loadSubscription();
  } catch (e) {
    alert('No se pudo avisar el pago: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Ya pagué'; }
  }
}

async function cancelSubPending() {
  try {
    await apiPost('/api/payments/cancel-pending', {}, true);
  } catch (e) {}
  SUB.invoice = null;
  stopPoll();
  renderSubModal();
}

// Al cargar: si hay sesion valida (email autorizado), entra; si no, queda el muro.
async function initAuth() {
  if (!SESSION.token) return;        // sin token: queda el muro
  enterApp(); refreshAuthUI();       // optimista: entra ya, sin esperar a la red
  try {
    var r = await fetchRetry(API_BASE + '/api/auth/me', { headers: { 'Authorization': 'Bearer ' + SESSION.token } });
    if (r.status === 401 || r.status === 403) { authLogout(); return; } // token invalido/expirado
    if (!r.ok) return;               // error transitorio del server: mantener sesion
    var d = await r.json().catch(function(){ return {}; });
    if (d.email) { SESSION.email = d.email; saveSession(); refreshAuthUI(); }
  } catch(e) { /* sin red: mantener sesion, no cerrar */ }
}

async function binanceConnect() {
  var st = document.getElementById('bnc-st');
  var apiKey = document.getElementById('cfg-bnc-key').value.trim();
  var apiSecret = document.getElementById('cfg-bnc-secret').value.trim();
  st.textContent = 'Validando con Binance...'; st.style.color = 'var(--text-2)';
  try {
    var d = await apiPost('/api/binance-connect', { apiKey: apiKey, apiSecret: apiSecret }, true);
    st.textContent = '✓ Conectado'; st.style.color = '#1D9E75';
    document.getElementById('cfg-bnc-key').value = '';
    document.getElementById('cfg-bnc-secret').value = '';
    BNC.connected = true;
    bncSetConnected(true);
    renderOnboard();
    loadMyAds();
  } catch(e) { st.textContent = '⚠ ' + e.message; st.style.color = 'var(--red)'; }
}

function bncSetConnected(connected) {
  var c = document.getElementById('bnc-connected');
  var f = document.getElementById('bnc-form');
  if (!c || !f) return;
  c.style.display = connected ? 'flex' : 'none';
  f.style.display = connected ? 'none' : '';
}

function bncShowForm() {
  var c = document.getElementById('bnc-connected');
  var f = document.getElementById('bnc-form');
  if (c) c.style.display = 'none';
  if (f) f.style.display = '';
}

// Formatea una duracion en segundos de forma legible (seg / min / h).
function fmtDur(s) {
  if (s == null) return '—';
  if (s < 60) return Math.round(s) + ' seg';
  if (s < 3600) return Math.round(s / 60) + ' min';
  return (s / 3600).toFixed(1) + ' h';
}
function intFmt(n) { return Math.round(n).toLocaleString('es-VE'); }

// Metricas de rotacion: volumen/ordenes desde la tabla orders del servidor.
// La ganancia es spread x capital x rotaciones: esto mide la rotacion real.
// Ganancia realizada (FIFO compra→venta). Complementa al P&L potencial del panel:
// aquel dice cuanto ganaria el anuncio, este cuanto entro de verdad y a que margen.
async function loadPnlStats() {
  var el = document.getElementById('pnl-stats');
  if (!el || !SESSION.token) return;
  try {
    var d = await botCallWorker('/order-pnl');
    if (d.error) throw new Error(d.error);
    if (!d.counts.sells) {
      el.innerHTML = '<div class="rot-line"><span>Ganancia realizada</span><b>sin ventas registradas</b></div>';
      return;
    }
    function money(v) { return (v >= 0 ? '+' : '') + fmt(v) + ' <small>USDT</small>'; }
    function tile(label, val, sub, color) {
      return '<div class="rot-tile"><span class="rot-lbl">' + label + '</span>' +
        '<span class="rot-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + val + '</span>' +
        '<span class="rot-sub">' + (sub || '') + '</span></div>';
    }
    var t = d.today, w = d.d7;
    var col = function(v) { return v >= 0 ? 'var(--green)' : 'var(--red)'; };
    var html = '<div class="rot-grid">' +
      tile('Ganancia hoy', money(t.netUsdt), t.lots + ' cierres', col(t.netUsdt)) +
      tile('Promedio 7 días', money(w.netUsdt / 7) + '/día', intFmt(w.qty) + ' USDT rotados', col(w.netUsdt)) +
      '</div>';
    // La brecha entre el margen real y el configurado es la fuga: fills parciales,
    // ordenes canceladas y ventas fuera del precio planeado.
    if (w.marginPct != null) {
      var gapTxt = w.marginPct.toFixed(3) + '%';
      if (d.minSpread != null) gapTxt += ' <span style="color:var(--text-3)">vs ' + d.minSpread + '% config</span>';
      html += '<div class="rot-line"><span>Margen real 7d</span><b style="color:' +
        (d.minSpread == null || w.marginPct >= d.minSpread ? 'var(--green)' : 'var(--red)') + '">' + gapTxt + '</b></div>';
    }
    if (w.medHoldSec != null) html += '<div class="rot-line"><span>Ciclo de capital</span><b>' + fmtDur(w.medHoldSec) + '</b></div>';
    if (d.openQty > 0.01) html += '<div class="rot-line"><span>Inventario abierto</span><b>' + intFmt(d.openQty) +
      ' USDT' + (d.openAvgPrice ? ' @ ' + fmt(d.openAvgPrice) : '') + '</b></div>';
    el.innerHTML = html;
    // Visible con la seccion plegada: la ganancia del dia sin tener que desplegar.
    var sum = document.getElementById('pnl-summary');
    if (sum) {
      sum.textContent = '· ' + (t.netUsdt >= 0 ? '+' : '') + fmt(t.netUsdt) + ' USDT';
      sum.style.color = col(t.netUsdt);
    }
  } catch (e) {
    el.textContent = '';
  }
}

// Ventanas de mercado: cuantas horas hubo spread trabajable y cuantas aprovechaste.
// El capital parado solo es fuga si el mercado pagaba y no estabas.
async function loadMarketWindows() {
  var el = document.getElementById('window-stats');
  if (!el || !SESSION.token) return;
  try {
    var d = await botCallWorker('/spread-windows');
    if (d.error) throw new Error(d.error);
    if (!d.coveredH) { el.innerHTML = ''; return; }
    var html = '<div class="rot-head">Mercado (' + d.days + ' días, piso ' + d.floor + '%)</div>' +
      '<div class="rot-line"><span>Horas con spread ≥ ' + d.floor + '%</span><b>' +
        fmtH(d.withSpreadH) + ' <span class="rot-mut">de ' + fmtH(d.coveredH) + '</span></b></div>' +
      '<div class="rot-line"><span>Aprovechadas (bot encendido)</span><b style="color:var(--green)">' +
        fmtH(d.takenH) + '</b></div>' +
      '<div class="rot-line"><span>Perdidas (había spread, bot apagado)</span><b style="color:' +
        (d.missedH > 0.5 ? 'var(--red)' : 'var(--text)') + '">' + fmtH(d.missedH) + '</b></div>';
    // Histograma por hora: donde aparece el spread. Es lo accionable — dice cuando
    // vale la pena estar encendido, no que estes encendido siempre.
    var hrs = d.byHour || [], max = 0;
    for (var i = 0; i < hrs.length; i++) if (hrs[i].rate > max) max = hrs[i].rate;
    if (max > 0) {
      var byH = {}, k;
      for (k = 0; k < hrs.length; k++) byH[hrs[k].hour] = hrs[k];
      var bars = '';
      for (var h = 0; h < 24; h++) {
        var r = byH[h], pct = r ? r.rate / max * 100 : 0;
        bars += '<span title="' + h + 'h: ' + (r ? Math.round(r.rate * 100) : 0) + '% del tiempo con spread">' +
          '<i style="height:' + Math.max(pct, 2).toFixed(0) + '%"></i></span>';
      }
      html += '<div class="rot-head" style="margin-bottom:3px">A qué hora aparece</div>' +
        '<div class="rot-hist">' + bars + '</div>' +
        '<div class="rot-leg"><span>0h</span><span style="margin-left:auto">12h</span><span style="margin-left:auto">23h</span></div>';
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '';
  }
}

// Spread vs llenado y reparto del tiempo del anuncio (tabla bot_samples).
// Un spread mas alto da mas margen por orden pero menos ordenes: lo que importa
// es el producto. Y el capital parado no cobra spread ninguno.
async function loadSpreadStats() {
  var el = document.getElementById('spread-stats');
  if (!el || !SESSION.token) return;
  try {
    var d = await botCallWorker('/spread-stats');
    if (d.error) throw new Error(d.error);
    var html = '';
    var b = d.budget;
    if (b && b.onH > 0.5) {
      var seg = [
        { l: 'Productivo', h: b.productiveH, c: 'var(--green)' },
        { l: 'Oculto',     h: b.hiddenH,     c: 'var(--gold)' },
        { l: 'Sin saldo',  h: b.emptyH,      c: 'var(--red)' },
        { l: 'Apagado',    h: b.offH,        c: 'var(--border-2)' }
      ];
      var bar = '', leg = '';
      for (var i = 0; i < seg.length; i++) {
        var pct = seg[i].h / b.totalH * 100;
        if (pct <= 0) continue;
        bar += '<span style="width:' + pct.toFixed(1) + '%;background:' + seg[i].c + '"></span>';
        leg += '<span><i style="background:' + seg[i].c + '"></i>' + seg[i].l + ' ' + Math.round(pct) + '%</span>';
      }
      html += '<div class="rot-head">Dónde se va el capital (7 días)</div>' +
        '<div class="rot-bar">' + bar + '</div><div class="rot-leg">' + leg + '</div>';
    }
    var curve = (d.curve || []).filter(function(c) { return c.hours >= 1; });
    if (curve.length) {
      var rows = '';
      for (var j = 0; j < curve.length; j++) {
        var c = curve[j];
        var isBest = d.best && c.spread === d.best.spread && curve.length > 1;
        rows += '<tr' + (isBest ? ' class="best"' : '') + '><td>' + c.spread + '%</td>' +
          '<td>' + c.ordersPerHour.toFixed(1) + '</td>' +
          '<td>' + intFmt(c.usdtPerHour) + '</td>' +
          '<td>' + fmt(c.netPerHour) + (isBest ? ' ★' : '') + '</td>' +
          '<td>' + Math.round(c.hours) + ' h</td></tr>';
      }
      html += '<div class="rot-head">Qué rindió cada margen (' + d.days + ' días)</div>' +
        '<table class="rot-tab"><tr><th>Margen</th><th>Órd/h</th><th>USDT/h</th><th>Neto/h</th><th>Muestra</th></tr>' +
        rows + '</table>' +
        '<div class="rot-leg" style="margin-top:5px">' + (d.best ? '★ mejor medido con ≥6 h. ' : '') +
        'El piso lo pones tú: esto solo dice cuánto volumen cuesta cada 0.1% extra de margen.</div>';
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '';
  }
}

function fmtH(h) { return h < 1 ? Math.round(h * 60) + ' min' : (h < 10 ? h.toFixed(1) : Math.round(h)) + ' h'; }

async function loadOrderStats() {
  loadPnlStats();
  loadMarketWindows();
  loadSpreadStats();
  syncJournalFromOrders().then(renderJournalStats);
  var el = document.getElementById('order-stats');
  if (!el || !SESSION.token) return;
  el.textContent = 'Cargando...';
  try {
    var d = await botCallWorker('/order-stats');
    if (d.error) throw new Error(d.error);
    var perDayUsdt = d.week.usdt / 7, perDayOrd = d.week.done / 7;
    var top = (d.hours || []).slice().sort(function(a, b){ return b.usdt - a.usdt; }).slice(0, 3)
      .map(function(h){ return String(h.h).padStart(2, '0') + 'h'; }).join(' · ');
    function tile(label, val, sub) {
      return '<div class="rot-tile"><span class="rot-lbl">' + label + '</span>' +
        '<span class="rot-val">' + val + '</span>' +
        '<span class="rot-sub">' + (sub || '') + '</span></div>';
    }
    el.innerHTML =
      '<div class="rot-grid">' +
        tile('Hoy', intFmt(d.today.usdt) + ' <small>USDT</small>', d.today.done + ' órdenes') +
        tile('Promedio 7 días', intFmt(perDayUsdt) + ' <small>USDT/día</small>', Math.round(perDayOrd) + ' órdenes/día') +
      '</div>' +
      '<div class="rot-line"><span>Una orden cada</span><b>' + fmtDur(d.medGapSec) + '</b></div>' +
      (top ? '<div class="rot-line"><span>Horas más activas</span><b>' + top + '</b></div>' : '');
    // Resumen en el titulo plegado: el dato de hoy sin tener que desplegar.
    var sum = document.getElementById('rot-summary');
    if (sum) sum.textContent = '· hoy ' + intFmt(d.today.usdt) + ' USDT';
  } catch (e) {
    el.textContent = 'Sin datos aún (se acumulan con el bot encendido)';
  }
}

async function refreshAuthUI() {
  var inEl = document.getElementById('auth-in');
  if (!inEl) return;
  var logged = !!SESSION.token;
  inEl.style.display = logged ? '' : 'none';
  if (logged) {
    document.getElementById('auth-email').textContent = SESSION.email || '';
    try {
      var r = await fetchRetry(API_BASE + '/api/binance-status', {
        method: 'GET', headers: { 'Authorization': 'Bearer ' + SESSION.token }
      });
      if (r.status === 401) { authLogout(); return; }
      var d = await r.json().catch(function(){ return {}; });
      var bnc = document.getElementById('bnc-st');
      BNC.connected = !!d.connected;
      if (d.connected) { bnc.textContent = '✓ Conectado'; bnc.style.color = '#1D9E75'; bncSetConnected(true); loadMyAds(); }
      renderOnboard();
    } catch(e) {}
  }
}

// ── Estado ───────────────────────────────────────────
var ST = {
  running: false,
  timer: null,
  allAds: [],
  mayoristas: [],
  smallAds: [],
  buyAds: [],
  priceHist: [],   // {ts, price}
  alerts: [],
  lastFetch: null,
  lastAttempt: 0, // inicio del ultimo fetchOnce (lo usa el watchdog de reanudacion)
  fetching: false,
  consecFails: 0
};

var COOLDOWN = {};
var COOLDOWN_MS = 5 * 60000;

// ── API ──────────────────────────────────────────────
// Construye el body de busqueda P2P
function buildSearchBody(opts) {
  var body = {
    asset: 'USDT',
    fiat: ACTIVE_FIAT,
    merchantCheck: false,
    page: opts.page,
    rows: 20,
    tradeType: opts.tradeType || 'SELL',
    payTypes: opts.pays
  };
  // Pre-filtrar verificados en Binance (como el toggle "Solo comerciantes" de su web):
  // paginas llenas de verificados → sin huecos y sin pedir paginas extra.
  if (CFG.verifiedOnly) body.publisherType = 'merchant';
  if (opts.fiat) body.fiat = opts.fiat; // override (el bot siempre busca en VES)
  if (opts.transAmount && parseFloat(opts.transAmount) > 0) body.transAmount = opts.transAmount;
  return body;
}

// Lote: 1 sola llamada Vercel para N paginas. Devuelve array alineado por indice (data[] por query).
// ── Red con timeout + reintento ───────────────────────
async function fetchWithTimeout(url, opts, ms) {
  ms = ms || 8000;
  var ctrl = new AbortController();
  var t = setTimeout(function(){ ctrl.abort(); }, ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function fetchRetry(url, opts, ms, retries) {
  retries = (retries == null) ? 1 : retries;
  var base = ms || 8000;
  var lastErr;
  for (var i = 0; i <= retries; i++) {
    try {
      // El primer intento puede llevar un timeout corto (ver fetchOnce al reanudar):
      // los reintentos vuelven al minimo normal para no cortar una respuesta lenta real.
      var r = await fetchWithTimeout(url, opts, i === 0 ? base : Math.max(base, 8000));
      if (r.status >= 500 || r.status === 429) {
        if (i < retries) { await new Promise(function(res){ setTimeout(res, 600); }); continue; }
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i < retries) { await new Promise(function(res){ setTimeout(res, 600); }); continue; }
      throw e;
    }
  }
  throw lastErr;
}

async function searchBatch(bodies, ms, wantBot) {
  bootMark('asked');
  var payload = { queries: bodies };
  // Pedir el estado del bot pegado a esta respuesta solo cuando su propio poller
  // esta activo (bot corriendo y no en pleno arranque): asi el servidor no lee
  // bot_state para nada.
  if (wantBot && BOT.running && BOT_POLL.timer && !botStarting()) payload.bot = true;
  var r = await fetchRetry(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (SESSION.token || '') },
    body: JSON.stringify(payload)
  }, ms);
  if (r.status === 401 || r.status === 403) { authLogout(); throw new Error('Sesión expirada'); }
  // El servidor cerro la puerta (suscripcion vencida entre refrescos): apagar el
  // monitor y mostrar el modal, en vez de reintentar cada 15s contra un 402.
  if (r.status === 402) {
    stopMonitorView();
    monitorServerDisable();
    loadSubscription();
    openSubModal();
    throw new Error('Suscripción requerida');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  var d = await r.json();
  if (d.error) throw new Error(d.error);
  // Llego el estado del bot montado en la respuesta del monitor: pintarlo YA, antes
  // de procesar el libro. Si viene null (el servidor no pudo leerlo) no se toca nada
  // y el poller propio del bot cubre el hueco a los 15s.
  if (d.bot) botStateFromMonitor(d.bot);
  var results = d.results || [];
  // Si TODAS las queries fallaron en Binance es un problema de red, no un mercado
  // vacio: lanzar para conservar los datos previos en vez de pintar tablas vacias.
  if (results.length && results.every(function(res) { return !res || res.error; })) throw new Error('Binance no respondió');
  return results.map(function(res) { return (res && res.data) || []; });
}

// Solo lo usa el bot (reprice inicial): SIEMPRE mercado VES, sin importar la vista.
async function fetchTier(transAmount, maxPages, payTypesOverride) {
  maxPages = maxPages || 2;
  var pays = (payTypesOverride && payTypesOverride.length) ? payTypesOverride : [PAY_SEL.VES];
  var bodies = [];
  for (var i = 1; i <= maxPages; i++) {
    bodies.push(buildSearchBody({ transAmount: transAmount, page: i, pays: pays, tradeType: 'SELL', fiat: 'VES' }));
  }
  var results = await searchBatch(bodies);
  return results.flatMap(function(arr) { return arr; });
}

// keepOrder=true (filtro de monto en 0): conserva el orden nativo de Binance.
// Con filtro de monto: ordena desc por precio (mejor mayorista primero).
function mapAds(raw, keepOrder) {
  var mapped = raw.map(function(item) {
    return {
      advNo:    item.adv.advNo,
      price:    parseFloat(item.adv.price),
      minVES:   parseFloat(item.adv.minSingleTransAmount),
      maxVES:   parseFloat(item.adv.maxSingleTransAmount),
      avail:    parseFloat(item.adv.tradableQuantity),
      merchant: item.advertiser.nickName,
      orders:   item.advertiser.monthOrderCount,
      comp:     Math.round((item.advertiser.monthFinishRate || 0) * 100),
      payTypes:  (item.adv.tradeMethods || []).map(function(m) { return m.identifier; }),
      badges:    item.advertiser.badges,
      vipLevel:  item.advertiser.vipLevel
    };
  }).filter(function(a) {
    // Solo comerciantes con insignia (Bronze/Silver/Gold/Block/Ordinary/PRO)
    // badges: null = sin insignia → excluir (si el filtro esta activo)
    return !CFG.verifiedOnly || (a.badges && a.badges.length > 0);
  });
  if (!keepOrder) mapped.sort(function(a, b) { return b.price - a.price; });
  return mapped;
}

// ── Sección Compra (BUY) ─────────────────────────────
function mapBuyAds(raw) {
  return raw.map(function(item) {
    return {
      advNo:   item.adv.advNo,
      price:   parseFloat(item.adv.price),
      minVES:  parseFloat(item.adv.minSingleTransAmount),
      maxVES:  parseFloat(item.adv.maxSingleTransAmount),
      avail:   parseFloat(item.adv.tradableQuantity),
      merchant: item.advertiser.nickName,
      orders:  item.advertiser.monthOrderCount,
      comp:    Math.round((item.advertiser.monthFinishRate || 0) * 100),
      badges:  item.advertiser.badges,
      vipLevel: item.advertiser.vipLevel
    };
  }).filter(function(a) {
    return (!CFG.verifiedOnly || (a.badges && a.badges.length > 0)) && a.maxVES >= CFG.buyAmount;
  }).sort(function(a, b) { return a.price - b.price; });  // ascendente: más barato primero
}

// ── Acumulador de variacion (avail / price) ───────────
// Ventana deslizante: cada variacion vive ACCUM_WINDOW_MS y luego se descuenta
// del total. El valor mostrado = suma de variaciones de los ultimos 60s.
var ACCUM_WINDOW_MS = 60000;
function accumDelta(section, ads, prevMap, field, minDelta) {
  ST.deltaAccum = ST.deltaAccum || {};
  var byField = ST.deltaAccum[field] = ST.deltaAccum[field] || {};
  var acc = byField[section] = byField[section] || {};
  var now = Date.now();
  var present = {};
  var display = {};
  ads.forEach(function(ad) {
    present[ad.advNo] = true;
    var ev = acc[ad.advNo] || [];
    var prev = prevMap[ad.advNo];
    var fresh = false;
    if (prev !== undefined) {
      var delta = ad[field] - prev;
      if (Math.abs(delta) >= minDelta) { ev.push({ ts: now, delta: delta }); fresh = true; }
    }
    ev = ev.filter(function(e){ return now - e.ts < ACCUM_WINDOW_MS; });
    acc[ad.advNo] = ev;
    var sum = ev.reduce(function(s, e){ return s + e.delta; }, 0);
    if (Math.abs(sum) >= minDelta) display[ad.advNo] = { value: sum, fresh: fresh };
  });
  // limpiar merchants que ya no estan en el top
  Object.keys(acc).forEach(function(m){ if (!present[m]) delete acc[m]; });
  return display;
}

// Filas visibles en cada libro: 10 por defecto, 15 al expandir con "ver mas".
var OB_BASE_ROWS = 10, OB_MAX_ROWS = 15;
// Indicador +X en el titulo: anuncios fetcheados que no caben en los visibles.
function setExtraCount(id, fetched) {
  var el = document.getElementById(id);
  if (!el) return;
  // +X = comercios traidos de Binance mas alla del maximo que muestra la UI (15).
  var extra = fetched - OB_MAX_ROWS;
  el.textContent = extra > 0 ? '+' + extra : '';
  el.title = extra > 0 ? fetched + ' anuncios traidos de Binance, ' + OB_MAX_ROWS + ' visibles como maximo' : '';
}

function availArrowHtml(d) {
  if (!d || !d.value) return '';
  var v = d.value, av = Math.abs(v);
  var s = av >= 1000
    ? (av / 1000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'k'
    : Math.round(av).toLocaleString('es-VE');
  if (v > 0) return '<span class="avail-arrow up" title="Recargó +' + Math.round(v) + ' USDT (últ. 60s)">+' + s + '</span>';
  return '<span class="avail-arrow down" title="Vendió ' + Math.round(v) + ' USDT (últ. 60s)">-' + s + '</span>';
}

// Variacion de precio del comerciante en los ultimos 60s, en Bs.
// Solo para la celda de la columna Cambio (oculta en movil). El precio no lleva
// esta clase: su color sale del flash y de .chg-part, nunca del numero entero.
function priceChgCls(d) {
  if (!d || !d.value) return '';
  return d.value > 0 ? ' chg-up' : ' chg-down';
}
// Precio partido en prefijo intacto + los digitos que se movieron, para colorear
// solo esa cola (el flash del numero entero lo hace la animacion en CSS).
function priceSplitHtml(price, d) {
  var cur = fmtP(price);
  if (!d || !d.value) return cur;
  var base = fmtP(price - d.value);
  var i = 0;
  while (i < cur.length && i < base.length && cur[i] === base[i]) i++;
  if (i >= cur.length) return cur;
  return cur.slice(0, i) + '<span class="chg-part ' + (d.value > 0 ? 'up' : 'down') + '">' + cur.slice(i) + '</span>';
}
// Clase de flash: solo el ciclo en que el precio se movio de verdad.
function priceFlashCls(d) {
  if (!d || !d.fresh) return '';
  d.fresh = false;
  return d.value > 0 ? ' flash-up' : ' flash-down';
}

function priceChgHtml(d) {
  if (!d || !d.value) return '';
  var v = d.value;
  var s = Math.abs(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  var up = v > 0;
  return '<span title="' + (up ? 'Subió +' : 'Bajó -') + s + ' Bs (últ. 60s)">' + (up ? '+' : '−') + s + '</span>';
}

function availPopupHtml(d) {
  if (!d || !d.value) return '';
  var v = d.value, av = Math.abs(v);
  var s = av >= 1000
    ? (av / 1000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'k'
    : Math.round(av).toLocaleString('es-VE');
  if (v > 0) return '<span class="avail-popup up">+' + s + '</span>';
  return '<span class="avail-popup down">-' + s + '</span>';
}

// ── Ciclo principal ───────────────────────────────────
// Un solo batch combinado: paginas may + small + buy en 1 request Vercel
var MAY_PAGES = 1, SMALL_PAGES = 1;
async function fetchOnce(fast) {
  // Sin solapes: al volver del background pueden dispararse varios eventos de
  // reanudacion y el watchdog a la vez; un solo ciclo en vuelo.
  if (ST.fetching) return;
  ST.fetching = true;
  ST.lastAttempt = Date.now();
  document.getElementById('last-update').textContent = 'Cargando...';
  try {
    // Con Modo Short apagado Recompra no se muestra en ningun lado: no pedir su
    // pagina. Con Short prendido (defecto), Verde solo se pide si la Sección
    // Compra esta expandida; con Short apagado, Verde es primaria y se pide siempre.
    var buyBody = document.getElementById('buy-section-body');
    var includeSmall = !isShortOff();
    var includeBuy = isShortOff() || !buyBody || buyBody.style.display !== 'none';

    var bodies = [];
    for (var i = 1; i <= MAY_PAGES; i++) bodies.push(buildSearchBody({ transAmount: CFG.mayAmount, page: i, pays: [ACTIVE_PAY], tradeType: 'SELL' }));
    var smallOffset = bodies.length;
    if (includeSmall) for (var j = 1; j <= SMALL_PAGES; j++) bodies.push(buildSearchBody({ transAmount: CFG.smallAmount, page: j, pays: [ACTIVE_PAY], tradeType: 'SELL' }));
    var buyOffset = bodies.length;
    if (includeBuy) bodies.push(buildSearchBody({ transAmount: CFG.buyAmount, page: 1, pays: [ACTIVE_PAY], tradeType: 'BUY' }));

    // Al reanudar, la conexion TCP/HTTP2 que quedo abierta antes del background
    // suele estar muerta y el fetch se cuelga hasta el timeout completo (de ahi los
    // 10-20s para ver datos). Primer intento corto: si el socket esta muerto se
    // aborta rapido y el reintento abre uno nuevo.
    var batch = await searchBatch(bodies, fast ? 3500 : 0, true);
    var mayRaw   = batch.slice(0, MAY_PAGES).flatMap(function(a){ return a; });
    var smallRaw = includeSmall ? batch.slice(smallOffset, smallOffset + SMALL_PAGES).flatMap(function(a){ return a; }) : [];
    var buyRaw   = includeBuy ? (batch[buyOffset] || []) : null;

    var prevMayAvail = {}, prevMayPrice = {};
    (ST.mayoristas || []).forEach(function(a){ prevMayAvail[a.advNo] = a.avail; prevMayPrice[a.advNo] = a.price; });

    var prevSmallAvail = {}, prevSmallPrice = {};
    (ST.smallAds || []).forEach(function(a){ prevSmallAvail[a.advNo] = a.avail; prevSmallPrice[a.advNo] = a.price; });

    var prevBuyAvail = {}, prevBuyPrice = {};
    (ST.buyAds || []).forEach(function(a){ prevBuyAvail[a.advNo] = a.avail; prevBuyPrice[a.advNo] = a.price; });

    ST.mayoristas = mapAds(mayRaw,   !(CFG.mayAmount   > 0));
    ST.smallAds   = mapAds(smallRaw, !(CFG.smallAmount > 0));

    // Top-up: si el filtro de verificados deja <8 filas y Binance tiene mas paginas
    // (las pedidas vinieron llenas), pedir hasta 3 paginas extra solo para esa tabla.
    // Con filtros VES bajos las primeras paginas vienen dominadas por no-verificados.
    var EXTRA_PAGES = 3;
    var extraBodies = [], extraMeta = [];
    if (ST.mayoristas.length < 8 && mayRaw.length >= MAY_PAGES * 20) {
      for (var ep = MAY_PAGES + 1; ep <= MAY_PAGES + EXTRA_PAGES; ep++) {
        extraBodies.push(buildSearchBody({ transAmount: CFG.mayAmount, page: ep, pays: [ACTIVE_PAY], tradeType: 'SELL' }));
        extraMeta.push('may');
      }
    }
    if (includeSmall && ST.smallAds.length < 8 && smallRaw.length >= SMALL_PAGES * 20) {
      for (var es = SMALL_PAGES + 1; es <= SMALL_PAGES + EXTRA_PAGES; es++) {
        extraBodies.push(buildSearchBody({ transAmount: CFG.smallAmount, page: es, pays: [ACTIVE_PAY], tradeType: 'SELL' }));
        extraMeta.push('small');
      }
    }
    if (extraBodies.length) {
      var extra = await searchBatch(extraBodies);
      var mayExtra = [], smallExtra = [];
      extra.forEach(function(arr, xi) {
        if (extraMeta[xi] === 'may') mayExtra = mayExtra.concat(arr || []);
        else smallExtra = smallExtra.concat(arr || []);
      });
      if (mayExtra.length)   ST.mayoristas = mapAds(mayRaw.concat(mayExtra),     !(CFG.mayAmount   > 0));
      if (smallExtra.length) ST.smallAds   = mapAds(smallRaw.concat(smallExtra), !(CFG.smallAmount > 0));
    }

    if (buyRaw !== null) ST.buyAds = mapBuyAds(buyRaw); // colapsada: conservar última data

    // +X en los titulos: candidatos reales (ya filtrados) que no caben en los 8 visibles
    setExtraCount('extra-may', ST.mayoristas.length);
    setExtraCount('extra-small', ST.smallAds.length);
    if (buyRaw !== null) setExtraCount('extra-buy', ST.buyAds.length);

    ST.availDisp = ST.availDisp || {};
    ST.availDisp['ob-may']   = accumDelta('ob-may',   ST.mayoristas, prevMayAvail,   'avail', 1);
    ST.availDisp['ob-small'] = accumDelta('ob-small', ST.smallAds,   prevSmallAvail, 'avail', 1);
    if (buyRaw !== null) ST.availDisp['ob-buy'] = accumDelta('ob-buy', ST.buyAds, prevBuyAvail, 'avail', 1);

    ST.priceDisp = ST.priceDisp || {};
    ST.priceDisp['ob-may']   = accumDelta('ob-may',   ST.mayoristas, prevMayPrice,   'price', 0.0005);
    ST.priceDisp['ob-small'] = accumDelta('ob-small', ST.smallAds,   prevSmallPrice, 'price', 0.0005);
    if (buyRaw !== null) ST.priceDisp['ob-buy'] = accumDelta('ob-buy', ST.buyAds, prevBuyPrice, 'price', 0.0005);

    ST.allAds     = ST.mayoristas; // para compatibilidad con historial

    // Historial de precio (primario del modo actual, creible, sin listings fantasma)
    var bestPrimary = marketPrimaryPrice();
    if (bestPrimary) {
      ST.priceHist.push({ ts: Date.now(), price: bestPrimary });
      if (ST.priceHist.length > 600) ST.priceHist.shift();
    }

    ST.lastFetch = new Date();
    ST.consecFails = 0;
    // Latir SOLO tras fetch exitoso: si la app esta abierta pero fallando,
    // el servidor debe tomar el relevo (no decirle "yo cubro" sin datos).
    monitorHeartbeat();
    renderAll();
    // Cada paso aislado: si uno revienta (dato raro, DOM no listo) no debe tumbar
    // a los de abajo. Antes un solo throw aqui dejaba "Analizando el libro..."
    // pegado para siempre, porque nunca se llegaba a updateDecision().
    try { checkAlerts(); } catch (e) { console.error('[checkAlerts]', e); }
    try { renderSparkline(); } catch (e) { console.error('[renderSparkline]', e); }
    try { refreshHist24(); } catch (e) { console.error('[refreshHist24]', e); }
    try { recordMarketSnapshot(); } catch (e) { console.error('[recordMarketSnapshot]', e); }
    try { updateDecision(); } catch (e) { console.error('[updateDecision]', e); }
    var emptyNote =(!ST.mayoristas.length && !ST.smallAds.length) ? ' — sin anuncios en rango' : '';
    bootMark('got');
    var bootNote = '';
    if (!BOOT.shown) {
      BOOT.shown = true;
      bootNote = ' · arranque ' + (BOOT.asked / 1000).toFixed(1) + 's + red ' +
                 ((BOOT.got - BOOT.asked) / 1000).toFixed(1) + 's';
    }
    var lu = document.getElementById('last-update');
    lu.style.color = '';
    lu.textContent = 'Actualizado ' + ST.lastFetch.toLocaleTimeString('es-VE') + emptyNote + bootNote;
  } catch(e) {
    ST.consecFails++;
    var lu2 = document.getElementById('last-update');
    if (ST.consecFails >= 2) {
      var okStr = ST.lastFetch ? ' (último OK ' + ST.lastFetch.toLocaleTimeString('es-VE') + ')' : '';
      lu2.style.color = 'var(--red)';
      lu2.textContent = '⚠ Sin conexión — datos viejos' + okStr;
    } else {
      lu2.textContent = '⚠ ' + e.message;
    }
    // Solo alertar al transicionar a "sin conexion" (no en cada fallo → spam)
    if (ST.consecFails === 2) addAlert('info', 'Error de conexión', e.message);
  } finally {
    ST.fetching = false;
  }
}

function startMonitorView() {
  if (ST.running) return;
  ST.running = true;
  fetchOnce();
  ST.timer = setInterval(fetchOnce, CFG.interval * 1000);
  document.getElementById('btn-start').textContent = '⏹ Detener';
  setBadge(true);
  renderOnboard();
  renderDecisionIdle();
}

function stopMonitorView() {
  ST.running = false;
  clearInterval(ST.timer); ST.timer = null;
  document.getElementById('btn-start').textContent = '▶ Iniciar';
  setBadge(false);
  renderOnboard();
  renderDecisionIdle();
}

// Un solo boton: arranca/detiene la vista (tablas) Y el monitor 24/7 server-side.
async function toggleMonitor() {
  ST.fromCache = false; // decision explicita del usuario: no la pise hydrateMon24
  if (ST.running) {
    stopMonitorView();
    monitorServerDisable();
    return;
  }
  if (!(await requireSub())) return;
  saveConfig();
  startMonitorView();
  monitorServerEnable();
}

// Pestana oculta: pausa el fetch visual (sin apagar el monitor). Deja de latir → a los ~70s
// el servidor toma el relevo (notificaciones siguen). Al volver, reanuda y el servidor cede.
function appHidden() {
  // Pestaña oculta: sin UI que actualizar. Pausar los pollers que pegan a la red
  // (fetch de precios y poller del bot) para no gastar invocaciones Vercel en vano.
  // El servidor cubre monitor y bot 24/7. ACTIVITY es local + seguridad: no se toca.
  if (ST.timer) { clearInterval(ST.timer); ST.timer = null; }
  if (BOT.running) stopBotPoller();
}

// Reanudar: re-armar los pollers y refrescar YA. Idempotente y con throttle porque
// al volver del background el navegador puede disparar varios de estos eventos.
var _lastResume = 0;
function appResume() {
  if (document.visibilityState !== 'visible') return;
  var now = Date.now();
  if (now - _lastResume < 1500) return;
  _lastResume = now;
  if (ST.running) {
    if (ST.timer) clearInterval(ST.timer);
    ST.timer = setInterval(fetchOnce, CFG.interval * 1000);
    fetchOnce(true); // fast: primer intento corto (socket muerto tras el background)
  }
  if (BOT.running) {
    if (!BOT_POLL.timer) startBotPoller();
  } else if (!botStarting() && Date.now() - _lastBotSync > 60000) {
    // El bot pudo encenderse desde otro dispositivo (o la UI quedo desfasada):
    // re-sincronizar el boton con el estado real del servidor.
    _lastBotSync = Date.now();
    hydrateBotState();
  }
}
var _lastBotSync = 0;

// En movil (PWA/TWA) volver al primer plano NO siempre dispara visibilitychange:
// segun el navegador puede llegar solo pageshow (restaurada del bfcache), focus o
// resume (Page Lifecycle). Se escuchan todos y desembocan en el mismo handler.
document.addEventListener('visibilitychange', function() {
  if (document.hidden) appHidden(); else appResume();
});
window.addEventListener('pageshow', appResume);
window.addEventListener('focus', appResume);
document.addEventListener('resume', appResume);

// Red de seguridad: si no llego ningun evento al volver del background (pasa en
// Android cuando el sistema congela la pagina), esto detecta que la vista lleva
// demasiado sin refrescar y la re-arma. Es local: no pega a la red por si mismo.
setInterval(function() {
  if (document.visibilityState !== 'visible') return;
  if (ST.running && !ST.fetching && (!ST.timer || Date.now() - ST.lastAttempt > CFG.interval * 1000 * 2 + 5000)) {
    _lastResume = 0; appResume();
  } else if (BOT.running && !BOT_POLL.timer) {
    startBotPoller();
  }
}, 5000);

function setBadge(live) {
  document.getElementById('live-badge').className = 'badge ' + (live ? 'badge-live' : 'badge-off');
  document.getElementById('live-dot').className   = 'dot ' + (live ? 'dot-live' : 'dot-off');
  document.getElementById('live-label').textContent = live ? 'En vivo' : 'Detenido';
}

// ── Render ────────────────────────────────────────────
function fmtAmount(n) {
  if (n >= 1000000) return (n / 1000000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'M';
  if (n >= 1000)    return (n / 1000).toLocaleString('es-VE', {maximumFractionDigits: 0}) + 'k';
  return n.toString();
}

// Repinta solo lo del monitor que depende de la config del bot (pisado/libre por
// tolerancia, y el resaltado de mis filas por nick). No pide datos: usa los que ya
// hay en ST, asi que es seguro llamarlo aunque el monitor este parado.
function syncMonitorWithBot() {
  if (!ST.mayoristas) return;
  renderOB('ob-may',   ST.mayoristas, 'best');
  renderOB('ob-small', ST.smallAds || [], 'best-buy');
  renderBuySection(ST.buyAds || []);
}

function renderAll() {
  renderSpreadHero();
  renderStats();
  renderOB('ob-may',   ST.mayoristas, 'best');
  renderOB('ob-small', ST.smallAds,   'best-buy');
  renderBuySection(ST.buyAds);
  updateSellPricePlaceholder();
  updateSessionStats();
}

function updateSessionStats() {
  // Max/min de las ULTIMAS 24H: misma fuente y ventana que el resumen diario de
  // Telegram (serie del servidor + puntos vivos), sobrevive recargas de pagina.
  var pts = sparkSeries();
  var now = Date.now(), min = null, max = null;
  for (var i = 0; i < pts.length; i++) {
    if (now - pts[i].ts > 24 * 3600e3) continue;
    if (min === null || pts[i].price < min) min = pts[i].price;
    if (max === null || pts[i].price > max) max = pts[i].price;
  }
  // Incluir el precio creible actual aunque aun no haya entrado a la serie
  var cur = bestCredibleMay();
  if (cur) {
    if (min === null || cur < min) min = cur;
    if (max === null || cur > max) max = cur;
  }
  document.getElementById('sess-max').textContent = max !== null ? fmt(max) : '—';
  document.getElementById('sess-min').textContent = min !== null ? fmt(min) : '—';
  // Marcador del rango 24h: donde cae el precio actual entre el minimo y el maximo.
  var curEl = document.getElementById('sess-cur'), mark = document.getElementById('sess-mark');
  if (curEl) curEl.textContent = cur ? 'ahora ' + fmt(cur) + fiatSuf() : '';
  if (mark) {
    var pos = (cur && min !== null && max !== null && max > min) ? (cur - min) / (max - min) : null;
    mark.style.display = pos === null ? 'none' : '';
    if (pos !== null) mark.style.left = (Math.max(0, Math.min(1, pos)) * 100).toFixed(1) + '%';
  }
}

function updateTopbarBotPrice(price) {
  var el = document.getElementById('topbar-bot-price');
  if (!el) return; // se quito de la top bar; el precio vive en el panel del bot
  if (price && BOT.running) {
    el.textContent = fmt(price) + ' Bs';
    el.style.display = 'inline-flex';
  } else {
    el.style.display = 'none';
  }
}

// ── Señal "spread estirado": percentil del SPREAD NETO vs 24h (adaptativo al régimen) ──
// El backtest mostró que el SPREAD NETO amplio es el mejor predictor de un retroceso.
// Como el umbral bueno depende del régimen del mercado, se usa percentil relativo a las
// últimas 24h (auto-ajusta). Solo BDV (única serie que grabamos y con la que se calibró).
var STRETCH = { buf: null, lastPush: 0 };
function stretchLoad() {
  if (STRETCH.buf) return STRETCH.buf;
  try { STRETCH.buf = JSON.parse(localStorage.getItem('mkt_spread24h') || '[]') || []; }
  catch (e) { STRETCH.buf = []; }
  return STRETCH.buf;
}
function stretchPush(v) {
  if (v == null || !isFinite(v)) return;
  var now = Date.now();
  if (now - STRETCH.lastPush < 60000) return; // 1 muestra/min: 24h => <=1440 puntos
  STRETCH.lastPush = now;
  var buf = stretchLoad();
  buf.push({ t: now, v: v });
  var cut = now - 24 * 3600 * 1000;
  while (buf.length && buf[0].t < cut) buf.shift();
  try { localStorage.setItem('mkt_spread24h', JSON.stringify(buf)); } catch (e) {}
}
function stretchPct(v) { // percentil (0-100) del valor actual; null si poca historia
  var buf = stretchLoad();
  if (buf.length < 120) return null; // ~2h de app abierta antes de opinar
  var below = 0; for (var i = 0; i < buf.length; i++) if (buf[i].v <= v) below++;
  return below / buf.length * 100;
}
// Aviso de spread estirado. Ya no es una linea propia que aparece y desaparece: eso
// crecia la tarjeta del hero y empujaba toda la pagina cada vez que entraba o salia
// la señal. Ahora viaja en la pildora de veredicto, que ocupa su sitio siempre, asi
// que el alto no cambia. Devuelve el texto (o null) en vez de pintar.
function stretchNote(pct, spreadNet) {
  if (pct == null || pct < 90 || !(spreadNet > 0)) return null;
  // Corto a proposito: mas largo que esto envuelve a dos lineas en pantallas de
  // 320px y la pildora crece, que es justo el salto que se quiso quitar.
  return '🔥 Estirado — top ' + Math.max(1, Math.round(100 - pct)) + '% de 24h';
}

function renderSpreadHero() {
  var stretch = null; // se calcula abajo, solo aplica a BDV con Modo Short ON
  // Mismo filtro de credibilidad (>=2000 USDT) que gráfico/alertas.
  var cMayH = marketPrimary(), cSmallH = marketSecondary();
  var bestMay   = cMayH   ? cMayH.price   : null;
  var bestSmall = cSmallH ? cSmallH.price : null;

  if (!bestMay) {
    document.getElementById('hero-pct').textContent   = '—';
    document.getElementById('hero-pct').style.color   = 'var(--text-3)';
    document.getElementById('hero-label').textContent = 'Esperando datos...';
    document.getElementById('hero-may').textContent   = '—';
    document.getElementById('hero-small').textContent = '—';
    var pill = document.getElementById('hero-pill');
    pill.className = 'sh-pill opp-no'; pill.textContent = 'Sin datos';
    return;
  }

  document.getElementById('hero-may').textContent   = fmt(bestMay)   + fiatSuf();
  document.getElementById('hero-small').textContent = bestSmall ? fmt(bestSmall) + fiatSuf() : '—';

  if (!bestSmall) {
    document.getElementById('hero-pct').textContent   = '—';
    document.getElementById('hero-pct').style.color   = 'var(--text-3)';
    document.getElementById('hero-label').textContent = 'Sin referencia de compra';
    var pill2 = document.getElementById('hero-pill');
    pill2.className = 'sh-pill opp-no'; pill2.textContent = 'Sin datos';
    return;
  }

  var spread    = (bestMay - bestSmall) / bestMay * 100;
  var spreadNet = spread - (CFG.commission || 0);
  var spreadBs  = bestMay - bestSmall;

  // Señal estirado: solo BDV y solo Modo Short ON — el percentil esta calibrado
  // contra Mayoristas/Recompra; mezclar el spread de Verde lo haria inservible.
  if (ACTIVE_PAY === 'BancoDeVenezuela' && !isShortOff()) {
    stretchPush(spreadNet);
    stretch = stretchNote(stretchPct(spreadNet), spreadNet);
  }

  var pct  = document.getElementById('hero-pct');
  var pill = document.getElementById('hero-pill');
  var threshold = CFG.spreadThr;
  var commNote  = CFG.commission > 0 ? '  ·  −' + CFG.commission + '% comisión' : '';

  pct.textContent = spreadNet.toFixed(3) + '%';

  if (spreadNet <= 0) {
    pct.style.color = 'var(--red)';
    document.getElementById('hero-label').textContent = (spread <= 0 ? 'Mercado invertido' : 'Comisión supera el spread') + '  ·  Dif: ' + fmt(spreadBs) + fiatSuf() + '/USDT';
    pill.className = 'sh-pill opp-warn';
    pill.textContent = '⚠ Neto negativo';
  } else if (spreadNet >= threshold) {
    pct.style.color = 'var(--gold)';
    document.getElementById('hero-label').textContent = 'Diferencia: ' + fmt(spreadBs) + fiatSuf() + '/USDT' + commNote;
    pill.className = 'sh-pill opp-yes';
    pill.textContent = '🟡 NETO > ' + threshold + '% — OPORTUNIDAD';
  } else {
    pct.style.color = 'var(--text-2)';
    document.getElementById('hero-label').textContent = 'Diferencia: ' + fmt(spreadBs) + fiatSuf() + '/USDT' + commNote;
    pill.className = 'sh-pill opp-no';
    pill.textContent = 'Neto por debajo del umbral';
  }

  // El estirado pisa al veredicto de umbral: es la señal mas accionable de las dos
  // (el umbral es fijo, el percentil dice como esta HOY el spread contra su 24h).
  // No pisa a "neto negativo": ahi no hay ventana que valga.
  if (stretch && spreadNet > 0) {
    pill.className = 'sh-pill opp-yes';
    pill.textContent = stretch;
  }
}

function renderStats() {
  var cMayS = marketPrimary(), cSmallS = marketSecondary();
  var bestMay   = cMayS   ? cMayS.price   : null;
  var bestSmall = cSmallS ? cSmallS.price : null;

  if (bestMay && bestSmall) {
    var diff = bestMay - bestSmall;
    document.getElementById('st-diff').textContent = fmt(diff) + fiatSuf();
  } else {
    document.getElementById('st-diff').textContent = '—';
  }

  var el = document.getElementById('st-delta');
  if (bestMay && ST.priceHist.length > 1) {
    var now = Date.now();
    var ref = null;
    for (var i = ST.priceHist.length - 1; i >= 0; i--) {
      var ageD = now - ST.priceHist[i].ts;
      if (ageD >= 9 * 60000) { if (ageD <= 18 * 60000) ref = ST.priceHist[i].price; break; }
    }
    if (ref !== null) {
      var d = (bestMay - ref) / ref * 100;
      el.textContent = (d >= 0 ? '+' : '') + d.toFixed(3) + '%';
      el.className = 'sc-v ' + (d > 0 ? 'g' : d < 0 ? 'r' : '');
    } else { el.textContent = '—'; }
  } else { el.textContent = '—'; }
}

// Nick propio para resaltar mis filas en el libro. Sale de la config del bot
// (se autodetecta al cargar los anuncios de Binance), asi que el resaltado
// funciona para cualquier usuario. El valor fijo queda solo de respaldo para
// cuando todavia no hay config cargada.
var MY_NICK_FALLBACK = 'キスショット';
function myNick() { return (BOT_CFG && BOT_CFG.myNick) || BOT.myNick || MY_NICK_FALLBACK; }

// Si la fila idx es mia, indica si me estan "pisando": alguien mejor posicionado
// (arriba) con limite minimo <= al mio y disponibilidad real (>=150). rojo = pisado, verde = libre.
// Verde/rojo en los limites de tu propio anuncio. Usa el MISMO criterio de
// competidor que el bot (ver botTick: minVES < miMinimo + tolerancia), no un
// "minVES <= el mio" pelado. Sin la tolerancia, alguien arriba con un minimo unos
// cientos de bolivares por encima del tuyo no contaba y la fila salia verde
// mientras el bot repreciaba contra el — y de paso los dos minimos se ven iguales
// en pantalla, porque la columna redondea a "80k".
function pisadoCls(ads, idx) {
  var me = ads[idx];
  if (!me || me.merchant !== myNick()) return '';
  // Mi limite: el que el bot tiene aplicado de verdad en Binance manda sobre el del
  // libro. El listado publico tarda en reflejar un cambio de limite, y mientras tanto
  // me.minVES es el viejo: el pisado/libre saldria calculado contra una posicion que
  // ya no existe. Sin bot corriendo no hay dato server-side y vale el del libro.
  var miMin = (BOT.myMinLimit > 0) ? BOT.myMinLimit : me.minVES;
  var tope = miMin + (BOT_CFG.limitThreshold || 0);
  for (var j = 0; j < idx; j++) {
    var c = ads[j];
    if (c && c.avail >= 150 && c.minVES < tope) return ' pisado';
  }
  return ' libre';
}

function renderOB(id, ads, bestCls) {
  var wrap = document.getElementById(id);
  var rows = '';
  var visible = (ST.showMore && ST.showMore[id]) ? OB_MAX_ROWS : OB_BASE_ROWS;
  for (var i = 0; i < visible; i++) {
    var ad = ads[i];
    if (!ad && i >= OB_BASE_ROWS) break; // sin relleno vacio en las filas expandidas
    if (ad) {
      var cls = 'ob-row' + (i === 0 ? ' ' + bestCls : '');
      var rnk = '<span class="rank ' + (i === 0 ? 'n1' : '') + '">' + (i + 1) + '</span>';
      var lims = fmtM(ad.minVES) + '–' + fmtM(ad.price * ad.avail);
      var lvlColor = ['','#CD7F32','#A8B8C8','#F0B90B'][ad.vipLevel] || '#F0B90B';
      var badgeHtml = '';
      if (ad.badges && ad.badges[0]) {
        if (ad.badges[0] === 'Block') {
          badgeHtml = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 100 100" style="margin-left:5px;flex-shrink:0;vertical-align:middle" title="Block vip'+ad.vipLevel+'"><defs><linearGradient id="dg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#c084fc"/><stop offset="100%" style="stop-color:#7c3aed"/></linearGradient></defs><polygon points="50,5 90,30 90,70 50,95 10,70 10,30" fill="url(#dg)" stroke="#a855f7" stroke-width="3"/><polyline points="32,52 44,64 68,38" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        } else {
          badgeHtml = '<span style="margin-left:5px;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:'+lvlColor+';color:#000;font-size:13px;font-weight:900;flex-shrink:0;line-height:1" title="PRO vip'+ad.vipLevel+'">✓</span>';
        }
      }
      var availStr = ad.avail >= 1000
        ? (ad.avail / 1000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'k'
        : Math.round(ad.avail).toLocaleString('es-VE');
      var disp = ST.availDisp && ST.availDisp[id];
      var arrowHtml = availArrowHtml(disp && disp[ad.advNo]);
      var popupHtml = availPopupHtml(disp && disp[ad.advNo]);
      var pDisp = ST.priceDisp && ST.priceDisp[id];
      var pd = pDisp && pDisp[ad.advNo];
      var chgCls = priceChgCls(pd), chgHtml = priceChgHtml(pd);
      var flashCls = priceFlashCls(pd), priceHtml = priceSplitHtml(ad.price, pd);
      var meCls = ad.merchant === myNick() ? ' me' : '';
      rows += '<div class="' + cls + '">' + rnk +
        '<span class="merch' + meCls + '" style="display:flex;align-items:center;gap:0" title="' + esc(ad.merchant) + '">' + esc(ad.merchant) + badgeHtml + '</span>' +
        '<span class="lim-c" style="font-variant-numeric:tabular-nums" title="' + Math.round(ad.avail) + ' USDT disponibles"><span class="avail-num">' + arrowHtml + availStr + '</span></span>' +
        '<span class="price-c' + flashCls + '">' + priceHtml + '</span>' +
        '<span class="chg-c' + chgCls + '">' + chgHtml + '</span>' +
        '<span class="lim-c' + pisadoCls(ads, i) + '">' + lims + '<span class="lim-amount">' + availStr + ' USDT</span></span>' +
        popupHtml +
      '</div>';
    } else {
      rows += '<div class="ob-row" style="opacity:0.18">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="merch" style="color:var(--text-3)">—</span>' +
        '<span class="lim-c">—</span>' +
        '<span class="price-c">—</span>' +
        '<span class="chg-c"></span>' +
        '<span class="lim-c">—</span>' +
      '</div>';
    }
  }
  wrap.innerHTML = rows;
  updateShowMoreBtn(id, ads.length);
}

// Muestra/oculta el boton "ver mas" segun cuantos comercios hay tras el visible base.
function updateShowMoreBtn(id, total) {
  var btn = document.getElementById('more-' + id);
  if (!btn) return;
  var expanded = !!(ST.showMore && ST.showMore[id]);
  if (!expanded && total <= OB_BASE_ROWS) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.textContent = expanded ? '▲ Ver menos' : '▼ Ver ' + Math.min(OB_MAX_ROWS - OB_BASE_ROWS, total - OB_BASE_ROWS) + ' comercios más';
}
function toggleShowMore(id) {
  ST.showMore = ST.showMore || {};
  ST.showMore[id] = !ST.showMore[id];
  renderAll();
}

// ── Buy Section Render ────────────────────────────────
function renderBuySection(ads) {
  var wrap = document.getElementById('ob-buy');
  if (!wrap) return;
  var rows = '';
  var visible = (ST.showMore && ST.showMore['ob-buy']) ? OB_MAX_ROWS : OB_BASE_ROWS;
  for (var i = 0; i < visible; i++) {
    var ad = ads[i];
    if (!ad && i >= OB_BASE_ROWS) break;
    if (ad) {
      var cls = 'ob-row' + (i === 0 ? ' best-buy-asc' : '');
      var rnk = '<span class="rank ' + (i === 0 ? 'n1' : '') + '">' + (i + 1) + '</span>';
      var lims = fmtM(ad.minVES) + '–' + fmtM(ad.price * ad.avail);
      var lvlColor = ['','#CD7F32','#A8B8C8','#F0B90B'][ad.vipLevel] || '#F0B90B';
      var badgeHtml = '';
      if (ad.badges && ad.badges[0]) {
        if (ad.badges[0] === 'Block') {
          badgeHtml = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 100 100" style="margin-left:5px;flex-shrink:0;vertical-align:middle" title="Block vip'+ad.vipLevel+'"><defs><linearGradient id="dg-buy" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#c084fc"/><stop offset="100%" style="stop-color:#7c3aed"/></linearGradient></defs><polygon points="50,5 90,30 90,70 50,95 10,70 10,30" fill="url(#dg-buy)" stroke="#a855f7" stroke-width="3"/><polyline points="32,52 44,64 68,38" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        } else {
          badgeHtml = '<span style="margin-left:5px;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:'+lvlColor+';color:#000;font-size:13px;font-weight:900;flex-shrink:0;line-height:1" title="PRO vip'+ad.vipLevel+'">✓</span>';
        }
      }
      var availStr = ad.avail >= 1000
        ? (ad.avail / 1000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'k'
        : Math.round(ad.avail).toLocaleString('es-VE');
      var disp = ST.availDisp && ST.availDisp['ob-buy'];
      var arrowHtml = availArrowHtml(disp && disp[ad.advNo]);
      var popupHtml = availPopupHtml(disp && disp[ad.advNo]);
      var pDisp = ST.priceDisp && ST.priceDisp['ob-buy'];
      var pd = pDisp && pDisp[ad.advNo];
      var chgCls = priceChgCls(pd), chgHtml = priceChgHtml(pd);
      var flashCls = priceFlashCls(pd), priceHtml = priceSplitHtml(ad.price, pd);
      var meCls = ad.merchant === myNick() ? ' me' : '';
      rows += '<div class="' + cls + '">' + rnk +
        '<span class="merch' + meCls + '" style="display:flex;align-items:center;gap:0" title="' + esc(ad.merchant) + '">' + esc(ad.merchant) + badgeHtml + '</span>' +
        '<span class="lim-c" style="font-variant-numeric:tabular-nums" title="' + Math.round(ad.avail) + ' USDT disponibles"><span class="avail-num">' + arrowHtml + availStr + '</span></span>' +
        '<span class="price-c g' + flashCls + '">' + priceHtml + '</span>' +
        '<span class="chg-c' + chgCls + '">' + chgHtml + '</span>' +
        '<span class="lim-c' + pisadoCls(ads, i) + '">' + lims + '<span class="lim-amount">' + availStr + ' USDT</span></span>' +
        popupHtml +
      '</div>';
    } else {
      rows += '<div class="ob-row" style="opacity:0.18">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="merch" style="color:var(--text-3)">—</span>' +
        '<span class="lim-c">—</span>' +
        '<span class="price-c">—</span>' +
        '<span class="chg-c"></span>' +
        '<span class="lim-c">—</span>' +
      '</div>';
    }
  }
  wrap.innerHTML = rows;
  updateShowMoreBtn('ob-buy', ads.length);
}

// La tarjeta "Spread de Venta" se retiró (ver #sh-mode-note / applyMarketMode);
// lo unico que sobrevive de renderBuySpread() es esta sugerencia de placeholder,
// que no tiene relacion con el modo (siempre usa el precio de Verde si existe).
function updateSellPricePlaceholder() {
  var sellPrice = ST.buyAds[0] ? ST.buyAds[0].price : null;
  var sellInp = document.getElementById('cfg-bot-sell');
  if (sellInp && sellPrice) sellInp.placeholder = 'sug. ' + Math.round(sellPrice);
}

// ── Alertas ───────────────────────────────────────────
function checkAlerts() {
  var now = Date.now();
  var cMay = marketPrimary(), cSmall = marketSecondary();
  var L = marketLabels();
  var bestMay   = cMay   ? cMay.price   : null;  // primario del modo actual, creible (>=2000 USDT)
  var bestSmall = cSmall ? cSmall.price : null;

  if (!bestMay) return;

  // Spread
  if (bestSmall) {
    var spread    = (bestMay - bestSmall) / bestMay * 100;
    var spreadNet = spread - CFG.commission;
    var evalSpread = CFG.commission > 0 ? spreadNet : spread;
    var netLabel   = CFG.commission > 0 ? ' (neto ' + spreadNet.toFixed(3) + '%)' : '';
    if (evalSpread >= CFG.spreadThr) {
      if (!COOLDOWN.spread || now - COOLDOWN.spread > COOLDOWN_MS) {
        COOLDOWN.spread = now;
        addAlert('spread',
          '💰 Spread ' + spread.toFixed(3) + '%' + netLabel + ' — OPORTUNIDAD',
          L.primary + ': ' + fmt(bestMay) + fiatSuf() + ' (' + esc(cMay.merchant) + ') → ' + L.secondary + ': ' + fmt(bestSmall) + fiatSuf() + ' · Dif: ' + fmt(bestMay - bestSmall) + fiatSuf() + '/USDT'
        );
        push('Spread P2P ' + spread.toFixed(3) + '%', 'Vende a ' + fmt(bestMay) + fiatSuf() + ' — compra ref. ' + fmt(bestSmall) + fiatSuf());
      }
    }
  }

  // Sobrecomprado / debilidad
  if (ST.priceHist.length > 1) {
    var ref10 = null;
    for (var i = ST.priceHist.length - 1; i >= 0; i--) {
      var age10 = now - ST.priceHist[i].ts;
      // Referencia valida solo si es de ~10 min (no de un hueco): ignora si tiene >18 min.
      if (age10 >= 9 * 60000) { if (age10 <= 18 * 60000) ref10 = ST.priceHist[i].price; break; }
    }
    if (ref10 !== null) {
      var chg = (bestMay - ref10) / ref10 * 100;
      if (chg > CFG.overboughtThr) {
        if (!COOLDOWN.ob || now - COOLDOWN.ob > COOLDOWN_MS) {
          COOLDOWN.ob = now;
          addAlert('overbought', '🔴 Mercado sobrecomprado', '+' + chg.toFixed(3) + '% en 10 min · Precio actual: ' + fmt(bestMay) + fiatSuf());
          push('Sobrecomprado P2P', '+' + chg.toFixed(3) + '% en 10 min');
        }
      } else { COOLDOWN.ob = 0; }

      if (chg < -CFG.weaknessThr) {
        if (!COOLDOWN.wk || now - COOLDOWN.wk > COOLDOWN_MS) {
          COOLDOWN.wk = now;
          addAlert('weakness', '🔵 Debilidad en el mercado', chg.toFixed(3) + '% en 10 min · Precio actual: ' + fmt(bestMay) + fiatSuf());
          push('Debilidad P2P', chg.toFixed(3) + '% en 10 min');
        }
      } else { COOLDOWN.wk = 0; }
    }
  }

  // Tendencia sostenida (~1h): cambio grande confirmado a mitad de ventana (filtra picos sueltos)
  if (ST.priceHist.length > 2) {
    var ref60 = null, ref30 = null;
    for (var k = ST.priceHist.length - 1; k >= 0; k--) {
      var ageT = now - ST.priceHist[k].ts;
      if (ref30 === null && ageT >= 25 * 60000 && ageT <= 40 * 60000) ref30 = ST.priceHist[k].price;
      if (ref60 === null && ageT >= 50 * 60000 && ageT <= 75 * 60000) ref60 = ST.priceHist[k].price;
      if (ref30 !== null && ref60 !== null) break;
    }
    if (ref60 !== null && ref30 !== null) {
      var chg60 = (bestMay - ref60) / ref60 * 100;
      var chg30 = (bestMay - ref30) / ref30 * 100;
      var TREND_CD = 20 * 60000;
      if (Math.abs(chg60) >= CFG.sustainThr && Math.sign(chg30) === Math.sign(chg60)) {
        if (!COOLDOWN.tr || now - COOLDOWN.tr > TREND_CD) {
          COOLDOWN.tr = now;
          var upT = chg60 > 0;
          addAlert(upT ? 'overbought' : 'weakness',
            upT ? '📈 Tendencia alcista sostenida' : '📉 Tendencia bajista sostenida',
            (upT ? '+' : '') + chg60.toFixed(2) + '% en 1h · Precio actual: ' + fmt(bestMay) + fiatSuf());
          push('Tendencia P2P', (upT ? '+' : '') + chg60.toFixed(2) + '% en 1h');
        }
      } else { COOLDOWN.tr = 0; }
    }
  }
}

function addAlert(type, title, desc) {
  var ts = new Date().toLocaleTimeString('es-VE');
  ST.alerts.unshift({ type: type, title: title, desc: desc, ts: ts });
  if (ST.alerts.length > 60) ST.alerts.pop();
  renderAlerts();
}

function renderAlerts() {
  var list  = document.getElementById('alert-list');
  var badge = document.getElementById('bell-badge');
  if (!ST.alerts.length) {
    list.innerHTML = '<div class="empty">Sin alertas</div>';
    badge.style.display = 'none';
    return;
  }
  badge.style.display = '';
  badge.textContent = ST.alerts.length > 9 ? '9+' : ST.alerts.length;
  var icons = { spread: '🟡', overbought: '🔴', weakness: '🔵', info: 'ℹ️' };
  list.innerHTML = ST.alerts.slice(0, 25).map(function(a) {
    return '<div class="al ' + a.type + '">' +
      '<span class="al-icon">' + (icons[a.type] || '•') + '</span>' +
      '<div class="al-body"><div class="al-title">' + a.title + '</div><div class="al-desc">' + a.desc + '</div></div>' +
      '<span class="al-time">' + a.ts + '</span></div>';
  }).join('');
}

function clearAlerts() { ST.alerts = []; COOLDOWN = {}; renderAlerts(); }

// ── Web Push (notificaciones del sistema, app cerrada) ─
var PUSH = { sub: null };
function b64ToU8(base64) {
  var pad = '='.repeat((4 - base64.length % 4) % 4);
  var b = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(b), arr = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function updPushBtn() {
  var b = document.getElementById('btn-push');
  if (!b) return;
  var supported = ('serviceWorker' in navigator) && ('PushManager' in window);
  if (!supported) { b.textContent = 'No soportado'; b.disabled = true; return; }
  b.textContent = PUSH.sub ? '✓ Activado' : 'Activar';
}
async function refreshPushState() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { updPushBtn(); return; }
    var reg = await navigator.serviceWorker.ready;
    PUSH.sub = await reg.pushManager.getSubscription();
  } catch(e) { PUSH.sub = null; }
  updPushBtn();
}
async function togglePush() {
  var b = document.getElementById('btn-push');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('Tu navegador no soporta push'); return; }
  if (!SESSION.token) { toast('Inicia sesión primero'); return; }
  try {
    var reg = await navigator.serviceWorker.ready;
    if (PUSH.sub) {
      var endpoint = PUSH.sub.endpoint;
      await PUSH.sub.unsubscribe().catch(function(){});
      await botCallWorker('/push-unsubscribe', { endpoint: endpoint }).catch(function(){});
      PUSH.sub = null; updPushBtn(); toast('Push desactivado');
      return;
    }
    if (Notification.permission !== 'granted') {
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Permiso denegado'); return; }
    }
    if (b) b.textContent = 'Activando...';
    var kd = await botCallWorker('/push-key');
    if (!kd || !kd.key) { toast('Push no configurado en el servidor'); updPushBtn(); return; }
    PUSH.sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(kd.key) });
    await botCallWorker('/push-subscribe', { sub: PUSH.sub.toJSON() });
    updPushBtn(); toast('✓ Push activado');
    botCallWorker('/push-test').catch(function(){});
  } catch(e) { toast('⚠ ' + e.message); updPushBtn(); }
}

// ── Notificaciones ────────────────────────────────────
function reqNotif() {
  if (!('Notification' in window)) { document.getElementById('notif-st').textContent = 'No soportado'; return; }
  Notification.requestPermission().then(updNotifSt);
}
function updNotifSt() {
  var el = document.getElementById('notif-st');
  if (!('Notification' in window)) { el.textContent = ''; return; }
  el.textContent = Notification.permission === 'granted' ? '✓' : Notification.permission === 'denied' ? '✗' : '?';
}
// Silencio nocturno del lado del CLIENTE: con la app abierta el servidor cede el
// monitor (heartbeat) y quien alerta es el cliente — debe respetar el mismo horario.
function inQuietNow() {
  var s = CFG.monQuietStart, e = CFG.monQuietEnd;
  if (!s || !e || s === e) return false;
  function toMin(hm) { var p = String(hm).split(':'); return (+p[0] || 0) * 60 + (+p[1] || 0); }
  var d = new Date(), cur = d.getHours() * 60 + d.getMinutes();
  var sm = toMin(s), em = toMin(e);
  return sm < em ? (cur >= sm && cur < em) : (cur >= sm || cur < em); // soporta franja nocturna
}
function push(title, body) {
  if (inQuietNow()) return; // 🌙 silencio nocturno: ni Telegram ni notificacion
  if (Notification.permission === 'granted') new Notification('🟡 P2P — ' + title, { body: body });
  sendTelegram('<b>🟡 P2P — ' + title + '</b>\n' + body);
}
function testNotif() {
  if (Notification.permission !== 'granted') { reqNotif(); return; }
  push('Test', 'Notificaciones funcionando'); toast('Test enviado');
}

// ── UI toggles ────────────────────────────────────────
function toggleAlertDropdown(e) {
  e.stopPropagation();
  var d = document.getElementById('alert-dropdown');
  if (d.style.display === 'flex') { d.style.display = 'none'; return; }
  d.style.display = 'flex';
}

function toggleAlertConfig(e) {
  e.stopPropagation();
  var c = document.getElementById('alert-config');
  if (c) c.style.display = c.style.display === 'none' ? 'block' : 'none';
}

function toggleBotGear(e) {
  e.stopPropagation();
  var p = document.getElementById('bot-gear-popup');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

function toggleObGear(e) {
  e.stopPropagation();
  var p = document.getElementById('ob-gear-popup');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

// ── Presence watchdog ─────────────────────────────────
var ACTIVITY = {
  lastActivity: Date.now(),
  checkTimer: null,
  countdownTimer: null,
  enabled: true,
  INACTIVE_MS: 5 * 60 * 1000,
  GRACE_MS: 60 * 1000,
  CHECK_MS: 30 * 1000
};

function loadActivityGuard() {
  try {
    var v = localStorage.getItem('p2p_activity_guard');
    if (v === 'false') ACTIVITY.enabled = false;
  } catch(e) {}
  updateActivityBtn();
}

function updateActivityBtn() {
  var b = document.getElementById('btn-activity');
  if (!b) return;
  if (ACTIVITY.enabled) {
    b.textContent = '🛡️';
    b.style.opacity = '1';
    b.title = 'Alertas de actividad activas (click para desactivar)';
  } else {
    b.textContent = '🛡️';
    b.style.opacity = '0.35';
    b.title = 'Alertas de actividad DESACTIVADAS (click para activar)';
  }
}

function toggleActivityGuard() {
  ACTIVITY.enabled = !ACTIVITY.enabled;
  try { localStorage.setItem('p2p_activity_guard', ACTIVITY.enabled ? 'true' : 'false'); } catch(e) {}
  updateActivityBtn();
  if (!ACTIVITY.enabled) hidePresenceModal();
  toast(ACTIVITY.enabled ? 'Apagado por inactividad: ON' : 'Apagado por inactividad: OFF');
}

function bumpActivity() { ACTIVITY.lastActivity = Date.now(); }

['mousemove','keydown','touchstart','click','scroll'].forEach(function(ev){
  document.addEventListener(ev, bumpActivity, { passive: true });
});

function startActivityWatcher() {
  bumpActivity();
  if (ACTIVITY.checkTimer) clearInterval(ACTIVITY.checkTimer);
  ACTIVITY.checkTimer = setInterval(activityCheck, ACTIVITY.CHECK_MS);
}

function stopActivityWatcher() {
  if (ACTIVITY.checkTimer) { clearInterval(ACTIVITY.checkTimer); ACTIVITY.checkTimer = null; }
  hidePresenceModal();
}

function activityCheck() {
  if (!BOT.running) return;
  if (!ACTIVITY.enabled) return;
  var modal = document.getElementById('presence-modal');
  if (modal && modal.style.display === 'flex') return;
  if (Date.now() - ACTIVITY.lastActivity >= ACTIVITY.INACTIVE_MS) showPresenceModal();
}

function showPresenceModal() {
  var m = document.getElementById('presence-modal');
  if (!m) return;
  m.style.display = 'flex';
  try { new Audio('data:audio/wav;base64,UklGRl9vAAAAAQEBAAEBAAEBAAEBAAEBAAEBAAEB').play(); } catch(e) {}
  var deadline = Date.now() + ACTIVITY.GRACE_MS;
  var cd = document.getElementById('presence-countdown');
  function tick() {
    var rem = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    if (cd) cd.textContent = rem + 's';
    if (rem <= 0) {
      hidePresenceModal();
      botLog('🛑 Bot detenido por inactividad (sin respuesta al chequeo de presencia)', '#E24B4A');
      sendTelegram('🛑 P2P Bot detenido: inactividad detectada — anuncio pausado');
      botToggle();
    }
  }
  tick();
  ACTIVITY.countdownTimer = setInterval(tick, 1000);
}

function hidePresenceModal() {
  var m = document.getElementById('presence-modal');
  if (m) m.style.display = 'none';
  if (ACTIVITY.countdownTimer) { clearInterval(ACTIVITY.countdownTimer); ACTIVITY.countdownTimer = null; }
}

function confirmPresence() {
  bumpActivity();
  hidePresenceModal();
  botLog('✓ Presencia confirmada', '#8b949e');
}

document.addEventListener('click', function(e) {
  var d = document.getElementById('alert-dropdown');
  if (d && d.style.display === 'flex' && !d.contains(e.target) && e.target.id !== 'btn-bell' && !document.getElementById('btn-bell').contains(e.target)) {
    d.style.display = 'none';
  }
  [['bot-gear-popup','bot-gear-btn'],['ob-gear-popup','ob-gear-btn']].forEach(function(pair) {
    var gp = document.getElementById(pair[0]);
    var gb = document.getElementById(pair[1]);
    if (gp && gp.style.display !== 'none' && !gp.contains(e.target) && gb && !gb.contains(e.target)) {
      gp.style.display = 'none';
    }
  });
});

// ── Auto-Repricing Bot ────────────────────────────────
var BOT = {
  running: false,
  timer: null,
  adNumber: null,
  myNick: null,
  basePrice: null,
  ceiling: null,
  currentPrice: null,
  adAmount: null, // USDT restante en el anuncio (surplusAmount), lo trae /bot-state — lo usa el P&L
  adHidden: false, // Binance lo escondio del mercado (muchas ordenes); sigue activo
  myMinLimit: null,
  lastReprice: 0,
  cycles: 0,
  appliedMinLimit: 0,
  cachedAd: null,
  cachedAdAt: 0,
  startSeq: 0,
  startingSeq: 0, // == startSeq mientras corre la secuencia de arranque (ver botStarting)
  adPayTypes: []
};

var BOT_CFG = {
  url: BOT_API,
  token: '',
  adNo: '',
  increment: 0.001,
  maxGap: 1.0,
  limitThreshold: 10000,
  sellPrice: 0,
  minSpread: 0.5,
  minLimit: 50000,
  myNick: '',
  payMethods: [] // ids elegidos para el anuncio (vacio = no tocar sus metodos)
};

// BDV en la UI = Banco de Venezuela + Bank Transfer (el usuario los usa juntos)
var BOT_PAY_EXPAND = { BancoDeVenezuela: ['BancoDeVenezuela', 'BANK'] };
function botExpandPays(ids) {
  var out = [];
  (ids || []).forEach(function (id) {
    (BOT_PAY_EXPAND[id] || [id]).forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); });
  });
  return out;
}

function stepEl(el, dir, mult) {
  if (!el) return;
  const step = (parseFloat(el.step) || 1) * (mult || 1);
  const min  = el.min !== '' ? parseFloat(el.min) : -Infinity;
  const max  = el.max !== '' ? parseFloat(el.max) :  Infinity;
  const cur  = parseFloat(el.value) || 0;
  const dec  = (step.toString().split('.')[1] || '').length;
  el.value   = Math.max(min, Math.min(max, parseFloat((cur + dir * step).toFixed(dec))));
  // bubbles:true — el listener de Guardar/Descartar escucha por delegacion en
  // #bot-panel; sin esto, los botones −/+ del stepper no marcaban el panel "sucio".
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
// Boton (?) junto al titulo de un grupo (Configuracion / Ajustes avanzados):
// muestra/oculta el bloque de ayuda con los campos de ese grupo.
function toggleHelpBlock(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.style.display = (el.style.display === 'block') ? 'none' : 'block';
}
// Con Shift presionado, medio step (micro-ajuste). Aplica al clic de los botones -/+.
function stepInput(id, dir) {
  var mult = (typeof window !== 'undefined' && window.event && window.event.shiftKey) ? 0.5 : 1;
  stepEl(document.getElementById(id), dir, mult);
}

// Scroll del mouse sobre un campo con stepper: sube/baja el valor. Con Shift, medio
// step (mas fino). Solo web (en movil no hay rueda). El clic de los -/+ tambien lo respeta.
document.addEventListener('wheel', function (e) {
  const el = e.target;
  if (!el || el.tagName !== 'INPUT' || el.type !== 'number' || typeof el.closest !== 'function') return;
  const inStepper = el.closest('.num-stepper');
  const inFilter  = el.closest('.lbl-filter');
  if (!inStepper && !inFilter) return;
  // Shift+scroll llega como deltaX (scroll horizontal) en la mayoria de navegadores;
  // sin esto, la direccion quedaba pegada y no ajustaba.
  const delta = e.deltaY || e.deltaX;
  if (!delta) return;
  e.preventDefault();
  // stepEl suma relativo al valor escrito (45000 → 55000), no al grid nativo (→ 50000).
  stepEl(el, delta < 0 ? 1 : -1, e.shiftKey ? 0.5 : 1);
  // Filtros: no refetchar en cada tick; disparar el onchange (fetch) solo al salir del input.
  if (inFilter) {
    if (document.activeElement !== el) el.focus();
    if (!el._wheelBlur) {
      el._wheelBlur = true;
      el.addEventListener('blur', function onb() {
        el.removeEventListener('blur', onb);
        el._wheelBlur = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  }
}, { passive: false });

// ── Campos obligatorios: el usuario elige, no hereda defaults ──────────
// El valor sugerido va de placeholder (gris). Si el campo queda vacio el bot
// NO arranca con un default silencioso: lo dice y marca el campo.
var BOT_REQUIRED = [
  { id: 'cfg-bot-sell',     label: 'Precio de venta' },
  { id: 'cfg-bot-spread',   label: 'Margen mínimo' },
  { id: 'cfg-bot-minlimit', label: 'Límite mínimo' }
];

function botMissingFields() {
  var out = [];
  for (var i = 0; i < BOT_REQUIRED.length; i++) {
    var el = document.getElementById(BOT_REQUIRED[i].id);
    // OJO: el margen admite 0 y negativos, asi que se valida el campo vacio,
    // no que el numero sea falsy.
    var empty = !el || el.value.trim() === '' || isNaN(parseFloat(el.value));
    if (el) el.classList.toggle('inp-missing', empty);
    if (empty) out.push(BOT_REQUIRED[i].label);
  }
  return out;
}

// ── Guardar/Descartar: solo con el bot corriendo ───────────────────────
// Detenido, "Iniciar Bot" guarda solo (saveBotConfig() al principio de
// botToggle()): no hace falta este control ahi. Corriendo, un ajuste a medias
// importa (puede estar comprando activamente), asi que se pide confirmar.
var BOT_DIRTY = false;

// Con el bot apagado la fila tambien aparece: guardar deja la config lista para el
// proximo arranque (saveBotConfig persiste siempre, y solo empuja al servidor si el
// bot corre). Antes solo salia con el bot corriendo y no habia forma de dejar los
// ajustes preparados de antemano.
function renderSaveRow() {
  var row = document.getElementById('bot-save-row');
  if (row) row.style.display = BOT_DIRTY ? 'flex' : 'none';
}

function markBotDirty() {
  if (BOT_DIRTY) return;
  BOT_DIRTY = true;
  renderSaveRow();
}

function discardBotConfig() {
  loadBotConfig(); // repuebla los inputs desde el ultimo BOT_CFG guardado
  // La cantidad del anuncio no vive en BOT_CFG (es de una sola vez): loadBotConfig
  // no la toca, hay que limpiarla aparte.
  var q = document.getElementById('manual-qty');
  if (q) { q.value = ''; updateManualTotal(); }
  botMissingFields(); // limpia marcas .inp-missing de valores descartados
  BOT_DIRTY = false;
  renderSaveRow();
  var st = document.getElementById('bot-cfg-st');
  if (st) { st.textContent = 'Descartado'; st.style.color = '#888'; clearTimeout(st._t); st._t = setTimeout(function(){ st.textContent = ''; }, 1500); }
}

(function watchBotInputs() {
  var panel = document.getElementById('bot-panel');
  if (!panel) return;
  panel.addEventListener('input', markBotDirty);
  panel.addEventListener('change', markBotDirty);
})();

function saveBotConfig() {
  BOT_CFG.adNo           = document.getElementById('cfg-bot-adsel').value;
  BOT_CFG.myNick         = document.getElementById('cfg-bot-nick').value.trim();
  BOT_CFG.increment      = parseFloat(document.getElementById('cfg-bot-inc').value)     || 0.001;
  BOT_CFG.maxGap         = parseFloat(document.getElementById('cfg-bot-gap').value)     || 1.0;
  // Tolerancia 0 es un ajuste valido (contar solo a quien tenga el limite minimo
  // estrictamente por debajo del mio). Con `|| 10000` el 0 se colaba como falsy y
  // se guardaba 10000 sin avisar: se ponia 0 y el bot seguia usando la tolerancia
  // por defecto. Vacio si cae al defecto.
  var _thr = parseFloat(document.getElementById('cfg-bot-thr').value);
  BOT_CFG.limitThreshold = isNaN(_thr) ? 10000 : _thr;
  BOT_CFG.sellPrice      = parseFloat(document.getElementById('cfg-bot-sell').value)    || 0;
  var _spr = parseFloat(document.getElementById('cfg-bot-spread').value);
  BOT_CFG.minSpread      = isNaN(_spr) ? 0.5 : _spr; // puede ser 0 o negativo (comprar sobre el precio de venta)
  BOT_CFG.minLimit       = parseFloat(document.getElementById('cfg-bot-minlimit').value) || 0;
  BOT_CFG.payMethods     = readBotPayChecks();
  localStorage.setItem('p2p_bot_cfg', JSON.stringify(BOT_CFG));
  botUpdateCeiling();
  // Aqui NO se repinta el libro: guardar solo deja la config lista, el anuncio en
  // Binance sigue como estaba. El monitor se refresca cuando el bot cierra el ciclo
  // y aplica el cambio de verdad (ver la firma de ciclo en renderBotState).
  // Si el bot ya corre en el servidor, empujar la config en caliente (limite, spread, etc.).
  if (BOT.running) botCallWorker('/bot-config', { config: botServerConfig() }).catch(function(){});
  // Destello corto: el "✓ Guardado" fijo competia con los datos del panel.
  var st = document.getElementById('bot-cfg-st');
  st.textContent = '✓ Guardado'; st.style.color = '#1D9E75';
  clearTimeout(st._t);
  // La fila se oculta junto con el destello: dejarla antes se lleva el "✓ Guardado".
  st._t = setTimeout(function(){ st.textContent = ''; BOT_DIRTY = false; renderSaveRow(); }, 1800);
  saveUserSettings();
}

// Checkboxes de metodos de pago del anuncio (lista VES; el bot siempre es VES)
function renderBotPayChecks() {
  var box = document.getElementById('bot-paymethods');
  if (!box) return;
  var sel = BOT_CFG.payMethods || [];
  box.innerHTML = PAY_METHODS_BY_FIAT.VES.map(function (m) {
    var checked = sel.indexOf(m.id) !== -1;
    return '<label class="pay-chk' + (checked ? ' on' : '') + '"><input type="checkbox" value="' + m.id + '"' + (checked ? ' checked' : '') +
      ' onchange="this.closest(\'label\').classList.toggle(\'on\',this.checked)">' + m.label + '</label>';
  }).join('');
}
function readBotPayChecks() {
  var box = document.getElementById('bot-paymethods');
  if (!box) return BOT_CFG.payMethods || [];
  return Array.prototype.filter.call(box.querySelectorAll('input:checked'), function () { return true; })
    .map(function (c) { return c.value; });
}
function samePaySet(a, b) {
  a = (a || []).slice().sort(); b = (b || []).slice().sort();
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
async function botApplyMethods(silent, skipIfSame) {
  var ids = readBotPayChecks();
  var st = document.getElementById('bot-cfg-st');
  if (!ids.length) { if (!silent && st) { st.textContent = 'Marca al menos un método'; st.style.color = 'var(--red)'; } return false; }
  var adNo = BOT.adNumber || BOT_CFG.adNo;
  if (!adNo) { if (!silent && st) { st.textContent = 'Configura el anuncio primero'; st.style.color = 'var(--red)'; } return false; }
  var pays = botExpandPays(ids);
  // Si el anuncio ya tiene exactamente esos metodos, no gastar requests (getDetail + update).
  if (skipIfSame && samePaySet(pays, BOT.adPayTypes)) return true;
  botLog('💳 Aplicando métodos: ' + ids.map(payLabel).join(', '), '#58A6FF');
  try {
    var data = await botCallWorker('/update-methods', { advNo: adNo, payTypes: pays });
    if (data.code && data.code !== '000000') throw new Error(data.msgDetail || data.message || data.msg || 'código ' + data.code);
    BOT.adPayTypes = pays.filter(function (id) { return GENERIC_PAY_IDS.indexOf(id) === -1; });
    updateBotPayBadge();
    BOT.cachedAd = null; BOT.cachedAdAt = 0;
    botLog('✓ Métodos actualizados en el anuncio', '#1D9E75');
    if (!silent && st) { st.textContent = '✓ Métodos aplicados'; st.style.color = 'var(--green)'; }
    return true;
  } catch (e) {
    botLog('⚠ No se pudieron aplicar métodos: ' + e.message, '#F6465D');
    if (!silent && st) { st.textContent = '✗ ' + e.message; st.style.color = 'var(--red)'; }
    return false;
  }
}

// Vuelca BOT_CFG a los inputs. Se llama tambien SIN config guardada: un usuario
// nuevo se encontraba los seis campos en blanco (el early return de abajo nunca
// llegaba aca) y tenia que adivinar seis numeros para arrancar. Los defaults de
// BOT_CFG ya eran razonables, solo que no llegaban a la pantalla.
function fillBotInputs() {
  var sel = document.getElementById('cfg-bot-adsel');
  if (BOT_CFG.adNo && !Array.prototype.some.call(sel.options, function(o){ return o.value === BOT_CFG.adNo; })) {
    var o = document.createElement('option'); o.value = BOT_CFG.adNo; o.textContent = 'Ad ' + BOT_CFG.adNo; sel.appendChild(o);
  }
  sel.value = BOT_CFG.adNo || '';
  document.getElementById('cfg-bot-nick').value     = BOT_CFG.myNick || '';
  document.getElementById('cfg-bot-inc').value      = BOT_CFG.increment;
  document.getElementById('cfg-bot-gap').value      = BOT_CFG.maxGap;
  document.getElementById('cfg-bot-thr').value      = BOT_CFG.limitThreshold;
  // El precio de venta es el unico que no se puede suponer: depende del mercado
  // de hoy. Queda vacio y el boton ✨ lo sugiere.
  document.getElementById('cfg-bot-sell').value     = BOT_CFG.sellPrice || '';
  document.getElementById('cfg-bot-spread').value   = BOT_CFG.minSpread;
  document.getElementById('cfg-bot-minlimit').value = BOT_CFG.minLimit || '';
  renderBotPayChecks();
  botUpdateCeiling();
}

function loadBotConfig() {
  try {
    var s = localStorage.getItem('p2p_bot_cfg');
    if (s) {
      Object.assign(BOT_CFG, JSON.parse(s));
      BOT_CFG.url = BOT_API; // fija (interna): ignora la url que hubiera en localStorage
    }
    fillBotInputs();
  } catch(e) {}
}

function updateCommissionLabels() {
  var c = CFG.commission || 0;
  // En el bot es un chip (texto corto); en Seccion Vender sigue como etiqueta.
  [['ob-commission-label', 'COMISIÓN '], ['bot-commission-label', 'com. ']].forEach(function(par){
    var el = document.getElementById(par[0]);
    if (!el) return;
    if (c > 0) {
      el.textContent = par[1] + c + '%';
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  });
}

function botUpdateCeiling() {
  var sell     = parseFloat(document.getElementById('cfg-bot-sell').value) || 0;
  var sprInput = parseFloat(document.getElementById('cfg-bot-spread').value);
  var spread   = isNaN(sprInput) ? 0.5 : sprInput; // puede ser 0 o negativo
  var el     = document.getElementById('bot-ceiling');
  if (sell > 0) {
    var ceiling = sell * (1 - (spread + (CFG.commission || 0)) / 100);
    BOT.ceiling = ceiling;
    if (el) el.textContent = ceiling.toFixed(3) + ' Bs';
    updateBotPriceColor();
  } else {
    BOT.ceiling = null;
    if (el) el.textContent = '—';
  }
  updateBotPnl();
}

// P&L potencial en USDT de llenar el anuncio completo al precio actual, contra el
// precio de venta configurado (referencia/costo). Binance solo cobra comision al
// COMPRAR (sobre la cantidad USDT), nunca al vender: por eso se resta aparte, en
// USDT, y no como % del precio (a diferencia del techo, que si la mete en el precio).
function botPnl() {
  var sell = parseFloat(document.getElementById('cfg-bot-sell').value) || 0;
  // Con el bot apagado no hay precio actual: se proyecta contra el techo, que es lo
  // maximo que llegaria a pagar con ese precio de venta y ese margen. Es el peor
  // caso, asi que el numero real nunca sale por debajo del estimado.
  var cur  = BOT.currentPrice || BOT.ceiling;
  var est  = !BOT.currentPrice;
  // La cantidad escrita manda sobre la del anuncio: es la que el usuario esta a
  // punto de aplicar, y con el bot apagado la del anuncio puede ser de otra corrida.
  var qty  = manualQtyUsdt() || BOT.adAmount;
  if (!sell || !cur || !qty) return null;
  var gross = qty * (sell - cur) / cur;
  var fee   = qty * (CFG.commission || 0) / 100;
  return { gross: gross, fee: fee, net: gross - fee, est: est, qty: qty, price: cur };
}

function updateBotPnl() {
  var el = document.getElementById('bot-pnl');
  if (!el) return;
  var p = botPnl();
  if (!p) { el.textContent = '—'; el.style.color = ''; el.title = ''; return; }
  // "~" delante cuando es proyeccion (bot apagado, calculada sobre el techo).
  el.textContent = (p.est ? '~' : '') + (p.net >= 0 ? '+' : '') + fmt(p.net) + ' USDT';
  el.style.color = p.net >= 0 ? 'var(--green)' : 'var(--red)';
  el.title = (p.est ? 'Estimado con el bot apagado: ' + fmt(p.qty) + ' USDT al precio máximo (' + p.price.toFixed(3) + ' Bs).\n' : '') +
    'Bruto: ' + (p.gross >= 0 ? '+' : '') + fmt(p.gross) + ' USDT · Comisión: −' + fmt(p.fee) + ' USDT';
}

async function botCallWorker(path, body) {
  if (!SESSION.token) throw new Error('Inicia sesión primero');
  // 20s: rutas como /update-limit hacen 2 llamadas a Binance + cold start; con el
  // default de 8s el cliente abortaba con "Timeout" aunque el servidor iba bien.
  var r = await fetchRetry(BOT_CFG.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SESSION.token },
    body: JSON.stringify({ path: path, params: body || {} })
  }, 20000);
  var data = await r.json().catch(function() { return {}; });
  if (!r.ok) throw new Error('Worker ' + r.status + (data.error ? ': ' + data.error : ''));
  return data;
}

async function loadMyAds() {
  var sel = document.getElementById('cfg-bot-adsel');
  var st  = document.getElementById('bot-cfg-st');
  if (!SESSION.token) { if (st) { st.textContent = 'Inicia sesión primero'; st.style.color = '#E24B4A'; } return; }
  if (st) { st.textContent = 'Cargando anuncios...'; st.style.color = '#555'; }
  try {
    var data = await botCallWorker('/my-ads');
    var ads = Array.isArray(data.data) ? data.data
            : (data.data && Array.isArray(data.data.data)) ? data.data.data : [];
    sel.innerHTML = '<option value="">Auto-detectar</option>';
    ads.forEach(function(a) {
      var no    = String(a.adNumber || a.advNo);
      var price = a.price != null ? (+a.price).toFixed(3) : '?';
      var avail = parseFloat(a.surplusAmount || a.tradableQuantity || a.remainQuantity || 0);
      var live  = a.advStatus === 'LIVE' || a.advStatus === 'ONLINE' || a.advStatus === 1 || a.adStatus === 1;
      var o = document.createElement('option');
      o.value = no;
      o.textContent = (a.tradeType || '') + ' ' + price + ' · ' + Math.round(avail) + ' USDT' + (live ? '' : ' (pausado)');
      sel.appendChild(o);
    });
    if (BOT_CFG.adNo && !Array.prototype.some.call(sel.options, function(o){ return o.value === BOT_CFG.adNo; })) {
      var miss = document.createElement('option'); miss.value = BOT_CFG.adNo; miss.textContent = 'Ad ' + BOT_CFG.adNo; sel.appendChild(miss);
    }
    sel.value = BOT_CFG.adNo || '';
    var nickEl = document.getElementById('cfg-bot-nick');
    var detected = ads.map(function(a){ return a.advertiserNickName || a.nickName || (a.advertiser && a.advertiser.nickName) || a.merchantNickName; }).find(Boolean);
    if (detected && nickEl && !nickEl.value.trim()) {
      nickEl.value = detected;
      BOT_CFG.myNick = detected;
      localStorage.setItem('p2p_bot_cfg', JSON.stringify(BOT_CFG));
      syncMonitorWithBot(); // ya se sabe cual es mi fila: resaltarla sin esperar al fetch
    }
    if (st) { st.textContent = ads.length + ' anuncio(s)'; st.style.color = '#1D9E75'; }
  } catch (e) {
    if (st) { st.textContent = e.message; st.style.color = '#E24B4A'; }
  }
}

function onAdSelect() {
  BOT_CFG.adNo = document.getElementById('cfg-bot-adsel').value;
  localStorage.setItem('p2p_bot_cfg', JSON.stringify(BOT_CFG));
  saveUserSettings();
}

async function botGetMyAd(allowPaused) {
  var data = await botCallWorker('/my-ads');
  var ads = Array.isArray(data.data) ? data.data
          : Array.isArray(data.data && data.data.data) ? data.data.data
          : null;
  if (!ads || !ads.length) {
    botLog('Raw API: ' + JSON.stringify(data).substring(0, 200), '#888');
    throw new Error('Sin anuncios (ver log)');
  }
  // Si hay Ad Number configurado, buscar ese exacto
  if (BOT_CFG.adNo) {
    var byId = ads.find(function(a) {
      return String(a.adNumber || a.advNo) === BOT_CFG.adNo;
    });
    if (!byId) throw new Error('Ad ' + BOT_CFG.adNo + ' no encontrado en la lista');
    var isLiveById = byId.advStatus === 'LIVE' || byId.advStatus === 'ONLINE' || byId.advStatus === 1
                  || byId.status === 'LIVE' || byId.adStatus === 1;
    if (!isLiveById && !allowPaused) return null; // pausado manualmente
    // Detectar fondos insuficientes: menos de 100 USDT no permite editar precio
    var surplusUsdt = parseFloat(byId.surplusAmount || byId.tradableQuantity || byId.remainQuantity || 0);
    if (surplusUsdt > 0 && surplusUsdt < 100) byId.__noFunds = true;
    return byId;
  }
  // Auto-detección: primer anuncio BUY USDT/VES activo
  return ads.find(function(a) {
    var isBuy  = a.tradeType === 'BUY';
    var isUsdt = a.asset === 'USDT' || a.cryptoCurrency === 'USDT';
    var isVes  = a.fiatUnit === 'VES' || a.fiatCurrency === 'VES' || a.fiat === 'VES';
    var isLive = a.advStatus === 'LIVE' || a.advStatus === 'ONLINE' || a.advStatus === 1
              || a.status === 'LIVE' || a.adStatus === 1;
    return isBuy && isUsdt && isVes && isLive;
  }) || null;
}

// Unidad en la que se ESCRIBE la cantidad. El anuncio siempre se actualiza en USDT:
// en modo VES se convierte (Bs / precio) antes de mandarlo.
var QTY_UNIT = 'VES';

function qtyPrice() {
  return BOT.currentPrice || parseFloat(document.getElementById('cfg-bot-sell').value) || 0;
}

// USDT que se le pondra al anuncio con lo escrito en el campo.
function manualQtyUsdt() {
  var v = parseFloat(document.getElementById('manual-qty').value) || 0;
  if (!v || QTY_UNIT === 'USDT') return v;
  var p = qtyPrice();
  return p ? Math.floor(v / p * 100) / 100 : 0;
}

function toggleQtyUnit() {
  QTY_UNIT = QTY_UNIT === 'USDT' ? 'VES' : 'USDT';
  var b = document.getElementById('manual-qty-unit');
  if (b) b.textContent = '↻ ' + (QTY_UNIT === 'USDT' ? 'USDT' : 'Bs');
  var inp = document.getElementById('manual-qty');
  if (inp) inp.step = QTY_UNIT === 'USDT' ? 100 : 10000;
  updateManualTotal();
}

function updateManualTotal() {
  var qty   = parseFloat(document.getElementById('manual-qty').value) || 0;
  var price = qtyPrice();
  var el    = document.getElementById('manual-total');
  if (QTY_UNIT === 'VES') {
    var usdt = manualQtyUsdt();
    el.textContent = usdt ? fmt(usdt) + ' USDT' : '—';
  } else {
    el.textContent = (qty && price) ? fmt(price * qty) + ' Bs' : '—';
  }
  updateBotPnl(); // la cantidad escrita entra en el P&L proyectado
}

function updateManualBalance() {
  var el = document.getElementById('manual-balance');
  if (!el) return;
  var ad = BOT.cachedAd;
  if (!ad) { el.textContent = ''; return; }
  var usdt = parseFloat(ad.surplusAmount || ad.tradableQuantity || ad.remainQuantity || 0);
  if (!usdt) { el.textContent = ''; return; }
  var price = BOT.currentPrice || parseFloat(document.getElementById('cfg-bot-sell').value) || 0;
  var ves = price ? '· ' + fmt(usdt * price) + ' Bs' : '';
  el.textContent = '(' + usdt.toFixed(2) + ' USDT ' + ves + ')';
}

// Devuelve true solo si Binance acepto el cambio (el que llama decide si limpia el campo).
async function manualSetQty() {
  var st = document.getElementById('manual-st');
  var raw = parseFloat(document.getElementById('manual-qty').value);
  if (raw > 0 && QTY_UNIT === 'VES' && !qtyPrice()) {
    st.textContent = 'Sin precio de venta: no puedo convertir Bs a USDT'; st.style.color = 'var(--red)'; return false;
  }
  var qty = manualQtyUsdt();
  if (!qty || qty <= 0) { st.textContent = 'Ingresa una cantidad válida'; st.style.color = 'var(--red)'; return false; }
  var adNo = BOT.adNumber || BOT_CFG.adNo;
  if (!adNo) { st.textContent = 'Configura el Ad Number primero'; st.style.color = 'var(--red)'; return false; }
  st.textContent = 'Aplicando cantidad...'; st.style.color = 'var(--text-2)';
  try {
    var data = await botCallWorker('/update-quantity', { advNo: adNo, totalAmount: qty });
    if (data.code && data.code !== '000000') throw new Error(data.msgDetail || data.msg || data.message || 'código ' + data.code);
    botLog('✎ Cantidad manual → ' + qty + ' USDT', '#58A6FF');
    BOT.cachedAd = null;
    BOT.cachedAdAt = 0;
    st.textContent = '✓ Cantidad actualizada'; st.style.color = 'var(--green)';
    return true;
  } catch(e) {
    st.textContent = '✗ ' + e.message; st.style.color = 'var(--red)';
    return false;
  }
}

// Boton Guardar del panel del bot: guarda la config y aplica al anuncio real lo que
// haya cambiado — metodos de pago y, si hay cantidad escrita, la cantidad (y limpia
// el campo para no reaplicarla sin querer al volver a guardar). Antes Metodos y
// Cantidad tenian su propio "Aplicar ahora" aparte de Guardar/Descartar; quedaba un
// tercer boton haciendo lo mismo que ya hace Guardar en todo lo demas.
async function saveBotConfigAndApply() {
  saveBotConfig();
  var adNo = BOT.adNumber || BOT_CFG.adNo;
  if (adNo && (BOT_CFG.payMethods || []).length) {
    try { await botApplyMethods(true, true); } catch(e) {}
  }
  var inp = document.getElementById('manual-qty');
  if (!inp || !(parseFloat(inp.value) > 0)) return;
  if (await manualSetQty()) { inp.value = ''; updateManualTotal(); }
}

async function botUpdateMinLimit(adNumber, minAmount) {
  var data = await botCallWorker('/update-limit', { advNo: adNumber, minSingleTransAmount: parseFloat(minAmount) });
  if (data.code && data.code !== '000000') {
    var msg = data.message || (String(data.code) === '-1002'
      ? 'API key no autorizada: la cuenta no es comerciante P2P o la key no tiene permiso para editar anuncios'
      : '?');
    botLog('Límite [' + data.code + ']: ' + msg, '#E24B4A');
    throw new Error(msg);
  }
  return true;
}

async function botUpdatePrice(adNumber, price) {
  var data = await botCallWorker('/update-ad', { advNo: adNumber, price: parseFloat(price.toFixed(3)) });
  if (data.code && data.code !== '000000') {
    botLog('Binance [' + data.code + ']: ' + (data.message || '?'), '#E24B4A');
    throw new Error(data.message || 'Error Binance código ' + data.code);
  }
  return true;
}

function botLog(msg, color) {
  var el = document.getElementById('bot-log');
  var ts = new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  var line = document.createElement('div');
  line.style.color = color || '#aaa';
  line.style.borderBottom = '1px solid #111';
  line.style.paddingBottom = '2px';
  line.style.marginBottom = '2px';
  line.textContent = ts + '  ' + msg;
  if (el.firstChild && el.firstChild.textContent === 'Sin actividad') el.innerHTML = '';
  el.insertBefore(line, el.firstChild);
  // Máximo 30 líneas
  while (el.children.length > 30) el.removeChild(el.lastChild);
}

function botSetStatus(msg, color) {
  var el = document.getElementById('bot-status');
  el.textContent = msg; el.style.color = color || '#888';
}

async function botInitialCycle(allowPaused) {
  botLog('⚡ Posicionando...', '#F0B90B');
  try {
    var ad = await botGetMyAd(allowPaused);
    if (!ad) { botLog('⚠ Anuncio no encontrado para reprice inicial', '#F0B90B'); return; }
    BOT.adNumber     = ad.adNumber || ad.advNo;
    BOT.currentPrice = parseFloat(ad.price);
    BOT.myMinLimit   = parseFloat(ad.minSingleTransAmount);
    BOT.adPayTypes   = (ad.tradeMethods || []).map(function(m){ return m.identifier; })
                       .filter(function(id){ return id && GENERIC_PAY_IDS.indexOf(id) === -1; });
    if (BOT.adPayTypes.length) {
      botLog('💳 Métodos: ' + BOT.adPayTypes.map(payLabel).join(', '), '#8b949e');
      updateBotPayBadge();
      // Auto-sync selector del monitor con el primer método del anuncio que esté en PAY_METHODS
      var primary = null;
      for (var pi = 0; pi < BOT.adPayTypes.length; pi++) {
        if (PAY_METHODS.some(function(m){ return m.id === BOT.adPayTypes[pi]; })) {
          primary = BOT.adPayTypes[pi];
          break;
        }
      }
      // Auto-sync del selector solo en vista VES (el anuncio del bot es VES;
      // si estas revisando USD no hay que tocarte la vista).
      if (ACTIVE_FIAT === 'VES' && primary && primary !== ACTIVE_PAY) {
        ACTIVE_PAY = primary;
        PAY_SEL.VES = primary;
        resetLocalSeries();
        persistPaySel();
        var sel = document.getElementById('pay-method-select');
        if (sel) sel.value = primary;
        botLog('🔄 Selector ajustado → ' + payLabel(primary), '#8b949e');
      }
    }
    BOT.ceiling = BOT_CFG.sellPrice * (1 - (BOT_CFG.minSpread + (CFG.commission || 0)) / 100);
    document.getElementById('bot-ceiling').textContent    = BOT.ceiling.toFixed(3) + ' Bs';
    document.getElementById('bot-cur-price').textContent  = BOT.currentPrice.toFixed(3) + ' Bs';
    updateBotPriceColor();

    var market      = mapAds(await fetchTier(BOT.myMinLimit + BOT_CFG.limitThreshold, 2, BOT.adPayTypes));
    var myPays = BOT.adPayTypes && BOT.adPayTypes.length ? BOT.adPayTypes : [ACTIVE_PAY];
    var competitors = market.filter(function(a) {
      var aTypes = a.payTypes || [];
      var match = myPays.some(function(p) { return aTypes.indexOf(p) !== -1; });
      return String(a.advNo) !== String(BOT.adNumber) &&
             a.merchant !== (BOT_CFG.myNick || BOT.myNick) &&
             match &&
             a.minVES < (BOT.myMinLimit + BOT_CFG.limitThreshold) &&
             a.avail >= 150;
    });

    // above: competidores bajo el techo (sin límite de gap — reprice inicial)
    var above = competitors.filter(function(a) { return a.price > BOT.currentPrice && a.price <= BOT.ceiling; });
    var below = competitors.filter(function(a) { return a.price < BOT.currentPrice; });

    // Si el precio actual ya supera el techo, todos los competidores válidos están "abajo"
    // Recalcular above con referencia al techo si estamos sobre él
    if (BOT.currentPrice > BOT.ceiling) {
      above = competitors.filter(function(a) { return a.price <= BOT.ceiling; });
      below = [];
    }

    var targetPrice = null;
    if (above.length > 0) {
      above.sort(function(a, b) { return b.price - a.price; });
      targetPrice = above[0].price + BOT_CFG.increment;
    } else if (below.length > 0) {
      below.sort(function(a, b) { return b.price - a.price; });
      var proposed = below[0].price + BOT_CFG.increment;
      if (proposed < BOT.currentPrice) targetPrice = proposed;
    }

    if (targetPrice === null) { botLog('⚡ Inicial: posición óptima', '#1D9E75'); return; }
    if (targetPrice > BOT.ceiling) targetPrice = BOT.ceiling;
    if (Math.abs(targetPrice - BOT.currentPrice) < 0.001) { botLog('⚡ Inicial: sin cambio necesario', '#1D9E75'); return; }

    await botUpdatePrice(BOT.adNumber, targetPrice);
    var arrow = targetPrice > BOT.currentPrice ? '↑' : '↓';
    botLog('⚡ Inicial: ' + arrow + ' ' + BOT.currentPrice.toFixed(3) + ' → ' + targetPrice.toFixed(3) + ' Bs', '#F0B90B');
    BOT.currentPrice = targetPrice;
    document.getElementById('bot-cur-price').textContent = targetPrice.toFixed(3) + ' Bs';
    updateBotPriceColor();
    updateTopbarBotPrice(targetPrice);
  } catch(e) {
    botLog('⚠ Reprice inicial: ' + e.message, '#F6465D');
  }
}

function botServerConfig() {
  return {
    adNo: BOT_CFG.adNo,
    sellPrice: BOT_CFG.sellPrice,
    minSpread: BOT_CFG.minSpread,
    minLimit: BOT_CFG.minLimit,
    increment: BOT_CFG.increment,
    maxGap: BOT_CFG.maxGap,
    limitThreshold: BOT_CFG.limitThreshold,
    myNick: BOT_CFG.myNick || BOT.myNick || '',
    commission: CFG.commission || 0,
    verifiedOnly: CFG.verifiedOnly !== false,
    payTypes: (BOT.adPayTypes && BOT.adPayTypes.length) ? BOT.adPayTypes : [PAY_SEL.VES]
  };
}

// El boton refleja SIEMPRE BOT.running desde un solo sitio: pintarlo a mano en
// cada rama era lo que dejaba "▶ Iniciar Bot" con el bot ya encendido.
function renderBotToggle() {
  var b = document.getElementById('bot-toggle');
  if (!b) return;
  b.textContent = BOT.running ? '⏹ Detener Bot' : '▶ Iniciar Bot';
  b.style.background = BOT.running ? '#E24B4A' : '';
  renderAdHidden(BOT.adHidden); // el chip "Oculto" no aplica con el bot detenido
  renderTabDot();
  renderSaveRow(); // Guardar/Descartar solo aplica con el bot corriendo
}

// La secuencia de arranque tarda (leer anuncio, metodos, reprice, activar). Mientras
// corre, el servidor aun no esta encendido: nada de fuera debe "corregir" la UI.
function botStarting() { return !!BOT.startingSeq && BOT.startingSeq === BOT.startSeq; }

// Chip "Oculto": Binance esconde el anuncio del mercado cuando se acumulan ordenes.
// El bot sigue repreciando; el anuncio vuelve solo. Solo tiene sentido con el bot activo.
function renderAdHidden(hidden) {
  BOT.adHidden = hidden;
  var el = document.getElementById('bot-hidden-badge');
  if (el) el.style.display = (hidden && BOT.running) ? '' : 'none';
}

async function botToggle() {
  if (BOT.running) {
    // ── STOP ────────────────────────────────────────────
    BOT.running = false;
    BOT.startSeq = (BOT.startSeq || 0) + 1; // cancela cualquier arranque aun en curso
    stopBotPoller();
    stopActivityWatcher();
    BOT.adPayTypes = [];
    updateBotPayBadge();
    updateManualBalance();

    renderBotToggle();
    document.getElementById('bot-cur-price').textContent = '—';
    document.getElementById('bot-cur-price').style.color = 'var(--gold)';
    botUpdateCeiling();
    updateTopbarBotPrice(null);
    botSetStatus('Deteniendo...', '#888');
    botLog('— Bot detenido —', '#555');

    // Detener el bot en el servidor primero, luego pausar el anuncio
    try { await botCallWorker('/bot-disable'); } catch(e) {}
    if (BOT.adNumber) {
      try {
        var res = await botCallWorker('/toggle-ad', { advNo: BOT.adNumber, advStatus: 3 });
        if (res.code && res.code !== '000000') throw new Error(res.message || 'código ' + res.code);
        if (res.failList && res.failList.length) throw new Error(res.failList[0].errorMsg || 'código ' + res.failList[0].errorCode);
        botLog('⏸ Anuncio pausado en Binance', '#8b949e');
      } catch(e) {
        botLog('⚠ No se pudo pausar el anuncio: ' + e.message, '#F6465D');
      }
    }
    botSetStatus('Detenido', '#555');
    if (TGLINK.linked) sendTelegram('🔴 <b>Bot apagado</b>');

  } else {
    // ── START ────────────────────────────────────────────
    saveBotConfig();
    if (!SESSION.token) { toast('Inicia sesión primero'); return; }
    if (!(await requireSub())) return;
    var falta = botMissingFields();
    if (falta.length) {
      toast('Falta configurar: ' + falta.join(', '));
      var first = document.querySelector('.inp-missing');
      if (first) { try { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus(); } catch (e) {} }
      return;
    }

    // Marcar corriendo YA, para que un segundo toque dispare Detener durante el arranque.
    BOT.running = true;
    BOT.startSeq = (BOT.startSeq || 0) + 1;
    var startSeq = BOT.startSeq;
    BOT.startingSeq = startSeq;

    renderBotToggle();
    document.getElementById('bot-live').style.display = 'grid';
    botLog('— Bot iniciado —', '#F0B90B');

    if (!BOT.adNumber && BOT_CFG.adNo) BOT.adNumber = BOT_CFG.adNo;

    // 1. Leer el anuncio (aún PAUSADO) para adNumber + métodos de pago
    if (!BOT.adNumber || !BOT.adPayTypes.length) {
      botSetStatus('Leyendo anuncio...', '#F0B90B');
      try {
        var adPre = await botGetMyAd(true);
        if (adPre) {
          BOT.adNumber   = adPre.adNumber || adPre.advNo;
          BOT.myMinLimit = parseFloat(adPre.minSingleTransAmount);
          BOT.adPayTypes = (adPre.tradeMethods || []).map(function(m){ return m.identifier; })
                            .filter(function(id){ return id && GENERIC_PAY_IDS.indexOf(id) === -1; });
          updateBotPayBadge();
        } else {
          botLog('⚠ Selecciona tu anuncio para activarlo/pausarlo', '#F0B90B');
        }
      } catch(e) {
        botLog('⚠ No se pudo leer el anuncio: ' + e.message, '#F6465D');
      }
    }

    // 1b. Aplicar métodos de pago elegidos (anuncio aún PAUSADO); salta si ya coinciden
    if ((BOT_CFG.payMethods || []).length && BOT.adNumber) {
      botSetStatus('Aplicando métodos...', '#F0B90B');
      try { await botApplyMethods(true, true); } catch(e) {}
    }

    // 2. Reprice inicial + límite mínimo mientras el anuncio está PAUSADO
    BOT.appliedMinLimit = 0;
    if (BOT_CFG.minLimit > 0 && BOT.adNumber) {
      botSetStatus('Aplicando límite mínimo...', '#F0B90B');
      try { await botUpdateMinLimit(BOT.adNumber, BOT_CFG.minLimit); BOT.appliedMinLimit = BOT_CFG.minLimit; } catch(e) {}
    }
    botSetStatus('Posicionando...', '#F0B90B');
    try { await botInitialCycle(true); } catch(e) {}

    // Si pulsaron Detener durante el arranque, abortar antes de activar/encender.
    if (BOT.startSeq !== startSeq) { botLog('— Inicio cancelado —', '#888'); return; }

    // 3. Activar el anuncio
    botSetStatus('Activando anuncio...', '#F0B90B');
    try {
      if (BOT.adNumber) {
        var res2 = await botCallWorker('/toggle-ad', { advNo: BOT.adNumber, advStatus: 1 });
        if (res2.code && res2.code !== '000000') throw new Error(res2.message || 'código ' + res2.code);
        if (res2.failList && res2.failList.length) throw new Error(res2.failList[0].errorMsg || 'código ' + res2.failList[0].errorCode);
        botLog('▶ Anuncio activado', '#1D9E75');
      }
    } catch(e) {
      botLog('⚠ No se pudo activar el anuncio: ' + e.message, '#F6465D');
    }

    // Si cancelaron justo después de activar, pausar el anuncio y no encender el servidor.
    if (BOT.startSeq !== startSeq) {
      botLog('— Inicio cancelado — pausando anuncio', '#888');
      if (BOT.adNumber) { try { await botCallWorker('/toggle-ad', { advNo: BOT.adNumber, advStatus: 3 }); } catch(e) {} }
      return;
    }

    // 4. Encender el bot en el SERVIDOR (repricia 24/7 aunque cierres la página)
    try {
      await botCallWorker('/bot-enable', { config: botServerConfig() });
      botLog('☁ Bot corriendo en el servidor (~18s)', '#1D9E75');
    } catch(e) {
      botLog('⚠ No se pudo encender el bot en el servidor: ' + e.message, '#F6465D');
    }

    BOT.running = true;
    BOT.startingSeq = 0;
    renderBotToggle(); // el boton pudo quedar desincronizado durante el arranque
    botSetStatus('✓ Bot activo', '#1D9E75');
    if (TGLINK.linked) sendTelegram('🟢 <b>Bot encendido</b>');
    startBotPoller();
    startActivityWatcher();
    // Las notificaciones de ordenes nuevas las maneja el servidor (24/7, app cerrada).
  }
}

// ── Poller de estado del bot server-side ──────────────
// lastCycle: firma del ultimo ciclo del bot que ya vimos (precio + limite). Cambia
// = el bot toco el anuncio y el monitor debe refrescarse. null = aun sin leer.
var BOT_POLL = { timer: null, lastLogTs: 0, lastCycle: null, fromMonitor: false };
var BOT_LOG_COLORS = { up: '#1D9E75', down: '#5dade2', warn: '#F0B90B', error: '#E24B4A', info: '#8b949e' };

function startBotPoller() {
  // Durante el arranque el poller leeria estado viejo (enabled:false, status
  // anterior) y pisaria la UI; lo arranca el final de botToggle.
  if (botStarting()) return;
  stopBotPoller();
  pollBotState();
  // 15s: el reprice server-side es ~18s, pollear mas rapido solo gastaba invocaciones
  // Vercel sin ver nada nuevo (era el mayor consumidor con la app abierta).
  BOT_POLL.timer = setInterval(pollBotState, 15000);
}
function stopBotPoller() {
  if (BOT_POLL.timer) { clearInterval(BOT_POLL.timer); BOT_POLL.timer = null; }
}

async function pollBotState() {
  if (!SESSION.token) return;
  try {
    var d = await botCallWorker('/bot-state');
    if (botStarting()) return; // arranque en curso: no pisar la UI con estado viejo
    renderBotState(d);
  } catch(e) {}
}

// El monitor trajo el estado del bot pegado a su propia respuesta (una invocacion
// Vercel en vez de dos). Se pinta igual que si lo hubiera traido pollBotState, y se
// reinicia la cuenta del poller: mientras el monitor siga alimentando, este no vuelve
// a preguntar por su cuenta; si el monitor se detiene o falla, a los 15s sin noticias
// dispara solo, como siempre. Nada de esto mueve al bot — eso es cosa de bot-tick.
function botStateFromMonitor(d) {
  if (!BOT.running || botStarting()) return;
  BOT_POLL.fromMonitor = true;
  try { renderBotState(d); } finally { BOT_POLL.fromMonitor = false; }
  if (BOT_POLL.timer) {
    clearInterval(BOT_POLL.timer);
    BOT_POLL.timer = setInterval(pollBotState, 15000);
  }
}

function renderBotState(d) {
  if (!d) return;
  if (d.ad_number) BOT.adNumber = d.ad_number;
  if (d.status) botSetStatus(d.status, d.status.indexOf('Error') === 0 || d.status.indexOf('Detenido:') === 0 ? '#E24B4A' : '#1D9E75');
  if (d.current_price != null) {
    var p = parseFloat(d.current_price);
    BOT.currentPrice = p;
    document.getElementById('bot-cur-price').textContent = p.toFixed(3) + ' Bs';
    updateBotPriceColor();
    updateTopbarBotPrice(p);
  }
  if (d.ad_amount != null) {
    BOT.adAmount = parseFloat(d.ad_amount);
    var qEl = document.getElementById('bot-qty');
    if (qEl) qEl.textContent = fmt(BOT.adAmount) + ' USDT';
  }
  if (d.ad_hidden != null) renderAdHidden(d.ad_hidden === true);
  if (d.ad_min_limit != null) {
    var lim = parseFloat(d.ad_min_limit);
    if (lim > 0) BOT.myMinLimit = lim;
  }
  // El bot acaba de cerrar un ciclo tocando el anuncio (precio o limite minimo). El
  // libro en pantalla es de ANTES de ese cambio, asi que no muestra la posicion real:
  // repintar ya con lo que sabemos y pedir datos frescos para ver el cambio en cuanto
  // ocurre, sin esperar al refresco normal del monitor. La firma junta las dos cosas
  // que mueve el bot; en la primera lectura solo se anota (no hay nada que refrescar).
  var firma = String(d.last_reprice || '') + '|' + String(d.ad_min_limit != null ? d.ad_min_limit : '');
  if (BOT_POLL.lastCycle == null) {
    BOT_POLL.lastCycle = firma;
  } else if (firma !== BOT_POLL.lastCycle) {
    BOT_POLL.lastCycle = firma;
    syncMonitorWithBot();
    // Si el estado vino pegado a la respuesta del monitor, el libro que se esta
    // procesando en esta misma llamada se pidio junto con el: ya es posterior al
    // cambio del bot, no hace falta otra vuelta a la red.
    if (ST.running && !BOT_POLL.fromMonitor) fetchOnce();
  }
  updateBotPnl();
  // Pintar entradas nuevas del log del servidor
  if (Array.isArray(d.log)) {
    d.log.forEach(function(e){
      if (e && e.ts > BOT_POLL.lastLogTs) {
        botLog(e.msg, BOT_LOG_COLORS[e.level] || '#8b949e');
        // Solo errores a Telegram. Los reprices (up/down) son demasiado frecuentes (spam).
        if (TGLINK.linked && e.level === 'error') sendTelegram('🤖 ' + e.msg);
      }
    });
    var maxTs = d.log.reduce(function(m, e){ return e && e.ts > m ? e.ts : m; }, BOT_POLL.lastLogTs);
    BOT_POLL.lastLogTs = maxTs;
  }
  // Si el servidor se auto-apagó (fondos bajos), reflejarlo en la UI
  // (durante el arranque el servidor aun no esta encendido: no es un auto-apagado)
  if (d.enabled === false && BOT.running && !botStarting()) {
    BOT.running = false;
    stopBotPoller();
    renderBotToggle();
  }
  // Salud del bot: ultimo tick / reprice + watchdog de bot congelado. Si el
  // scheduler (DO/Vercel) muere, el anuncio queda publicado a precio viejo: avisar.
  var health = document.getElementById('bot-health');
  if (health) health.style.display = BOT.running ? 'flex' : 'none';
  if (BOT.running) {
    var nowH = Date.now();
    var tickMs = d.last_tick ? nowH - new Date(d.last_tick).getTime() : null;
    var repMs  = d.last_reprice ? nowH - new Date(d.last_reprice).getTime() : null;
    var bt = document.getElementById('bh-tick'), br = document.getElementById('bh-reprice');
    if (bt) { bt.textContent = 'Tick: ' + (tickMs != null ? 'hace ' + agoStr(tickMs) : '—'); bt.style.color = (tickMs != null && tickMs > 120000) ? 'var(--red)' : ''; }
    if (br) br.textContent = 'Reprice: ' + (repMs != null ? 'hace ' + agoStr(repMs) : '—');
    if (d.enabled !== false && tickMs != null && tickMs > 120000) {
      botSetStatus('⚠ Sin tick del servidor hace ' + agoStr(tickMs), '#E24B4A');
      if (nowH - (BOT.staleNotifTs || 0) > 10 * 60000) {
        BOT.staleNotifTs = nowH;
        botLog('⚠ Bot congelado: el servidor no repricia hace ' + agoStr(tickMs) + ' — revisa el scheduler', '#E24B4A');
        sendTelegram('⚠ <b>Bot congelado</b>: sin tick hace ' + agoStr(tickMs) + '. Tu anuncio puede estar a precio viejo.');
      }
    } else if (BOT.staleNotifTs && tickMs != null && tickMs < 60000) {
      BOT.staleNotifTs = 0;
      botLog('✓ Tick del servidor recuperado', '#1D9E75');
      sendTelegram('✓ Bot recuperado: el servidor volvió a repriciar.');
    }
  }
}

function agoStr(ms) {
  var s = Math.round(ms / 1000);
  if (s < 90) return s + 's';
  var m = Math.round(s / 60);
  if (m < 90) return m + ' min';
  return Math.round(m / 60) + ' h';
}

// Al cargar: si el bot quedó encendido en el servidor, reflejar estado + reanudar poller.
async function hydrateBotState() {
  if (!SESSION.token) return;
  try {
    var d = await botCallWorker('/bot-state');
    if (d && d.enabled) {
      BOT.running = true;
      renderBotToggle();
      document.getElementById('bot-live').style.display = 'grid';
      BOT_POLL.lastLogTs = Array.isArray(d.log) ? d.log.reduce(function(m,e){ return e&&e.ts>m?e.ts:m; }, 0) : 0;
      renderBotState(d);
      startBotPoller();
      startActivityWatcher();
      // Notificaciones de ordenes nuevas: server-side (24/7).
    }
  } catch(e) {}
}

// ── Telegram ──────────────────────────────────────────
// ── Bot de Telegram compartido (vinculacion por deep link) ─────
// El usuario no ve ningun token ni tiene que buscar su chat ID: toca Conectar,
// Telegram abre el chat con el bot y al pulsar Iniciar el webhook guarda su chat.
var TGLINK = { linked: false, available: false };

async function tgRefreshLink() {
  var st = document.getElementById('tg-link-state');
  var btn = document.getElementById('tg-link-btn');
  var block = document.getElementById('tg-link-block');
  if (!block) return;
  try {
    var d = await apiPost('/api/telegram/status', {}, true);
    TGLINK = d;
  } catch (e) {
    TGLINK = { linked: false, available: false };
  }
  renderOnboard();
  if (!TGLINK.available) { block.style.display = 'none'; return; }
  block.style.display = '';
  var testBtn = document.getElementById('tg-test-btn');
  if (TGLINK.linked) {
    if (st) st.textContent = '✓ Telegram conectado';
    if (btn) { btn.textContent = 'Desconectar'; btn.onclick = tgDisconnect; }
    if (testBtn) testBtn.style.display = '';
  } else {
    if (st) st.textContent = 'Recibe las alertas en Telegram, sin configurar nada.';
    if (btn) { btn.textContent = 'Conectar Telegram'; btn.onclick = tgConnect; }
    if (testBtn) testBtn.style.display = 'none';
  }
}

async function tgConnect() {
  var btn = document.getElementById('tg-link-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Abriendo…'; }
  try {
    var d = await apiPost('/api/telegram/link', {}, true);
    window.open(d.url, '_blank', 'noopener');
    var st = document.getElementById('tg-link-state');
    if (st) st.textContent = 'Pulsa "Iniciar" en Telegram y vuelve aquí.';
    if (btn) { btn.disabled = false; btn.textContent = 'Esperando…'; }
    // El vinculo lo confirma el webhook, no esta pestania: se consulta un rato.
    // tgRefreshLink repinta el bloque, asi que solo se llama cuando ya hay novedad
    // (si no, borraria el "Pulsa Iniciar" en la primera vuelta).
    var tries = 0;
    var t = setInterval(async function () {
      tries++;
      try {
        var d = await apiPost('/api/telegram/status', {}, true);
        if (d.linked) { clearInterval(t); TGLINK = d; tgRefreshLink(); return; }
      } catch (e) {}
      if (tries > 20) { clearInterval(t); tgRefreshLink(); }
    }, 3000);
  } catch (e) {
    alert('Error: ' + e.message);
    if (btn) btn.disabled = false;
    tgRefreshLink();
  }
}

async function tgTest() {
  var btn = document.getElementById('tg-test-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    await apiPost('/api/telegram/notify', { text: '🔔 <b>Prueba</b>\nSi ves esto, tus alertas de P2P Monitor llegan bien.' }, true);
    if (btn) btn.textContent = '✓ Enviado';
  } catch (e) {
    alert('Error: ' + e.message);
    if (btn) btn.textContent = 'Enviar alerta de prueba';
  } finally {
    if (btn) {
      btn.disabled = false;
      setTimeout(function () { if (btn) btn.textContent = 'Enviar alerta de prueba'; }, 2500);
    }
  }
}

async function tgDisconnect() {
  if (!window.confirm('¿Dejar de recibir alertas en Telegram?')) return;
  try {
    await apiPost('/api/telegram/unlink', {}, true);
  } catch (e) {
    alert('Error: ' + e.message);
  }
  tgRefreshLink();
}

async function sendTelegram(msg) {
  // El token del bot compartido NUNCA baja al navegador: el envio lo hace el servidor
  // contra el chat vinculado de este usuario.
  if (!TGLINK.linked || !SESSION.token) return;
  try { await apiPost('/api/telegram/notify', { text: msg }, true); } catch (e) {}
}

// ── Monitor 24/7 (server-side) ────────────────────────
var MON24 = { enabled: false, lastHb: 0, lastHist: 0, lastLogTs: 0 };

// Superficie de errores del monitor server-side: el peor fallo silencioso es
// "Telegram rechazo el envio" / "API fallo" — el server lo registra pero no puede
// avisarte por Telegram si Telegram es lo que falla. Lo mostramos en mon24-status.
// Reusa el poll de /monitor-state (sin requests extra). Primer poll: sembrar sin avisar.
function surfaceMonitorErrors(d) {
  if (!d || !Array.isArray(d.log)) return;
  var newest = 0, lastErr = null;
  d.log.forEach(function(e) {
    if (!e || !e.ts) return;
    if (e.ts > newest) newest = e.ts;
    if (e.ts > MON24.lastLogTs && (e.level === 'error' || e.level === 'warn')) lastErr = e;
  });
  if (MON24.lastLogTs === 0) { MON24.lastLogTs = newest; return; }
  var st = document.getElementById('mon24-status');
  if (lastErr && st) { st.textContent = '⚠ Monitor: ' + lastErr.msg; st.style.color = 'var(--red)'; }
  else if (st && st.style.color) { st.style.color = ''; renderMon24(d.status); } // se resolvio: volver a normal
  MON24.lastLogTs = Math.max(MON24.lastLogTs, newest);
}

// ── Sparkline 24h (mejor mayorista) ───────────────────
// Anuncios CREIBLES: con disponibilidad real (>=2000 USDT, mayorista real). Las listas
// vienen ordenadas desc por precio, asi que el primero que supera el umbral es el mejor.
// Evita que un listing fantasma se registre como pico en el grafico o dispare alertas.
var MIN_AVAIL = 2000;
// Margen dentro del cual otro anuncio "confirma" un precio (mismo criterio que el
// server, ver api/_lib/monitor.js). Un unico anuncio muy por encima del resto es un
// dedazo, no el mercado: metia picos irreales en el grafico y falsas alertas.
var CORROB_PCT = 1;
// Mejor precio creible CONFIRMADO por otro anuncio a menos de CORROB_PCT. Ordena por
// precio: la lista puede venir en orden nativo de Binance si el filtro de monto esta en 0.
function credibleBest(a) {
  var list = [];
  for (var i = 0; i < (a || []).length; i++) if (a[i].avail >= MIN_AVAIL) list.push(a[i]);
  list.sort(function(x, y) { return y.price - x.price; });
  if (list.length < 2) return list[0] || null;
  for (var j = 0; j < list.length - 1; j++) {
    if ((list[j].price - list[j + 1].price) / list[j].price * 100 <= CORROB_PCT) return list[j];
  }
  return list[1]; // ninguno confirmado: el primero es el menos fiable
}
// Reacomoda el DOM segun el modo: mueve el ob-side de Verde entre la Sección
// Compra (Short ON, su lugar de siempre) y el ob-grid de arriba (Short OFF, en
// el puesto de Mayoristas), oculta Recompra y la Sección Compra restante, y
// ajusta el hero. appendChild/insertBefore sobre un nodo existente lo MUEVE
// (conserva ids/listeners): no hace falta duplicar markup.
function applyMarketMode() {
  var off = isShortOff();
  var grid   = document.getElementById('ob-grid');
  var mayS   = document.getElementById('ob-side-may');
  var smallS = document.getElementById('ob-side-small');
  var buyS   = document.getElementById('ob-side-buy');
  var buyWrap     = document.getElementById('buy-ob-wrap');
  var buysecOuter = document.getElementById('buysec-outer');
  if (grid && mayS && smallS && buyS && buyWrap && buysecOuter) {
    if (off) {
      if (buyS.parentNode !== grid) grid.insertBefore(buyS, mayS);
      smallS.style.display = 'none';
      buysecOuter.style.display = 'none';
    } else {
      if (buyS.parentNode !== buyWrap) buyWrap.appendChild(buyS);
      smallS.style.display = '';
      buysecOuter.style.display = '';
    }
  }
  var note = document.getElementById('sh-mode-note');
  if (note) note.textContent = off ? ' · Verde vs Mayorista' : '';
  var metrics = document.getElementById('hero-metrics');
  if (metrics) metrics.classList.toggle('hm-3', off);
  var hmRange = document.getElementById('hm-range');
  if (hmRange) hmRange.style.display = off ? 'none' : '';
}

function credibleMay()   { return credibleBest(ST.mayoristas); }
function credibleSmall() { return credibleBest(ST.smallAds); }
function credibleBuy()   { return credibleBest(ST.buyAds); }
function bestCredibleMay() { var m = credibleMay(); return m ? m.price : null; }
function bestCredibleBuy() { var m = credibleBuy(); return m ? m.price : null; }

// ── Modo Short: que par de tablas manda en el hero, las alertas y el momentum ──
// ON (por defecto, CFG.shortMode !== false): Mayoristas vs Recompra, igual que siempre.
// OFF: Verde vs Mayoristas — Recompra no se muestra ni se pide en ese modo.
function isShortOff() { return CFG.shortMode === false; }
function marketPrimary()      { return isShortOff() ? credibleBuy()      : credibleMay(); }
function marketSecondary()    { return isShortOff() ? credibleMay()      : credibleSmall(); }
function marketPrimaryPrice() { return isShortOff() ? bestCredibleBuy()  : bestCredibleMay(); }
function marketLabels() {
  return isShortOff() ? { primary: 'Verde', secondary: 'Mayorista' } : { primary: 'Mayorista', secondary: 'Compra' };
}

// ── Tabs Mercado/Bot (solo movil) ─────────────────────────────────────
var TABS = ['mercado', 'bot'];

// dir: 'l' (la nueva entra desde la derecha) o 'r'. Sin dir no se anima — asi el
// arranque de la app no pega un deslizamiento de la nada.
function showTab(name, dir) {
  if (TABS.indexOf(name) < 0) name = 'mercado';
  for (var i = 0; i < TABS.length; i++) {
    var on = TABS[i] === name;
    var btn = document.getElementById('tab-' + TABS[i]);
    var col = document.getElementById('col-' + TABS[i]);
    if (btn) btn.classList.toggle('is-on', on);
    if (!col) continue;
    col.classList.remove('slide-l', 'slide-r');
    col.classList.toggle('is-on', on);
    if (on && dir) {
      // Reflow forzado: sin esto, re-agregar la clase en el mismo frame no
      // reinicia la animacion y un swipe rapido de ida y vuelta no se ve.
      void col.offsetWidth;
      col.classList.add(dir === 'l' ? 'slide-l' : 'slide-r');
    }
  }
  try { localStorage.setItem('p2p-tab', name); } catch (e) {}
}

function initTabs() {
  var saved = 'mercado';
  try { saved = localStorage.getItem('p2p-tab') || 'mercado'; } catch (e) {}
  showTab(saved);
  initTabSwipe();
}

// Swipe horizontal para cambiar de tab en movil. Solo cuenta un gesto claramente
// horizontal (mas ancho que alto) y de recorrido suficiente: si no, cualquier
// scroll vertical de las tablas cambiaria de pestania sin querer.
var SWIPE_MIN_X = 60;   // px de recorrido minimo
var SWIPE_MAX_Y = 45;   // desvio vertical tolerado
function initTabSwipe() {
  var layout = document.querySelector('.layout');
  if (!layout || layout._swipeOn) return;
  layout._swipeOn = true;
  var x0 = 0, y0 = 0, tracking = false;

  layout.addEventListener('touchstart', function (e) {
    // Las tabs no existen en escritorio (CSS: .tabs{display:none}); sin esto el
    // gesto tambien aplicaria en pantallas anchas donde ambas columnas se ven.
    var tabs = document.getElementById('main-tabs');
    if (!tabs || !tabs.offsetParent) { tracking = false; return; }
    if (e.touches.length !== 1) { tracking = false; return; }
    // No robar el gesto a lo que se desplaza solo en horizontal (tablas anchas).
    if (e.target.closest && e.target.closest('.hx-wrap, canvas, input, select, textarea')) { tracking = false; return; }
    tracking = true;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });

  layout.addEventListener('touchend', function (e) {
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    var dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dy) > SWIPE_MAX_Y || Math.abs(dx) <= Math.abs(dy)) return;
    var cur = TABS.indexOf(currentTab());
    if (cur < 0) return;
    var next = dx < 0 ? cur + 1 : cur - 1; // arrastrar a la izquierda = avanzar
    if (next < 0 || next >= TABS.length) return;
    showTab(TABS[next], dx < 0 ? 'l' : 'r');
  }, { passive: true });
}

function currentTab() {
  for (var i = 0; i < TABS.length; i++) {
    var col = document.getElementById('col-' + TABS[i]);
    if (col && col.classList.contains('is-on')) return TABS[i];
  }
  return 'mercado';
}

// Punto verde en la tab del Bot: ver que sigue corriendo sin cambiar de pestaña.
function renderTabDot() {
  var d = document.getElementById('tab-bot-dot');
  if (d) d.classList.toggle('on', !!BOT.running);
}

// ── Motor de decision de venta (decision-engine.js + decision-journal.js) ──
// Responde "¿vendo ahora?" con el libro vivo: spread neto, liquidez arriba/abajo,
// absorcion del top5, concentracion, momentum y probabilidad de reversion.
// Solo lee ST (ya descargado): no agrega ni una request.
var DEC = { hist: [], last: null, lastLabel: null };

function decisionBuyLimit() {
  // El monto con el que se filtran los anuncios de recompra: define que ofertas
  // son alcanzables de verdad para el tamano con el que opera.
  return CFG.smallAmount > 0 ? CFG.smallAmount : 0;
}

function updateDecision() {
  if (typeof DE === 'undefined') return;
  try {
    DE.pushSnapshot(DEC.hist, ST); // muta el ring buffer y devuelve el snapshot, no la historia
    var F = DE.computeFeatures(ST, DEC.hist, decisionBuyLimit());
    var S = (F && !F.degraded) ? DE.score(F) : { raw: 0, parts: {}, vetoes: [] };
    var d = DE.decide(F, S);
    DEC.last = { d: d, F: F };
    renderDecision(d, F);
    renderVolumeBadges(F);
    // Al diario solo van los cambios de veredicto: con un tick cada 30s, guardar
    // todo llenaria IndexedDB de filas identicas y ensuciaria el backtest.
    if (typeof DJ !== 'undefined' && d.label !== DEC.lastLabel) {
      DEC.lastLabel = d.label;
      DJ.recordDecision(d, F);
    }
  } catch (e) { console.error('[updateDecision]', e); }
}

// Puente diario ↔ ordenes: cada ciclo venta→recompra de Binance se empareja con
// el veredicto que estaba vigente al vender, y se cierra en el diario con su
// resultado real. Sin botones: si la orden existe, el veredicto queda calificado.
var DEC_MATCH_MS = 15 * 60 * 1000; // veredicto valido hasta 15 min antes de vender

function lastDecisionBefore(decs, ts) {
  // decs viene de listDecisions: mas nuevo primero.
  for (var i = 0; i < decs.length; i++) {
    if (decs[i].ts <= ts && ts - decs[i].ts <= DEC_MATCH_MS) return decs[i];
  }
  return null;
}

async function syncJournalFromOrders() {
  if (typeof DJ === 'undefined' || !SESSION.token) return null;
  try {
    var d = await botCallWorker('/sell-cycles');
    var cycles = d.cycles || [];
    if (!cycles.length) return null;
    var trades = await DJ.listTrades(300);
    var seen = {};
    for (var i = 0; i < trades.length; i++) if (trades[i].src) seen[trades[i].src] = 1;
    var decs = await DJ.listDecisions(500);
    var imported = 0, noVerdict = 0;
    for (var j = 0; j < cycles.length; j++) {
      var c = cycles[j];
      // Una venta recomprada en varias compras parciales genera varios ciclos con
      // el mismo sellId (uno por cada compra que la fue llenando): identificar el
      // ciclo solo por sellId perdia todos menos el primero. sellId+buyId es unico
      // por ciclo porque fifoShort empareja cada par venta-compra una sola vez.
      var srcKey = c.sellId + '_' + c.buyId;
      if (!c.sellId || !c.buyId || seen[srcKey] || c.sellAt == null) continue;
      var dec = lastDecisionBefore(decs, c.sellAt);
      // Sin veredicto grabado no hay nada que calificar: el motor solo corre con
      // la app abierta, asi que las ventas a ciegas quedan fuera a proposito.
      if (!dec) { noVerdict++; continue; }
      var id = await DJ.createTrade({ score: dec.score, label: dec.label }, dec.features, c.qty, c.sellPrice);
      if (id == null) continue;
      // No se usa recordRebuy: calcula los minutos contra Date.now() y aqui los
      // tiempos son historicos. Se escribe el desenlace con las fechas reales.
      var success = c.netPct >= DJ.SUCCESS_NET ? 'win' : (c.netPct >= 0 ? 'neutral' : 'loss');
      await DJ.updateTrade(id, {
        ts: c.sellAt, src: srcKey, status: 'closed',
        rebuy: {
          price: c.buyPrice, ts: c.buyAt,
          minutesElapsed: c.minutes != null ? Math.round(c.minutes * 10) / 10 : null,
          grossPct: c.grossPct, netPct: c.netPct, success: success
        }
      });
      imported++;
    }
    return { imported: imported, noVerdict: noVerdict, cycles: cycles.length };
  } catch (e) { return null; }
}

// Resultado historico de los veredictos: sale bajo el panel de decision.
async function renderJournalStats() {
  var el = document.getElementById('decision-stats');
  if (!el || typeof DJ === 'undefined') return;
  try {
    var s = await DJ.stats();
    // Con 1-2 ciclos el % de acierto es puro ruido (100% con una sola venta no dice
    // nada) y confunde mas de lo que ayuda. Se pide una muestra minima para mostrarlo.
    if (!s || s.n < 5) { el.innerHTML = ''; return; }
    var wr = s.winRate != null ? Math.round(s.winRate * 100) : null;
    el.innerHTML = '<div class="dec-feat" style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<span>' + s.n + (s.n === 1 ? ' ciclo calificado' : ' ciclos calificados') + '</span>' +
      (wr != null ? '<span style="color:' + (wr >= 50 ? 'var(--green)' : 'var(--red)') + '">' + wr + '% acierto</span>' : '') +
      '<span>neto medio ' + (s.avgNetPct * 100).toFixed(2) + '%</span>' +
      '<span>recompra ' + s.avgMinutesToRebuy.toFixed(0) + ' min</span>' +
      (s.suggestions.length ? '<span style="color:var(--gold)">' + s.suggestions.length + ' ajustes de peso sugeridos</span>' : '') +
      '</div>';
  } catch (e) { el.innerHTML = ''; }
}

var DEC_COLORS = {
  'green-strong': 'var(--green)', green: 'var(--green)',
  amber: 'var(--gold)', red: 'var(--red)', gray: 'var(--text-3)'
};

// Los label del motor son identificadores internos (decide() los compara y el
// diario los guarda): se traducen al pintar, no en el motor.
var DEC_LABELS = {
  'STRONG SELL':  'VENDER YA',
  'SELL':         'VENDER',
  'PARTIAL SELL': 'VENDER PARCIAL',
  'WAIT':         'ESPERAR',
  'DO NOT SELL':  'NO VENDER',
  'HIGH RISK':    'RIESGO ALTO'
};

// Que mostrar mientras no hay veredicto. El panel vive en la pestaña Bot pero lo
// alimenta el MONITOR de mercado (el ▶ de la barra), no el bot: con el bot
// corriendo y el monitor parado el mensaje viejo ("Inicia el monitor") parecia que
// el panel estuviera roto. Ahora dice cual de los dos falta y trae el boton.
function renderDecisionIdle() {
  var el = document.getElementById('decision-panel');
  if (!el || DEC.last) return; // ya hay veredicto: no lo pises
  el.innerHTML = ST.running
    ? '<span class="dec-idle">Analizando el libro…</span>'
    : '<span class="dec-idle">Necesita el monitor de mercado encendido.</span>' +
      '<button class="btn btn-sm" type="button" onclick="toggleMonitor()" style="margin-top:8px">▶ Iniciar monitor</button>';
}

function renderDecision(d, F) {
  var el = document.getElementById('decision-panel');
  if (!el || !d) return;
  var col = DEC_COLORS[d.color] || 'var(--text-3)';
  var html = '<div class="dec-top">' +
    '<span class="dec-label" style="color:' + col + ';border-color:' + col + '">' + (DEC_LABELS[d.label] || d.label) + '</span>' +
    (d.score != null ? '<span class="dec-score">' + d.score + '<small>/100</small></span>' : '') +
    (d.rebuy ? '<span class="dec-rebuy">recompra en ' + d.rebuy.min + '–' + d.rebuy.max + ' min</span>' : '') +
    '</div>';
  var li = '';
  for (var i = 0; i < d.reasons.pos.length; i++) li += '<li class="dec-pos">' + d.reasons.pos[i] + '</li>';
  for (var j = 0; j < d.reasons.neg.length; j++) li += '<li class="dec-neg">' + d.reasons.neg[j] + '</li>';
  for (var k = 0; k < (d.conflicts || []).length; k++) li += '<li class="dec-conf">⚠ ' + d.conflicts[k] + '</li>';
  if (li) html += '<ul class="dec-why">' + li + '</ul>';
  if (F && !F.degraded) {
    html += '<div class="dec-feat">' +
      'spread ' + (F.spreadNet * 100).toFixed(2) + '% · ' +
      'absorción ' + (F.absRate3m * 100).toFixed(0) + '% · ' +
      'drenaje recompra ' + (F.buyAbsRate3m * 100).toFixed(0) + '% · ' +
      'liquidez para vender ' + intFmt(F.LA) + ' / para recomprar ' + intFmt(F.LB) +
      '</div>';
  }
  el.innerHTML = html;
}

// Badge junto al titulo de Mayoristas/Recompra: cuanto del top 5 se vacio o se
// repuso en los ultimos 3 min. Mismo dato que ya usa el motor (absRate3m /
// buyAbsRate3m), solo que en vivo junto al libro. Oculto si no hay nada llamativo
// que decir (poco movimiento) para no ensuciar el header.
function volBadge(rate, replenish) {
  if (rate == null) return '';
  var absorbed = rate >= replenish;
  var pct = Math.round((absorbed ? rate : replenish) * 100);
  if (pct < 15) return '';
  var cls = pct >= 30 ? 'vol-hot' : 'vol-warm';
  return '<span class="lbl-vol ' + cls + '">' + (absorbed ? '▼' : '▲') + pct + '%</span>';
}
function renderVolumeBadges(F) {
  var may = document.getElementById('vol-may');
  var small = document.getElementById('vol-small');
  if (may)   may.innerHTML   = (F && !F.degraded) ? volBadge(F.absRate3m, F.replenishRate) : '';
  if (small) small.innerHTML = (F && !F.degraded) ? volBadge(F.buyAbsRate3m, F.buyReplenishRate) : '';
}

// ── Grabador de mercado BDV (Paso 1 del indice de debilidad) ──────────
// Snapshot de los ingredientes crudos (precios, profundidad, spread neto) cada ~30s,
// en lote cada ~2 min a Supabase. Solo BDV y con el monitor corriendo. Cero costo real.
var MKT = { buf: [], lastSample: 0, lastFlush: 0 };
function r3(x) { return (x == null) ? null : Math.round(x * 1000) / 1000; }
function sumAvail5(arr) { var s = 0; for (var i = 0; i < Math.min(5, arr.length); i++) s += (arr[i].avail || 0); return s; }
function buildMarketSnapshot() {
  if (ACTIVE_PAY !== 'BancoDeVenezuela') return null;
  var cMay = credibleMay(); if (!cMay) return null;
  var cSmall = credibleSmall();
  var may = ST.mayoristas || [], rec = ST.smallAds || [], verde = ST.buyAds || [];
  var mayBest = cMay.price;
  var recBest = cSmall ? cSmall.price : (rec[0] ? rec[0].price : null);
  var verdeBest = verde[0] ? verde[0].price : null;
  var c = (CFG.commission || 0) / 100;
  var spreadNet = (recBest != null) ? ((mayBest - recBest) / mayBest * 100) - (CFG.commission || 0) : null;
  var verdeEff = (verdeBest != null) ? verdeBest * (1 - c) : null;
  return {
    ts: Date.now(),
    mb: r3(mayBest), ma: Math.round(sumAvail5(may)),
    mt: may.slice(0, 5).map(function (a) { return { p: r3(a.price), a: Math.round(a.avail || 0), n: a.merchant }; }),
    rb: r3(recBest), ra: Math.round(sumAvail5(rec)),
    vb: r3(verdeBest), ve: r3(verdeEff),
    sn: r3(spreadNet), c: CFG.commission || 0
  };
}
function recordMarketSnapshot() {
  try {
    if (!ST.running) return;
    var now = Date.now();
    if (now - MKT.lastSample >= 28000) {
      var snap = buildMarketSnapshot();
      if (snap) { MKT.buf.push(snap); MKT.lastSample = now; }
    }
    if (MKT.buf.length && (now - MKT.lastFlush > 120000 || MKT.buf.length >= 20)) flushMarketSnapshots();
  } catch (e) {}
}
function flushMarketSnapshots() {
  if (!MKT.buf.length || !SESSION.token) return;
  var batch = MKT.buf; MKT.buf = []; MKT.lastFlush = Date.now();
  botCallWorker('/market-snapshot', { rows: batch }).catch(function () {}); // lote perdido no es critico
}
// Mediana del top-10 creible (misma criba que el server: avail >= MIN_AVAIL).
// Va en el heartbeat para que p2p_rate siga fresca con la app abierta.
function medianCredibleMay() {
  var prices = [];
  var a = ST.mayoristas || [];
  for (var i = 0; i < a.length; i++) if (a[i].avail >= MIN_AVAIL) prices.push(a[i].price);
  prices.sort(function(x, y) { return y - x; });
  prices = prices.slice(0, 10).sort(function(x, y) { return x - y; });
  if (!prices.length) return { rate: 0, n: 0 };
  var m = prices.length >> 1;
  return { rate: prices.length % 2 ? prices[m] : (prices[m - 1] + prices[m]) / 2, n: prices.length };
}

// HIST24 = series del servidor por metodo de pago { pay: [{ts,price}] }; se completa
// con los puntos vivos del cliente. Formato legado (array plano) = serie de BDV.
var HIST24 = {};
var LEGACY_PAY = 'BancoDeVenezuela';
function histByPay(h, pay) {
  if (Array.isArray(h)) return pay === LEGACY_PAY ? h : [];
  return (h && h[pay]) || [];
}

// Cache local de la serie de 24h. Al abrir la app HIST24 esta vacio hasta que
// contesta /monitor-state, y el sparkline se dibujaba con los dos o tres puntos
// que llevaba el cliente: una raya plana durante unos segundos en cada recarga.
// Con esto arranca pintando lo ultimo que se sabia y el servidor lo reemplaza.
var HIST24_KEY = 'p2p_hist24';
function saveHist24() {
  try {
    var cut = Date.now() - 24 * 3600 * 1000;
    var out = {};
    for (var pay in HIST24) {
      var serie = histByPay(HIST24, pay).filter(function(p) { return p && p.ts >= cut; });
      if (serie.length) out[pay] = serie;
    }
    localStorage.setItem(HIST24_KEY, JSON.stringify(out));
  } catch (e) {} // cuota llena: el cache es un lujo, no rompe nada
}
function loadHist24() {
  try {
    var raw = localStorage.getItem(HIST24_KEY);
    if (!raw) return;
    var cached = JSON.parse(raw) || {};
    var cut = Date.now() - 24 * 3600 * 1000;
    var any = false;
    for (var pay in cached) {
      var serie = (cached[pay] || []).filter(function(p) { return p && p.ts >= cut && p.price; });
      if (serie.length) { HIST24[pay] = serie; any = true; }
    }
    if (any) renderSparkline();
  } catch (e) {}
}
function sparkSeries() {
  var s = histByPay(HIST24, ACTIVE_PAY).slice();
  var lastTs = s.length ? s[s.length - 1].ts : 0;
  for (var i = 0; i < ST.priceHist.length; i++) {
    if (ST.priceHist[i].ts > lastTs) s.push(ST.priceHist[i]);
  }
  return s.filter(function(p) { return p && p.price; });
}
function renderSparkline() {
  var wrap = document.getElementById('spark-wrap');
  var svg  = document.getElementById('spark');
  if (!wrap || !svg) return;
  var pts = sparkSeries();
  // Dos puntos separados por segundos dan una raya plana que no dice nada y parece
  // un grafico roto. Sin al menos 10 minutos de recorrido, mejor no mostrar nada
  // hasta que llegue la serie del servidor (o la del cache).
  if (pts.length < 2 || (pts[pts.length - 1].ts - pts[0].ts) < 10 * 60000) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  // viewBox 1:1 con el ancho real → sin distorsion (la barra es full-width).
  var H = 96, padX = 2, padT = 4, padB = 4;
  var W = Math.max(120, Math.round(svg.clientWidth || 600));
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var t0 = pts[0].ts, dt = (pts[pts.length - 1].ts - t0) || 1;
  var min = pts[0], max = pts[0];
  for (var i = 0; i < pts.length; i++) { if (pts[i].price < min.price) min = pts[i]; if (pts[i].price > max.price) max = pts[i]; }
  // Holgura vertical para que picos/valles no queden pegados al borde.
  var span = (max.price - min.price) || 1, lo = min.price - span * 0.03, hi = max.price + span * 0.03, dp = hi - lo;
  function X(ts) { return padX + (ts - t0) / dt * (W - 2 * padX); }
  function Y(p)  { return padT + (1 - (p - lo) / dp) * (H - padT - padB); }
  var line = '';
  for (var j = 0; j < pts.length; j++) line += (j ? 'L' : 'M') + X(pts[j].ts).toFixed(1) + ' ' + Y(pts[j].price).toFixed(1) + ' ';
  var x0 = X(pts[0].ts), xL = X(pts[pts.length - 1].ts), yBase = H - padB;
  var area = 'M' + x0.toFixed(1) + ' ' + yBase + ' ' + line.substring(1) + 'L' + xL.toFixed(1) + ' ' + yBase + ' Z';
  var open = pts[0].price, close = pts[pts.length - 1].price, chg = (close - open) / open * 100;
  var up = close >= open, col = up ? '#2ebd85' : '#f6465d';
  svg.innerHTML =
    '<defs><linearGradient id="spg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + col + '" stop-opacity="0.26"/>' +
      '<stop offset="100%" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>' +
    '<line x1="' + padX + '" y1="' + Y(open).toFixed(1) + '" x2="' + (W - padX) + '" y2="' + Y(open).toFixed(1) +
      '" stroke="#3a3f4b" stroke-width="1" stroke-dasharray="3 4"/>' +
    '<path d="' + area + '" fill="url(#spg)"/>' +
    '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + X(max.ts).toFixed(1) + '" cy="' + Y(max.price).toFixed(1) + '" r="2.4" fill="#2ebd85"/>' +
    '<circle cx="' + X(min.ts).toFixed(1) + '" cy="' + Y(min.price).toFixed(1) + '" r="2.4" fill="#f6465d"/>' +
    '<circle cx="' + xL.toFixed(1) + '" cy="' + Y(close).toFixed(1) + '" r="3" fill="' + col + '"/>';
  document.getElementById('spark-range').innerHTML =
    '<span style="color:' + col + '">' + fmt(close) + fiatSuf() + ' (' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%)</span>' +
    ' <span style="color:var(--text-3);font-weight:400">· ' + fmt(min.price) + '–' + fmt(max.price) + '</span>';
}
window.addEventListener('resize', function() { try { renderSparkline(); } catch(e) {} try { if (HX.open) hxDraw(); } catch(e) {} });

// ── Historial completo (overlay pantalla completa) ──────────────
// Modelo de la vista, estilo TradingView: el timeframe fija el tamano de vela
// (ya no lo elige el codigo solo segun el rango) y la ventana visible se guarda
// como "cuantas velas entran en pantalla" (viewCount) + "hasta que instante
// llega el borde derecho" (viewEndT). Panear mueve viewEndT; hacer zoom cambia
// viewCount; cambiar de timeframe deja los dos igual, asi que el ancla (mismo
// numero de velas, mismo borde derecho) se mantiene y el rango que cubre se
// reescala solo. Todo el historial sigue siendo el mismo array de puntos ya
// cargado — nada de esto pide datos nuevos al servidor.
var HX = { open: false, series: [], vol: [], mode: 'candles', tf: '1h', viewCount: null, viewEndT: null,
  drawMode: false, lines: [], linesRev: 0 };
try { HX.mode = localStorage.getItem('p2p_hx_mode') || 'candles'; } catch(e) {}
try { HX.tf = localStorage.getItem('p2p_hx_tf') || '1h'; } catch(e) {}
var HX_TIMEFRAMES = [
  { id: '15m', label: '15m', ms: 15 * 60000 },
  { id: '1h',  label: '1H',  ms: 3600000 },
  { id: '4h',  label: '4H',  ms: 4 * 3600000 },
  { id: '1d',  label: '1D',  ms: 24 * 3600000 },
  { id: '1w',  label: '1S',  ms: 7 * 24 * 3600000 }
];
var HX_DEFAULT_CANDLES = 90, HX_MIN_CANDLES = 8, HX_MAX_CANDLES = 500;
function hxTf() {
  for (var i = 0; i < HX_TIMEFRAMES.length; i++) if (HX_TIMEFRAMES[i].id === HX.tf) return HX_TIMEFRAMES[i];
  return HX_TIMEFRAMES[1];
}
function openHistory() {
  HX.open = true;
  HX.hoverX = null;
  var hp = document.getElementById('hx-pay');
  if (hp) hp.textContent = ' · ' + payLabel(ACTIVE_PAY);
  document.getElementById('hx-overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  // Entrada en el historial del navegador: el boton atras (movil) cierra el grafico
  // en vez de salir de la app.
  try { history.pushState({ hxOpen: true }, ''); } catch (e) {}
  hxBindPointer();
  hxRenderRanges();
  hxLoad();
}
function closeHistory(fromPop) {
  if (!HX.open) return;
  HX.open = false;
  document.getElementById('hx-overlay').style.display = 'none';
  document.body.style.overflow = '';
  // Cierre por la UI (X): retroceder para consumir el estado que empujamos.
  // Si vino del boton atras, el navegador ya lo consumio.
  if (!fromPop) { try { history.back(); } catch (e) {} }
}
window.addEventListener('popstate', function() {
  if (HX.open) closeHistory(true);
});
function hxMerge(histLong, hist24) {
  var byTs = {};
  [histLong, hist24].forEach(function(arr) {
    if (Array.isArray(arr)) arr.forEach(function(p) { if (p && p.price) byTs[p.ts] = p.price; });
  });
  return Object.keys(byTs).map(function(ts) { return { ts: +ts, price: byTs[ts] }; })
    .sort(function(a, b) { return a.ts - b.ts; });
}
function hxMsg(t) {
  var m = document.getElementById('hx-msg'), c = document.getElementById('hx-chart');
  if (t) { m.textContent = t; m.style.display = 'flex'; c.style.display = 'none'; }
  else { m.style.display = 'none'; c.style.display = ''; }
}
function hxTimeLabel(ts, spanMs) {
  var d = new Date(ts), p2 = function(n) { return (n < 10 ? '0' : '') + n; };
  if (spanMs <= 36 * 3600e3) return p2(d.getHours()) + ':' + p2(d.getMinutes());
  return p2(d.getDate()) + '/' + p2(d.getMonth() + 1);
}
// Acepta puntos {price} (modo linea) o velas {o,h,l,c} (modo velas): un solo
// lugar para pintar Actual/Cambio/Minimo/Maximo sin duplicar el calculo.
function hxStats(arr) {
  var ids = ['hx-cur', 'hx-chg', 'hx-min', 'hx-max'];
  if (!arr.length) { ids.forEach(function(i) { document.getElementById(i).textContent = '—'; }); return; }
  var isCandle = arr[0].o !== undefined;
  var open = isCandle ? arr[0].o : arr[0].price;
  var close = isCandle ? arr[arr.length - 1].c : arr[arr.length - 1].price;
  var min = isCandle ? arr[0].l : arr[0].price, max = isCandle ? arr[0].h : arr[0].price;
  arr.forEach(function(x) {
    var lo = isCandle ? x.l : x.price, hi = isCandle ? x.h : x.price;
    if (lo < min) min = lo; if (hi > max) max = hi;
  });
  var chg = open ? (close - open) / open * 100 : 0;
  document.getElementById('hx-cur').textContent = fmt(close) + fiatSuf();
  var chgEl = document.getElementById('hx-chg');
  chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
  chgEl.style.color = close >= open ? 'var(--green)' : 'var(--red)';
  document.getElementById('hx-min').textContent = fmt(min) + fiatSuf();
  document.getElementById('hx-max').textContent = fmt(max) + fiatSuf();
}
function hxBtnCss(active) {
  return 'border-radius:8px;padding:6px 13px;font-size:13px;cursor:pointer;font-weight:600;border:1px solid ' +
    (active ? 'var(--gold);background:var(--gold);color:#000' : 'var(--border);background:var(--surf-2);color:var(--text-3)');
}
function hxRenderRanges() {
  var wrap = document.getElementById('hx-ranges');
  wrap.innerHTML = '';
  HX_TIMEFRAMES.forEach(function(r) {
    var b = document.createElement('button');
    b.textContent = r.label;
    b.style.cssText = hxBtnCss(r.id === HX.tf);
    // El timeframe cambia el tamano de vela; viewCount/viewEndT NO se tocan, asi
    // que la cantidad de velas en pantalla y el borde derecho se mantienen y el
    // zoom se reescala solo (hxClampView lo acomoda si ya no calza con los datos).
    b.onclick = function() {
      HX.tf = r.id;
      try { localStorage.setItem('p2p_hx_tf', r.id); } catch(e) {}
      hxClampView(); HX.hoverX = null; hxRenderRanges(); hxDraw();
    };
    wrap.appendChild(b);
  });
  var latest = document.createElement('button');
  latest.textContent = '⏭'; latest.title = 'Ir a lo último';
  latest.style.cssText = hxBtnCss(false) + ';padding:6px 11px';
  latest.onclick = function() { hxResetView(); hxDraw(); };
  wrap.appendChild(latest);
  // Lineas rectas: boton para activar/desactivar el modo dibujo (arrastrar traza
  // una linea; tocar una linea existente sin arrastrar la borra) y otro para
  // borrarlas todas de un tiro.
  var drawBtn = document.createElement('button');
  drawBtn.textContent = '📏'; drawBtn.title = 'Dibujar línea (toca una línea para borrarla)';
  drawBtn.style.cssText = hxBtnCss(HX.drawMode) + ';padding:6px 11px';
  drawBtn.onclick = function() {
    HX.drawMode = !HX.drawMode;
    var cv = document.getElementById('hx-chart');
    if (cv) cv.style.cursor = HX.drawMode ? 'crosshair' : 'grab';
    HX.hoverX = null; hxRenderRanges(); hxDraw();
  };
  wrap.appendChild(drawBtn);
  if (HX.lines.length) {
    var clearBtn = document.createElement('button');
    clearBtn.textContent = '🗑'; clearBtn.title = 'Borrar todas las líneas';
    clearBtn.style.cssText = hxBtnCss(false) + ';padding:6px 11px';
    clearBtn.onclick = function() { HX.lines = []; HX.linesRev++; hxRenderRanges(); hxDraw(); };
    wrap.appendChild(clearBtn);
  }
  var sep = document.createElement('span');
  sep.style.cssText = 'flex:1';
  wrap.appendChild(sep);
  [['line', '📈 Línea'], ['candles', '🕯 Velas']].forEach(function(m) {
    var b = document.createElement('button');
    b.textContent = m[1];
    b.style.cssText = hxBtnCss(HX.mode === m[0]);
    b.onclick = function() {
      HX.mode = m[0];
      try { localStorage.setItem('p2p_hx_mode', m[0]); } catch(e) {}
      HX.hoverX = null; hxRenderRanges(); hxDraw();
    };
    wrap.appendChild(b);
  });
}
// Velas de TODO el historial cargado, al tamano fijo del timeframe elegido —
// derivadas al vuelo de hist24+hist_long, igual que antes; el servidor no
// precalcula velas. Se cachean: solo se recalculan si cambia el timeframe o
// llega data nueva, asi que panear/hacer zoom (que llama hxDraw en cada tick)
// no reconstruye el array completo cada vez.
function hxAllCandles() {
  if (HX.cs && HX.csTf === HX.tf && HX.csSeriesLen === HX.series.length) return HX.cs;
  var bMs = hxTf().ms, pts = HX.series, buckets = {};
  for (var i = 0; i < pts.length; i++) {
    var t = Math.floor(pts[i].ts / bMs) * bMs, p = pts[i].price;
    var b = buckets[t];
    if (!b) buckets[t] = { t: t, o: p, h: p, l: p, c: p };
    else { b.c = p; if (p > b.h) b.h = p; if (p < b.l) b.l = p; }
  }
  var cs = Object.keys(buckets).map(function(k) { return buckets[k]; }).sort(function(a, b) { return a.t - b.t; });
  HX.cs = cs; HX.csTf = HX.tf; HX.csSeriesLen = pts.length;
  return cs;
}
// Ventana visible actual, en tiempo: [viewEndT - viewCount*tf, viewEndT].
function hxViewT0() { return HX.viewEndT - HX.viewCount * hxTf().ms; }
function hxVisibleCandles() {
  var cs = hxAllCandles();
  if (HX.viewEndT == null) return cs;
  var bMs = hxTf().ms, t0 = hxViewT0(), t1 = HX.viewEndT;
  return cs.filter(function(c) { return c.t + bMs > t0 && c.t < t1; });
}
function hxVisiblePts() {
  if (HX.viewEndT == null) return HX.series;
  var t0 = hxViewT0(), t1 = HX.viewEndT;
  return HX.series.filter(function(p) { return p.ts >= t0 && p.ts <= t1; });
}
// Vista por defecto: las ultimas HX_DEFAULT_CANDLES velas del timeframe activo
// (menos si no hay tantos datos todavia).
function hxResetView() {
  var cs = hxAllCandles(), bMs = hxTf().ms;
  if (cs.length) {
    HX.viewEndT = cs[cs.length - 1].t + bMs;
    HX.viewCount = Math.min(HX_DEFAULT_CANDLES, Math.max(HX_MIN_CANDLES, cs.length));
  } else {
    HX.viewEndT = Date.now();
    HX.viewCount = HX_DEFAULT_CANDLES;
  }
}
// No dejar panear/zoomear mas alla de lo que hay: ni antes del primer dato, ni
// mostrando menos de HX_MIN_CANDLES ni mas que todo el historial disponible.
function hxClampView() {
  var cs = hxAllCandles(), bMs = hxTf().ms;
  if (HX.viewEndT == null || !cs.length) { hxResetView(); return; }
  HX.viewCount = Math.max(HX_MIN_CANDLES, Math.min(HX_MAX_CANDLES, Math.round(HX.viewCount)));
  var firstT = cs[0].t, lastEdge = cs[cs.length - 1].t + bMs;
  var totalCandles = Math.max(HX_MIN_CANDLES, Math.round((lastEdge - firstT) / bMs) + 2);
  if (HX.viewCount > totalCandles) HX.viewCount = totalCandles;
  var span = HX.viewCount * bMs;
  // Aire a la derecha del ultimo dato: la mitad de las velas en pantalla (minimo
  // 15), asi que siempre hay hueco de sobra para proyectar una linea de tendencia
  // hacia el futuro, y escala con el zoom (mas cerca = mas hueco en pantalla,
  // pero medido en velas es proporcional siempre).
  var minEndT = firstT + span, maxEndT = lastEdge + Math.max(HX.viewCount * 0.5, 15) * bMs;
  if (HX.viewEndT < minEndT) HX.viewEndT = minEndT;
  if (HX.viewEndT > maxEndT) HX.viewEndT = maxEndT;
}
// Cambia cuantas velas entran en pantalla manteniendo fijo pivotTs (el punto
// bajo el cursor, o el centro si viene de un boton +/-).
function hxZoomStep(pivotTs, factor) {
  if (HX.viewEndT == null) return;
  var bMs = hxTf().ms;
  var oldSpan = HX.viewCount * bMs, oldT0 = HX.viewEndT - oldSpan;
  var rel = oldSpan > 0 ? (pivotTs - oldT0) / oldSpan : 1;
  var newCount = Math.max(HX_MIN_CANDLES, Math.min(HX_MAX_CANDLES, Math.round(HX.viewCount * factor)));
  HX.viewCount = newCount;
  var newSpan = HX.viewCount * bMs;
  HX.viewEndT = pivotTs + (1 - rel) * newSpan;
  hxClampView();
}
// Traduce un pixel del canvas al instante que representa, usando la ultima
// escala dibujada (HX.px). Lo usan el wheel-zoom y el pinch para anclar el
// punto bajo el cursor/los dedos.
function hxPxToTs(px) {
  if (!HX.px) return Date.now();
  var clamped = Math.max(HX.px.padL, Math.min(HX.px.padL + HX.px.W, px));
  return HX.px.t0 + (clamped - HX.px.padL) / HX.px.W * HX.px.dt;
}
function hxPxToPrice(py) {
  if (!HX.px) return 0;
  var clamped = Math.max(HX.px.padT, Math.min(HX.px.padT + HX.px.H, py));
  return HX.px.lo + (1 - (clamped - HX.px.padT) / HX.px.H) * HX.px.dp;
}

// ── Lineas rectas ────────────────────────────────────
// Herramienta minima: arrastrar traza una linea blanca (en coordenadas
// tiempo/precio, asi que se mantiene en su sitio al panear o hacer zoom);
// tocar una linea existente sin arrastrar la borra. Viven solo en memoria
// (HX.lines) mientras la pagina sigue cargada, nada se manda al servidor.
function hxDistToSeg(px, py, x1, y1, x2, y2) {
  var dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  var t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  var ex = px - (x1 + t * dx), ey = py - (y1 + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}
var HX_LINE_PX = 6; // radio de tolerancia para "tocaste esta linea"
function hxLineIndexNear(px, py) {
  if (!HX.px || !HX.lines.length) return -1;
  var padL = HX.px.padL, padT = HX.px.padT, W = HX.px.W, H = HX.px.H, t0 = HX.px.t0, dt = HX.px.dt, lo = HX.px.lo, dp = HX.px.dp;
  function X(ts) { return padL + (ts - t0) / dt * W; }
  function Y(p)  { return padT + (1 - (p - lo) / dp) * H; }
  var best = -1, bestD = HX_LINE_PX;
  for (var i = 0; i < HX.lines.length; i++) {
    var l = HX.lines[i], d = hxDistToSeg(px, py, X(l.t1), Y(l.p1), X(l.t2), Y(l.p2));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
function hxRemoveLineNear(px, py) {
  var idx = hxLineIndexNear(px, py);
  if (idx < 0) return false;
  HX.lines.splice(idx, 1); HX.linesRev++;
  return true;
}
// Se dibujan como parte del frame base (mismo X/Y que usa cada modo), recortadas
// al area del grafico para que no se salgan sobre la escala de precio.
function hxDrawLines(ctx, X, Y, padL, padT, W, H) {
  if (!HX.lines.length) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT, W, H); ctx.clip();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  HX.lines.forEach(function(l) { ctx.moveTo(X(l.t1), Y(l.p1)); ctx.lineTo(X(l.t2), Y(l.p2)); });
  ctx.stroke();
  ctx.restore();
}
// Volumen absorbido agrupado en los mismos cubos que las velas. Se SUMA (no se
// promedia): es un flujo, asi que una vela de 4h vale lo operado en esas 4h,
// igual que las barras de volumen de cualquier grafico de trading.
// Devuelve { at: {t: {may, rec}}, max } — max sirve para escalar la banda.
function hxVolBuckets(bMs) {
  var at = {}, max = 0;
  var src = HX.vol || [];
  for (var i = 0; i < src.length; i++) {
    var v = src[i];
    if (!v || v.ts == null) continue;
    var t = Math.floor(v.ts / bMs) * bMs;
    var a = at[t] || (at[t] = { may: 0, rec: 0 });
    a.may += (v.may || 0); a.rec += (v.rec || 0);
    if (a.may + a.rec > max) max = a.may + a.rec;
  }
  return { at: at, max: max };
}

// Frame base en modo VELAS (grilla/ejes compartidos con el modo linea)
function hxDrawBaseCandles(cs, cssW, cssH, dpr) {
  var base = HX.base || (HX.base = document.createElement('canvas'));
  base.width = Math.round(cssW * dpr); base.height = Math.round(cssH * dpr);
  var ctx = base.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  // Escala de precio a la DERECHA (como en los graficos de trading): el ultimo precio
  // queda pegado a su eje. De ahi que padR sea el ancho y padL solo un margen.
  var padL = 14, padR = 62, padT = 14, padB = 26, W = cssW - padL - padR;
  var bMs = hxTf().ms;
  // Banda de volumen abajo (solo si hay serie): le quita alto al precio en vez de
  // superponerse, para no ensuciar la lectura de las velas.
  var vol = hxVolBuckets(bMs);
  var volH = vol.max > 0 ? Math.round((cssH - padT - padB) * 0.18) : 0;
  var H = cssH - padT - padB - volH;
  // t0/t1 son la VENTANA (pan/zoom), no el primer/ultimo dato: asi el mapeo de
  // pixeles es continuo mientras se arrastra, con velas parciales en los bordes
  // como en cualquier grafico de trading real.
  var t0 = hxViewT0(), t1 = HX.viewEndT, dt = (t1 - t0) || 1;
  // Escala Y de lo visible; si el pan cayo en un hueco sin velas, se usa el
  // rango de todo el historial para no romper la escala.
  var scaleSrc = cs.length ? cs : hxAllCandles();
  var min = scaleSrc.length ? scaleSrc[0].l : 0, max = scaleSrc.length ? scaleSrc[0].h : 1;
  scaleSrc.forEach(function(k) { if (k.l < min) min = k.l; if (k.h > max) max = k.h; });
  var span = (max - min) || 1, lo = min - span * 0.08, hi = max + span * 0.08, dp = hi - lo;
  function X(ts) { return padL + (ts - t0) / dt * W; }
  function Y(p)  { return padT + (1 - (p - lo) / dp) * H; }
  var up = cs.length ? cs[cs.length - 1].c >= cs[0].o : true;
  HX.px = { padL: padL, padR: padR, padT: padT, W: W, H: H, t0: t0, dt: dt, lo: lo, dp: dp, volH: volH, col: up ? '#2ebd85' : '#f6465d' };
  ctx.font = '11px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
  for (var i = 0; i <= 5; i++) {
    var val = lo + (hi - lo) * i / 5, y = Y(val);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.fillStyle = '#8b93a7'; ctx.textAlign = 'left'; ctx.fillText(fmt(val), padL + W + 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  // Fijo en 6 (no ligado a cuantas velas hay dato): la ventana es de tamano
  // constante en tiempo, asi que los rotulos del eje X deben repartirse parejo
  // aunque el tramo visible este parcialmente vacio (un hueco nocturno, etc).
  var ticks = 6;
  for (var k2 = 0; k2 <= ticks; k2++) {
    var ts = t0 + dt * k2 / ticks;
    ctx.fillStyle = '#8b93a7';
    ctx.fillText(hxTimeLabel(ts, dt), Math.max(padL + 14, Math.min(padL + W - 14, X(ts))), padT + H + volH + 7);
  }
  // Ancho por RANURA de tiempo, no por vela dibujada: si hay huecos (buckets sin dato)
  // cs.length es menor que las ranuras del rango y las velas salian mas anchas que su
  // propio intervalo, pisandose entre si.
  var slots = Math.max(1, Math.round(dt / bMs));
  var cw = Math.max(2, Math.min(14, (W / slots) * 0.7));
  for (var q = 0; q < cs.length; q++) {
    var c = cs[q], cx = X(c.t + bMs / 2), colq = c.c >= c.o ? '#2ebd85' : '#f6465d';
    ctx.strokeStyle = colq; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, Y(c.h)); ctx.lineTo(cx, Y(c.l)); ctx.stroke();
    var yTop = Y(Math.max(c.o, c.c)), yBot = Y(Math.min(c.o, c.c));
    ctx.fillStyle = colq;
    ctx.fillRect(cx - cw / 2, yTop, cw, Math.max(1, yBot - yTop));
  }
  hxDrawLines(ctx, X, Y, padL, padT, W, H);
  // Banda de volumen absorbido: barra apilada por vela — mayoristas (presion de
  // venta, rojo) sobre recompra (presion de compra, violeta), colores del libro.
  if (volH > 0) {
    var vBase = padT + H + volH;
    for (var r = 0; r < cs.length; r++) {
      var vb = vol.at[cs[r].t];
      if (!vb) continue;
      var vx = X(cs[r].t + bMs / 2);
      var hMay = (vb.may / vol.max) * volH;
      var hRec = (vb.rec / vol.max) * volH;
      ctx.fillStyle = 'rgba(246,70,93,.45)';
      ctx.fillRect(vx - cw / 2, vBase - hMay, cw, Math.max(1, hMay));
      ctx.fillStyle = 'rgba(199,146,234,.45)';
      ctx.fillRect(vx - cw / 2, vBase - hMay - hRec, cw, Math.max(1, hRec));
    }
    ctx.fillStyle = '#8b93a7'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Volumen absorbido (USDT) · mayoristas / recompra', padL + 2, padT + H + 3);
  }
}
// Dibuja el frame base (grilla, ejes, area, linea) en un canvas offscreen. Se
// regenera solo cuando cambia la data/rango/tamano; el mousemove solo lo blitea.
function hxDrawBase(pts, cssW, cssH, dpr) {
  var base = HX.base || (HX.base = document.createElement('canvas'));
  base.width = Math.round(cssW * dpr); base.height = Math.round(cssH * dpr);
  var ctx = base.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  var padL = 14, padR = 62, padT = 14, padB = 26, W = cssW - padL - padR, H = cssH - padT - padB;
  // t0/t1 = la ventana (pan/zoom), no el primer/ultimo punto: mismo criterio que
  // el modo velas, asi el mapeo de pixeles no salta al cambiar de modo.
  var t0 = hxViewT0(), t1 = HX.viewEndT, dt = (t1 - t0) || 1;
  var min = pts[0].price, max = pts[0].price;
  pts.forEach(function(p) { if (p.price < min) min = p.price; if (p.price > max) max = p.price; });
  var span = (max - min) || 1, lo = min - span * 0.08, hi = max + span * 0.08, dp = hi - lo;
  function X(ts) { return padL + (ts - t0) / dt * W; }
  function Y(p)  { return padT + (1 - (p - lo) / dp) * H; }
  var open = pts[0].price, close = pts[pts.length - 1].price, col = close >= open ? '#2ebd85' : '#f6465d';
  HX.px = { padL: padL, padR: padR, padT: padT, W: W, H: H, t0: t0, dt: dt, lo: lo, dp: dp, volH: 0, col: col }; // para el crosshair
  ctx.font = '11px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
  for (var i = 0; i <= 5; i++) {
    var val = lo + (hi - lo) * i / 5, y = Y(val);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.fillStyle = '#8b93a7'; ctx.textAlign = 'left'; ctx.fillText(fmt(val), padL + W + 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  var ticks = 6;
  for (var k = 0; k <= ticks; k++) {
    var ts = t0 + dt * k / ticks, x = X(ts);
    ctx.fillStyle = '#8b93a7';
    ctx.fillText(hxTimeLabel(ts, dt), Math.max(padL + 14, Math.min(padL + W - 14, x)), padT + H + 7);
  }
  var grad = ctx.createLinearGradient(0, padT, 0, padT + H);
  grad.addColorStop(0, col + '44'); grad.addColorStop(1, col + '00');
  ctx.beginPath(); ctx.moveTo(X(pts[0].ts), Y(pts[0].price));
  for (var a = 1; a < pts.length; a++) ctx.lineTo(X(pts[a].ts), Y(pts[a].price));
  ctx.lineTo(X(t1), padT + H); ctx.lineTo(X(t0), padT + H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(X(pts[0].ts), Y(pts[0].price));
  for (var b = 1; b < pts.length; b++) ctx.lineTo(X(pts[b].ts), Y(pts[b].price));
  ctx.strokeStyle = col; ctx.lineWidth = 1.7; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.beginPath(); ctx.arc(X(t1), Y(close), 3.2, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill();
  hxDrawLines(ctx, X, Y, padL, padT, W, H);
}
function hxDraw() {
  if (HX.viewEndT == null) hxResetView();
  var candles = HX.mode === 'candles';
  var cs = candles ? hxVisibleCandles() : [];
  var pts = candles ? [] : hxVisiblePts();
  // Si la ventana actual no tiene con que dibujar (por ejemplo, se acaba de
  // cambiar de timeframe con un zoom muy cerrado, o recien se abre el grafico
  // sin datos todavia), volver a la vista por defecto en vez de quedar en blanco.
  if ((candles ? cs.length : pts.length) < 2) {
    hxResetView();
    cs = candles ? hxVisibleCandles() : [];
    pts = candles ? [] : hxVisiblePts();
  }
  // En velas, si aun asi no hay al menos 2 en pantalla caemos a linea (dataset muy chico).
  if (candles && cs.length < 2) { candles = false; pts = hxVisiblePts(); }
  hxStats(candles ? cs : pts);
  if ((candles ? cs.length : pts.length) < 2) { hxMsg('Aún no hay suficientes datos. El historial se acumula con el tiempo.'); return; }
  hxMsg('');
  var canvas = document.getElementById('hx-chart');
  var dpr = window.devicePixelRatio || 1, cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  // Regenerar el base solo si cambio modo/timeframe/ventana/tamano (no en cada mousemove).
  var key = (candles ? 'c' : 'l') + '|' + ACTIVE_PAY + '|' + HX.tf + '|' + Math.round(HX.viewEndT) + '|' + HX.viewCount + '|' + cssW + 'x' + cssH + '|' + dpr + '|' + HX.linesRev;
  if (HX.baseKey !== key) {
    if (candles) hxDrawBaseCandles(cs, cssW, cssH, dpr); else hxDrawBase(pts, cssW, cssH, dpr);
    HX.baseKey = key;
  }
  var bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.drawImage(HX.base, 0, 0, cssW, cssH);
  var padL = HX.px.padL, padT = HX.px.padT, W = HX.px.W, H = HX.px.H;
  var t0 = HX.px.t0, dt = HX.px.dt, lo = HX.px.lo, dp = HX.px.dp, col = HX.px.col;
  function X(ts) { return padL + (ts - t0) / dt * W; }
  function Y(p)  { return padT + (1 - (p - lo) / dp) * H; }

  // Linea que se esta arrastrando ahora mismo (aun no soltada): se pinta en la
  // capa de arriba, igual que el crosshair, para no invalidar el base en cada
  // tick del arrastre.
  if (HX_DRAWING.active) {
    ctx.save();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(HX_DRAWING.t1), Y(HX_DRAWING.p1)); ctx.lineTo(X(HX_DRAWING.t2), Y(HX_DRAWING.p2)); ctx.stroke();
    ctx.restore();
  }

  // Vela/punto de referencia para la leyenda de arriba a la izquierda: el que
  // esta bajo el cursor si hay hover, si no el mas reciente — asi la leyenda
  // nunca queda vacia, igual que en cualquier grafico de trading.
  var hoverTs = (HX.hoverX != null && (candles ? cs.length : pts.length) > 0)
    ? t0 + ((HX.hoverX - padL) / W) * dt : null;
  var refCandle = null, refPoint = null, refCol = col, refX = null;
  var bMs = hxTf().ms;
  if (candles && cs.length) {
    if (hoverTs != null) {
      refCandle = cs[0];
      var bd = Infinity;
      for (var q = 0; q < cs.length; q++) { var dd = Math.abs((cs[q].t + bMs / 2) - hoverTs); if (dd < bd) { bd = dd; refCandle = cs[q]; } }
    } else {
      refCandle = cs[cs.length - 1];
    }
    refCol = refCandle.c >= refCandle.o ? '#2ebd85' : '#f6465d';
    refX = X(refCandle.t + bMs / 2);
  } else if (!candles && pts.length) {
    if (hoverTs != null) {
      refPoint = pts[0];
      var bd2 = Infinity;
      for (var q2 = 0; q2 < pts.length; q2++) { var dd2 = Math.abs(pts[q2].ts - hoverTs); if (dd2 < bd2) { bd2 = dd2; refPoint = pts[q2]; } }
    } else {
      refPoint = pts[pts.length - 1];
    }
    refX = X(refPoint.ts);
  }
  // Leyenda OHLC (o precio, en modo Linea) fija arriba a la izquierda: no sigue
  // al cursor, se lee siempre en el mismo sitio.
  if (refCandle || refPoint) {
    ctx.save();
    ctx.font = '600 12px -apple-system, sans-serif';
    var legend = refCandle
      ? 'A ' + fmt(refCandle.o) + '  H ' + fmt(refCandle.h) + '  L ' + fmt(refCandle.l) + '  C ' + fmt(refCandle.c)
      : fmt(refPoint.price) + fiatSuf();
    var lw = ctx.measureText(legend).width + 14;
    ctx.fillStyle = 'rgba(10,13,18,.78)';
    ctx.fillRect(padL + 4, padT + 4, lw, 20);
    ctx.fillStyle = refCol; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(legend, padL + 11, padT + 14);
    ctx.restore();
  }

  // Crosshair estilo TradingView: las lineas siguen al CURSOR (libre); el marcador,
  // la etiqueta de precio (eje derecho) y la de fecha (eje inferior) enganchan al
  // dato mas cercano (la misma referencia de la leyenda de arriba).
  if (hoverTs != null) {
    var cx = HX.hoverX, cy = HX.hoverY;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, cy); ctx.lineTo(padL + W, cy); ctx.stroke();
    ctx.setLineDash([]);
    var refTs, refY;
    if (refCandle) { refTs = refCandle.t; refY = Y(refCandle.c); col = refCol; }
    else { refTs = refPoint.ts; refY = Y(refPoint.price); }
    ctx.beginPath(); ctx.arc(refX, refY, 4, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    // Etiqueta de precio sobre el eje Y (a la derecha) a la altura del cursor.
    var curPrice = lo + (1 - (cy - padT) / H) * dp;
    ctx.font = '600 11px -apple-system, sans-serif';
    ctx.fillStyle = col; ctx.fillRect(padL + W + 4, cy - 9, HX.px.padR - 4, 18);
    ctx.fillStyle = '#000'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(fmt(curPrice), padL + W + 8, cy);
    // Etiqueta de fecha/hora sobre el eje X (abajo), pegada al dato enganchado.
    var dateStr = hxFullLabel(refTs);
    ctx.font = '600 11px -apple-system, sans-serif';
    var dtw = ctx.measureText(dateStr).width + 12;
    var axisY = padT + H + (HX.px.volH || 0);
    var dtx = Math.max(padL, Math.min(padL + W - dtw, refX - dtw / 2));
    ctx.fillStyle = col; ctx.fillRect(dtx, axisY + 2, dtw, 16);
    ctx.fillStyle = '#000'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(dateStr, dtx + 6, axisY + 10);
    ctx.restore();
  }
}
function hxFullLabel(ts) {
  var d = new Date(ts), p2 = function(n) { return (n < 10 ? '0' : '') + n; };
  return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}
function hxPointer(e) {
  // Arrastrando o dibujando: ese gesto ya redibuja, no pelear por el mismo frame.
  if (!HX.px || HX_DRAG.active || HX.drawMode) return;
  var cv = document.getElementById('hx-chart'), rect = cv.getBoundingClientRect();
  var t = (e.touches && e.touches[0]) ? e.touches[0] : e;
  var px = t.clientX - rect.left, py = t.clientY - rect.top;
  HX.hoverX = Math.max(HX.px.padL, Math.min(HX.px.padL + HX.px.W, px));
  HX.hoverY = Math.max(HX.px.padT, Math.min(HX.px.padT + HX.px.H, py));
  hxDraw();
}
// Arrastrar con el mouse = panear (no crosshair): se distingue por HX_DRAG.active,
// que hxPointer respeta para no pelearse por el mismo redraw.
var HX_DRAG = { active: false, startX: 0, startEndT: 0 };
// Linea en curso (modo dibujo): t1/p1 el punto donde se apreto, t2/p2 el punto
// actual mientras se arrastra.
var HX_DRAWING = { active: false, startPx: 0, startPy: 0, t1: 0, p1: 0, t2: 0, p2: 0 };
var HX_TAP_PX = 4; // por debajo de esto, un "arrastre" cuenta como toque (borrar, no dibujar)
function hxPanTo(clientX) {
  if (!HX.px) return;
  var span = HX.viewCount * hxTf().ms;
  var dt = -(clientX - HX_DRAG.startX) / HX.px.W * span;
  HX.viewEndT = HX_DRAG.startEndT + dt;
  hxClampView();
  HX.hoverX = null;
  hxDraw();
}
function hxTouchDist(touches) {
  var dx = touches[0].clientX - touches[1].clientX, dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy) || 1;
}
function hxDrawStart(px, py) {
  HX_DRAWING.active = true;
  HX_DRAWING.startPx = px; HX_DRAWING.startPy = py;
  HX_DRAWING.t1 = hxPxToTs(px); HX_DRAWING.p1 = hxPxToPrice(py);
  HX_DRAWING.t2 = HX_DRAWING.t1; HX_DRAWING.p2 = HX_DRAWING.p1;
}
function hxDrawMove(px, py) {
  HX_DRAWING.t2 = hxPxToTs(px); HX_DRAWING.p2 = hxPxToPrice(py);
  hxDraw();
}
function hxDrawEnd(px, py) {
  HX_DRAWING.active = false;
  var moved = Math.hypot(px - HX_DRAWING.startPx, py - HX_DRAWING.startPy);
  if (moved < HX_TAP_PX) {
    hxRemoveLineNear(px, py);
  } else {
    HX.lines.push({ t1: HX_DRAWING.t1, p1: HX_DRAWING.p1, t2: hxPxToTs(px), p2: hxPxToPrice(py) });
    HX.linesRev++;
  }
  hxRenderRanges(); // el boton de borrar todo aparece/desaparece segun haya lineas
  hxDraw();
}
function hxBindPointer() {
  if (HX.bound) return;
  HX.bound = true;
  var cv = document.getElementById('hx-chart');
  cv.style.cursor = 'grab';
  cv.style.touchAction = 'none'; // el gesto lo maneja el canvas (pan/pinch/dibujo), no el scroll de la pagina

  cv.addEventListener('mousemove', hxPointer);
  cv.addEventListener('mouseleave', function() { HX.hoverX = null; hxDraw(); });
  cv.addEventListener('mousedown', function(e) {
    if (!HX.px) return;
    var rect = cv.getBoundingClientRect();
    if (HX.drawMode) { hxDrawStart(e.clientX - rect.left, e.clientY - rect.top); return; }
    HX_DRAG.active = true; HX_DRAG.startX = e.clientX; HX_DRAG.startEndT = HX.viewEndT;
    cv.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', function(e) {
    if (HX_DRAWING.active) {
      var rect = cv.getBoundingClientRect();
      hxDrawMove(e.clientX - rect.left, e.clientY - rect.top);
    } else if (HX_DRAG.active) {
      hxPanTo(e.clientX);
    }
  });
  window.addEventListener('mouseup', function(e) {
    if (HX_DRAWING.active) {
      var rect = cv.getBoundingClientRect();
      hxDrawEnd(e.clientX - rect.left, e.clientY - rect.top);
    } else if (HX_DRAG.active) {
      HX_DRAG.active = false; cv.style.cursor = 'grab';
    }
  });
  // Zoom con la rueda, anclado al instante bajo el cursor (no al centro).
  cv.addEventListener('wheel', function(e) {
    if (!HX.px) return;
    e.preventDefault();
    var rect = cv.getBoundingClientRect();
    var pivotTs = hxPxToTs(e.clientX - rect.left);
    hxZoomStep(pivotTs, e.deltaY > 0 ? 1.15 : 0.87);
    HX.hoverX = null;
    hxDraw();
  }, { passive: false });

  // Tactil: 1 dedo = panear (o dibujar, si esta activo el modo linea) y muestra
  // el crosshair al tocar; 2 dedos = pinch-zoom (deshabilitado en modo dibujo).
  var pinch = { active: false, startDist: 0, startCount: 0, midTs: 0, startEndT: 0 };
  cv.addEventListener('touchstart', function(e) {
    var rect = cv.getBoundingClientRect();
    if (HX.drawMode) {
      if (e.touches.length === 1 && HX.px) hxDrawStart(e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
      return;
    }
    if (e.touches.length === 1) {
      HX_DRAG.active = true; HX_DRAG.startX = e.touches[0].clientX; HX_DRAG.startEndT = HX.viewEndT;
      pinch.active = false;
      hxPointer(e);
    } else if (e.touches.length === 2 && HX.px) {
      HX_DRAG.active = false;
      pinch.active = true;
      pinch.startDist = hxTouchDist(e.touches);
      pinch.startCount = HX.viewCount;
      pinch.startEndT = HX.viewEndT;
      var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      pinch.midTs = hxPxToTs(midX);
    }
  }, { passive: true });
  cv.addEventListener('touchmove', function(e) {
    if (HX_DRAWING.active && e.touches.length === 1) {
      e.preventDefault();
      var rect = cv.getBoundingClientRect();
      hxDrawMove(e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
    } else if (pinch.active && e.touches.length === 2) {
      e.preventDefault();
      var bMs = hxTf().ms;
      var oldSpan = pinch.startCount * bMs, oldT0 = pinch.startEndT - oldSpan;
      var rel = oldSpan > 0 ? (pinch.midTs - oldT0) / oldSpan : 1;
      var scale = hxTouchDist(e.touches) / pinch.startDist; // dedos separandose = acercar
      HX.viewCount = Math.max(HX_MIN_CANDLES, Math.min(HX_MAX_CANDLES, Math.round(pinch.startCount / scale)));
      var newSpan = HX.viewCount * bMs;
      HX.viewEndT = pinch.midTs + (1 - rel) * newSpan;
      hxClampView();
      HX.hoverX = null;
      hxDraw();
    } else if (HX_DRAG.active && e.touches.length === 1) {
      e.preventDefault();
      hxPanTo(e.touches[0].clientX);
    }
  }, { passive: false });
  cv.addEventListener('touchend', function(e) {
    if (HX_DRAWING.active) {
      var t = e.changedTouches && e.changedTouches[0];
      if (t) {
        var rect = cv.getBoundingClientRect();
        hxDrawEnd(t.clientX - rect.left, t.clientY - rect.top);
      } else {
        HX_DRAWING.active = false;
      }
    }
    if (e.touches.length < 2) pinch.active = false;
    if (e.touches.length < 1) HX_DRAG.active = false;
  });
}
async function hxLoad() {
  if (!SESSION.token) { hxMsg('Inicia sesión primero.'); return; }
  hxMsg('Cargando historial...');
  try {
    var d = await botCallWorker('/monitor-history');
    HX.series = hxMerge(histByPay(d && d.hist_long, ACTIVE_PAY), histByPay(d && d.hist24, ACTIVE_PAY));
    // Serie de volumen aparte (puede venir vacia: se acumula desde que se empezo
    // a grabar, igual que paso con el precio). No afecta al dibujo del precio.
    HX.vol = (d && d.vol) || [];
    var cov = document.getElementById('hx-coverage');
    if (cov) cov.textContent = HX.series.length
      ? '· ' + HX.series.length + ' puntos desde ' + hxFullLabel(HX.series[0].ts)
      : '';
    if (!HX.series.length) { hxMsg('Aún no hay datos. El historial se acumula con el tiempo.'); return; }
    // Primera carga: arranca mirando lo mas reciente. Si ya se habia abierto antes
    // (HX.viewEndT ya seteado), se respeta donde el usuario habia dejado el pan/zoom
    // y solo se reacota por si la data nueva movio los bordes.
    if (HX.viewEndT == null) hxResetView(); else hxClampView();
    hxDraw();
  } catch (e) { hxMsg('Error: ' + e.message); }
}
// Refresca la serie de 24h desde el servidor (max 1 vez cada 5 min, alineado con el latido).
function refreshHist24() {
  if (!SESSION.token) return;
  var now = Date.now();
  if (now - MON24.lastHist < 5 * 60000) return;
  MON24.lastHist = now;
  botCallWorker('/monitor-state').then(function(d) {
    if (d && d.hist24) { HIST24 = d.hist24; saveHist24(); renderSparkline(); }
    surfaceMonitorErrors(d);
  }).catch(function(){});
}

// Latido: avisa al servidor que la app esta abierta y refrescando, para que NO duplique
// la busqueda ni las alertas mientras tanto. Throttle ~30s.
function monitorHeartbeat() {
  // USD es solo vista local: sin latido, el servidor sigue vigilando VES 24/7
  // y los precios USD no contaminan las series del servidor.
  if (ACTIVE_FIAT !== 'VES') return;
  if (!MON24.enabled || !SESSION.token) return;
  var now = Date.now();
  // 5 min: el servidor toma el relevo a los 12 min sin latido (2 latidos perdidos
  // + margen). Antes eran 15/35 min para no despertar la Neon vieja.
  if (now - MON24.lastHb < 5 * 60 * 1000) return;
  MON24.lastHb = now;
  // De paso, el precio que ve la app alimenta hist24 en el servidor (sparkline sin huecos de dia).
  var p = bestCredibleMay() || 0;
  var med = medianCredibleMay();
  botCallWorker('/monitor-heartbeat', { price: p, pay: ACTIVE_PAY, median: med.rate, medianN: med.n }).catch(function(){});
}

function monitorServerConfig() {
  return {
    refreshSec: 60, // servidor (app cerrada/oculta): 60s. La vista abierta sigue a CFG.interval (10s).
    quietStart: document.getElementById('cfg-mon-qstart').value || '',
    quietEnd:   document.getElementById('cfg-mon-qend').value   || '',
    summaryHour: document.getElementById('cfg-mon-summary').value || '',
    spreadThr: CFG.spreadThr,
    overboughtThr: CFG.overboughtThr,
    weaknessThr: CFG.weaknessThr,
    sustainThr: CFG.sustainThr,
    commission: CFG.commission || 0,
    mayAmount: CFG.mayAmount,
    smallAmount: CFG.smallAmount,
    buyAmount: CFG.buyAmount,
    shortMode: CFG.shortMode !== false,
    verifiedOnly: CFG.verifiedOnly !== false,
    payTypes: [ACTIVE_PAY]
  };
}

// Encender/apagar el monitor server-side (lo dispara el boton Iniciar, no un boton aparte).
async function monitorServerEnable() {
  // El 24/7 del servidor es solo VES; en USD no tocar su config (vista local).
  if (ACTIVE_FIAT !== 'VES') { renderMon24('USD: solo vista local (24/7 sigue en VES)'); return; }
  if (!SESSION.token) { renderMon24(); return; }
  if (!TGLINK.linked) { MON24.enabled = false; rememberMon24(false); renderMon24('Conecta Telegram para el 24/7'); return; }
  try { await botCallWorker('/monitor-enable', { config: monitorServerConfig() }); MON24.enabled = true; MON24.lastHb = Date.now(); rememberMon24(true); botCallWorker('/monitor-heartbeat').catch(function(){}); renderMon24('Corriendo en el servidor'); }
  catch(e) { MON24.enabled = false; rememberMon24(false); renderMon24('Error 24/7: ' + e.message); }
}

async function monitorServerDisable() {
  try { await botCallWorker('/monitor-disable'); } catch(e) {}
  MON24.enabled = false; rememberMon24(false); renderMon24();
}

function renderMon24(statusText) {
  var st = document.getElementById('mon24-status');
  if (st) st.textContent = MON24.enabled ? (statusText || 'Corriendo en el servidor') : (statusText || '');
}

// Ultimo estado conocido del 24/7: lo lee enterApp para pedir el libro sin esperar
// la respuesta del servidor.
function rememberMon24(on) {
  try { localStorage.setItem('p2p_mon24', on ? '1' : '0'); } catch (e) {}
}

async function hydrateMon24(isRetry) {
  if (!SESSION.token) return;
  try {
    var d = await botCallWorker('/monitor-state');
    MON24.enabled = !!(d && d.enabled);
    rememberMon24(MON24.enabled);
    if (d && d.hist24) { HIST24 = d.hist24; MON24.lastHist = Date.now(); saveHist24(); renderSparkline(); }
    renderMon24(d && d.status);
    surfaceMonitorErrors(d); // siembra lastLogTs sin avisar errores viejos
    // Si el monitor 24/7 quedo activo, arranca la vista (tablas a CFG.interval) sin pulsar Iniciar.
    if (MON24.enabled && !ST.running) startMonitorView();
    // El arranque optimista de enterApp pudo equivocarse (se apago desde otro
    // dispositivo): corregir, pero solo si lo encendio el cache, nunca el usuario.
    else if (!MON24.enabled && ST.running && ST.fromCache) stopMonitorView();
    ST.fromCache = false; // ya confirmado contra el servidor
  } catch(e) {
    // Fallo transitorio al abrir la app (cold start): si se traga el error, la UI
    // muestra el monitor "apagado" aunque siga corriendo en el servidor. Reintentar una vez.
    if (!isRetry) setTimeout(function(){ hydrateMon24(true); }, 5000);
  }
}

// ── Config ────────────────────────────────────────────
function saveConfig() {
  CFG.interval      = Math.max(10, parseInt(document.getElementById('cfg-int').value) || 15);
  CFG.spreadThr     = parseFloat(document.getElementById('cfg-spr').value) || 0.5;
  CFG.overboughtThr = parseFloat(document.getElementById('cfg-ob').value)  || 1.0;
  CFG.weaknessThr   = parseFloat(document.getElementById('cfg-wk').value)  || 0.5;
  CFG.sustainThr    = parseFloat(document.getElementById('cfg-sustain').value) || 1.5;
  var mayVal = document.getElementById('cfg-may-amount').value;
  CFG.mayAmount   = mayVal === '' ? 0 : (parseFloat(mayVal) || 0);
  CFG.smallAmount = parseFloat(document.getElementById('cfg-small-amount').value) || 59999;
  CFG.commission  = parseFloat(document.getElementById('cfg-commission').value)   || 0;
  CFG.buyAmount   = parseFloat(document.getElementById('cfg-buy-amount').value)   || 2000000;
  CFG.monQuietStart = document.getElementById('cfg-mon-qstart').value || '00:00';
  CFG.monQuietEnd   = document.getElementById('cfg-mon-qend').value   || '07:00';
  CFG.monSummary    = document.getElementById('cfg-mon-summary').value || '08:00';
  var shortEl = document.getElementById('cfg-shortmode');
  if (shortEl) CFG.shortMode = shortEl.checked;
  localStorage.setItem('p2p_cfg2', JSON.stringify(CFG));
  syncFilterInputs();
  applyMarketMode();
  if (ST.running) { clearInterval(ST.timer); ST.timer = setInterval(fetchOnce, CFG.interval * 1000); }
  updateCommissionLabels();
  botUpdateCeiling();
  fetchOnce();
  saveUserSettings();
  if (MON24.enabled && ACTIVE_FIAT === 'VES') { botCallWorker('/monitor-enable', { config: monitorServerConfig() }).catch(function(){}); }
  toast('Guardado');
}

function loadConfig() {
  try {
    var s = localStorage.getItem('p2p_cfg2');
    if (!s) return;
    Object.assign(CFG, JSON.parse(s));
    // Migracion unica al nuevo default: quien venia de 10s pasa a 15s. Sigue siendo
    // editable a mano hasta el minimo de 10s.
    if (!CFG.intervalMigrated) {
      if (CFG.interval < 15) CFG.interval = 15;
      CFG.intervalMigrated = true;
      try { localStorage.setItem('p2p_cfg2', JSON.stringify(CFG)); } catch (e) {}
    }
    document.getElementById('cfg-int').value      = CFG.interval;
    document.getElementById('cfg-spr').value      = CFG.spreadThr;
    document.getElementById('cfg-ob').value       = CFG.overboughtThr;
    document.getElementById('cfg-wk').value       = CFG.weaknessThr;
    if (CFG.sustainThr != null) document.getElementById('cfg-sustain').value = CFG.sustainThr;
    document.getElementById('cfg-may-amount').value   = CFG.mayAmount;
    document.getElementById('cfg-small-amount').value = CFG.smallAmount;
    document.getElementById('cfg-commission').value   = CFG.commission;
    document.getElementById('cfg-buy-amount').value   = CFG.buyAmount;
    if (CFG.monQuietStart) document.getElementById('cfg-mon-qstart').value = CFG.monQuietStart;
    if (CFG.monQuietEnd)   document.getElementById('cfg-mon-qend').value   = CFG.monQuietEnd;
    if (CFG.monSummary)    document.getElementById('cfg-mon-summary').value = CFG.monSummary;
    var shortEl = document.getElementById('cfg-shortmode');
    if (shortEl) shortEl.checked = CFG.shortMode !== false;
  } catch(e) {}
  updateVerToggle();
  applyMarketMode();
}

// Instantaneo, sin pasar por "Guardar" (es un modo de vista, no un parametro de riesgo).
function toggleShortMode() {
  var cb = document.getElementById('cfg-shortmode');
  CFG.shortMode = cb ? cb.checked : true;
  localStorage.setItem('p2p_cfg2', JSON.stringify(CFG));
  ST.priceHist = []; // la serie primaria cambia: evita un salto de momentum falso
  applyMarketMode();
  fetchOnce();
  saveUserSettings();
  if (MON24.enabled && ACTIVE_FIAT === 'VES') { botCallWorker('/monitor-enable', { config: monitorServerConfig() }).catch(function(){}); }
}

function toggleVerified() {
  var on = CFG.verifiedOnly !== false;
  CFG.verifiedOnly = !on;
  localStorage.setItem('p2p_cfg2', JSON.stringify(CFG));
  updateVerToggle();
  fetchOnce();
  saveUserSettings();
}

function updateVerToggle() {
  var el = document.getElementById('ver-toggle');
  if (!el) return;
  var on = CFG.verifiedOnly !== false;
  el.classList.toggle('off', !on);
  el.title = on ? 'Solo verificados — clic para incluir a todos' : 'Mostrando todos — clic para solo verificados';
  syncFiltersChip();
}

// Filtros inline (label en web) + tuerca (mobile): misma fuente CFG.
function setFilter(which, raw) {
  var map = { may: ['mayAmount', 2000000], small: ['smallAmount', 59999], buy: ['buyAmount', 2000000] };
  var m = map[which]; if (!m) return;
  // 0 o vacio = SIN filtro de monto (eleccion del usuario): la tabla muestra el
  // orden nativo de Binance, solo con filtros de verificados y metodo de pago.
  var v = (raw === '' || raw == null) ? 0 : parseFloat(raw);
  if (isNaN(v)) v = m[1];
  CFG[m[0]] = v;
  localStorage.setItem('p2p_cfg2', JSON.stringify(CFG));
  syncFilterInputs();
  fetchOnce();
  saveUserSettings();
}

function syncFilterInputs() {
  [['flt-may','cfg-may-amount','mayAmount'],
   ['flt-small','cfg-small-amount','smallAmount'],
   ['flt-buy','cfg-buy-amount','buyAmount']].forEach(function(p) {
    var a = document.getElementById(p[0]), b = document.getElementById(p[1]);
    if (a) a.value = CFG[p[2]];
    if (b) b.value = CFG[p[2]];
  });
}

// ── Utils ─────────────────────────────────────────────
function fmt(n) { return parseFloat(n).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtP(n) { return parseFloat(n).toLocaleString('es-VE', { minimumFractionDigits: 3, maximumFractionDigits: 3 }); }
function fmtM(n) {
  n = parseFloat(n);
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return n.toFixed(0);
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Cierra el panel de filtros y el menu ⋯ al tocar fuera (solo movil los muestra).
document.addEventListener('click', function(e) {
  var p = document.getElementById('top-controls');
  if (p && p.classList.contains('open') && !p.contains(e.target) &&
      !(e.target.closest && e.target.closest('#filters-chip'))) p.classList.remove('open');
  var c = document.getElementById('icon-cluster');
  if (c && c.classList.contains('open') && !c.contains(e.target) &&
      !(e.target.closest && e.target.closest('#more-btn'))) c.classList.remove('open');
});
function toast(msg) {
  var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(function() { t.remove(); }, 2500);
}

// ── Sección Compra colapsable (oculta en mobile) ──────
function setBuyCollapsed(collapsed) {
  var body = document.getElementById('buy-section-body');
  var chev = document.getElementById('buy-chevron');
  if (body) body.style.display = collapsed ? 'none' : '';
  if (chev) chev.style.transform = collapsed ? 'rotate(-90deg)' : '';
  try { localStorage.setItem('p2p_buy_collapsed', collapsed ? '1' : '0'); } catch(e) {}
}
function toggleBuySection() {
  var body = document.getElementById('buy-section-body');
  var willCollapse = body && body.style.display !== 'none';
  setBuyCollapsed(willCollapse);
  // Al expandir, refrescar para traer la data BUY (no se pide mientras está colapsada).
  if (!willCollapse) fetchOnce();
}
function initBuySection() {
  var saved = null;
  try { saved = localStorage.getItem('p2p_buy_collapsed'); } catch(e) {}
  // Sin preferencia previa: colapsada en mobile, abierta en escritorio.
  setBuyCollapsed(saved === null ? window.innerWidth <= 760 : saved === '1');
}

loadConfig(); syncFilterInputs(); loadBotConfig(); loadPayMethod(); loadActivityGuard(); updateCommissionLabels(); updNotifSt(); renderAlerts(); refreshAuthUI(); refreshPushState(); renderDecisionIdle(); loadHist24();
initBuySection();
// Enlaces de email (verify/reset) tienen prioridad; si no, valida sesion normal.
handleAuthLinks().then(function(handled){ if (!handled) initAuth(); });
renderOB('ob-may',   [], 'best');
renderOB('ob-small', [], 'best-buy');
renderBuySection([]);
updateSellPricePlaceholder();
