// health/swipe.js — deslizar horizontalmente para cambiar de pestana. Cada
// pestana vive en un iframe, asi que el gesto se detecta aqui y se avisa al shell.
(function () {
  if (window.parent === window) return;
  let x0 = 0, y0 = 0, t0 = 0, skip = false;

  // No robar el gesto a campos de texto, sliders, modales o zonas que ya
  // se desplazan de lado (p. ej. la fila de dias de Nutricion).
  function blocked(el) {
    for (; el && el !== document.body; el = el.parentElement) {
      if (el.matches?.('input, textarea, select, [contenteditable], .modal-bg.open, .modal-backdrop:not(.hidden), .celebrate, dialog[open]')) return true;
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 2) return true;
    }
    return false;
  }

  addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { skip = true; return; }
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    skip = blocked(e.target);
  }, { passive: true });

  addEventListener('touchend', e => {
    if (skip) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Date.now() - t0 > 600 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    parent.postMessage({ type: 'health:swipe', dir: dx < 0 ? 1 : -1 }, location.origin);
  }, { passive: true });
})();
