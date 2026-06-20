// Five Hours — 5h/week × 12 weeks training tracker, Strava-backed.

const BLOCK_START_ISO = '2026-05-25'; // Mon
const BLOCK_WEEKS = 12;
const WEEKLY_GOAL_HOURS = 5;

const TOKEN_URL = 'https://www.strava.com/oauth/token';
const AUTH_URL = 'https://www.strava.com/oauth/authorize';
const API_BASE = 'https://www.strava.com/api/v3';

const CONFIG_KEY = 'fivehours.config';
const WEIGHT_KEY = 'fivehours.weight';
const WEIGHT_START = 85;
const WEIGHT_GOAL = 80;
const WEEKLY_RUNNING_GOAL_HOURS = 2;
const RUNNING_GOAL_START_WEEK = 3;
const RUNNING_TYPES = ['run', 'trailrun', 'virtualrun'];
const root = document.getElementById('app');

// ───────────────────────── Config / storage ─────────────────────────

function getConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; }
  catch { return {}; }
}
function setConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}
function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

// ───────────────────────── Date math ─────────────────────────

function blockStart() {
  const [y, m, d] = BLOCK_START_ISO.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function blockEnd() {
  const end = blockStart();
  end.setDate(end.getDate() + BLOCK_WEEKS * 7);
  return end; // exclusive
}

// Start of Monday-based week containing `date` (local time).
function weekStartFor(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekIndexFor(date) {
  // 0-based week within the block. Negative if before, >= BLOCK_WEEKS if after.
  const ws = weekStartFor(date);
  const bs = blockStart();
  // Round to days first to absorb any DST hour shift.
  const days = Math.round((ws - bs) / (24 * 60 * 60 * 1000));
  return Math.floor(days / 7);
}

function formatHMS(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h === 0) return `${mm}m`;
  return `${h}h ${String(mm).padStart(2, '0')}m`;
}
function parseStravaLocal(iso) {
  // Strava's start_date_local has a trailing Z but represents local time at the
  // activity's location. Strip the Z so JS parses it as local.
  return new Date(String(iso).replace(/Z$/, ''));
}
function dayAbbrev(iso) {
  return ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][parseStravaLocal(iso).getDay()];
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isRunningActivity(a) {
  const t = (a.sport_type || a.type || '').replace(/\s/g, '').toLowerCase();
  return RUNNING_TYPES.includes(t);
}

function getWeightEntries() {
  try {
    const data = JSON.parse(localStorage.getItem(WEIGHT_KEY));
    if (Array.isArray(data) && data.length > 0) return data;
  } catch {}
  const initial = [{ date: '2026-06-20', weight: 85 }];
  localStorage.setItem(WEIGHT_KEY, JSON.stringify(initial));
  return initial;
}

function addWeightEntry(date, weight) {
  const entries = getWeightEntries();
  const idx = entries.findIndex(e => e.date === date);
  if (idx >= 0) entries[idx].weight = weight;
  else entries.push({ date, weight });
  entries.sort((a, b) => a.date.localeCompare(b.date));
  localStorage.setItem(WEIGHT_KEY, JSON.stringify(entries));
}

// ───────────────────────── Strava API ─────────────────────────

async function exchangeCode(clientId, clientSecret, code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(cfg) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function ensureFreshToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  if (cfg.accessToken && cfg.expiresAt && cfg.expiresAt - 120 > now) {
    return cfg.accessToken;
  }
  const data = await refreshAccessToken(cfg);
  cfg.accessToken = data.access_token;
  cfg.refreshToken = data.refresh_token;
  cfg.expiresAt = data.expires_at;
  setConfig(cfg);
  return cfg.accessToken;
}

async function fetchActivities(token, afterEpoch, beforeEpoch) {
  // Strava paginates; for a single week we won't exceed 200.
  const url = `${API_BASE}/athlete/activities?after=${afterEpoch}&before=${beforeEpoch}&per_page=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Activities fetch failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// ───────────────────────── Rendering ─────────────────────────

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function render(content) {
  root.className = '';
  root.innerHTML = '';
  for (const c of [].concat(content)) {
    if (c) root.appendChild(c);
  }
}

function renderLoading() {
  root.className = 'loading';
  root.innerHTML = '<div class="spinner"></div>';
}

function renderSetup(errorMsg) {
  const redirectUri = window.location.origin + window.location.pathname;

  const setup = el('section', { class: 'setup' }, [
    el('div', { class: 'brand' }, [el('span', { class: 'dot' }), 'Five Hours']),
    el('h1', {}, 'Connect Strava'),
    el('p', {}, '5h/week × 12 weeks of training. Pulls activities from your Strava account.'),
    el('ol', { html: `
      <li>Visit <code>https://www.strava.com/settings/api</code> and create an app (any name).</li>
      <li>Set <strong>Authorization Callback Domain</strong> to <code>${window.location.hostname || 'localhost'}</code></li>
      <li>Copy your <strong>Client ID</strong> and <strong>Client Secret</strong> below.</li>
    `}),
    errorMsg ? el('div', { class: 'error' }, errorMsg) : null,
    el('form', { id: 'setupForm' }, [
      el('label', { for: 'clientId' }, 'Client ID'),
      el('input', { type: 'text', id: 'clientId', required: 'required', autocomplete: 'off' }),
      el('label', { for: 'clientSecret' }, 'Client Secret'),
      el('input', { type: 'password', id: 'clientSecret', required: 'required', autocomplete: 'off' }),
      el('button', { type: 'submit', class: 'btn btn-accent' }, 'Connect with Strava →'),
    ]),
    el('div', { class: 'note' }, `Tokens are stored only in your browser (localStorage). Redirect URI: ${redirectUri}`),
  ]);

  render(setup);

  const existing = getConfig();
  if (existing.clientId) document.getElementById('clientId').value = existing.clientId;
  if (existing.clientSecret) document.getElementById('clientSecret').value = existing.clientSecret;

  document.getElementById('setupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const clientId = document.getElementById('clientId').value.trim();
    const clientSecret = document.getElementById('clientSecret').value.trim();
    if (!clientId || !clientSecret) return;
    setConfig({ ...getConfig(), clientId, clientSecret });
    startOAuth(clientId);
  });
}

function startOAuth(clientId) {
  const redirectUri = window.location.origin + window.location.pathname;
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope', 'activity:read_all');
  window.location.assign(url.toString());
}

function renderPreBlock() {
  const bs = blockStart();
  const fmt = bs.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  render([
    topbar(),
    el('div', { class: 'state-msg' }, [
      el('h2', {}, 'Block hasn’t started'),
      el('p', {}, `Week 1 begins ${fmt}.`),
    ]),
  ]);
}

function renderPostBlock() {
  render([
    topbar(),
    el('div', { class: 'state-msg' }, [
      el('h2', {}, '12 weeks complete'),
      el('p', {}, 'Block finished. Nice work.'),
    ]),
  ]);
}

function topbar() {
  return el('header', { class: 'topbar' }, [
    el('div', { class: 'brand' }, [el('span', { class: 'dot' }), 'Five Hours']),
    el('button', {
      class: 'menu-btn',
      title: 'Disconnect & reset',
      onclick: () => {
        if (confirm('Disconnect Strava and reset all settings?')) {
          clearConfig();
          window.location.assign(window.location.pathname);
        }
      },
    }, '⚙'),
  ]);
}

function renderRunningGoal(activities, weekIndex) {
  if (weekIndex < RUNNING_GOAL_START_WEEK) return null;

  const runSeconds = activities
    .filter(isRunningActivity)
    .reduce((s, a) => s + (a.moving_time || 0), 0);
  const goalSeconds = WEEKLY_RUNNING_GOAL_HOURS * 3600;
  const pct = Math.min(1, runSeconds / goalSeconds);
  const isDone = runSeconds >= goalSeconds;

  return el('div', { class: 'run-goal' }, [
    el('div', { class: 'run-goal-header' }, [
      el('span', { class: 'run-goal-label' }, 'Running'),
      el('span', { class: 'run-goal-progress' + (isDone ? ' done' : '') },
        `${formatDuration(runSeconds)} / ${WEEKLY_RUNNING_GOAL_HOURS}h`),
    ]),
    el('div', { class: 'run-bar-track' }, [
      el('div', { class: 'run-bar-fill' + (isDone ? ' done' : ''),
        style: `width:${pct * 100}%` }),
    ]),
  ]);
}

function renderWeightTracker(weekIndex) {
  const entries = getWeightEntries();
  const bs = blockStart();

  const W = 480, H = 180;
  const ml = 38, mr = 12, mt = 12, mb = 24;
  const pw = W - ml - mr, ph = H - mt - mb;

  const dateToWeek = (dateStr) => {
    const d = new Date(dateStr + 'T12:00:00');
    return (d - bs) / (7 * 86400000);
  };

  const xMin = RUNNING_GOAL_START_WEEK;
  const xMax = BLOCK_WEEKS;
  const xRange = xMax - xMin;
  const xPos = (wf) => ml + ((wf - xMin) / xRange) * pw;

  const allWeights = entries.map(e => e.weight).concat([WEIGHT_START, WEIGHT_GOAL]);
  const yMinVal = Math.floor(Math.min(...allWeights)) - 1;
  const yMaxVal = Math.ceil(Math.max(...allWeights)) + 1;
  const yRange = yMaxVal - yMinVal;
  const yPos = (w) => mt + (1 - (w - yMinVal) / yRange) * ph;

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="weight-chart">`;

  for (let kg = yMinVal; kg <= yMaxVal; kg++) {
    const yy = yPos(kg);
    svg += `<line x1="${ml}" y1="${yy}" x2="${W - mr}" y2="${yy}" stroke="var(--rule)" stroke-width="0.5"/>`;
    svg += `<text x="${ml - 6}" y="${yy + 3.5}" text-anchor="end" fill="var(--ink-faint)" font-size="10" font-family="inherit">${kg}</text>`;
  }

  for (let w = xMin; w < xMax; w++) {
    svg += `<text x="${xPos(w)}" y="${H - 4}" text-anchor="middle" fill="var(--ink-faint)" font-size="10" font-family="inherit">W${w + 1}</text>`;
  }

  svg += `<line x1="${xPos(xMin)}" y1="${yPos(WEIGHT_START)}" x2="${xPos(xMax)}" y2="${yPos(WEIGHT_GOAL)}" stroke="var(--done)" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.6"/>`;

  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length > 1) {
    const pts = sorted.map(e => `${xPos(dateToWeek(e.date))},${yPos(e.weight)}`).join(' ');
    svg += `<polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  for (const e of sorted) {
    svg += `<circle cx="${xPos(dateToWeek(e.date))}" cy="${yPos(e.weight)}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
  }

  svg += '</svg>';

  const chartEl = el('div', { class: 'weight-chart-wrap' });
  chartEl.innerHTML = svg;

  const latest = sorted[sorted.length - 1];
  const latestW = latest ? latest.weight : WEIGHT_START;

  const section = el('section', { class: 'weight-section' }, [
    el('div', { class: 'section-title' }, [
      document.createTextNode('Weight'),
      el('span', { class: 'meta' }, `${latestW.toFixed(1)}kg → ${WEIGHT_GOAL}kg · ${(latestW - WEIGHT_GOAL).toFixed(1)}kg to go`),
    ]),
    chartEl,
  ]);

  const form = el('form', { class: 'weight-form' }, [
    el('input', {
      type: 'number',
      id: 'weightInput',
      step: '0.1',
      placeholder: 'kg',
      required: 'required',
    }),
    el('button', { type: 'submit', class: 'btn btn-ghost' }, 'Log today'),
  ]);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('weightInput');
    const w = parseFloat(input.value);
    if (isNaN(w) || w < 30 || w > 300) return;
    addWeightEntry(todayISO(), w);
    const old = document.querySelector('.weight-section');
    if (old) old.replaceWith(renderWeightTracker(weekIndex));
  });

  section.appendChild(form);
  return section;
}

function renderDashboard({ weekIndex, weekStart, activities }) {
  const totalSeconds = activities.reduce((s, a) => s + (a.moving_time || 0), 0);
  const goalSeconds = WEEKLY_GOAL_HOURS * 3600;
  const remainingSeconds = Math.max(0, goalSeconds - totalSeconds);
  const pct = Math.min(1, totalSeconds / goalSeconds);
  const isDone = remainingSeconds === 0;

  // Per-day pace: remaining time ÷ days left this week
  const today = new Date();
  const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay(); // Mon=1 … Sun=7
  const hasActivityToday = activities.some(
    a => parseStravaLocal(a.start_date_local).toDateString() === today.toDateString()
  );
  // If today already has an activity, only count future days; otherwise include today
  const daysLeft = hasActivityToday ? (7 - dayOfWeek) : (8 - dayOfWeek);
  const perDaySeconds = daysLeft > 0 ? remainingSeconds / daysLeft : 0;

  // Ring
  const r = 124;
  const c = 2 * Math.PI * r;
  const ring = el('div', { class: 'ring-wrap' }, []);
  ring.innerHTML = `
    <svg viewBox="0 0 280 280">
      <circle class="ring-track" cx="140" cy="140" r="${r}"></circle>
      <circle class="ring-fill ${isDone ? 'done' : ''}" cx="140" cy="140" r="${r}"
        stroke-dasharray="${c}"
        stroke-dashoffset="${c * (1 - pct)}"></circle>
    </svg>
    <div class="ring-center">
      <div class="hours-big">${formatHMS(remainingSeconds)}</div>
      <div class="hours-label">${isDone ? 'goal hit' : 'hours left'}</div>
      <div class="hours-sub">${formatDuration(totalSeconds)} / ${WEEKLY_GOAL_HOURS}h</div>
      ${!isDone && daysLeft > 0 ? `<div class="hours-pace">${formatDuration(perDaySeconds)}/day needed</div>` : ''}
    </div>
  `;

  // Week range label
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const monthFmt = { month: 'short', day: 'numeric' };
  const rangeStr = `${weekStart.toLocaleDateString(undefined, monthFmt)} – ${weekEnd.toLocaleDateString(undefined, monthFmt)}`;

  const hero = el('section', { class: 'hero' + (isDone ? ' complete' : '') }, [
    el('div', { class: 'week-label' }, `Week ${weekIndex + 1} of ${BLOCK_WEEKS} · ${rangeStr}`),
    ring,
  ]);

  // Week strip
  const weeks = el('div', { class: 'weeks' }, []);
  for (let i = 0; i < BLOCK_WEEKS; i++) {
    const cls = i < weekIndex ? 'week-cell past'
              : i === weekIndex ? 'week-cell current'
              : 'week-cell';
    weeks.appendChild(el('div', { class: cls, title: `Week ${i + 1}` }, String(i + 1)));
  }

  // Activities
  const activitiesSorted = [...activities].sort(
    (a, b) => parseStravaLocal(b.start_date_local) - parseStravaLocal(a.start_date_local)
  );

  const activitiesList = el('ul', { class: 'activities' }, []);
  if (activitiesSorted.length === 0) {
    activitiesList.appendChild(el('li', {}, [
      el('span', { class: 'empty', style: 'grid-column:1/-1' }, 'No activities yet this week.'),
    ]));
  } else {
    for (const a of activitiesSorted) {
      activitiesList.appendChild(el('li', {}, [
        el('span', { class: 'day' }, dayAbbrev(a.start_date_local)),
        el('span', { class: 'name' }, [
          document.createTextNode(a.name || '(untitled)'),
          el('span', { class: 'sport' }, (a.sport_type || a.type || '').replace(/([A-Z])/g, ' $1').trim().toLowerCase()),
        ]),
        el('span', { class: 'dur' }, formatDuration(a.moving_time || 0)),
      ]));
    }
  }

  const section = el('section', {}, [
    el('div', { class: 'section-title' }, [
      document.createTextNode('This week'),
      el('span', { class: 'meta' }, `${activitiesSorted.length} ${activitiesSorted.length === 1 ? 'activity' : 'activities'}`),
    ]),
    activitiesList,
  ]);

  const actions = el('div', { class: 'actions' }, [
    el('button', { class: 'btn btn-ghost', onclick: () => load(true) }, '↻ Refresh'),
  ]);

  const runGoal = renderRunningGoal(activities, weekIndex);
  const weightTracker = renderWeightTracker(weekIndex);

  render([topbar(), hero, runGoal, weeks, section, actions, weightTracker]);
}

function renderError(msg) {
  render([
    topbar(),
    el('div', { class: 'error', style: 'margin-top:24px' }, msg),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn-ghost', onclick: () => load(true) }, 'Retry'),
      el('button', { class: 'btn btn-danger', onclick: () => {
        if (confirm('Reset all settings?')) { clearConfig(); window.location.assign(window.location.pathname); }
      } }, 'Reset'),
    ]),
  ]);
}

// ───────────────────────── Main flow ─────────────────────────

async function handleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (error) {
    history.replaceState({}, '', window.location.pathname);
    renderSetup(`Strava authorization was cancelled or failed: ${error}`);
    return true;
  }
  if (!code) return false;

  const cfg = getConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    history.replaceState({}, '', window.location.pathname);
    renderSetup('Missing client credentials. Please re-enter.');
    return true;
  }

  renderLoading();
  try {
    const data = await exchangeCode(cfg.clientId, cfg.clientSecret, code);
    cfg.accessToken = data.access_token;
    cfg.refreshToken = data.refresh_token;
    cfg.expiresAt = data.expires_at;
    setConfig(cfg);
    history.replaceState({}, '', window.location.pathname);
    return false; // fall through to dashboard
  } catch (err) {
    history.replaceState({}, '', window.location.pathname);
    renderSetup(err.message);
    return true;
  }
}

async function load(force = false) {
  const cfg = getConfig();
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    renderSetup();
    return;
  }

  const now = new Date();
  const wi = weekIndexFor(now);
  if (wi < 0) { renderPreBlock(); return; }
  if (wi >= BLOCK_WEEKS) { renderPostBlock(); return; }

  if (force) renderLoading();

  try {
    const token = await ensureFreshToken(cfg);
    const ws = weekStartFor(now);
    const we = new Date(ws); we.setDate(we.getDate() + 7);
    const after = Math.floor(ws.getTime() / 1000);
    const before = Math.floor(we.getTime() / 1000);
    const activities = await fetchActivities(token, after, before);
    renderDashboard({ weekIndex: wi, weekStart: ws, activities });
  } catch (err) {
    renderError(err.message);
  }
}

async function main() {
  renderLoading();
  const handled = await handleOAuthRedirect();
  if (!handled) await load();
}

main();
