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
      && a.avail   >= 20000
      && a.minVES  >= 2000000
      && a.badges && a.badges.length > 0
      && (a.comp == null || a.comp >= 95)
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

  // ── Features ────────────────────────────────────────
  function computeFeatures(ST, history) {
    var snap = history[history.length - 1];
    if (!snap) return null;

    var may   = sanitize(snap.may);
    var buy   = snap.buy;
    var maj   = majors(may);

    if (may.length < 3 || !buy.length) {
      return { degraded: true, reason: 'thin book', spreadNet: 0 };
    }

    var pSell  = may[0].price;
    var pRebuy = buy[0].price;

    // 1. Spread
    var spreadGross = (pSell - pRebuy) / pRebuy;
    var spreadNet   = spreadGross - FEE_BUY;

    // 2. LA — liquidity above (sellable in profitable zone)
    var threshold = pRebuy * (1 + FEE_BUY + 0.003);
    var LA = 0;
    for (var i = 0; i < maj.length; i++) {
      if (maj[i].price >= threshold) LA += maj[i].avail;
    }

    // 3. LB — liquidity below (rebuyable near best buy)
    var LB = 0, lbCap = pRebuy * 1.0015;
    for (var j = 0; j < buy.length; j++) {
      if (buy[j].price <= lbCap) LB += buy[j].avail;
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
      var prevMaj = majors(sanitize(prev.may));
      var prevTop = prevMaj.slice(0, 5);
      var idx = {};
      var curMap = {};
      for (var m = 0; m < may.length; m++) curMap[may[m].merchant] = may[m];
      var absorbed = 0, replen = 0;
      for (var p = 0; p < prevTop.length; p++) {
        var pm = prevTop[p];
        prevTop5USDT += pm.avail;
        var cur = curMap[pm.merchant];
        if (!cur)             absorbed += pm.avail;
        else if (cur.avail < pm.avail) absorbed += (pm.avail - cur.avail);
        else                  replen   += (cur.avail - pm.avail);
      }
      if (prevTop5USDT > 0) {
        absRate3m     = absorbed / prevTop5USDT;
        replenishRate = replen   / prevTop5USDT;
      }
    }

    // 6. Liquidity gaps
    var gaps = [], gapMax = 0, gapBigCnt = 0;
    for (var g = 0; g < Math.min(maj.length, 6) - 1; g++) {
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
      gapMaxRel: gapMaxRel, gapBigCnt: gapBigCnt,
      weakness: weakness, priceDirAdj: priceDirAdj,
      priceMom: priceMom, flowMom: flowMom, momentum: momentum,
      revProb: revProb, hi20: hi20,
      events: events,
      avgMajorOrder: maj.length ? topUSDT / Math.min(maj.length, 5) : 0
    };
  }

  // ── Score ───────────────────────────────────────────
  var WEIGHTS = {
    spread: 30, liqRatio: 12, conc: 8, abs: 15,
    mom: 10, weak: 7, gap: 5, rev: 8, tape: 5
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
      tape:     (F.events && F.events.rapidDeplete && F.events.priceDropTop) ? 100 : 0
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
    if (F.majorCount < 3) vetoes.push('< 3 majors');

    return { raw: raw, parts: parts, vetoes: vetoes };
  }

  // ── Decide ──────────────────────────────────────────
  function decide(F, S) {
    if (!F || F.degraded) {
      return { score: null, label: 'WAIT', color: 'gray',
               reasons: { pos: [], neg: ['libro degradado'] }, conflicts: [], rebuy: null };
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
    if (F.absRate3m >= 0.20)   pos.push('absorbió ' + (F.absRate3m * 100).toFixed(0) + '% top5 en 3m');
    else if (F.absRate3m >= 0.10) pos.push('absorción ' + (F.absRate3m * 100).toFixed(0) + '%');
    if (F.momentum >= 0.3)     pos.push('momentum +' + F.momentum.toFixed(2));
    if (F.LA > F.LB * 1.5)     pos.push('LA/LB ' + (F.LA / Math.max(F.LB, 1)).toFixed(1) + 'x');
    if (F.events.rapidDeplete) pos.push('vaciado rápido top1');

    if (F.HHI > 0.5)           neg.push('HHI ' + F.HHI.toFixed(2) + ' (concentrado)');
    if (F.gapBigCnt >= 2)      neg.push(F.gapBigCnt + ' gaps grandes');
    if (F.weakness > 0.4)      neg.push('debilidad ' + F.weakness.toFixed(2));
    if (F.momentum < -0.2)     neg.push('momentum ' + F.momentum.toFixed(2));
    if (F.revProb >= 0.6)      neg.push('reversal prob ' + (F.revProb * 100).toFixed(0) + '%');
    if (F.LB < 20000)          neg.push('LB ' + Math.round(F.LB) + ' baja');

    var conflicts = [];
    if (F.HHI > 0.5 && F.absRate3m >= 0.20)
      conflicts.push('alta concentración + absorción fuerte');
    if (F.momentum >= 0.3 && F.revProb >= 0.6)
      conflicts.push('momentum alcista vs reversal alta');

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
})(typeof window !== 'undefined' ? window : globalThis);
