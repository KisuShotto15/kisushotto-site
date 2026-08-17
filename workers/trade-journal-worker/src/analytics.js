// analytics.js — pure computation, no I/O

function r2(n) { return Math.round(n * 100) / 100; }
function r1(n) { return Math.round(n * 10) / 10; }

// R = cuanto gano/pierdo en multiplos del riesgo que puse en el trade.
// Si no hay risk_usd guardado se deriva de |entrada - stop| * size.
export function riskOf(t) {
  if (t.risk_usd > 0) return t.risk_usd;
  if (t.stop_price > 0 && t.entry_price > 0 && t.size > 0) {
    const r = Math.abs(t.entry_price - t.stop_price) * t.size;
    return r > 0 ? r : null;
  }
  return null;
}

export function rMultiple(t) {
  const risk = riskOf(t);
  return risk && t.pnl != null ? t.pnl / risk : null;
}

function rStats(closed) {
  const rs = closed.map(rMultiple).filter(v => v != null && Number.isFinite(v));
  if (!rs.length) return { rCount: 0, totalR: 0, avgR: 0, bestR: 0, worstR: 0, rCoverage: 0 };
  const wins   = rs.filter(v => v > 0);
  const losses = rs.filter(v => v < 0);
  return {
    rCount:    rs.length,
    rCoverage: r1(rs.length / closed.length * 100),
    totalR:    r2(rs.reduce((s, v) => s + v, 0)),
    avgR:      r2(rs.reduce((s, v) => s + v, 0) / rs.length),
    avgWinR:   wins.length   ? r2(wins.reduce((s, v) => s + v, 0) / wins.length)     : 0,
    avgLossR:  losses.length ? r2(losses.reduce((s, v) => s + v, 0) / losses.length) : 0,
    bestR:     r2(Math.max(...rs)),
    worstR:    r2(Math.min(...rs)),
  };
}

// Spot y futuros son negocios distintos y en monedas distintas: mezclarlos no
// dice nada. Solo entran al calculo los que tienen pnl realizado en USDT.
export function splitByMarket(trades) {
  const out = { futures: [], spot: [] };
  for (const t of trades) (t.category === 'spot' ? out.spot : out.futures).push(t);
  return out;
}

export function computeStats(trades, opts = {}) {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl != null && t.category !== 'spot');
  if (!closed.length) return emptyStats(trades.length, opts);

  const wins        = closed.filter(t => t.pnl > 0);
  const losses      = closed.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl    = grossProfit - grossLoss;
  const winRate     = wins.length / closed.length;
  const avgWin      = wins.length   ? grossProfit / wins.length   : 0;
  const avgLoss     = losses.length ? grossLoss   / losses.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const expectancy   = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  const { maxDD, maxDDAbs, curve } = buildEquityCurve(closed, opts.equityNow, opts.startCapital);
  const { current, maxWin, maxLoss } = computeStreaks(closed);

  const withTime  = closed.filter(t => t.exit_time && t.entry_time);
  const avgHoldS  = withTime.length
    ? withTime.reduce((s, t) => s + (t.exit_time - t.entry_time), 0) / withTime.length
    : 0;

  const sorted = [...closed].sort((a, b) => b.pnl - a.pnl);

  const spot = trades.filter(t => t.category === 'spot');

  return {
    tradeCount:    trades.length,
    spotCount:     spot.length,
    spotRealized:  r2(spot.reduce((s, t) => s + (t.pnl || 0), 0)),
    closedCount:   closed.length,
    openCount:     trades.length - closed.length,
    winCount:      wins.length,
    lossCount:     losses.length,
    winRate:       r1(winRate * 100),
    totalPnl:      r2(totalPnl),
    grossProfit:   r2(grossProfit),
    grossLoss:     r2(grossLoss),
    profitFactor:  r2(Math.min(profitFactor, 999)),
    avgWin:        r2(avgWin),
    avgLoss:       r2(avgLoss),
    expectancy:    r2(expectancy),
    maxDrawdown:   maxDD,
    maxDrawdownAbs: r2(maxDDAbs),
    drawdownBase:  opts.startCapital > 0 ? 'capital declarado'
                 : opts.equityNow ? 'capital estimado' : 'pico',
    startCapital:  opts.startCapital || null,
    returnPct:     opts.startCapital > 0 ? r2(totalPnl / opts.startCapital * 100) : null,
    currentStreak: current,
    maxWinStreak:  maxWin,
    maxLossStreak: maxLoss,
    bestTrade:     sorted[0]  || null,
    worstTrade:    sorted[sorted.length - 1] || null,
    avgHoldMinutes:Math.round(avgHoldS / 60),
    equityCurve:   curve,
    ...rStats(closed),
  };
}

function emptyStats(total = 0, opts = {}) {
  return {
    tradeCount: total, closedCount: 0, openCount: total,
    winCount: 0, lossCount: 0, winRate: 0, totalPnl: 0,
    grossProfit: 0, grossLoss: 0, profitFactor: 0,
    avgWin: 0, avgLoss: 0, expectancy: 0, maxDrawdown: 0,
    currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0,
    bestTrade: null, worstTrade: null, avgHoldMinutes: 0,
    maxDrawdownAbs: 0, drawdownBase: 'pico',
    startCapital: opts.startCapital || null, returnPct: opts.startCapital > 0 ? 0 : null,
    equityCurve: [],
    spotCount: 0, spotRealized: 0,
    rCount: 0, rCoverage: 0, totalR: 0, avgR: 0,
    avgWinR: 0, avgLossR: 0, bestR: 0, worstR: 0,
  };
}

// El drawdown en % solo significa algo contra el capital. Medido contra el pico
// del PnL acumulado (que arranca en 0) da valores imposibles: si ganas 10 y
// luego pierdes 12, el pico es 10 y sale 120% de drawdown.
// Con equityNow se reconstruye el capital inicial (equity actual - PnL total)
// y se mide contra la curva de capital real. Sin el, solo se reporta absoluto.
export function buildEquityCurve(trades, equityNow = null, declaredCapital = null) {
  const sorted   = [...trades].sort((a, b) => a.entry_time - b.entry_time);
  const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);

  // Un capital declarado es siempre mejor que deducirlo: los depositos y el
  // capital inmovilizado hacen que equity - pnl no sea el capital de partida.
  const startCapital = declaredCapital > 0
    ? declaredCapital
    : (equityNow != null && equityNow - totalPnl > 0 ? equityNow - totalPnl : null);

  let balance = 0, peakBal = 0, maxDDAbs = 0;
  let peakEquity = startCapital ?? 0, maxDD = 0;

  const curve = sorted.map(t => {
    balance += t.pnl;

    // Caida absoluta desde el pico: siempre valida, este o no el capital
    if (balance > peakBal) peakBal = balance;
    const ddAbs = peakBal - balance;
    if (ddAbs > maxDDAbs) maxDDAbs = ddAbs;

    if (startCapital != null) {
      const equity = startCapital + balance;
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }

    return { t: t.entry_time, v: r2(balance) };
  });

  // Sin capital conocido no se inventa un porcentaje
  return { maxDD: startCapital != null ? r1(maxDD) : null, maxDDAbs, curve };
}

function computeStreaks(trades) {
  const sorted = [...trades].sort((a, b) => a.entry_time - b.entry_time);
  let maxWin = 0, maxLoss = 0, curW = 0, curL = 0;
  for (const t of sorted) {
    if (t.pnl > 0) { curW++; curL = 0; if (curW > maxWin) maxWin = curW; }
    else if (t.pnl < 0) { curL++; curW = 0; if (curL > maxLoss) maxLoss = curL; }
  }
  if (!sorted.length) return { current: 0, maxWin, maxLoss };
  const dir = sorted[sorted.length - 1].pnl >= 0 ? 1 : -1;
  let cnt = 0, i = sorted.length - 1;
  while (i >= 0 && (sorted[i].pnl >= 0 ? 1 : -1) === dir) { cnt++; i--; }
  return { current: cnt * dir, maxWin, maxLoss };
}

export function groupByDimension(trades, field) {
  const groups = new Map();
  for (const t of trades.filter(t => t.status === 'closed' && t.pnl != null && t.category !== 'spot')) {
    const k = t[field] || 'sin tag';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()]
    .map(([label, group]) => ({ label, ...dimStats(group) }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

function dimStats(trades) {
  const wins      = trades.filter(t => t.pnl > 0);
  const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const gProfit   = wins.reduce((s, t) => s + t.pnl, 0);
  const gLoss     = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const rs        = trades.map(rMultiple).filter(v => v != null && Number.isFinite(v));
  return {
    count:        trades.length,
    winCount:     wins.length,
    winRate:      trades.length ? r1(wins.length / trades.length * 100) : 0,
    totalPnl:     r2(totalPnl),
    avgPnl:       trades.length ? r2(totalPnl / trades.length) : 0,
    profitFactor: gLoss > 0 ? r2(gProfit / gLoss) : (gProfit > 0 ? 99 : 0),
    totalR:       rs.length ? r2(rs.reduce((s, v) => s + v, 0)) : null,
    avgR:         rs.length ? r2(rs.reduce((s, v) => s + v, 0) / rs.length) : null,
  };
}

// Review semanal: lo que paso cada semana y los trades que hay que revisar.
export function buildWeeklyReview(trades, weeks = 8) {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl != null && t.category !== 'spot');
  const groups = new Map();

  for (const t of closed) {
    const d = new Date(t.entry_time * 1000);
    // Lunes de esa semana, en UTC
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) / 1000;
    if (!groups.has(monday)) groups.set(monday, []);
    groups.get(monday).push(t);
  }

  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, weeks)
    .map(([weekStart, group]) => {
      const sorted  = [...group].sort((a, b) => a.pnl - b.pnl);
      const rs      = group.map(rMultiple).filter(v => v != null && Number.isFinite(v));
      const scores  = group.map(t => t.rule_score).filter(v => v != null);
      const emotions = {};
      for (const t of group) if (t.emotion) emotions[t.emotion] = (emotions[t.emotion] || 0) + 1;

      return {
        weekStart,
        weekEnd:   weekStart + 7 * 86400 - 1,
        ...dimStats(group),
        totalFees: r2(group.reduce((s, t) => s + (t.fees || 0), 0)),
        avgRuleScore: scores.length ? r1(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
        emotions,
        untagged:  group.filter(t => !t.setup_tag && !t.strategy_tag).length,
        unreviewed: group.filter(t => !t.notes).length,
        // Los tres peores son los que hay que mirar en la revision
        worst:     sorted.slice(0, 3).filter(t => t.pnl < 0).map(t => ({
          id: t.id, symbol: t.symbol, side: t.side, pnl: r2(t.pnl),
          r: rMultiple(t) != null ? r2(rMultiple(t)) : null,
          entry_time: t.entry_time, notes: t.notes || null,
        })),
        best:      sorted.slice(-1).filter(t => t.pnl > 0).map(t => ({
          id: t.id, symbol: t.symbol, side: t.side, pnl: r2(t.pnl),
          r: rMultiple(t) != null ? r2(rMultiple(t)) : null,
          entry_time: t.entry_time,
        })),
        rCount: rs.length,
      };
    });
}

export function buildHeatmap(trades) {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl != null && t.category !== 'spot');
  const sums   = Array.from({ length: 24 }, () => Array(7).fill(0));
  const counts = Array.from({ length: 24 }, () => Array(7).fill(0));
  for (const t of closed) {
    const d   = new Date(t.entry_time * 1000);
    const h   = d.getUTCHours();
    const dow = (d.getUTCDay() + 6) % 7;
    sums[h][dow]   += t.pnl;
    counts[h][dow] += 1;
  }
  return sums.map((row, h) =>
    row.map((sum, d) => counts[h][d] > 0 ? r2(sum / counts[h][d]) : null)
  );
}
