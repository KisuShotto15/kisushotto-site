// insights.js — rule-based insight generation

export function generateInsights(trades) {
  if (trades.length < 10) return [];
  const closed = trades
    .filter(t => t.status === 'closed' && t.pnl != null)
    .sort((a, b) => a.entry_time - b.entry_time);
  if (closed.length < 10) return [];

  return [
    ...checkPostLoss(closed),
    ...checkSessionPerf(closed),
    ...checkBadSetups(closed),
    ...checkRevenge(closed),
    ...checkOvertrade(closed),
    ...checkHourPatterns(closed),
    ...checkDayPatterns(closed),
  ];
}

function bwr(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  return trades.length ? wins.length / trades.length : 0;
}

// ── Pattern: post-loss decay ──────────────────────────────────────────────────
function checkPostLoss(sorted) {
  const results = [];
  for (const N of [2, 3]) {
    let streak = 0;
    const nextTrades = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].pnl < 0) streak++;
      else streak = 0;
      if (streak >= N) nextTrades.push(sorted[i + 1]);
    }
    if (nextTrades.length < 4) continue;
    const base = bwr(sorted);
    const post = bwr(nextTrades);
    const drop = base - post;
    if (drop > 0.12) {
      results.push({
        type:     'post_loss_decay',
        title:    `Winrate −${Math.round(drop * 100)}% tras ${N} pérdidas seguidas`,
        description: `Base: ${Math.round(base * 100)}% → Tras ${N}+ pérdidas: ${Math.round(post * 100)}% (${nextTrades.length} trades). Considera pausar.`,
        severity: drop > 0.22 ? 'critical' : 'warning',
        data:     JSON.stringify({ n: N, base, post, sample: nextTrades.length }),
      });
    }
  }
  return results;
}

// ── Pattern: session underperformance ─────────────────────────────────────────
function checkSessionPerf(trades) {
  const base = bwr(trades);
  return ['asia', 'london', 'ny', 'other'].flatMap(session => {
    const st = trades.filter(t => t.session === session);
    if (st.length < 5) return [];
    const wr    = bwr(st);
    const total = st.reduce((s, t) => s + t.pnl, 0);
    if (wr < 0.38 || total < 0) {
      return [{
        type:        'session_underperform',
        title:       `Sesión ${session.toUpperCase()}: ${total < 0 ? 'PnL negativo' : 'winrate bajo'}`,
        description: `${Math.round(wr * 100)}% winrate, PnL total ${total.toFixed(2)} USDT (${st.length} trades). Base: ${Math.round(base * 100)}%.`,
        severity:    total < 0 && wr < 0.38 ? 'critical' : 'warning',
        data:        JSON.stringify({ session, winRate: wr, totalPnl: total, count: st.length }),
      }];
    }
    return [];
  });
}

// ── Pattern: high winrate but negative expectancy (trap setup) ────────────────
function checkBadSetups(trades) {
  const bySetup = new Map();
  for (const t of trades.filter(t => t.setup_tag)) {
    if (!bySetup.has(t.setup_tag)) bySetup.set(t.setup_tag, []);
    bySetup.get(t.setup_tag).push(t);
  }
  return [...bySetup.entries()].flatMap(([setup, group]) => {
    if (group.length < 5) return [];
    const wr  = bwr(group);
    const avg = group.reduce((s, t) => s + t.pnl, 0) / group.length;
    if (wr > 0.5 && avg < 0) {
      return [{
        type:        'trap_setup',
        title:       `Setup "${setup}": alta winrate, expectancy negativa`,
        description: `${Math.round(wr * 100)}% winrate pero promedio ${avg.toFixed(2)} USDT/trade. Las pérdidas son desproporcionadas.`,
        severity:    'critical',
        data:        JSON.stringify({ setup, winRate: wr, avgPnl: avg, count: group.length }),
      }];
    }
    return [];
  });
}

// ── Pattern: revenge trading (size increase after loss) ───────────────────────
function checkRevenge(sorted) {
  const hasSizes = sorted.filter(t => t.size > 0);
  let instances = 0;
  const revenge = [];
  for (let i = 1; i < hasSizes.length; i++) {
    if (hasSizes[i - 1].pnl < 0 && hasSizes[i].size > hasSizes[i - 1].size * 1.5) {
      instances++;
      revenge.push(hasSizes[i]);
    }
  }
  if (instances < 3) return [];
  const rwr = bwr(revenge);
  const base = bwr(sorted);
  return [{
    type:        'revenge_trading',
    title:       `Revenge trading detectado (${instances} instancias)`,
    description: `Aumentaste tamaño >50% tras pérdida ${instances} veces. Winrate en esas entradas: ${Math.round(rwr * 100)}% vs base ${Math.round(base * 100)}%.`,
    severity:    rwr < base - 0.1 ? 'critical' : 'warning',
    data:        JSON.stringify({ instances, revengeWinRate: rwr, baseWinRate: base }),
  }];
}

// ── Pattern: overtrading on bad days ─────────────────────────────────────────
function checkOvertrade(trades) {
  const byDay = new Map();
  for (const t of trades) {
    const day = new Date(t.entry_time * 1000).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }
  const days = [...byDay.values()];
  if (days.length < 3) return [];
  const avgPerDay  = trades.length / days.length;
  const threshold  = Math.max(avgPerDay * 2, 8);
  const overDays   = days.filter(d => d.length > threshold);
  if (!overDays.length) return [];
  const overTrades = overDays.flat();
  const allAvg     = trades.reduce((s, t) => s + t.pnl, 0) / trades.length;
  const overAvg    = overTrades.reduce((s, t) => s + t.pnl, 0) / overTrades.length;
  if (overAvg < allAvg) {
    return [{
      type:        'overtrading',
      title:       `Overtrading correlaciona con peor rendimiento`,
      description: `En ${overDays.length} días con >${Math.round(threshold)} trades, PnL promedio: ${overAvg.toFixed(2)} vs ${allAvg.toFixed(2)} USDT/trade en días normales.`,
      severity:    'warning',
      data:        JSON.stringify({ threshold, overtradeDays: overDays.length, overAvg, allAvg }),
    }];
  }
  return [];
}

// ── Pattern: best / worst hour ────────────────────────────────────────────────
function checkHourPatterns(trades) {
  const byH = Array.from({ length: 24 }, () => []);
  for (const t of trades) byH[new Date(t.entry_time * 1000).getUTCHours()].push(t.pnl);
  const stats = byH
    .map((pnls, h) => ({ h, avg: pnls.length ? pnls.reduce((s, p) => s + p, 0) / pnls.length : null, n: pnls.length }))
    .filter(s => s.avg !== null && s.n >= 3);
  if (!stats.length) return [];
  const results = [];
  const worst = [...stats].sort((a, b) => a.avg - b.avg)[0];
  if (worst.avg < -0.5) {
    results.push({
      type: 'worst_hour', title: `Peor hora: ${worst.h}:00 UTC`,
      description: `Promedio ${worst.avg.toFixed(2)} USDT/trade a las ${worst.h}:00 UTC (${worst.n} trades).`,
      severity: 'warning', data: JSON.stringify(worst),
    });
  }
  const best = [...stats].sort((a, b) => b.avg - a.avg)[0];
  if (best.avg > 0.5) {
    results.push({
      type: 'best_hour', title: `Mejor hora: ${best.h}:00 UTC`,
      description: `Promedio ${best.avg.toFixed(2)} USDT/trade a las ${best.h}:00 UTC (${best.n} trades). Concentra operaciones aquí.`,
      severity: 'info', data: JSON.stringify(best),
    });
  }
  return results;
}

// ── Pattern: best / worst weekday ────────────────────────────────────────────
function checkDayPatterns(trades) {
  const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const byD  = Array.from({ length: 7 }, () => []);
  for (const t of trades) byD[(new Date(t.entry_time * 1000).getUTCDay() + 6) % 7].push(t.pnl);
  const stats = byD
    .map((pnls, i) => ({ day: DAYS[i], avg: pnls.length ? pnls.reduce((s, p) => s + p, 0) / pnls.length : null, n: pnls.length }))
    .filter(s => s.avg !== null && s.n >= 3);
  if (!stats.length) return [];
  const results = [];
  const worst = [...stats].sort((a, b) => a.avg - b.avg)[0];
  if (worst.avg < -0.5) {
    results.push({
      type: 'worst_day', title: `Peor día: ${worst.day}`,
      description: `Promedio ${worst.avg.toFixed(2)} USDT/trade los ${worst.day} (${worst.n} trades). Considera no operar ese día.`,
      severity: 'warning', data: JSON.stringify(worst),
    });
  }
  const best = [...stats].sort((a, b) => b.avg - a.avg)[0];
  if (best.avg > 0.5) {
    results.push({
      type: 'best_day', title: `Mejor día: ${best.day}`,
      description: `Promedio ${best.avg.toFixed(2)} USDT/trade los ${best.day} (${best.n} trades).`,
      severity: 'info', data: JSON.stringify(best),
    });
  }
  return results;
}
