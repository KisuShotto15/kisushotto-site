import { getHabits, createHabit, updateHabit, deleteHabit, getCompletions, toggleComplete, setComplete, getStats } from './api.js';

// ── State ─────────────────────────────────────────────────────────────────────
let habits      = [];
let completions = {};   // { 'YYYY-MM-DD': { habitId: value } }
let calYear     = 0;
let calMonth    = 0;    // 1-12
let calDaily    = {};   // { 'YYYY-MM-DD': pct }
let editingId   = null;
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
    const origin = new Date(habit.created_at * 1000);
    const diff   = Math.floor((d - origin) / 86400000);
    return diff % every === 0;
  }
  return true;
}

function freqLabel(habit) {
  if (habit.frequency === 'daily') return 'Diario';
  if (habit.frequency === 'weekly') {
    const DAYS = ['D','L','M','X','J','V','S'];
    const days = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1,2,3,4,5];
    return days.map(d => DAYS[d]).join(' ');
  }
  if (habit.frequency === 'custom') return `Cada ${habit.frequency_every} días`;
  return '';
}

// ── Streak calculation ────────────────────────────────────────────────────────
function calcStreak(habit) {
  let streak = 0;
  const now  = new Date();
  const check = new Date(now.toISOString().slice(0, 10) + 'T00:00:00');

  for (let i = 0; i < 365; i++) {
    const ds = check.toISOString().slice(0, 10);
    if (isDueOn(habit, ds)) {
      if (completions[ds]?.[habit.id] != null) {
        streak++;
      } else {
        if (ds !== today()) break; // allow today's incomplete
      }
    }
    check.setDate(check.getDate() - 1);
  }
  return streak;
}

function bestStreakAll() {
  if (!habits.length) return 0;
  return Math.max(0, ...habits.map(calcStreak));
}

// ── Completion helpers ────────────────────────────────────────────────────────
function isDone(habitId, date = today()) {
  return completions[date]?.[habitId] != null;
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
  const due  = habits.filter(h => isDueOn(h, t));
  const done = due.filter(h => isDone(h.id, t));
  const pct  = due.length ? Math.round(done.length / due.length * 100) : 0;
  return { due: due.length, done: done.length, pct };
}

// ── Render: today checklist ───────────────────────────────────────────────────
function renderToday() {
  const t = selectedDate;
  const d = new Date(t + 'T12:00:00');
  const isToday = t === today();
  const dateText = d.toLocaleDateString('es', { weekday:'long', day:'numeric', month:'long' });
  $('todayDate').innerHTML = isToday
    ? dateText
    : `${dateText} <button onclick="selectDate('${today()}')" style="margin-left:8px;background:rgba(196,181,253,0.12);border:1px solid var(--accent);border-radius:5px;color:var(--accent);font-size:11px;padding:2px 8px;cursor:pointer;font-family:'IBM Plex Mono',monospace">Hoy →</button>`;

  const { due, done, pct } = todayStats();
  $('progressLabel').textContent = `${done} de ${due} hábitos`;
  $('progressPct').textContent   = `${pct}%`;
  $('progressFill').style.width  = `${pct}%`;
  $('todayPct').textContent      = `${pct}%`;
  $('statToday').textContent     = `${done}/${due}`;

  const dueHabits = habits.filter(h => isDueOn(h, t));
  const notDue    = habits.filter(h => !isDueOn(h, t));

  const list = $('habitList');
  if (!habits.length) {
    list.innerHTML = `<div class="habits-empty"><div class="habits-empty-icon">🌱</div>Sin hábitos aún.<br>Usa el botón + para crear el primero.</div>`;
    return;
  }

  list.innerHTML = [...dueHabits, ...notDue].map(h => {
    const color   = COLORS[h.color] || COLORS.lavender;
    const done_   = isDone(h.id, t);
    const streak  = calcStreak(h);
    const notDue_ = !isDueOn(h, t);
    const overdue = h.reminder_time && !done_ && isOverdue(h.reminder_time) && isDueOn(h, t);

    const streakHtml  = streak > 0
      ? `<span class="habit-streak ${streak >= 7 ? 'hot' : ''}">🔥 ${streak}</span>`
      : '';
    const reminderHtml = overdue
      ? `<span class="reminder-badge">⏰ ${h.reminder_time}</span>`
      : '';

    let rightSide = '';
    if (!notDue_ && h.type === 'count') {
      const val = getValue(h.id, t);
      const target = h.target_value || 1;
      const isDoneCount = val >= target;
      rightSide = `
        <div class="habit-counter" onclick="event.stopPropagation()">
          <button class="counter-btn" onclick="adjustCount('${h.id}',-1)">−</button>
          <span class="counter-val">${val}${isDoneCount ? `<span style="color:var(--mint)">✓</span>` : `/${target}`}<span style="font-size:9px;color:var(--muted);margin-left:2px">${h.target_unit||''}</span></span>
          <button class="counter-btn" onclick="adjustCount('${h.id}',+1)">+</button>
        </div>`;
    } else {
      rightSide = `${reminderHtml}${streakHtml}`;
    }

    return `
      <div class="habit-row ${done_ ? 'done' : ''} ${notDue_ ? 'not-due' : ''}"
           style="--habit-color:${color}"
           onclick="${notDue_ ? '' : `onHabitClick('${h.id}')`}">
        <div class="habit-check"></div>
        <span class="habit-emoji">${h.emoji || '✓'}</span>
        <div class="habit-info">
          <div class="habit-name">${h.name}</div>
          <div class="habit-freq">${freqLabel(h)}${h.description ? ` · ${h.description}` : ''}</div>
        </div>
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
    const color = COLORS[h.color] || COLORS.lavender;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--card2);border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:border-color 0.2s"
           onmouseenter="this.style.borderColor='var(--border2)'" onmouseleave="this.style.borderColor='var(--border)'"
           onclick="openPanel(${JSON.stringify(h).replace(/"/g,'&quot;')})">
        <span style="font-size:18px;line-height:1">${h.emoji || '✓'}</span>
        <span style="flex:1;font-size:13px;font-weight:600">${h.name}</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--muted2)">${freqLabel(h)}</span>
        <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block"></span>
      </div>`;
  }).join('');
}

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
    cell.innerHTML = `<span class="cal-cell-num">${d}</span>`;
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
window.selectDate = function(iso) {
  selectedDate = iso;
  renderCalendar();
  renderToday();
};

window.onHabitClick = async function(id) {
  const habit = habits.find(h => h.id === id);
  if (!habit || habit.type === 'count') return;

  const t      = selectedDate;
  const wasDone = isDone(id, t);
  setLocal(id, t, wasDone ? null : 1);
  renderToday();

  try {
    await toggleComplete({ habit_id: id, date: t });
    await loadCalMonth();
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
    await loadCalMonth();
    renderCalendar();
    renderStats();
  } catch (e) {
    setLocal(id, t, oldVal || null);
    renderToday();
    toast(e.message, 'err');
  }
};

// ── Calendar navigation ───────────────────────────────────────────────────────
window.shiftMonth = async function(dir) {
  calMonth += dir;
  if (calMonth > 12) { calMonth = 1;  calYear++; }
  if (calMonth < 1)  { calMonth = 12; calYear--; }
  await loadCalMonth();
  renderCalendar();
  renderStats();
};

// ── Panel: add/edit habit ─────────────────────────────────────────────────────
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
  onTypeChange();
  onFreqChange();

  $('panelBackdrop').classList.remove('hidden');
  requestAnimationFrame(() => $('sidePanel').classList.add('open'));
  setTimeout(() => $('fName').focus(), 280);
};

window.closePanel = function() {
  $('sidePanel').classList.remove('open');
  $('panelBackdrop').classList.add('hidden');
  $('emojiPicker').style.display = 'none';
  editingId = null;
};

window.toggleEmojiPicker = function() {
  const p = $('emojiPicker');
  p.style.display = p.style.display === 'grid' ? 'none' : 'grid';
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
  $('weeklyFields').style.display = v === 'weekly' ? 'block' : 'none';
  $('customFields').style.display = v === 'custom'  ? 'block' : 'none';
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
    frequency_days:  $('fFreq').value === 'weekly'  ? activeDays : null,
    frequency_every: parseInt($('fEvery').value)    || 2,
    reminder_time:   $('fReminder').value           || null,
    description:     $('fDesc').value.trim()        || null,
  };

  try {
    if (editingId) await updateHabit(editingId, body);
    else           await createHabit(body);
    toast(editingId ? 'Hábito actualizado' : '¡Hábito creado!');
    closePanel();
    await init();
  } catch (e) {
    toast(e.message, 'err');
  }
};

window.confirmDelete = async function() {
  if (!editingId) return;
  if (!confirm('¿Eliminar este hábito?')) return;
  try {
    await deleteHabit(editingId);
    toast('Hábito eliminado');
    closePanel();
    await init();
  } catch (e) {
    toast(e.message, 'err');
  }
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
window.testNotification = function() {
  const title = '🔔 Test de notificación';
  const body  = 'Las notificaciones están funcionando correctamente';
  pushNotif(title, body);
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
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
function initNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    $('notifBanner').classList.remove('hidden');
  }
  updateNotifBadge();
}

window.requestNotifPermission = async function() {
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    $('notifBanner').classList.add('hidden');
    toast('Notificaciones activadas ✓');
    setupReminders();
  }
};

function setupReminders() {
  reminderTimers.forEach(clearTimeout);
  reminderTimers = [];
  if (Notification.permission !== 'granted') return;

  const t = today();
  for (const habit of habits) {
    if (!habit.reminder_time || !isDueOn(habit, t) || isDone(habit.id, t)) continue;

    const [rh, rm] = habit.reminder_time.split(':').map(Number);
    const fire  = new Date(); fire.setHours(rh, rm, 0, 0);
    const ms    = fire - Date.now();

    if (ms > 0) {
      reminderTimers.push(setTimeout(() => {
        if (!isDone(habit.id, today())) {
          const title = `${habit.emoji || '⏰'} ${habit.name}`;
          const body  = habit.description || '¡Es hora de completar tu hábito!';
          new Notification(title, { body });
          pushNotif(title, body);
        }
      }, ms));
    } else if (ms > -3600000) {
      // Missed within last hour
      const title = `${habit.emoji || '⏰'} ${habit.name}`;
      const body  = `Recordatorio perdido — ${habit.reminder_time}`;
      new Notification(title, { body });
      pushNotif(title, body);
    }
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadCompletions() {
  const t    = today();
  const from = t.slice(0, 7) + '-01';
  const to   = t.slice(0, 7) + '-31';
  const { completions: rows } = await getCompletions({ from, to });
  completions = {};
  for (const r of rows) {
    if (!completions[r.date]) completions[r.date] = {};
    completions[r.date][r.habit_id] = r.value;
  }
}

async function loadCalMonth() {
  const monthStr = `${calYear}-${String(calMonth).padStart(2,'0')}`;
  try {
    const { daily } = await getStats({ month: monthStr });
    calDaily = daily || {};
  } catch { calDaily = {}; }
}

async function init() {
  // Dev override: set habits_user in localStorage for local testing without CF Access
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    if (!localStorage.getItem('habits_user')) {
      const email = prompt('Dev mode: ingresa tu email para identificarte');
      if (email) localStorage.setItem('habits_user', email.toLowerCase().trim());
    }
  }

  const now = new Date();
  calYear      = now.getFullYear();
  calMonth     = now.getMonth() + 1;
  selectedDate = today();

  try {
    const [{ habits: h }] = await Promise.all([getHabits(), loadCompletions()]);
    habits = h;
    await loadCalMonth();
  } catch (e) {
    toast('Error cargando datos: ' + e.message, 'err');
    habits = [];
  }

  renderToday();
  renderManage();
  renderCalendar();
  renderStats();
  initNotifications();
  setupReminders();
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

init();
