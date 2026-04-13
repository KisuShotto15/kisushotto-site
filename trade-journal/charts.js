// charts.js — equity curve (lightweight-charts) + SVG helpers

import { createChart, ColorType, LineType } from 'lightweight-charts';

// ── Equity curve ──────────────────────────────────────────────────────────────
export function drawEquityCurve(container, points) {
  container.innerHTML = '';
  if (!points?.length) {
    container.innerHTML = '<div class="chart-empty">Sin datos suficientes</div>';
    return;
  }

  const chart = createChart(container, {
    layout: {
      background:  { type: ColorType.Solid, color: 'transparent' },
      textColor:   '#666',
    },
    grid: {
      vertLines:   { color: '#1a1a1a' },
      horzLines:   { color: '#1a1a1a' },
    },
    crosshair: { mode: 1 },
    rightPriceScale: { borderColor: '#222' },
    timeScale: { borderColor: '#222', timeVisible: true },
    width:  container.clientWidth,
    height: container.clientHeight || 260,
  });

  const lastV  = points[points.length - 1].v;
  const color  = lastV >= 0 ? '#c8f135' : '#ef4444';
  const series = chart.addAreaSeries({
    lineColor:        color,
    topColor:         color + '44',
    bottomColor:      color + '08',
    lineWidth:        2,
    lineType:         LineType.Simple,
    priceLineVisible: false,
    crosshairMarkerRadius: 4,
  });

  series.setData(points.map(p => ({ time: p.t, value: p.v })));

  // Zero baseline
  series.createPriceLine({ price: 0, color: '#333', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });

  // Responsive resize
  const ro = new ResizeObserver(() => chart.resize(container.clientWidth, container.clientHeight || 260));
  ro.observe(container);
  container._chartInstance = chart;
  container._chartRO = ro;
}

export function destroyChart(container) {
  container._chartRO?.disconnect();
  container._chartInstance?.remove();
}

// ── SVG bar chart ─────────────────────────────────────────────────────────────
// data: [{ label, value, count? }]
export function drawBars(container, data, { height = 36, maxItems = 12 } = {}) {
  container.innerHTML = '';
  if (!data?.length) { container.innerHTML = '<div class="chart-empty">Sin datos</div>'; return; }

  const items = data.slice(0, maxItems);
  const W     = container.clientWidth || 480;
  const gap   = 6;
  const H     = items.length * (height + gap) + 16;
  const PAD_L = 80;
  const PAD_R = 16;
  const IW    = W - PAD_L - PAD_R;
  const maxAbs = Math.max(...items.map(d => Math.abs(d.value)), 0.01);

  let html = '';
  items.forEach((d, i) => {
    const y      = 8 + i * (height + gap);
    const barW   = Math.abs(d.value) / maxAbs * IW * 0.72;
    const isPos  = d.value >= 0;
    const color  = isPos ? '#c8f135' : '#ef4444';
    const label  = String(d.label).slice(0, 10);
    const valStr = d.value >= 0 ? `+${d.value.toFixed(2)}` : d.value.toFixed(2);
    const extra  = d.count != null ? ` (${d.count})` : '';

    html += `
      <text x="${PAD_L - 8}" y="${y + height / 2 + 4}"
        text-anchor="end" fill="#888" font-size="11" font-family="IBM Plex Mono">${label}</text>
      <rect x="${PAD_L}" y="${y}" width="${barW}" height="${height}" fill="${color}" fill-opacity="0.85" rx="3"/>
      <text x="${PAD_L + barW + 6}" y="${y + height / 2 + 4}"
        fill="${color}" font-size="11" font-family="IBM Plex Mono">${valStr}${extra}</text>`;
  });

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', H);
  svg.innerHTML = html;
  container.appendChild(svg);
}

// ── SVG heatmap 24h × 7d ──────────────────────────────────────────────────────
// matrix: 24 rows × 7 cols of avg pnl or null
export function drawHeatmap(container, matrix) {
  container.innerHTML = '';
  if (!matrix?.length) { container.innerHTML = '<div class="chart-empty">Sin datos</div>'; return; }

  const DAYS  = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const W     = container.clientWidth || 560;
  const cellH = 18;
  const cellW = Math.floor((W - 44) / 7);
  const H     = 24 * cellH + 28;

  const allVals = matrix.flat().filter(v => v !== null);
  const maxAbs  = Math.max(...allVals.map(Math.abs), 0.001);

  let html = '';

  // Day headers
  DAYS.forEach((d, i) => {
    html += `<text x="${44 + i * cellW + cellW / 2}" y="13"
      text-anchor="middle" fill="#555" font-size="10" font-family="IBM Plex Mono">${d}</text>`;
  });

  for (let h = 0; h < 24; h++) {
    html += `<text x="38" y="${22 + h * cellH + cellH / 2 + 3}"
      text-anchor="end" fill="#444" font-size="9" font-family="IBM Plex Mono"
      >${String(h).padStart(2, '0')}h</text>`;

    for (let d = 0; d < 7; d++) {
      const v = matrix[h][d];
      const x = 44 + d * cellW;
      const y = 18 + h * cellH;

      if (v === null) {
        html += `<rect x="${x + 1}" y="${y + 1}" width="${cellW - 2}" height="${cellH - 2}" fill="#111" rx="2"/>`;
      } else {
        const intensity = Math.min(Math.abs(v) / maxAbs, 1);
        const color     = v >= 0
          ? `rgba(200,241,53,${(0.1 + intensity * 0.85).toFixed(2)})`
          : `rgba(239,68,68,${(0.1 + intensity * 0.85).toFixed(2)})`;
        html += `<rect x="${x + 1}" y="${y + 1}" width="${cellW - 2}" height="${cellH - 2}" fill="${color}" rx="2"/>`;
        if (intensity > 0.35) {
          html += `<text x="${x + cellW / 2}" y="${y + cellH / 2 + 3}"
            text-anchor="middle" fill="rgba(0,0,0,0.7)" font-size="7" font-family="IBM Plex Mono"
            >${v.toFixed(0)}</text>`;
        }
      }
    }
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', H);
  svg.innerHTML = html;
  container.appendChild(svg);
}

// ── Mini spark bars (win/loss distribution) ───────────────────────────────────
export function drawWinLossBars(container, winRate, tradeCount) {
  container.innerHTML = '';
  if (!tradeCount) { container.innerHTML = '<div class="chart-empty">Sin datos</div>'; return; }
  const W     = container.clientWidth || 320;
  const H     = 20;
  const wW    = W * winRate / 100;
  const lW    = W - wW;
  const svg   = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', H);
  svg.innerHTML = `
    <rect x="0"   y="0" width="${wW}" height="${H}" fill="#c8f135" fill-opacity="0.8" rx="3 0 0 3"/>
    <rect x="${wW}" y="0" width="${lW}" height="${H}" fill="#ef4444" fill-opacity="0.8" rx="0 3 3 0"/>
    <text x="${wW / 2}" y="13" text-anchor="middle" fill="#000" font-size="11" font-family="IBM Plex Mono">${winRate}%</text>
    ${lW > 30 ? `<text x="${wW + lW / 2}" y="13" text-anchor="middle" fill="#fff" font-size="11" font-family="IBM Plex Mono">${(100 - winRate).toFixed(1)}%</text>` : ''}
  `;
  container.appendChild(svg);
}
