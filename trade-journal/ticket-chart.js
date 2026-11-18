// ticket-chart.js — grafico de velas del ticket con VWAP y bandas, y lineas de
// SL / TP / limite que se arrastran con el mouse o el dedo. Lo alimentan las
// velas que ya trae el terminal (historial + WebSocket): no hace peticiones.

import { createChart, LineStyle, CrosshairMode } from 'lightweight-charts';
import { vwapBands, utcAnchor, nyOpenAnchor } from '../workers/trade-journal-worker/src/indicators.js';
import { nyParts } from '../workers/trade-journal-worker/src/risk.js';

const cssVar = (n, fb) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
const toBar = k => ({ time: Math.floor(k.t / 1000), open: k.o, high: k.h, low: k.l, close: k.c });

// Estilo como el VWAP de TradingView del usuario: fondo casi negro sin cuadricula,
// velas gris claro / violeta, VWAP azul y bandas solidas verde, amarillo y rojo.
const TV = {
  bg: '#0c0c0c', text: '#8a8a8a', border: '#1f1f1f',
  up: '#c7c7cc', down: '#6b3fd4',
  vwap: '#3b6cf6', band: ['#2fa84f', '#e3c430', '#e5484d'],
  volUp: 'rgba(199,199,204,0.35)', volDown: 'rgba(107,63,212,0.55)',
};
const toVol = k => ({ time: Math.floor(k.t / 1000), value: k.v, color: k.c >= k.o ? TV.volUp : TV.volDown });

// Lineas editables (con asa) y lineas fijas de una posicion abierta
const EDITABLE = {
  sl:    { color: () => cssVar('--lv-sl', '#ef4444'),    label: 'SL',     style: LineStyle.Solid },
  tp:    { color: () => cssVar('--lv-tp', '#00c896'),    label: 'TP',     style: LineStyle.Solid },
  entry: { color: () => cssVar('--lv-entry', '#93c5fd'), label: 'LIMITE', style: LineStyle.Dashed },
};

export class TicketChart {
  // labelOf(name, price): HTML del asa; onDrag(name, price) mientras se mueve;
  // onDrop(name, price) al soltar; onRemove(name) al tocar la × del asa.
  // Dentro del asa, un elemento con data-act="add-sl" / "add-tp" crea esa linea
  // en el precio del asa y la empieza a arrastrar (como en TradingView).
  constructor(el, { labelOf, onDrag, onDrop, onRemove }) {
    this.el = el;
    this.labelOf = labelOf;
    this.onDrag = onDrag;
    this.onDrop = onDrop;
    this.onRemove = onRemove;
    this.levels = {};      // nombre -> { price, line, handle }
    this.fixed = [];       // lineas de la posicion abierta
    this.fixedPrices = []; // sus precios, sin la liquidacion (a poco apalancamiento queda muy lejos)
    this.tick = 0.1;

    el.classList.add('tc-chart');
    this.box = document.createElement('div');
    this.box.className = 'tc-chart-canvas';
    this.ov = document.createElement('div');
    this.ov.className = 'tc-chart-ov';
    el.append(this.box, this.ov);

    this.chart = createChart(this.box, {
      layout: { background: { type: 'solid', color: TV.bg }, textColor: TV.text, fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: TV.border, scaleMargins: { top: 0.06, bottom: 0.16 } },
      timeScale: { borderColor: TV.border, timeVisible: true, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });
    // Volumen abajo, en su propia escala, por debajo de las velas
    this.volume = this.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    this.series = this.chart.addCandlestickSeries({
      upColor: TV.up, downColor: TV.down, wickUpColor: TV.up, wickDownColor: TV.down,
      borderUpColor: TV.up, borderDownColor: TV.down, borderVisible: true,
      priceLineVisible: true, priceLineStyle: LineStyle.Dotted, priceLineColor: '#5a5a5a', priceLineWidth: 1,
      // La escala incluye SL, TP, limite y la posicion abierta para que siempre se vean.
      // Mientras se arrastra se usa el precio inicial para que la escala no se mueva bajo el dedo.
      autoscaleInfoProvider: original => {
        const r = original();
        if (!r?.priceRange) return r;
        const ps = [...Object.entries(this.levels).map(([n, l]) => (n === this.dragging ? this.dragFrom : l.price)), ...this.fixedPrices];
        for (const v of ps) {
          if (!(v > 0)) continue;
          r.priceRange.minValue = Math.min(r.priceRange.minValue, v);
          r.priceRange.maxValue = Math.max(r.priceRange.maxValue, v);
        }
        return r;
      },
    });
    const line = (color, width, style) => this.chart.addLineSeries({
      color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    this.vwap = line(TV.vwap, 1, LineStyle.Solid);
    this.bands = [0, 1, 2].map(i => [line(TV.band[i], 1, LineStyle.Solid), line(TV.band[i], 1, LineStyle.Solid)]);

    new ResizeObserver(() => this.place()).observe(this.box);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.place());
    // La escala de precios se ajusta sola con las velas: las asas se reubican seguido
    this.timer = setInterval(() => this.place(), 300);
  }

  setData(candles, anchor, tick) {
    this.tick = tick || this.tick;
    const dec = Math.max(0, -Math.floor(Math.log10(this.tick) + 1e-9));
    this.series.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove: this.tick } });
    this.anchorOf = anchor === 'ny' ? nyOpenAnchor(nyParts) : utcAnchor;
    this.series.setData(candles.map(toBar));
    this.volume.setData(candles.map(toVol));
    this.drawBands(candles);
    this.chart.timeScale().fitContent();
    this.place();
  }

  // Vela en curso o nueva desde el WebSocket
  update(candles) {
    if (!candles?.length) return;
    this.series.update(toBar(candles[candles.length - 1]));
    this.volume.update(toVol(candles[candles.length - 1]));
    this.drawBands(candles);
  }

  drawBands(candles) {
    const b = vwapBands(candles, this.anchorOf);
    // Al reiniciarse el ancla el tramo que une las dos sesiones va transparente
    // (el color de un punto pinta el tramo hacia el siguiente)
    const pt = (x, i, value) => {
      const d = { time: Math.floor(candles[i].t / 1000), value };
      if (i + 1 < candles.length && this.anchorOf(candles[i].t) !== this.anchorOf(candles[i + 1].t)) d.color = 'transparent';
      return d;
    };
    this.vwap.setData(b.map((x, i) => pt(x, i, x.vwap)));
    [1, 2, 3].forEach((n, j) => {
      this.bands[j][0].setData(b.map((x, i) => pt(x, i, x.vwap + n * x.sd)));
      this.bands[j][1].setData(b.map((x, i) => pt(x, i, x.vwap - n * x.sd)));
    });
  }

  // price null quita la linea. ghost: solo la etiqueta, sin linea ni arrastre
  // (la orden a mercado: la etiqueta sigue al precio y sirve para sacar SL y TP)
  setLevel(name, price, { ghost = false } = {}) {
    const def = EDITABLE[name];
    const cur = this.levels[name];
    if (!(price > 0)) {
      if (cur) { this.series.removePriceLine(cur.line); cur.handle.remove(); delete this.levels[name]; }
      return;
    }
    if (cur) {
      cur.price = price;
      if (cur.ghost !== ghost) { cur.ghost = ghost; cur.line.applyOptions({ lineVisible: !ghost, axisLabelVisible: !ghost }); cur.handle.classList.toggle('ghost', ghost); }
      cur.line.applyOptions({ price });
    } else {
      const line = this.series.createPriceLine({
        price, color: def.color(), lineWidth: 1, lineStyle: def.style, axisLabelVisible: !ghost, lineVisible: !ghost, title: '',
      });
      const handle = document.createElement('div');
      handle.className = `tc-handle tc-h-${name}`;
      handle.addEventListener('pointerdown', e => this.pointerDown(e, name));
      this.ov.appendChild(handle);
      handle.classList.toggle('ghost', ghost);
      this.levels[name] = { price, line, handle, ghost };
    }
    this.place();
  }

  // Entrada, SL, TP y liquidacion de una posicion abierta en este simbolo
  setPosition(p) {
    for (const l of this.fixed) this.series.removePriceLine(l);
    this.fixed = [];
    this.fixedPrices = p ? [p.entry, p.stop, p.tp] : [];
    if (!p) return;
    const add = (price, color, title, style) => {
      if (price > 0) this.fixed.push(this.series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    add(p.entry, cssVar('--lv-entry', '#93c5fd'), 'POS', LineStyle.Dotted);
    add(p.stop, cssVar('--lv-sl', '#ef4444'), 'SL pos', LineStyle.Dotted);
    add(p.tp, cssVar('--lv-tp', '#00c896'), 'TP pos', LineStyle.Dotted);
    add(p.liq, cssVar('--lv-liq', '#e879f9'), 'LIQ', LineStyle.Dashed);
  }

  place() {
    for (const [name, lv] of Object.entries(this.levels)) {
      const y = this.series.priceToCoordinate(lv.price);
      const h = this.box.clientHeight;
      if (y == null) { lv.handle.style.display = 'none'; continue; }
      lv.handle.style.display = '';
      // Fuera de la vista el asa queda pegada al borde para poder traerla
      lv.handle.style.top = `${Math.max(10, Math.min(h - 30, y))}px`;
      lv.handle.classList.toggle('off', y < 10 || y > h - 30);
      if (this.dragging !== name) this.paint(name, lv);
    }
  }

  paint(name, lv) {
    const html = name === 'entry' ? this.labelOf(name, lv.price) : `<span>⇕</span>${this.labelOf(name, lv.price)}`;
    if (lv.html !== html) { lv.handle.innerHTML = html; lv.html = html; }
  }

  pointerDown(e, name) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'remove') { e.preventDefault(); e.stopPropagation(); this.onRemove?.(name); return; }
    if (act === 'add-sl' || act === 'add-tp') {
      const target = act === 'add-sl' ? 'sl' : 'tp';
      if (!this.levels[target]) this.setLevel(target, this.levels[name].price);
      this.startDrag(e, target);
      return;
    }
    if (!this.levels[name].ghost) this.startDrag(e, name);
  }

  startDrag(e, name) {
    e.preventDefault();
    e.stopPropagation();
    const lv = this.levels[name];
    const h = lv.handle;
    h.setPointerCapture(e.pointerId);
    this.dragging = name;
    this.dragFrom = lv.price;
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    h.classList.add('drag');
    const rect = this.box.getBoundingClientRect();
    const move = ev => {
      const y = ev.clientY - rect.top;
      const raw = this.series.coordinateToPrice(y);
      if (!(raw > 0)) return;
      const price = +(Math.round(raw / this.tick) * this.tick).toFixed(10);
      lv.price = price;
      lv.line.applyOptions({ price });
      h.style.top = `${Math.max(10, Math.min(this.box.clientHeight - 30, y))}px`;
      this.paint(name, lv);
      this.onDrag?.(name, price);
    };
    const end = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', end);
      h.removeEventListener('pointercancel', end);
      h.classList.remove('drag');
      this.dragging = null;
      this.chart.applyOptions({ handleScroll: true, handleScale: true });
      this.onDrop?.(name, lv.price);
      this.place();
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }

  lastPrice() {
    const d = this.series.data?.();
    return d?.length ? d[d.length - 1].close : null;
  }
}
