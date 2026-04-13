// analytics.js — pure computation, no I/O

function r2(n) { return Math.round(n * 100) / 100; }
function r1(n) { return Math.round(n * 10) / 10; }

export function computeStats(trades) {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl != null);
  if (!closed.length) return emptyStats(trades.length);

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

  const { maxDD, curve } = buildEquityCurve(closed);
  const { current, maxWin, maxLoss } = computeStreaks(closed);

  const withTime  = closed.filter(t => t.exit_time && t.entry_time);
  const avgHoldS  = withTime.length
    ? withTime.reduce((s, t) => s + (t.exit_time - t.entry_time), 0) / withTime.length
    : 0;

  const sorted = [...closed].sort((a, b) => b.pnl - a.pnl);

  return {
    tradeCount:    trades.length,
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
    maxDrawdown:   r1(maxDD),
    currentStreak: current,
    maxWinStreak:  maxWin,
    maxLossStreak: maxLoss,
    bestTrade:     sorted[0]  || null,
    worstTrade:    sorted[sorted.length - 1] || null,
    avgHoldMinutes:Math.round(avgHoldS / 60),
    equityCurve:   curve,
  };
}

function emptyStats(total = 0) {
  return {
    tradeCount: total, closedCount: 0, openCount: total,
    winCount: 0, lossCount: 0, winRate: 0, totalPnl: 0,
    grossProfit: 0, grossLoss: 0, profitFactor: 0,
    avgWin: 0, avgLoss: 0, expectancy: 0, maxDrawdown: 0,
    currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0,
    bestTrade: null, worstTrade: null, avgHoldMinutes: 0,
    equityCurve: [],
  };
}

export function buildEquityCurve(trades) {
  const sorted = [...trades].sort((a, b) => a.entry_time - b.entry_time);
  let balance = 0, peak = 0, maxDD = 0;
  const curve = sorted.map(t => {
    balance += t.pnl;
    if (balance > peak) peak = balance;
    const dd = peak > 0 ? (peak - balance) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    return { t: t.entry_time, v: r2(balance) };
  });
  return { maxDD: r1(maxDD), curve };
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
  for (const t of trades.filter(t => t.status === 'closed' && t.pnl != null)) {
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
  return {
    count:        trades.length,
    winCount:     wins.length,
    winRate:      trades.length ? r1(wins.length / trades.length * 100) : 0,
    totalPnl:     r2(totalPnl),
    avgPnl:       trades.length ? r2(totalPnl / trades.length) : 0,
    profitFactor: gLoss > 0 ? r2(gProfit / gLoss) : (gProfit > 0 ? 99 : 0),
  };
}

export function buildHeatmap(trades) {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl != null);
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
