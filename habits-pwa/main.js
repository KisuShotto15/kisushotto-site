import { getHabits, createHabit, updateHabit, deleteHabit, getCompletions, toggleComplete, setComplete, getStats, getUserEmail } from './api.js?v=18';

// Push is optional and loaded lazily so a missing push.js never blocks page load.
async function ensurePushSubscription() {
  try {
    const m = await import('./push.js?v=18');
    return await m.ensurePushSubscription();
  } catch { /* push optional */ }
}

// ── State ─────────────────────────────────────────────────────────────────────
let habits        = [];
let completions   = {};   // { 'YYYY-MM-DD': { habitId: value } }
let notes         = {};   // { 'YYYY-MM-DD': { habitId: noteText } }
let loadedMonths  = new Set();
let calYear       = 0;
let calMonth      = 0;    // 1-12
let calDaily      = {};   // { 'YYYY-MM-DD': pct }
const calDailyCache = {};  // { 'YYYY-MM': { 'YYYY-MM-DD': pct } }
let editingId     = null;
let reminderTimers = [];
let selectedDate = '';  // '' = today (set in init)

const COLORS = {
  lavender: '#c4b5fd',
  mint:     '#6ee7b7',
  coral:    '#fca5a5',
  amber:    '#fcd34d',
  sky:      '#7dd3fc',
  rose:     '#f9a8d4',
  lime:     '#bef264',
  orange:   '#fdba74',
  teal:     '#5eead4',
  indigo:   '#818cf8',
  pink:     '#f472b6',
  slate:    '#94a3b8',
};

// ── Utils ─────────────────────────────────────────────────────────────────────
const $     = id => document.getElementById(id);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

function toast(msg, type = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

function dateStr(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

const ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);
}

// ── Frequency helpers ─────────────────────────────────────────────────────────
function isDueOn(habit, dateISO) {
  const d   = new Date(dateISO + 'T00:00:00');
  const dow = d.getDay(); // 0=Sun

  if (habit.frequency === 'daily') return true;

  if (habit.frequency === 'weekly') {
    const days = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1,2,3,4,5];
    return days.includes(dow);
  }

  if (habit.frequency === 'custom') {
    const every  = habit.frequency_every || 1;
    const fd     = habit.frequency_days ? JSON.parse(habit.frequency_days) : [];
    const origin = fd[0] ? new Date(fd[0] + 'T00:00:00') : new Date(habit.created_at * 1000);
    const diff   = Math.floor((d - origin) / 86400000);
    return diff >= 0 && diff % every === 0;
  }

  if (habit.frequency === 'monthly') {
    const days = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1];
    return days.includes(d.getDate());
  }

  if (habit.frequency === 'every_n_months') {
    const every  = habit.frequency_every || 3;
    const day    = habit.frequency_days ? JSON.parse(habit.frequency_days)[0] : 1;
    if (d.getDate() !== day) return false;
    const origin      = new Date(habit.created_at * 1000);
    const originMonth = origin.getFullYear() * 12 + origin.getMonth();
    const checkMonth  = d.getFullYear() * 12 + d.getMonth();
    return (checkMonth - originMonth) % every === 0;
  }

  if (habit.frequency === 'yearly') {
    const [m, day] = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1, 1];
    return d.getMonth() + 1 === m && d.getDate() === day;
  }

  return true;
}

function freqLabel(habit) {
  if (habit.frequency === 'daily') return 'Diario';
  if (habit.frequency === 'weekly') {
    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const days = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1,2,3,4,5];
    return days.map(d => DAYS[d]).join(' ');
  }
  if (habit.frequency === 'custom') return `Cada ${habit.frequency_every} días`;
  if (habit.frequency === 'monthly') {
    const days = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1];
    return `Mensual · día ${days.join(', ')}`;
  }
  if (habit.frequency === 'every_n_months') {
    const every = habit.frequency_every || 3;
    const day   = habit.frequency_days ? JSON.parse(habit.frequency_days)[0] : 1;
    return `Cada ${every} meses · día ${day}`;
  }
  if (habit.frequency === 'yearly') {
    const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const [m, day] = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1, 1];
    return `Anual · ${day} ${MONTHS[m - 1]}`;
  }
  return '';
}

// ── Streak calculation ────────────────────────────────────────────────────────
// Streak is computed server-side over the full history (habit.streak).
function calcStreak(habit) {
  return habit?.streak ?? 0;
}

function bestStreakAll() {
  if (!habits.length) return 0;
  return Math.max(0, ...habits.map(calcStreak));
}

// ── Completion helpers ────────────────────────────────────────────────────────
function isDone(habitId, date = today()) {
  const v = completions[date]?.[habitId];
  if (v == null) return false;
  const h = habits.find(x => x.id === habitId);
  return h && h.type === 'count' ? v >= (h.target_value || 1) : v > 0;
}
function getValue(habitId, date = today()) {
  return completions[date]?.[habitId] ?? 0;
}
function setLocal(habitId, date, value) {
  if (!completions[date]) completions[date] = {};
  if (value == null || value <= 0) delete completions[date][habitId];
  else completions[date][habitId] = value;
}

// ── Today stats ───────────────────────────────────────────────────────────────
function todayStats() {
  const t    = selectedDate;
  const due  = habits.filter(h => !h.paused && isDueOn(h, t));
  const done = due.filter(h => isDone(h.id, t));
  const pct  = due.length ? Math.round(done.length / due.length * 100) : 0;
  return { due: due.length, done: done.length, pct };
}

// ── Render: today checklist ───────────────────────────────────────────────────
function renderToday() {
  const t = selectedDate;
  const d = new Date(t + 'T12:00:00');
  const isToday = t === today();
  const yDate = new Date(); yDate.setDate(yDate.getDate() - 1);
  const yesterdayISO = dateStr(yDate.getFullYear(), yDate.getMonth() + 1, yDate.getDate());
  const isYesterday = t === yesterdayISO;
  const dateText = isToday ? 'Hoy' : isYesterday ? 'Ayer' : d.toLocaleDateString('es', { weekday:'long', day:'numeric', month:'long' });
  $('todayDate').innerHTML = isToday
    ? dateText
    : `${dateText} <button onclick="selectDate('${today()}')" style="margin-left:8px;background:rgba(196,181,253,0.12);border:1px solid var(--accent);border-radius:5px;color:var(--accent);font-size:11px;padding:2px 8px;cursor:pointer;font-family:'IBM Plex Mono',monospace">Hoy →</button>`;

  const { due, done, pct } = todayStats();
  $('progressLabel').textContent = `${done} de ${due} hábitos`;
  $('progressPct').textContent   = `${pct}%`;
  $('progressFill').style.width  = `${pct}%`;
  $('todayPct').textContent      = `${pct}%`;
  $('statToday').textContent     = `${done}/${due}`;

  const dueHabits = habits.filter(h => !h.paused && isDueOn(h, t));

  const list = $('habitList');
  if (!habits.length) {
    list.innerHTML = `<div class="habits-empty"><div class="habits-empty-icon">🌱</div>Sin hábitos aún.<br>Usa el botón + para crear el primero.</div>`;
    return;
  }
  if (!dueHabits.length) {
    list.innerHTML = `<div class="habits-empty"><div class="habits-empty-icon">✓</div>Sin hábitos para hoy.</div>`;
    return;
  }

  list.innerHTML = dueHabits.map(h => {
    const color   = COLORS[h.color] || COLORS.lavender;
    const done_   = isDone(h.id, t);
    const streak  = calcStreak(h);
    const overdue = h.reminder_time && !done_ && isOverdue(h.reminder_time);

    const streakHtml  = streak > 0
      ? `<span class="habit-streak ${streak >= 7 ? 'hot' : ''}">🔥 ${streak}</span>`
      : '';
    const reminderInline = overdue
      ? `<span class="reminder-inline">⏰ ${h.reminder_time}</span>`
      : '';

    const noteVal = notes[t]?.[h.id];
    const canNote = h.type === 'count' ? getValue(h.id, t) > 0 : done_;
    const noteBtn = canNote
      ? `<button onclick="event.stopPropagation();openNote('${h.id}')" title="${noteVal ? esc(noteVal) : 'Agregar nota'}" style="background:none;border:none;cursor:pointer;font-size:14px;opacity:${noteVal ? '1' : '0.32'};flex-shrink:0;padding:0 2px">📝</button>`
      : '';

    let rightSide = '';
    if (h.type === 'count') {
      const val = getValue(h.id, t);
      const target = h.target_value || 1;
      const isDoneCount = val >= target;
      rightSide = `
        <div class="habit-counter" onclick="event.stopPropagation()">
          <button class="counter-btn" onclick="adjustCount('${h.id}',-1)">−</button>
          <span class="counter-val">${val}${isDoneCount ? `<span style="color:var(--mint)">✓</span>` : `/${target}`}<span style="font-size:9px;color:var(--muted);margin-left:2px">${esc(h.target_unit||'')}</span></span>
          <button class="counter-btn" onclick="adjustCount('${h.id}',+1)">+</button>
        </div>`;
    } else {
      rightSide = streakHtml;
    }

    return `
      <div class="habit-row ${done_ ? 'done' : ''}"
           data-hid="${h.id}"
           style="--habit-color:${color}"
           onclick="onHabitClick('${h.id}')">
        <div class="habit-pill"></div>
        <div class="habit-check"></div>
        <span class="habit-emoji">${esc(h.emoji || '✓')}</span>
        <div class="habit-info">
          <div class="habit-name">${esc(h.name)}</div>
          <div class="habit-freq">${h.description ? esc(h.description) : freqLabel(h)}${reminderInline}</div>
        </div>
        ${noteBtn}
        ${rightSide}
      </div>`;
  }).join('');
}

function isOverdue(reminderTime) {
  const [h, m] = reminderTime.split(':').map(Number);
  const now    = new Date();
  return now.getHours() > h || (now.getHours() === h && now.getMinutes() > m);
}

// ── Render: manage list ───────────────────────────────────────────────────────
function renderManage() {
  const el = $('manageList');
  if (!habits.length) {
    el.innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--muted);padding:12px 0">Sin hábitos aún.</div>`;
    return;
  }
  el.innerHTML = habits.map(h => {
    const color   = COLORS[h.color] || COLORS.lavender;
    const streak  = h.streak ?? 0;
    const record  = h.record_streak ?? 0;
    const rate    = h.rate30 ?? 0;
    const pausedTag = h.paused ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--amber);border:1px solid var(--amber);border-radius:4px;padding:1px 4px">pausado</span>` : '';
    const meta = `🔥 ${streak} · récord ${record} · ${rate}%`;
    return `
      <div class="manage-row" data-hid="${h.id}" draggable="true"
           ondragstart="onManageDragStart(event,'${h.id}')"
           ondragover="onManageDragOver(event)"
           ondragenter="onManageDragEnter(event)"
           ondragleave="onManageDragLeave(event)"
           ondrop="onManageDrop(event,'${h.id}')"
           ondragend="onManageDragEnd(event)"
           style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--card2);border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:border-color 0.2s${h.paused ? ';opacity:0.5' : ''}"
           onclick="openPanelById('${h.id}')">
        <span style="color:var(--muted2);font-size:14px;cursor:grab" onclick="event.stopPropagation()">⠿</span>
        <span style="font-size:18px;line-height:1">${esc(h.emoji || '✓')}</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600">${esc(h.name)}${pausedTag}</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--muted2);margin-top:2px">${freqLabel(h)} · ${meta}</div>
        </div>
        <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block"></span>
      </div>`;
  }).join('');
}

// ── Drag & drop reorder (manage list) ─────────────────────────────────────────
let manageDragId = null;
window.onManageDragStart = function(e, id) { manageDragId = id; e.dataTransfer.effectAllowed = 'move'; };
window.onManageDragOver  = function(e) { e.preventDefault(); };
window.onManageDragEnter = function(e) { e.currentTarget.style.borderColor = 'var(--accent)'; };
window.onManageDragLeave = function(e) { e.currentTarget.style.borderColor = 'var(--border)'; };
window.onManageDragEnd   = function(e) { e.currentTarget.style.borderColor = 'var(--border)'; };
window.onManageDrop = function(e, targetId) {
  e.preventDefault();
  e.currentTarget.style.borderColor = 'var(--border)';
  const id = manageDragId;
  manageDragId = null;
  if (!id || id === targetId) return;
  const fromIdx = habits.findIndex(h => h.id === id);
  const toIdx   = habits.findIndex(h => h.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = habits.splice(fromIdx, 1);
  habits.splice(toIdx, 0, moved);
  habits.forEach((h, i) => {
    if (h.sort_order !== i) { h.sort_order = i; updateHabit(h.id, { sort_order: i }).catch(() => {}); }
  });
  renderManage();
};

// ── Render: stats ─────────────────────────────────────────────────────────────
function renderStats() {
  $('statStreak').textContent = bestStreakAll() || '—';
  const values = Object.values(calDaily).filter(v => v > 0);
  const monthAvg = values.length
    ? Math.round(values.reduce((s,v) => s+v, 0) / Object.keys(calDaily).length)
    : 0;
  $('statMonth').textContent = Object.keys(calDaily).length ? monthAvg + '%' : '—';
}

// ── Calendar heatmap ──────────────────────────────────────────────────────────
function isPerfectDay(iso) {
  const due = habits.filter(h => !h.paused && isDueOn(h, iso));
  return due.length > 0 && due.every(h => isDone(h.id, iso));
}

function renderCalendar() {
  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  $('calMonth').textContent = `${MONTHS[calMonth - 1]} ${calYear}`;

  const todayISO = today();
  const firstDay = new Date(calYear, calMonth - 1, 1);
  let startDow   = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const prevDays    = new Date(calYear, calMonth - 1, 0).getDate();

  const grid = $('calGrid');
  grid.innerHTML = '';

  for (let i = startDow - 1; i >= 0; i--) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell other-month';
    cell.innerHTML = `<span class="cal-cell-num">${prevDays - i}</span>`;
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const iso  = dateStr(calYear, calMonth, d);
    const pct  = calDaily[iso] ?? null;
    const cell = document.createElement('div');
    const isSelected = iso === selectedDate && iso !== todayISO;
    cell.className = `cal-cell${iso === todayISO ? ' today' : ''}${isSelected ? ' selected' : ''}`;

    if (pct !== null) {
      cell.style.background = pct === 0
        ? 'var(--border2)'
        : `rgba(196,181,253,${(0.12 + (pct / 100) * 0.78).toFixed(2)})`;
    }

    cell.title = `${iso}: ${pct !== null ? pct + '%' : 'sin datos'}`;
    cell.innerHTML = `<span class="cal-cell-num">${d}</span>${isPerfectDay(iso) ? '<span class="cal-perfect">✦</span>' : ''}`;
    if (iso <= todayISO) {
      cell.style.cursor = 'pointer';
      cell.onclick = () => selectDate(iso);
    }
    grid.appendChild(cell);
  }

  const total     = startDow + daysInMonth;
  const remaining = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let d = 1; d <= remaining; d++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell other-month';
    cell.innerHTML = `<span class="cal-cell-num">${d}</span>`;
    grid.appendChild(cell);
  }
}

// ── Habit interactions ────────────────────────────────────────────────────────
window.selectDate = async function(iso) {
  selectedDate = iso;
  const m = iso.slice(0, 7);
  if (!loadedMonths.has(m)) {
    await loadCompletions(m);
  }
  renderCalendar();
  renderToday();
};

window.onHabitClick = async function(id) {
  const habit = habits.find(h => h.id === id);
  if (!habit || habit.type === 'count') return;

  const t      = selectedDate;
  const wasDone = isDone(id, t);
  setLocal(id, t, wasDone ? null : 1);
  if (wasDone && notes[t]) delete notes[t][id];
  renderToday();
  if (!wasDone) {
    const check = document.querySelector(`[data-hid="${id}"] .habit-check`);
    if (check) { check.classList.add('pop'); check.addEventListener('animationend', () => check.classList.remove('pop'), { once: true }); }
  }

  try {
    await toggleComplete({ habit_id: id, date: t });
    if (t === today() && isDueOn(habit, t)) {
      habit.streak = Math.max(0, (habit.streak ?? 0) + (wasDone ? -1 : 1));
    } else {
      try { const { habits: hh } = await getHabits(today()); habits = hh; } catch {}
    }
    delete calDailyCache[t.slice(0, 7)];
    await loadCalMonth();
    renderToday();
    renderCalendar();
    renderStats();
  } catch (e) {
    setLocal(id, t, wasDone ? 1 : null);
    renderToday();
    toast(e.message, 'err');
  }
};

window.adjustCount = async function(id, delta) {
  const habit  = habits.find(h => h.id === id);
  if (!habit) return;
  const t      = selectedDate;
  const oldVal = getValue(id, t);
  const newVal = Math.max(0, oldVal + delta);

  setLocal(id, t, newVal || null);
  renderToday();

  try {
    await setComplete({ habit_id: id, date: t, value: newVal });
    if ((oldVal > 0) !== (newVal > 0)) {
      if (t === today() && isDueOn(habit, t)) {
        habit.streak = Math.max(0, (habit.streak ?? 0) + (newVal > 0 ? 1 : -1));
      } else {
        try { const { habits: hh } = await getHabits(today()); habits = hh; } catch {}
      }
    }
    delete calDailyCache[t.slice(0, 7)];
    await loadCalMonth();
    renderToday();
    renderCalendar();
    renderStats();
  } catch (e) {
    setLocal(id, t, oldVal || null);
    renderToday();
    toast(e.message, 'err');
  }
};

// ── Calendar navigation ───────────────────────────────────────────────────────
window.shiftMonth = function(dir) {
  const now = new Date();
  if (dir > 0 && calYear === now.getFullYear() && calMonth === now.getMonth() + 1) return;

  const exitClass  = dir > 0 ? 'exit-left'       : 'exit-right';
  const enterClass = dir > 0 ? 'enter-from-right' : 'enter-from-left';
  const grid = document.getElementById('calGrid');
  grid.classList.remove('enter-from-right', 'enter-from-left');
  grid.classList.add(exitClass);

  setTimeout(() => {
    calMonth += dir;
    if (calMonth > 12) { calMonth = 1;  calYear++; }
    if (calMonth < 1)  { calMonth = 12; calYear--; }
    renderCalendar();
    renderStats();
    const g = document.getElementById('calGrid');
    g.classList.remove('exit-left', 'exit-right', 'enter-from-right', 'enter-from-left');
    void g.offsetWidth;
    g.classList.add(enterClass);
    g.addEventListener('animationend', () => g.classList.remove(enterClass), { once: true });
    loadCalMonth().then(() => { renderCalendar(); renderStats(); });
  }, 185);
};

// ── Panel: add/edit habit ─────────────────────────────────────────────────────
window.openPanelById = function(id) {
  const habit = habits.find(h => h.id === id);
  if (habit) window.openPanel(habit);
};

window.openPanel = function(habit) {
  editingId = habit?.id ?? null;
  $('panelTitle').textContent = habit ? 'EDITAR HÁBITO' : 'NUEVO HÁBITO';

  $('fName').value      = habit?.name          || '';
  const emoji = habit?.emoji || '🔥';
  $('fEmoji').value     = emoji;
  $('emojiBtn').textContent = emoji;
  $('fType').value      = habit?.type          || 'binary';
  $('fTarget').value    = habit?.target_value  ?? 1;
  $('fUnit').value      = habit?.target_unit   || '';
  $('fFreq').value      = habit?.frequency     || 'daily';
  $('fEvery').value     = habit?.frequency_every ?? 2;

  const fd = habit?.frequency_days ? JSON.parse(habit.frequency_days) : [];
  const customStart = habit?.frequency === 'custom' && fd[0] ? fd[0] : today();
  $('fCustomStart').value = customStart;
  $('fMonthDay').value      = habit?.frequency === 'monthly'        ? (fd[0] ?? 1)  : 1;
  $('fNMonths').value       = habit?.frequency === 'every_n_months' ? (habit.frequency_every ?? 3) : 3;
  $('fNMonthsDay').value    = habit?.frequency === 'every_n_months' ? (fd[0] ?? 1)  : 1;
  $('fYearMonth').value     = habit?.frequency === 'yearly'         ? (fd[0] ?? 1)  : 1;
  $('fYearDay').value       = habit?.frequency === 'yearly'         ? (fd[1] ?? 1)  : 1;
  $('fReminder').value  = habit?.reminder_time || '';
  $('fDesc').value      = habit?.description   || '';

  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === (habit?.color || 'lavender'));
  });

  const activeDays = habit?.frequency_days ? JSON.parse(habit.frequency_days) : [1,2,3,4,5];
  document.querySelectorAll('.wd-btn').forEach(b => {
    b.classList.toggle('active', activeDays.includes(parseInt(b.dataset.day)));
  });

  $('btnDelete').classList.toggle('hidden', !editingId);
  const pauseBtn = $('btnPause');
  pauseBtn.classList.toggle('hidden', !editingId);
  pauseBtn.textContent = habit?.paused ? 'Reanudar' : 'Pausar';
  onTypeChange();
  onFreqChange();

  $('panelBackdrop').classList.remove('hidden');
  requestAnimationFrame(() => $('sidePanel').classList.add('open'));
  setTimeout(() => $('fName').focus(), 150);
};

window.closePanel = function() {
  $('sidePanel').classList.remove('open');
  $('panelBackdrop').classList.add('hidden');
  $('emojiPicker').style.display = 'none';
  editingId = null;
};

window.toggleEmojiPicker = function() {
  const p = $('emojiPicker');
  // Move to body to escape the panel's CSS transform containing block
  if (p.parentElement !== document.body) document.body.appendChild(p);
  if (p.style.display === 'grid') { p.style.display = 'none'; return; }
  const rect = $('emojiBtn').getBoundingClientRect();
  p.style.top  = (rect.bottom + 4) + 'px';
  p.style.left = Math.min(rect.left, window.innerWidth - 236) + 'px';
  p.style.display = 'grid';
};

window.pickEmoji = function(e) {
  $('fEmoji').value = e;
  $('emojiBtn').textContent = e;
  $('emojiPicker').style.display = 'none';
};

window.selectColor = function(el) {
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
};

window.onTypeChange = function() {
  $('countFields').style.display = $('fType').value === 'count' ? 'block' : 'none';
};

window.onFreqChange = function() {
  const v = $('fFreq').value;
  $('weeklyFields').style.display        = v === 'weekly'         ? 'block' : 'none';
  $('customFields').style.display        = v === 'custom'         ? 'block' : 'none';
  $('monthlyFields').style.display       = v === 'monthly'        ? 'block' : 'none';
  $('everyNMonthsFields').style.display  = v === 'every_n_months' ? 'block' : 'none';
  $('yearlyFields').style.display        = v === 'yearly'         ? 'block' : 'none';
};

window.saveHabit = async function() {
  const name = $('fName').value.trim();
  if (!name) { toast('El nombre es obligatorio', 'err'); return; }

  const selectedColor = document.querySelector('.color-swatch.active')?.dataset.color || 'lavender';
  const activeDays    = [...document.querySelectorAll('.wd-btn.active')].map(b => parseInt(b.dataset.day));

  const body = {
    name,
    emoji:           $('fEmoji').value.trim()     || '✓',
    color:           selectedColor,
    type:            $('fType').value,
    target_value:    parseFloat($('fTarget').value) || 1,
    target_unit:     $('fUnit').value.trim()        || 'veces',
    frequency:       $('fFreq').value,
    frequency_days:  $('fFreq').value === 'weekly'         ? activeDays
                   : $('fFreq').value === 'monthly'        ? [parseInt($('fMonthDay').value) || 1]
                   : $('fFreq').value === 'every_n_months' ? [parseInt($('fNMonthsDay').value) || 1]
                   : $('fFreq').value === 'yearly'         ? [parseInt($('fYearMonth').value) || 1, parseInt($('fYearDay').value) || 1]
                   : $('fFreq').value === 'custom'         ? [$('fCustomStart').value || today()]
                   : null,
    frequency_every: $('fFreq').value === 'every_n_months' ? (parseInt($('fNMonths').value) || 3)
                   : $('fFreq').value === 'custom'         ? (parseInt($('fEvery').value)   || 2)
                   : null,
    reminder_time:   $('fReminder').value           || null,
    tz:              Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    description:     $('fDesc').value.trim()        || null,
  };

  try {
    if (editingId) await updateHabit(editingId, body);
    else           await createHabit(body);
    toast(editingId ? 'Hábito actualizado' : '¡Hábito creado!');
    if (body.reminder_time) ensurePushSubscription().catch(() => {});
    closePanel();
    await init();
  } catch (e) {
    toast(e.message, 'err');
  }
};

window.togglePause = async function() {
  if (!editingId) return;
  const habit = habits.find(h => h.id === editingId);
  if (!habit) return;
  const newPaused = habit.paused ? 0 : 1;
  habit.paused = newPaused;
  closePanel();
  renderToday(); renderManage(); renderCalendar(); setupReminders();
  try {
    await updateHabit(habit.id, { paused: newPaused });
    toast(newPaused ? 'Hábito pausado' : 'Hábito reanudado');
  } catch (e) {
    habit.paused = newPaused ? 0 : 1;
    renderToday(); renderManage();
    toast(e.message, 'err');
  }
};

window.confirmDelete = async function() {
  if (!editingId) return;
  if (!(await window.customConfirm('¿Eliminar este hábito?'))) return;
  const idToDelete = editingId;
  closePanel();
  habits = habits.filter(h => h.id !== idToDelete);
  renderToday();
  renderManage();
  try {
    await deleteHabit(idToDelete);
    toast('Hábito eliminado');
  } catch (e) {
    toast(e.message, 'err');
  }
  await init();
};

// ── Weekday picker toggle ─────────────────────────────────────────────────────
document.addEventListener('click', e => {
  if (e.target.classList.contains('wd-btn')) {
    e.target.classList.toggle('active');
  }
});

// ── Notification history ──────────────────────────────────────────────────────
const NOTIF_KEY = 'habits_notifications';
function getNotifHistory() {
  try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]'); } catch { return []; }
}
function pushNotif(title, body) {
  const history = getNotifHistory();
  history.unshift({ title, body, time: Date.now(), read: false });
  if (history.length > 50) history.length = 50;
  localStorage.setItem(NOTIF_KEY, JSON.stringify(history));
  updateNotifBadge();
}
function updateNotifBadge() {
  const badge = $('notifBadge');
  if (!badge) return;
  const unread = getNotifHistory().filter(n => !n.read).length;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.classList.toggle('hidden', unread === 0);
}
window.toggleNotifDrawer = function() {
  const drawer = $('notifDrawer');
  if (drawer.classList.contains('hidden')) {
    renderNotifDrawer();
    drawer.classList.remove('hidden');
    const history = getNotifHistory().map(n => ({ ...n, read: true }));
    localStorage.setItem(NOTIF_KEY, JSON.stringify(history));
    updateNotifBadge();
  } else {
    drawer.classList.add('hidden');
  }
};
window.closeNotifDrawer = function() {
  $('notifDrawer').classList.add('hidden');
};
function showNotif(title, body) {
  if (Notification.permission !== 'granted') return;
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready.then(reg => reg.showNotification(title, { body, icon: '/icons/icon-192x192.png' }));
  } else {
    new Notification(title, { body });
  }
}

window.testNotification = function() {
  const title = '🔔 Test de notificación';
  const body  = 'Las notificaciones están funcionando correctamente';
  pushNotif(title, body);
  if (Notification.permission === 'granted') {
    showNotif(title, body);
  } else {
    toast('Activa las notificaciones primero con el banner superior');
  }
  renderNotifDrawer();
};
function renderNotifDrawer() {
  const list = $('notifList');
  const history = getNotifHistory();
  if (!history.length) {
    list.innerHTML = '<div class="notif-empty">Sin notificaciones aún</div>';
    return;
  }
  list.innerHTML = history.map(n => {
    const d = new Date(n.time);
    const time = d.toLocaleString('es', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<div class="notif-item${n.read ? '' : ' unread'}">
      <div class="notif-item-title">${n.title}</div>
      <div class="notif-item-body">${n.body}</div>
      <div class="notif-item-time">${time}</div>
    </div>`;
  }).join('');
}

// ── Notifications ─────────────────────────────────────────────────────────────
function checkNotifBanner() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    $('notifBanner').classList.add('hidden');
    setupReminders();
  } else if (Notification.permission === 'default') {
    $('notifBanner').classList.remove('hidden');
  }
}

function initNotifications() {
  if (!('Notification' in window)) return;
  checkNotifBanner();
  const btn = document.getElementById('notifActivarBtn');
  if (btn) btn.addEventListener('click', () => requestNotifPermission());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkNotifBanner();
  });
  updateNotifBadge();
}

window.requestNotifPermission = async function() {
  try {
    $('notifBanner').classList.add('hidden');
    if (!('Notification' in window)) {
      toast('Notificaciones no disponibles', 'err'); return;
    }
    let perm = Notification.permission;
    if (perm === 'default') {
      toast('Solicitando permiso...', 'ok');
      try {
        perm = await Promise.race([
          Notification.requestPermission(),
          new Promise(r => setTimeout(() => r('timeout'), 6000)),
        ]);
      } catch { perm = 'denied'; }
    }
    if (perm === 'granted') {
      toast('Notificaciones activadas ✓');
      setupReminders();
      ensurePushSubscription().catch(() => {});
    } else if (perm === 'denied') {
      toast('Notificaciones bloqueadas en ajustes del navegador', 'err');
    } else {
      toast('Permiso pendiente — reabre la app', 'err');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'err');
  }
};

function setupReminders() {
  reminderTimers.forEach(clearTimeout);
  reminderTimers = [];
  if (Notification.permission !== 'granted') return;

  const t = today();
  for (const habit of habits) {
    if (habit.paused || !habit.reminder_time || !isDueOn(habit, t) || isDone(habit.id, t)) continue;

    const [rh, rm] = habit.reminder_time.split(':').map(Number);
    const fire  = new Date(); fire.setHours(rh, rm, 0, 0);
    const ms    = fire - Date.now();

    // Only log to the in-app drawer; the actual system notification is delivered
    // by the server-side push (cron) to avoid double notifications.
    if (ms > 0) {
      reminderTimers.push(setTimeout(() => {
        if (!isDone(habit.id, today())) {
          pushNotif(`${habit.emoji || '⏰'} ${habit.name}`, habit.description || '¡Es hora de completar tu hábito!');
        }
      }, ms));
    } else if (ms > -3600000) {
      pushNotif(`${habit.emoji || '⏰'} ${habit.name}`, `Recordatorio perdido — ${habit.reminder_time}`);
    }
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadCompletions(monthStr) {
  const m = monthStr || today().slice(0, 7);
  if (loadedMonths.has(m)) return;
  loadedMonths.add(m);
  const from = m + '-01';
  const to   = m + '-31';
  const { completions: rows } = await getCompletions({ from, to });
  for (const r of rows) {
    if (!completions[r.date]) completions[r.date] = {};
    completions[r.date][r.habit_id] = r.value;
    if (r.note) { (notes[r.date] ||= {})[r.habit_id] = r.note; }
  }
}

async function loadCalMonth(force = false) {
  const monthStr = `${calYear}-${String(calMonth).padStart(2,'0')}`;
  if (!force && calDailyCache[monthStr] !== undefined) {
    calDaily = calDailyCache[monthStr];
    return;
  }
  try {
    const { daily } = await getStats({ month: monthStr });
    calDailyCache[monthStr] = daily || {};
    calDaily = calDailyCache[monthStr];
  } catch { calDaily = {}; }
}

// One-time: existing habits with a reminder but no tz were created before tz tracking.
// Patch them to the browser tz so the cron fires at the correct local time.
function backfillTz() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!tz) return;
  for (const h of habits) {
    if (h.reminder_time && !h.tz) {
      h.tz = tz;
      updateHabit(h.id, { tz }).catch(() => {});
    }
  }
}

async function init() {
  if (!getUserEmail()) { showLogin(); return; }

  const now = new Date();
  calYear      = now.getFullYear();
  calMonth     = now.getMonth() + 1;
  selectedDate = today();

  completions  = {};
  notes        = {};
  loadedMonths = new Set();

  const currMonth  = today().slice(0, 7);
  const prev1Date  = new Date(now.getFullYear(), now.getMonth(), 0);
  const prev1Month = `${prev1Date.getFullYear()}-${String(prev1Date.getMonth()+1).padStart(2,'0')}`;
  const prev2Date  = new Date(prev1Date.getFullYear(), prev1Date.getMonth(), 0);
  const prev2Month = `${prev2Date.getFullYear()}-${String(prev2Date.getMonth()+1).padStart(2,'0')}`;

  try {
    const [{ habits: h }] = await Promise.all([
      getHabits(today()),
      loadCompletions(currMonth),
      loadCompletions(prev1Month),
      loadCompletions(prev2Month),
    ]);
    habits = h;
    await loadCalMonth();
    backfillTz();
  } catch (e) {
    toast('Error cargando datos: ' + e.message, 'err');
    habits = [];
  }

  renderToday();
  const listEl = document.getElementById('habitList');
  listEl.classList.add('entering');
  setTimeout(() => listEl.classList.remove('entering'), 700);
  renderManage();
  renderCalendar();
  renderStats();
  initNotifications();
  setupReminders();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closePanel(); return; }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const dir = e.key === 'ArrowRight' ? 1 : -1;
  const cur = new Date((selectedDate || today()) + 'T00:00:00');
  cur.setDate(cur.getDate() + dir);
  const next = dateStr(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
  if (next > today()) return;
  const listEl     = document.getElementById('habitList');
  const exitClass  = dir > 0 ? 'exit-left'       : 'exit-right';
  const enterClass = dir > 0 ? 'enter-from-right' : 'enter-from-left';
  listEl.classList.remove('enter-from-right', 'enter-from-left');
  listEl.classList.add(exitClass);
  setTimeout(() => {
    selectDate(next);
    const nl = document.getElementById('habitList');
    nl.classList.remove('exit-left', 'exit-right', 'enter-from-right', 'enter-from-left');
    void nl.offsetWidth;
    nl.classList.add(enterClass);
    nl.addEventListener('animationend', () => nl.classList.remove(enterClass), { once: true });
  }, 185);
});

// ── Swipe to change day (mobile) ──────────────────────────────────────────────
(function() {
  let x0 = null, y0 = null, locked = false;
  const el = document.querySelector('.habits-layout > div');
  if (!el) return;

  el.addEventListener('touchstart', e => {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    locked = false;
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (x0 === null) return;
    const dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (!locked && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      locked = true;
    }
    if (locked) e.preventDefault();
  }, { passive: false });

  el.addEventListener('touchend', e => {
    if (x0 === null || !locked) { x0 = y0 = null; locked = false; return; }
    const dx = e.changedTouches[0].clientX - x0;
    x0 = y0 = null; locked = false;
    if (Math.abs(dx) < 50) return;
    const cur = new Date((selectedDate || today()) + 'T00:00:00');
    const dir = dx < 0 ? 1 : -1;
    cur.setDate(cur.getDate() + dir);
    const next = dateStr(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
    if (next > today()) return;
    const listEl     = document.getElementById('habitList');
    const exitClass  = dx < 0 ? 'exit-left'       : 'exit-right';
    const enterClass = dx < 0 ? 'enter-from-right' : 'enter-from-left';
    listEl.classList.remove('enter-from-right', 'enter-from-left');
    listEl.classList.add(exitClass);
    setTimeout(() => {
      selectDate(next);
      const nl = document.getElementById('habitList');
      nl.classList.remove('exit-left', 'exit-right', 'enter-from-right', 'enter-from-left');
      void nl.offsetWidth; // force reflow so animation restarts
      nl.classList.add(enterClass);
      nl.addEventListener('animationend', () => nl.classList.remove(enterClass), { once: true });
    }, 185);
  }, { passive: true });
})();

// ── Login ─────────────────────────────────────────────────────────────────────
function showLogin() {
  $('loginScreen').classList.remove('hidden');
}

window.submitLogin = function() {
  const email = $('loginEmail').value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    $('loginError').textContent = 'Ingresa un email válido.';
    return;
  }
  localStorage.setItem('habits_user', email);
  $('loginScreen').classList.add('hidden');
  init();
};

window.handleLoginKey = function(e) {
  if (e.key === 'Enter') window.submitLogin();
};

window.logout = function() {
  localStorage.removeItem('habits_user');
  location.reload();
};

// ── Swipe to change month on calendar (mobile) ────────────────────────────────
(function() {
  let x0 = null, y0 = null, locked = false;
  const el = document.getElementById('calGrid');
  if (!el) return;

  el.addEventListener('touchstart', e => {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    locked = false;
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (x0 === null) return;
    const dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (!locked && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) locked = true;
    if (locked) e.preventDefault();
  }, { passive: false });

  el.addEventListener('touchend', e => {
    if (x0 === null || !locked) { x0 = y0 = null; locked = false; return; }
    const dx = e.changedTouches[0].clientX - x0;
    x0 = y0 = null; locked = false;
    if (Math.abs(dx) < 50) return;
    shiftMonth(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

init();

// ── Completion notes ──────────────────────────────────────────────────────────
let noteEditId = null;
window.openNote = function(id) {
  noteEditId = id;
  $('note-text').value = notes[selectedDate]?.[id] || '';
  $('note-bg').classList.add('open');
  setTimeout(() => $('note-text').focus(), 100);
};
window.closeNote = function() {
  $('note-bg').classList.remove('open');
  noteEditId = null;
};
window.saveNote = async function() {
  if (!noteEditId) return;
  const id   = noteEditId;
  const t    = selectedDate;
  const text = $('note-text').value.trim();
  const value = getValue(id, t) || 1;
  if (text) { (notes[t] ||= {})[id] = text; }
  else if (notes[t]) { delete notes[t][id]; }
  closeNote();
  renderToday();
  try {
    await setComplete({ habit_id: id, date: t, value, note: text || null });
  } catch (e) { toast(e.message, 'err'); }
};

window.customConfirm = function(msg) {
  return new Promise(resolve => {
    const bg = document.getElementById('confirm-bg');
    const msgEl = document.getElementById('confirm-msg');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    
    msgEl.textContent = msg;
    bg.classList.add('open');
    
    function cleanup() {
      bg.classList.remove('open');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
    }
    
    okBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
  });
};
