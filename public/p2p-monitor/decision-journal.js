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
