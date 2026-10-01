// Research Progress Dashboard — a dependency-free static app.
// Viewers read data.json (read-only). The owner edits on their own device and
// publishes by committing data.json to GitHub through the REST API.

const LOCALE = 'en-GB';
const HOUR_H = 48; // px per hour in week view
const COLORS = ['#3b6cf6', '#8b5cf6', '#0ea5e9', '#14b8a6', '#22a55a', '#f97316', '#ec4899', '#64748b'];
const STATUS = {
  done:        { label: 'Completed',       icon: '✓' },
  failed:      { label: 'Not as planned',  icon: '✕' },
  inprogress:  { label: 'In progress',     icon: '▶' },
  upcoming:    { label: 'Up next',         icon: '★' },
  overdue:     { label: 'Awaiting update', icon: '!' },
  planned:     { label: 'Planned',         icon: '○' },
  unscheduled: { label: 'Not scheduled',   icon: '–' },
  off:         { label: 'Day off',         icon: '🏖' },
};
// Entries of a "Holiday & leave" project: days off that never ask for a result.
const LEAVE_KINDS = {
  holiday:  { label: 'Public holiday',    icon: '🎌' },
  personal: { label: 'Personal leave',    icon: '👤' },
  closed:   { label: 'University closed', icon: '🏫' },
  other:    { label: 'Day off',           icon: '🏖' },
};
const LEAVE_COLOR = '#ffffff';
const KEY = { gh: 'rpd.gh', draft: 'rpd.draft', owner: 'rpd.owner', edit: 'rpd.edit', cal: 'rpd.cal' };

// ---------------------------------------------------------------- utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7)); // Monday
const toMin = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const fmt = (d, o) => d.toLocaleDateString(LOCALE, o);
const fmtDay = (d) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = (d) => fmt(d, { day: 'numeric', month: 'short' });

const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- state
const state = {
  data: null,
  sha: null,        // blob sha of data.json on GitHub (for safe updates)
  dirty: false,     // unpublished local changes
  owner: false,     // this device may edit
  edit: false,      // edit controls visible
  gh: { owner: '', repo: '', branch: 'main', path: 'data.json', token: '' },
  cal: { view: 'month', cursor: ymd(new Date()), project: 'all', day: ymd(new Date()), past: false },
  statuses: new Map(),
};

// ---------------------------------------------------------------- data model
function normalize(d) {
  const data = d && typeof d === 'object' ? d : {};
  data.meta = { title: 'Research Progress', subtitle: '', updated: '', ...(data.meta || {}) };
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  for (const p of data.projects) {
    p.id ||= uid('p');
    p.title ||= 'Untitled project';
    p.description ??= '';
    p.status ||= 'ongoing';
    p.color ||= COLORS[0];
    p.type = p.type === 'leave' ? 'leave' : 'research';
    p.stages = Array.isArray(p.stages) ? p.stages : [];
    for (const s of p.stages) {
      s.id ||= uid('s');
      s.name ||= 'Untitled stage';
      s.notes ??= '';
      s.conditions = Array.isArray(s.conditions) ? s.conditions.map(String) : [];
      s.date ??= ''; s.endDate ??= ''; s.start ??= ''; s.end ??= '';
      s.allDay = !!s.allDay || !s.start;
      if (!['done', 'failed'].includes(s.outcome)) s.outcome = null;
      s.comment ??= '';
      if (p.type === 'leave') { s.outcome = null; if (!LEAVE_KINDS[s.kind]) s.kind = 'other'; }
    }
  }
  return data;
}

function stageRange(s) {
  if (!s.date) return null;
  const start = parseYmd(s.date);
  const end = parseYmd(s.endDate && s.endDate >= s.date ? s.endDate : s.date);
  if (!s.allDay && s.start) {
    const a = toMin(s.start);
    start.setHours(Math.floor(a / 60), a % 60);
    const b = toMin(s.end);
    if (b != null) end.setHours(Math.floor(b / 60), b % 60);
    else if (end.getTime() === startOfDay(start).getTime()) end.setTime(start.getTime() + 3600e3);
    else end.setHours(23, 59, 59);
    if (end <= start) end.setTime(start.getTime() + 3600e3);
  } else {
    end.setHours(23, 59, 59);
  }
  return { start, end };
}

function computeStatuses(now = new Date()) {
  const map = new Map();
  for (const p of state.data.projects) {
    if (isLeave(p)) { for (const s of p.stages) map.set(s.id, 'off'); continue; }
    let next = null; let nextStart = Infinity;
    for (const s of p.stages) {
      let st;
      if (s.outcome === 'done') st = 'done';
      else if (s.outcome === 'failed') st = 'failed';
      else {
        const r = stageRange(s);
        if (!r) st = 'unscheduled';
        else if (r.end < now) st = 'overdue';
        else { st = 'planned'; if (r.start < nextStart) { nextStart = r.start; next = s; } }
      }
      map.set(s.id, st);
    }
    if (next) map.set(next.id, stageRange(next).start <= now ? 'inprogress' : 'upcoming');
  }
  state.statuses = map;
  return map;
}
const statusOf = (s) => state.statuses.get(s.id) || 'planned';
const isLeave = (p) => p?.type === 'leave';
const projColor = (p) => (isLeave(p) ? LEAVE_COLOR : p.color);
// Label + icon for a stage's status; days off show their kind instead.
function stInfo(s, st = statusOf(s)) {
  return st === 'off' ? (LEAVE_KINDS[s.kind] || LEAVE_KINDS.other) : STATUS[st];
}

function progressOf(p) {
  const c = { total: p.stages.length, done: 0, failed: 0, overdue: 0 };
  for (const s of p.stages) {
    const st = statusOf(s);
    if (st === 'done') c.done++; else if (st === 'failed') c.failed++; else if (st === 'overdue') c.overdue++;
  }
  // A stage that did not go as planned is a record of an attempt; the repeat is
  // planned as its own stage, so failed stages are left out of the denominator.
  c.counted = c.total - c.failed;
  c.pct = c.counted > 0 ? Math.round((c.done / c.counted) * 100) : 0;
  return c;
}

function findStage(id) {
  for (const p of state.data.projects) {
    const i = p.stages.findIndex((s) => s.id === id);
    if (i >= 0) return { p, s: p.stages[i], i };
  }
  return null;
}
const findProject = (id) => state.data.projects.find((p) => p.id === id);

// Projects grouped by colour label, in the colour picker's order; projects with
// the same colour keep the order they were created in (Array#sort is stable).
function byColor(list = state.data.projects) {
  const rank = (p) => { if (isLeave(p)) return COLORS.length + 1; const i = COLORS.indexOf(String(p.color).toLowerCase()); return i < 0 ? COLORS.length : i; };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

function allItems(filter = () => true) {
  const out = [];
  for (const p of state.data.projects) for (const s of p.stages) if (filter(p, s)) out.push({ p, s, st: statusOf(s), r: stageRange(s) });
  return out;
}

function fmtWhen(s) {
  if (!s.date) return 'Not scheduled';
  const a = parseYmd(s.date);
  const multi = s.endDate && s.endDate > s.date;
  if (multi) {
    const b = parseYmd(s.endDate);
    return s.allDay ? `${fmtShort(a)} → ${fmtDay(b)}` : `${fmtShort(a)} ${s.start} → ${fmtDay(b)} ${s.end || ''}`.trim();
  }
  return s.allDay ? `${fmtDay(a)} · All day` : `${fmtDay(a)} · ${s.start}${s.end ? `–${s.end}` : ''}`;
}

// ---------------------------------------------------------------- persistence
function saveDraft() { store.set(KEY.draft, { data: state.data, sha: state.sha, dirty: state.dirty }); }

function commit(msg) {
  state.dirty = true;
  saveDraft();
  render();
  if (msg) toast(msg);
}

async function fetchPublished() {
  const res = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`data.json: HTTP ${res.status}`);
  return res.json();
}

// ---- GitHub contents API
const b64enc = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

function ghUrl() {
  const { owner, repo, path } = state.gh;
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}
async function ghRequest(method, body) {
  const { token, branch } = state.gh;
  const url = method === 'GET' ? `${ghUrl()}?ref=${encodeURIComponent(branch)}&t=${Date.now()}` : ghUrl();
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.message || `GitHub HTTP ${res.status}`); e.status = res.status; throw e; }
  return json;
}
async function ghGet() {
  const j = await ghRequest('GET');
  return { data: JSON.parse(b64dec(j.content)), sha: j.sha };
}
async function ghPut(text, sha, message) {
  const j = await ghRequest('PUT', { message, content: b64enc(text), branch: state.gh.branch, ...(sha ? { sha } : {}) });
  return j.content.sha;
}
const ghReady = () => !!(state.gh.token && state.gh.owner && state.gh.repo);

async function loadFromGitHub({ quiet = false } = {}) {
  try {
    const { data, sha } = await ghGet();
    state.data = normalize(data); state.sha = sha; state.dirty = false;
    saveDraft(); render();
    if (!quiet) toast('Loaded latest version from GitHub');
    return true;
  } catch (e) {
    if (!quiet) toast(`Could not load from GitHub: ${e.message}`, 5000);
    return false;
  }
}

async function publish() {
  if (!ghReady()) { openSettings('Connect GitHub once to publish changes online.'); return; }
  const btn = $('[data-act="publish"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  state.data.meta.updated = new Date().toISOString();
  const text = `${JSON.stringify(state.data, null, 2)}\n`;
  const message = `Update research progress (${new Date().toLocaleString(LOCALE)})`;
  try {
    if (!state.sha) { try { state.sha = (await ghGet()).sha; } catch (e) { if (e.status !== 404) throw e; } }
    try {
      state.sha = await ghPut(text, state.sha, message);
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      if (!confirm('The online version changed since you loaded it (perhaps edited on another device).\n\nOK = overwrite it with this version\nCancel = keep your changes as a local draft')) throw new Error('Publish cancelled');
      state.sha = (await ghGet()).sha;
      state.sha = await ghPut(text, state.sha, message);
    }
    state.dirty = false; saveDraft(); render();
    toast('Published ✓  Visitors will see it within a minute or two.', 4000);
  } catch (e) {
    render();
    toast(e.message === 'Publish cancelled' ? e.message : `Publish failed: ${e.message}`, 6000);
  }
}

// ---------------------------------------------------------------- exports
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast(`Downloaded ${name}`);
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'export';
const stamp = () => ymd(new Date());

function scopeProjects(scope) {
  if (scope && scope !== 'all') { const p = findProject(scope); return p ? [p] : []; }
  return byColor();
}
function scopeName(scope) { const p = scope && scope !== 'all' ? findProject(scope) : null; return p ? slug(p.title) : 'research-progress'; }

function exportJSON(scope) {
  const out = { meta: { ...state.data.meta, exported: new Date().toISOString() }, projects: scopeProjects(scope) };
  download(`${scopeName(scope)}-${stamp()}.json`, `${JSON.stringify(out, null, 2)}\n`, 'application/json');
}

function exportCSV(scope) {
  const projects = scopeProjects(scope);
  const maxC = Math.max(1, ...projects.flatMap((p) => p.stages.map((s) => s.conditions.length)));
  const head = ['Project', 'Project status', 'Stage #', 'Action', 'Start date', 'End date', 'Start time', 'End time', 'Status', 'Comment', 'Notes'];
  for (let i = 1; i <= maxC; i++) head.push(`Condition ${i}`);
  const q = (v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = [head];
  for (const p of projects) {
    p.stages.forEach((s, i) => {
      const row = [p.title, p.status, i + 1, s.name, s.date, s.endDate || s.date, s.allDay ? '' : s.start, s.allDay ? '' : s.end, stInfo(s).label, s.comment, s.notes];
      for (let c = 0; c < maxC; c++) row.push(s.conditions[c] || '');
      rows.push(row);
    });
  }
  download(`${scopeName(scope)}-${stamp()}.csv`, `\ufeff${rows.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
}

function exportICS(scope) {
  const e = (t) => String(t ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const dt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const dd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const now = new Date();
  const utc = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Research Progress Dashboard//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${e(state.data.meta.title)}`];
  for (const p of scopeProjects(scope)) {
    for (const s of p.stages) {
      const r = stageRange(s);
      if (!r) continue;
      const st = stInfo(s);
      const desc = [`Project: ${p.title}`, `Status: ${st.label}`, ...s.conditions.map((c, i) => `Condition ${i + 1}: ${c}`), s.notes && `Notes: ${s.notes}`, s.comment && `Comment: ${s.comment}`].filter(Boolean).join('\n');
      lines.push('BEGIN:VEVENT', `UID:${s.id}@research-progress`, `DTSTAMP:${utc}`);
      if (s.allDay) lines.push(`DTSTART;VALUE=DATE:${dd(r.start)}`, `DTEND;VALUE=DATE:${dd(addDays(startOfDay(r.end), 1))}`);
      else lines.push(`DTSTART:${dt(r.start)}`, `DTEND:${dt(r.end)}`);
      lines.push(`SUMMARY:${e(`${st.icon} ${s.name} [${p.title}]`)}`, `DESCRIPTION:${e(desc)}`, `CATEGORIES:${e(p.title)}`, 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  const fold = (l) => { const out = []; while (l.length > 74) { out.push(l.slice(0, 74)); l = ` ${l.slice(74)}`; } out.push(l); return out.join('\r\n'); };
  download(`${scopeName(scope)}-${stamp()}.ics`, `${lines.map(fold).join('\r\n')}\r\n`, 'text/calendar;charset=utf-8');
}

function openExport() {
  const route = parseRoute();
  const p = route.name === 'project' ? findProject(route.id) : null;
  const group = (scope, title) => `
    <div class="export-group"><h3>${esc(title)}</h3><div class="export-list">
      <button class="btn" data-act="dl" data-kind="report" data-scope="${scope}">🖨️ Printable report / PDF <small>print or save as PDF</small></button>
      <button class="btn" data-act="dl" data-kind="csv" data-scope="${scope}">📊 Spreadsheet (.csv) <small>Excel, Numbers, Sheets</small></button>
      <button class="btn" data-act="dl" data-kind="ics" data-scope="${scope}">📅 Calendar (.ics) <small>Google / Apple Calendar</small></button>
      <button class="btn" data-act="dl" data-kind="json" data-scope="${scope}">💾 Full data (.json) <small>backup, re-import</small></button>
    </div></div>`;
  openModal({
    title: 'Export',
    body: `${p ? group(p.id, `This project — ${p.title}`) : ''}${group('all', 'All projects')}
      <p class="help" style="margin-top:14px">On iPhone, downloaded files go to the Files app (Downloads). Open the .ics file to add the schedule to your calendar.</p>`,
  });
}

// ---------------------------------------------------------------- routing
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, id] = h.split('/');
  if (name === 'project' && id) return { name: 'project', id: decodeURIComponent(id) };
  if (name === 'calendar') return { name: 'calendar' };
  if (name === 'completed') return { name: 'completed' };
  if (name === 'report') return { name: 'report', id: id ? decodeURIComponent(id) : 'all' };
  return { name: 'dashboard' };
}

// ---------------------------------------------------------------- rendering helpers
const badge = (st, s) => { const i = s ? stInfo(s, st) : STATUS[st]; return `<span class="badge st-${st}">${i.icon} ${esc(i.label)}</span>`; };

function pbar(c, lg = false) {
  const w = (n) => (c.counted > 0 ? (n / c.counted) * 100 : 0);
  return `<div class="pbar ${lg ? 'lg' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.pct}" aria-label="${c.pct}% complete">
    <span class="seg-done" style="width:${w(c.done)}%"></span><span class="seg-due" style="width:${w(c.overdue)}%"></span></div>`;
}

function progressMeta(c) {
  const extra = [c.failed && `${c.failed} not as planned`, c.overdue && `${c.overdue} awaiting update`].filter(Boolean).join(' · ');
  return `<div class="pc-meta"><span><b>${c.done}/${c.counted}</b> stages done${extra ? ` · ${extra}` : ''}</span><b>${c.pct}%</b></div>`;
}

function outcomeButtons(s) {
  return `<button class="btn sm good" data-act="outcome" data-id="${s.id}" data-v="done">✓ Done as planned</button>
          <button class="btn sm bad" data-act="outcome" data-id="${s.id}" data-v="failed">✕ Not as planned</button>`;
}

function miniRow({ p, s, st }, withActions = false) {
  return `<div class="mini st-${st}" data-act="open-stage" data-id="${s.id}">
    <span class="dot" style="background:${esc(projColor(p))}"></span>
    <div class="body"><div class="t">${esc(s.name)}</div><div class="s">${esc(p.title)} · ${esc(fmtWhen(s))}</div></div>
    ${withActions && state.edit ? `<div class="acts">${outcomeButtons(s)}</div>` : badge(st, s)}
  </div>`;
}

const legend = () => `<div class="legend">${['upcoming', 'done', 'failed', 'overdue', 'planned', 'off'].map((k) => `<span class="st-${k}"><i></i>${STATUS[k].label}</span>`).join('')}</div>`;

// ---------------------------------------------------------------- views
function viewDashboard() {
  const { meta } = state.data;
  const all = byColor();
  const projects = all.filter((p) => !isLeave(p));
  const leave = all.filter(isLeave);
  const now = new Date();
  const ongoing = projects.filter((p) => p.status === 'ongoing');
  const paused = projects.filter((p) => p.status === 'paused');
  const completed = projects.filter((p) => p.status === 'completed');
  const overdue = allItems().filter((x) => x.st === 'overdue').sort((a, b) => a.r.start - b.r.start);
  const in7 = addDays(now, 7);
  const soon = allItems((p) => p.status !== 'completed').filter((x) => x.r && x.r.end >= now && !x.s.outcome && x.r.start <= addDays(now, 14)).sort((a, b) => a.r.start - b.r.start);
  const totals = [...ongoing, ...paused].reduce((t, p) => { const c = progressOf(p); t.done += c.done; t.counted += c.counted; return t; }, { done: 0, counted: 0 });

  return `
    <div class="page-head">
      <div><h1>${esc(meta.title)}</h1>${meta.subtitle ? `<div class="sub">${esc(meta.subtitle)}</div>` : ''}</div>
      <span class="spacer"></span>
      ${state.edit ? '<button class="btn" data-act="new-leave">＋ Day off</button><button class="btn primary" data-act="new-project">＋ New project</button>' : ''}
    </div>
    <div class="stats">
      <div class="card stat"><div class="k">Ongoing projects</div><div class="v">${ongoing.length}</div></div>
      <div class="card stat"><div class="k">Stages completed</div><div class="v">${totals.done}<small> / ${totals.counted}</small></div></div>
      <div class="card stat"><div class="k">Next 7 days</div><div class="v">${soon.filter((x) => x.r.start <= in7 && x.st !== 'off').length}</div></div>
      <div class="card stat ${overdue.length ? 'warn' : ''}"><div class="k">Awaiting update</div><div class="v">${overdue.length}</div></div>
    </div>

    ${overdue.length ? `<div class="section-title">${state.edit ? 'Needs your update' : 'Awaiting update'} <span class="count">${overdue.length}</span></div>
      <div class="mini-list">${overdue.map((x) => miniRow(x, true)).join('')}</div>` : ''}

    <div class="section-title">Ongoing projects <span class="count">${ongoing.length}</span></div>
    ${ongoing.length ? `<div class="projects">${ongoing.map(projectCard).join('')}</div>`
      : `<div class="card empty">No ongoing projects yet.${state.edit ? '<br><button class="btn primary" data-act="new-project">＋ Create your first project</button>' : ''}</div>`}

    ${soon.length ? `<div class="section-title">Coming up · next 14 days</div><div class="mini-list">${soon.slice(0, 8).map((x) => miniRow(x)).join('')}</div>` : ''}

    ${paused.length ? `<div class="section-title">Paused <span class="count">${paused.length}</span></div><div class="projects">${paused.map(projectCard).join('')}</div>` : ''}

    ${leave.length ? `<div class="section-title">Holidays &amp; leave</div><div class="projects">${leave.map(leaveCard).join('')}</div>` : ''}

    ${completed.length ? `<a class="card archive-link" href="#/completed"><span class="ico">✓</span><span><b>Completed projects</b><br><span class="muted small">${completed.length} project${completed.length > 1 ? 's' : ''} · moved out of the dashboard</span></span><span class="spacer"></span><span aria-hidden="true">›</span></a>` : ''}
    <div style="margin-top:18px">${legend()}</div>`;
}

function viewCompleted() {
  const done = byColor().filter((p) => !isLeave(p) && p.status === 'completed');
  return `
    <div class="page-head"><div><h1>Completed projects</h1><div class="sub">Finished projects are kept here so the dashboard stays short.</div></div></div>
    ${done.length ? `<div class="projects">${done.map(projectCard).join('')}</div>`
      : '<div class="card empty">No completed projects yet.<br><span class="small">Set a project’s status to <b>Completed</b> (✎ Edit project) to move it here.</span></div>'}`;
}

function projectCard(p) {
  const c = progressOf(p);
  const nextS = p.stages.find((s) => ['upcoming', 'inprogress'].includes(statusOf(s)));
  return `<a class="card project-card" href="#/project/${encodeURIComponent(p.id)}" style="--pc:${esc(p.color)}">
    <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap"><h3>${esc(p.title)}</h3>${p.status !== 'ongoing' ? `<span class="pill">${esc(p.status)}</span>` : ''}</div>
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
    <div class="pc-foot">
      ${pbar(c)}${progressMeta(c)}
      ${nextS ? `<div class="next-chip tinted st-${statusOf(nextS)}"><span>${STATUS[statusOf(nextS)].icon}</span><div><div class="t">${esc(nextS.name)}</div><div>${esc(fmtWhen(nextS))}</div></div></div>`
        : c.total && c.done === c.counted ? '<div class="next-chip tinted st-done">✓ All stages completed</div>' : ''}
    </div></a>`;
}

function leaveCard(p) {
  const today0 = startOfDay(new Date());
  const next = p.stages.map((s) => ({ s, r: stageRange(s) })).filter((x) => x.r && x.r.end >= today0).sort((a, b) => a.r.start - b.r.start);
  return `<a class="card project-card leave-card" href="#/project/${encodeURIComponent(p.id)}" style="--pc:${LEAVE_COLOR}">
    <h3>🏖 ${esc(p.title)}</h3>
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
    <div class="pc-foot">
      ${next.length ? next.slice(0, 3).map(({ s }) => `<div class="next-chip tinted st-off"><span>${stInfo(s).icon}</span><div><div class="t">${esc(s.name)}</div><div>${esc(fmtWhen(s))}</div></div></div>`).join('')
        : '<div class="muted small">No upcoming days off.</div>'}
      ${next.length > 3 ? `<div class="muted small">+${next.length - 3} more</div>` : ''}
    </div></a>`;
}

function stageCard(p, s, i) {
  const st = statusOf(s);
  const E = state.edit;
  if (st === 'off') {
    return `<li class="stage st-off" data-act="open-stage" data-id="${s.id}">
    <div class="stage-num">${stInfo(s).icon}</div>
    <div class="stage-main">
      <div class="stage-top"><h3>${esc(s.name)}</h3>${badge(st, s)}</div>
      <div class="when">🗓 ${esc(fmtWhen(s))}</div>
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      ${E ? `<div class="stage-actions"><button class="btn sm" data-act="edit-stage" data-id="${s.id}">✎ Edit</button><button class="btn sm danger" data-act="delete-stage" data-id="${s.id}">Delete</button></div>` : ''}
    </div></li>`;
  }
  return `<li class="stage st-${st}" data-act="open-stage" data-id="${s.id}">
    <div class="stage-num">${s.outcome === 'done' ? '✓' : s.outcome === 'failed' ? '✕' : i + 1}</div>
    <div class="stage-main">
      <div class="stage-top"><h3>${esc(s.name)}</h3>${badge(st, s)}</div>
      <div class="when">🗓 ${esc(fmtWhen(s))}</div>
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      ${s.conditions.length ? `<ol class="conds">${s.conditions.map((c, k) => `<li><b>Condition ${k + 1}</b><span>${esc(c)}</span></li>`).join('')}</ol>` : ''}
      ${s.comment ? `<div class="comment"><b>${s.outcome === 'failed' ? 'Why it did not go as planned' : 'Comment'}</b>${esc(s.comment)}</div>` : ''}
      ${st === 'overdue' ? `<div class="needs-update"><strong>This date has passed — did it go as planned?</strong>${E ? outcomeButtons(s) : ''}</div>` : ''}
      ${E ? `<div class="stage-actions">
        ${st !== 'overdue' ? `<button class="btn sm" data-act="outcome" data-id="${s.id}">Update result</button>` : ''}
        <button class="btn sm" data-act="edit-stage" data-id="${s.id}">✎ Edit</button>
        ${s.outcome === 'failed' ? `<button class="btn sm" data-act="dup-stage" data-id="${s.id}">↻ Reschedule as new stage</button>` : ''}
        <button class="btn sm" data-act="move-stage" data-id="${s.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="btn sm" data-act="move-stage" data-id="${s.id}" data-dir="1" ${i === p.stages.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="btn sm danger" data-act="delete-stage" data-id="${s.id}">Delete</button>
      </div>` : ''}
    </div></li>`;
}

function viewProject(id) {
  const p = findProject(id);
  if (!p) return '<div class="card empty">Project not found. <a href="#/">Back to dashboard</a></div>';
  if (isLeave(p)) return viewLeave(p);
  const c = progressOf(p);
  return `
    <div class="crumbs"><a href="#/">← Dashboard</a></div>
    <div class="card proj-head" style="--pc:${esc(p.color)}">
      <div class="row" style="align-items:flex-start"><h1>${esc(p.title)}</h1><span class="pill">${esc(p.status)}</span></div>
      ${p.description ? `<p class="muted" style="margin:6px 0 0;white-space:pre-wrap">${esc(p.description)}</p>` : ''}
      <div class="proj-progress">${progressMeta(c)}${pbar(c, true)}</div>
      <div class="row no-print" style="margin-top:14px">
        ${state.edit ? `<button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add stage</button>
          <button class="btn" data-act="edit-project" data-id="${p.id}">✎ Edit project</button>` : ''}
        <a class="btn" href="#/calendar" data-act="cal-project" data-id="${p.id}">📅 Calendar</a>
        <button class="btn" data-act="export">⇪ Export</button>
      </div>
    </div>
    <div class="section-title">Stages <span class="count">${p.stages.length}</span><span class="spacer"></span></div>
    <div class="no-print" style="margin:-4px 0 6px">${legend()}</div>
    ${p.stages.length ? `<ol class="timeline">${p.stages.map((s, i) => stageCard(p, s, i)).join('')}</ol>`
      : `<div class="card empty">No stages yet.${state.edit ? `<br><button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add the first stage</button>` : ''}</div>`}`;
}

function viewLeave(p) {
  // Days off are always shown in date order (unscheduled ones last).
  const days = [...p.stages].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const today = ymd(new Date());
  const upcoming = days.filter((s) => !s.date || (s.endDate || s.date) >= today);
  const past = days.filter((s) => s.date && (s.endDate || s.date) < today);
  const list = (xs) => `<ol class="timeline">${xs.map((s) => stageCard(p, s, 0)).join('')}</ol>`;
  return `
    <div class="crumbs"><a href="#/">← Dashboard</a></div>
    <div class="card proj-head" style="--pc:#cbd5e1">
      <div class="row" style="align-items:flex-start"><h1>🏖 ${esc(p.title)}</h1><span class="pill">Holiday &amp; leave</span></div>
      <p class="muted" style="margin:6px 0 0;white-space:pre-wrap">${esc(p.description || 'Public holidays, personal appointments and days the university is closed. These never ask for a status update.')}</p>
      <div class="row no-print" style="margin-top:14px">
        ${state.edit ? `<button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add day off</button>
          <button class="btn" data-act="edit-project" data-id="${p.id}">✎ Edit</button>` : ''}
        <a class="btn" href="#/calendar" data-act="cal-project" data-id="${p.id}">📅 Calendar</a>
      </div>
    </div>
    <div class="section-title">Upcoming <span class="count">${upcoming.length}</span></div>
    ${upcoming.length ? list(upcoming) : `<div class="card empty">No upcoming days off.${state.edit ? `<br><button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add day off</button>` : ''}</div>`}
    ${past.length ? `<div class="section-title">Past <span class="count">${past.length}</span></div>${list(past.reverse())}` : ''}`;
}

// ---- calendar
// The calendar only offers ongoing research projects and holiday/leave projects;
// paused and completed ones are left out (unless opened from their project page).
const calProjects = () => byColor().filter((p) => isLeave(p) || p.status === 'ongoing');
function calItems() {
  const f = state.cal.project;
  const shown = new Set(calProjects().map((p) => p.id));
  // 'everything' also includes paused and completed projects (overall workload).
  return allItems((p) => (f === 'everything' ? true : f === 'all' ? shown.has(p.id) : p.id === f)).filter((x) => x.r);
}
// Calendar bars use the project's colour; the status is a small dot on the bar.
const STATUS_DOT = new Set(['upcoming', 'inprogress', 'done', 'failed', 'overdue']);
function calChip(x, label, cls = '') {
  const info = stInfo(x.s, x.st);
  return `<button class="chip st-${x.st} ${cls}" style="--pc:${esc(projColor(x.p))}" data-act="open-stage" data-id="${x.s.id}" title="${esc(`${x.s.name} · ${x.p.title} · ${info.label}`)}">${STATUS_DOT.has(x.st) ? '<span class="sdot" aria-hidden="true"></span>' : ''}${label}</button>`;
}
function calLegend() {
  const f = state.cal.project;
  const ps = f === 'everything' ? byColor() : f === 'all' ? calProjects() : byColor().filter((p) => p.id === f);
  return `<div class="legend cal-legend">${ps.map((p) => `<span><i class="pswatch" style="--pc:${esc(projColor(p))}"></i>${esc(p.title)}</span>`).join('')}</div>
    <div class="legend cal-legend" style="margin-top:6px">${['upcoming', 'done', 'failed', 'overdue'].map((k) => `<span class="st-${k}"><span class="sdot"></span>${STATUS[k].label}</span>`).join('')}<span class="muted">No dot = planned later</span></div>`;
}
function itemsOnDay(items, day) {
  const d0 = startOfDay(day); const d1 = addDays(d0, 1);
  return items.filter((x) => x.r.start < d1 && x.r.end >= d0).sort((a, b) => (a.s.allDay === b.s.allDay ? a.r.start - b.r.start : a.s.allDay ? -1 : 1));
}
const isSingleDayTimed = (s) => !s.allDay && (!s.endDate || s.endDate === s.date);

function viewCalendar() {
  const c = state.cal;
  const cur = parseYmd(c.cursor);
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  let title; let body;
  const items = calItems();
  if (c.view === 'month') {
    title = fmt(cur, { month: 'long', year: 'numeric' });
    body = monthView(cur, items);
  } else if (c.view === 'week') {
    const n = narrow ? 3 : 7;
    const first = n === 7 ? startOfWeek(cur) : startOfDay(cur);
    const last = addDays(first, n - 1);
    title = first.getMonth() === last.getMonth() ? `${first.getDate()}–${fmt(last, { day: 'numeric', month: 'long', year: 'numeric' })}` : `${fmtShort(first)} – ${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    body = weekView(first, n, items);
  } else {
    title = 'Schedule';
    body = agendaView(items);
  }
  const listed = calProjects();
  const sel = !['all', 'everything'].includes(c.project) && !listed.some((p) => p.id === c.project) ? findProject(c.project) : null;
  const opts = [...listed, ...(sel ? [sel] : [])].map((p) => `<option value="${esc(p.id)}" ${c.project === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('');
  return `
    <div class="cal-toolbar">
      <h2>${esc(title)}</h2>
      ${c.view !== 'agenda' ? `<div class="row"><button class="btn sm" data-act="cal-nav" data-d="-1" aria-label="Previous">‹</button><button class="btn sm" data-act="cal-today">Today</button><button class="btn sm" data-act="cal-nav" data-d="1" aria-label="Next">›</button></div>`
        : `<label class="check" style="margin:0"><input type="checkbox" data-act="cal-past" ${c.past ? 'checked' : ''}> Show past</label>`}
      <div class="seg" role="group" aria-label="Calendar view">${['month', 'week', 'agenda'].map((v) => `<button data-act="cal-view" data-v="${v}" class="${c.view === v ? 'on' : ''}">${v === 'agenda' ? 'List' : v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      <select data-change="cal-project" aria-label="Filter by project"><option value="all">All ongoing projects</option><option value="everything" ${c.project === 'everything' ? 'selected' : ''}>All projects (incl. paused &amp; completed)</option>${opts}</select>
      ${state.edit ? `<button class="btn sm" data-act="new-leave" data-date="${c.view === 'month' ? c.day : ymd(new Date())}">＋ Day off</button><button class="btn sm primary" data-act="new-stage" data-date="${c.view === 'month' ? c.day : ymd(new Date())}">＋ Stage</button>` : ''}
    </div>
    ${body}
    <div style="margin-top:12px">${calLegend()}</div>`;
}

function monthView(cur, items) {
  const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const today = ymd(new Date());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    if (i === 35 && d.getMonth() !== cur.getMonth()) break;
    const key = ymd(d);
    const evs = itemsOnDay(items, d);
    cells.push(`<div class="mday ${d.getMonth() !== cur.getMonth() ? 'other' : ''} ${key === today ? 'today' : ''} ${key === state.cal.day ? 'sel' : ''}" data-act="cal-day" data-date="${key}">
      <div class="dnum">${d.getDate()}</div>
      ${evs.slice(0, 3).map((x) => calChip(x, `${!x.s.allDay && x.s.date === key ? `${x.s.start} ` : ''}${esc(x.s.name)}`)).join('')}
      ${evs.length > 3 ? `<div class="more">+${evs.length - 3} more</div>` : ''}
    </div>`);
  }
  const dayItems = itemsOnDay(items, parseYmd(state.cal.day));
  return `<div class="month">
      <div class="month-head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div>${d}</div>`).join('')}</div>
      <div class="month-grid">${cells.join('')}</div>
    </div>
    <div class="day-panel">
      <div class="section-title" style="margin-top:6px">${esc(fmtDay(parseYmd(state.cal.day)))} <span class="count">${dayItems.length}</span></div>
      ${dayItems.length ? `<div class="mini-list">${dayItems.map((x) => miniRow(x)).join('')}</div>` : '<p class="muted small">Nothing scheduled on this day.</p>'}
    </div>`;
}

function layoutDay(evs) {
  evs.sort((a, b) => a.a - b.a || b.b - a.b);
  let cluster = []; let clusterEnd = -1;
  const flush = () => {
    const cols = [];
    for (const ev of cluster) {
      let c = cols.findIndex((end) => end <= ev.a);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = ev.b; ev.col = c;
    }
    for (const ev of cluster) ev.ncol = cols.length;
    cluster = [];
  };
  for (const ev of evs) {
    if (cluster.length && ev.a >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(ev); clusterEnd = Math.max(clusterEnd, ev.b);
  }
  if (cluster.length) flush();
  return evs;
}

function weekView(first, n, items) {
  const days = Array.from({ length: n }, (_, i) => addDays(first, i));
  const today = ymd(new Date());
  const now = new Date();
  const head = days.map((d) => `<div class="${ymd(d) === today ? 'today' : ''}">${fmt(d, { weekday: 'short' })}<b>${d.getDate()}</b></div>`).join('');
  const allday = days.map((d) => {
    const evs = itemsOnDay(items, d).filter((x) => !isSingleDayTimed(x.s));
    return `<div>${evs.map((x) => calChip(x, esc(x.s.name), 'wide')).join('')}</div>`;
  }).join('');
  const cols = days.map((d) => {
    const key = ymd(d);
    const evs = layoutDay(items.filter((x) => isSingleDayTimed(x.s) && x.s.date === key).map((x) => {
      const a = toMin(x.s.start); let b = x.s.end ? toMin(x.s.end) : a + 60; if (b <= a) b = a + 60;
      return { ...x, a, b };
    }));
    const blocks = evs.map((ev) => {
      const w = 100 / ev.ncol;
      return `<div class="ev st-${ev.st}" data-act="open-stage" data-id="${ev.s.id}" title="${esc(`${ev.s.name} · ${ev.p.title} · ${stInfo(ev.s, ev.st).label}`)}" style="--pc:${esc(projColor(ev.p))};top:${(ev.a / 60) * HOUR_H}px;height:${Math.max(((ev.b - ev.a) / 60) * HOUR_H - 2, 20)}px;left:calc(${w * ev.col}% + 2px);width:calc(${w}% - 4px);right:auto">
        <b>${STATUS_DOT.has(ev.st) ? '<span class="sdot" aria-hidden="true"></span>' : ''}${esc(ev.s.name)}</b>${esc(ev.s.start)}–${esc(ev.s.end || fromMin(ev.b))}</div>`;
    }).join('');
    const nowLine = key === today ? `<div class="now-line" style="top:${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_H}px"></div>` : '';
    return `<div class="wk-col ${key === today ? 'today' : ''}" data-act="cal-slot" data-date="${key}">${blocks}${nowLine}</div>`;
  }).join('');
  const hours = Array.from({ length: 24 }, (_, h) => `<div>${h ? `${pad(h)}:00` : ''}</div>`).join('');
  return `<div class="week" style="--ndays:${n};--hh:${HOUR_H}px">
      <div class="wk-head"><div></div>${head}</div>
      <div class="wk-allday"><div>all-day</div>${allday}</div>
      <div class="wk-scroll" id="wk-scroll"><div class="wk-body"><div class="wk-hours">${hours}</div>${cols}</div></div>
    </div>`;
}

function agendaView(items) {
  const today0 = startOfDay(new Date());
  const list = items.filter((x) => state.cal.past || x.r.end >= today0 || x.st === 'overdue').sort((a, b) => a.r.start - b.r.start);
  if (!list.length) return '<div class="card empty">Nothing scheduled.</div>';
  const groups = new Map();
  for (const x of list) { const k = x.s.date; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const todayKey = ymd(today0);
  return [...groups].map(([k, xs]) => `<div class="agenda-day ${k === todayKey ? 'today' : ''}"><h3>${k === todayKey ? 'Today · ' : ''}${esc(fmtDay(parseYmd(k)))}</h3>
    <div class="mini-list">${xs.map((x) => miniRow(x, x.st === 'overdue')).join('')}</div></div>`).join('');
}

// ---- report
function viewReport(scope) {
  const projects = scopeProjects(scope);
  const { meta } = state.data;
  return `<div class="report">
    <div class="row no-print" style="margin-bottom:14px"><a class="btn" href="${scope !== 'all' && findProject(scope) ? `#/project/${encodeURIComponent(scope)}` : '#/'}">← Back</a><span class="spacer"></span><button class="btn primary" data-act="print">🖨️ Print / Save as PDF</button></div>
    <h1>${esc(meta.title)}${scope !== 'all' && projects[0] ? ` — ${esc(projects[0].title)}` : ''}</h1>
    <p class="muted">${meta.subtitle ? `${esc(meta.subtitle)} · ` : ''}Report generated ${esc(new Date().toLocaleString(LOCALE))}${meta.updated ? ` · data last updated ${esc(new Date(meta.updated).toLocaleString(LOCALE))}` : ''}</p>
    ${projects.map((p) => {
      const c = progressOf(p);
      return `<section class="proj"><h2>${esc(p.title)} <span class="pill">${esc(p.status)}</span></h2>
        ${p.description ? `<p class="muted" style="margin:4px 0">${esc(p.description)}</p>` : ''}
        <div style="max-width:420px;margin-top:8px">${progressMeta(c)}${pbar(c)}</div>
        <div class="table-wrap"><table><thead><tr><th>#</th><th>Action</th><th>Schedule</th><th>Experiment conditions</th><th>Status</th><th>Comment</th></tr></thead><tbody>
        ${p.stages.map((s, i) => `<tr><td>${i + 1}</td><td><b>${esc(s.name)}</b>${s.notes ? `<div class="muted small">${esc(s.notes)}</div>` : ''}</td><td>${esc(fmtWhen(s))}</td>
          <td>${s.conditions.length ? `<ol>${s.conditions.map((cn) => `<li>${esc(cn)}</li>`).join('')}</ol>` : '—'}</td>
          <td class="st st-${statusOf(s)}">${stInfo(s).icon} ${esc(stInfo(s).label)}</td><td>${esc(s.comment) || '—'}</td></tr>`).join('')}
        </tbody></table></div></section>`;
    }).join('')}
  </div>`;
}

// ---------------------------------------------------------------- main render
function render() {
  if (!state.data) return;
  computeStatuses();
  const route = parseRoute();
  const { meta } = state.data;
  document.title = route.name === 'project' ? `${findProject(route.id)?.title || 'Project'} · ${meta.title}` : meta.title;
  $('#brand-title').textContent = meta.title;
  $$('.tabs [data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === (['calendar', 'completed'].includes(route.name) ? route.name : route.name === 'project' && findProject(route.id)?.status === 'completed' ? 'completed' : route.name === 'report' ? '' : 'dashboard')));

  // top actions
  let actions = '<button class="btn sm" data-act="share" aria-label="Share visitor link">🔗<span class="lbl-long"> Share</span></button>';
  if (state.owner) {
    if (state.dirty) actions += '<button class="btn sm primary pulse" data-act="publish">⬆ Publish</button>';
    actions += state.edit
      ? '<button class="btn sm" data-act="settings" aria-label="Settings">⚙︎</button><button class="btn sm" data-act="toggle-edit">Done</button>'
      : '<button class="btn sm" data-act="toggle-edit">✎ Edit</button>';
  }
  $('#top-actions').innerHTML = actions;

  // banner
  const overdue = [...state.statuses.values()].filter((v) => v === 'overdue').length;
  let banner = '';
  if (state.owner && state.dirty) banner = `<div class="banner"><div class="inner info">You have unpublished changes. Visitors still see the previous version.<span class="spacer"></span><button class="btn sm primary" data-act="publish">Publish now</button><button class="btn sm ghost" data-act="discard">Discard</button></div></div>`;
  else if (state.edit && overdue && route.name !== 'dashboard') banner = `<div class="banner"><div class="inner st-overdue">⏰ ${overdue} stage${overdue > 1 ? 's' : ''} past the planned date need${overdue > 1 ? '' : 's'} an update.<span class="spacer"></span><a class="btn sm" href="#/">Review</a></div></div>`;
  $('#banner').innerHTML = banner;

  // view
  const scroll = $('#wk-scroll')?.scrollTop;
  const v = $('#view');
  v.innerHTML = route.name === 'project' ? viewProject(route.id)
    : route.name === 'calendar' ? viewCalendar()
    : route.name === 'report' ? viewReport(route.id)
    : route.name === 'completed' ? viewCompleted()
    : viewDashboard();
  const wk = $('#wk-scroll');
  if (wk) wk.scrollTop = scroll ?? Math.max(0, (Math.min(new Date().getHours(), 16) - 1) * HOUR_H - 20) ;

  $('#foot').innerHTML = `<span>${meta.updated ? `Last updated ${esc(new Date(meta.updated).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}</span>
    <span>${state.owner ? (state.edit ? 'Editing on this device' : 'Owner device') : 'View only · <a href="#" data-act="owner-signin">Owner sign-in</a>'}</span>`;
}

// ---------------------------------------------------------------- modal / toast
let modalCleanup = null;
function openModal({ title, body, footer = '', onMount }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-close><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">${body}</div>${footer ? `<div class="modal-foot">${footer}</div>` : ''}</div></div>`;
  document.body.classList.add('modal-open');
  const bd = root.firstElementChild;
  bd.addEventListener('click', (e) => { if (e.target.closest('[data-close]') && (e.target === bd || e.target.closest('button[data-close]'))) closeModal(); });
  const m = $('.modal', root);
  modalCleanup = onMount ? onMount(m) : null;
  const first = m.querySelector('input:not([type=hidden]):not([type=radio]), textarea');
  if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
  return m;
}
function closeModal() {
  if (typeof modalCleanup === 'function') modalCleanup();
  modalCleanup = null;
  $('#modal-root').innerHTML = '';
  document.body.classList.remove('modal-open');
}
const modalOpen = () => !!$('#modal-root').firstElementChild;

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- dialogs
function openStage(id) {
  const f = findStage(id); if (!f) return;
  const { p, s } = f; const st = statusOf(s);
  const E = state.edit;
  openModal({
    title: s.name,
    body: `<div class="stack">
      <div class="row"><span class="mini" style="padding:0;background:none;border:0;cursor:auto"><span class="dot" style="background:${esc(projColor(p))}"></span></span><a href="#/project/${encodeURIComponent(p.id)}" data-close-nav>${esc(p.title)}</a><span class="spacer"></span>${badge(st, s)}</div>
      <div class="when" style="font-size:.95rem">🗓 ${esc(fmtWhen(s))}</div>
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      ${s.conditions.length ? `<div class="st-${st}"><ol class="conds">${s.conditions.map((c, k) => `<li><b>Condition ${k + 1}</b><span>${esc(c)}</span></li>`).join('')}</ol></div>` : st === 'off' ? '' : '<p class="muted small">No experiment conditions listed.</p>'}
      ${s.comment ? `<div class="st-${st}"><div class="comment"><b>${s.outcome === 'failed' ? 'Why it did not go as planned' : 'Comment'}</b>${esc(s.comment)}</div></div>` : ''}
      ${st === 'overdue' ? `<div class="needs-update"><strong>The planned date has passed — did it go as planned?</strong></div>` : ''}
    </div>`,
    footer: E && st === 'off' ? `<button class="btn danger" data-act="delete-stage" data-id="${s.id}">Delete</button><span class="spacer"></span>
        <button class="btn primary" data-act="edit-stage" data-id="${s.id}">✎ Edit</button>`
      : E ? `<button class="btn danger" data-act="delete-stage" data-id="${s.id}">Delete</button><span class="spacer"></span>
        ${s.outcome === 'failed' ? `<button class="btn" data-act="dup-stage" data-id="${s.id}">↻ Reschedule</button>` : ''}
        <button class="btn" data-act="edit-stage" data-id="${s.id}">✎ Edit</button>
        <button class="btn primary" data-act="outcome" data-id="${s.id}">Update result</button>`
      : `<a class="btn" href="#/project/${encodeURIComponent(p.id)}" data-close-nav>Open project</a>`,
  });
}

function openOutcome(id, preset) {
  const f = findStage(id); if (!f || isLeave(f.p)) return;
  const { s } = f;
  const initial = preset || s.outcome || 'done';
  openModal({
    title: 'Update result',
    body: `<form id="oc-form">
      <p style="margin-top:0"><b>${esc(s.name)}</b><br><span class="muted small">${esc(fmtWhen(s))}</span></p>
      <div class="choice">
        <label class="st-done"><input type="radio" name="oc" value="done" ${initial === 'done' ? 'checked' : ''}><span class="opt"><span class="ico">✓</span>Done as planned</span></label>
        <label class="st-failed"><input type="radio" name="oc" value="failed" ${initial === 'failed' ? 'checked' : ''}><span class="opt"><span class="ico">✕</span>Not as planned</span></label>
      </div>
      <label class="field"><span id="oc-label">Comment (optional)</span><textarea name="comment" rows="4" placeholder="What happened?">${esc(s.comment)}</textarea></label>
      <p class="help" id="oc-help"></p>
      ${s.outcome ? '<button type="button" class="btn sm ghost" id="oc-reset">↺ Reset to “not updated yet”</button>' : ''}
    </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" form="oc-form" type="submit">Save</button>',
    onMount(m) {
      const form = $('#oc-form', m);
      const sync = () => {
        const v = form.oc.value;
        $('#oc-label', m).textContent = v === 'failed' ? 'What happened? (required)' : 'Comment (optional)';
        form.comment.required = v === 'failed';
        form.comment.placeholder = v === 'failed' ? 'e.g. equipment failure, sample contamination, postponed…' : 'Any notes on the result';
        $('#oc-help', m).textContent = v === 'failed' ? 'The stage turns red. You can then reschedule it as a new stage.' : 'The stage turns green.';
        if (v === 'failed' && preset === 'failed') form.comment.focus();
      };
      form.addEventListener('change', sync); sync();
      $('#oc-reset', m)?.addEventListener('click', () => { s.outcome = null; closeModal(); commit('Result cleared'); });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = form.oc.value; const comment = form.comment.value.trim();
        if (v === 'failed' && !comment) { form.comment.reportValidity(); return; }
        s.outcome = v; s.comment = comment; s.updatedAt = new Date().toISOString();
        closeModal();
        commit(v === 'done' ? 'Marked as completed ✓' : 'Marked as not as planned');
        if (v === 'failed' && confirm('Plan a repeat of this stage now?')) duplicateStage(s.id);
      });
    },
  });
}

function openStageForm({ id, pid, date, start } = {}) {
  const found = id ? findStage(id) : null;
  const s = found ? found.s : { name: '', notes: '', conditions: [''], date: date || '', endDate: '', start: start || '', end: start ? fromMin(Math.min(toMin(start) + 120, 23 * 60 + 59)) : '', allDay: !start, outcome: null, comment: '', kind: 'holiday' };
  const research = state.data.projects.filter((p) => !isLeave(p));
  const projectId = found ? found.p.id : pid || (findProject(state.cal.project) ? state.cal.project : research.find((p) => p.status === 'ongoing')?.id || research[0]?.id || state.data.projects[0]?.id);
  if (!state.data.projects.length) { toast('Create a project first'); openProjectForm(); return; }
  const conds = s.conditions.length ? [...s.conditions] : [''];
  const condRow = (v, i) => `<div class="cond-row"><span class="lab">Condition ${i + 1}</span><textarea name="cond" rows="1" placeholder="e.g. 35 °C, pH 7, 3 replicates">${esc(v)}</textarea><button type="button" class="icon-btn" data-rm aria-label="Remove condition">✕</button></div>`;
  openModal({
    title: found ? 'Edit stage' : 'New stage',
    body: `<form id="st-form" autocomplete="off">
      <label class="field"><span>Project</span><select name="pid">${byColor().map((p) => `<option value="${esc(p.id)}" ${p.id === projectId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select></label>
      <label class="field leave-only"><span>Type of day off</span><select name="kind">${Object.entries(LEAVE_KINDS).map(([k, v]) => `<option value="${k}" ${(s.kind || 'holiday') === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}</select></label>
      <label class="field"><span id="name-label">Action name</span><input type="text" name="name" required value="${esc(s.name)}" placeholder="e.g. BMP batch test set-up"></label>
      <div class="field research-only"><span class="muted small" style="font-weight:600;display:block;margin-bottom:6px">Experiment conditions</span>
        <div id="conds">${conds.map(condRow).join('')}</div>
        <button type="button" class="btn sm" id="add-cond">＋ Add condition</button></div>
      <label class="field"><span>Notes (optional)</span><textarea name="notes" rows="2">${esc(s.notes)}</textarea></label>
      <div class="grid2">
        <label class="field"><span>Date</span><input type="date" name="date" value="${esc(s.date)}"></label>
        <label class="field"><span>End date (multi-day)</span><input type="date" name="endDate" value="${esc(s.endDate)}"></label>
      </div>
      <label class="check"><input type="checkbox" name="allDay" ${s.allDay ? 'checked' : ''}> All day</label>
      <div class="grid2" id="times">
        <label class="field"><span>Start time</span><input type="time" name="start" value="${esc(s.start)}"></label>
        <label class="field"><span>End time</span><input type="time" name="end" value="${esc(s.end)}"></label>
      </div>
      <p class="help research-only">Leave the date empty to keep the stage unscheduled.</p>
      <p class="help leave-only">Days off are always shown in white and never ask for a status update.</p>
    </form>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="st-form">${found ? 'Save' : 'Add stage'}</button>`,
    onMount(m) {
      const form = $('#st-form', m); const box = $('#conds', m);
      const renumber = () => $$('.cond-row .lab', box).forEach((l, i) => { l.textContent = `Condition ${i + 1}`; });
      $('#add-cond', m).addEventListener('click', () => {
        box.insertAdjacentHTML('beforeend', condRow('', box.children.length));
        box.lastElementChild.querySelector('textarea').focus();
      });
      box.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { e.target.closest('.cond-row').remove(); renumber(); } });
      const syncTimes = () => { $('#times', m).classList.toggle('hidden', form.allDay.checked); };
      const syncType = () => {
        const leave = isLeave(findProject(form.pid.value));
        $$('.leave-only', m).forEach((el) => el.classList.toggle('hidden', !leave));
        $$('.research-only', m).forEach((el) => el.classList.toggle('hidden', leave));
        $('#name-label', m).textContent = leave ? 'Title' : 'Action name';
        form.name.placeholder = leave ? 'e.g. Sports Day, dentist appointment' : 'e.g. BMP batch test set-up';
        $('.modal-foot [type=submit]', m).textContent = found ? 'Save' : leave ? 'Add day off' : 'Add stage';
        $('.modal-head h2', m).textContent = found ? (leave ? 'Edit day off' : 'Edit stage') : (leave ? 'New day off' : 'New stage');
      };
      form.pid.addEventListener('change', syncType);
      syncType();
      form.allDay.addEventListener('change', () => { if (!form.allDay.checked && !form.start.value) { form.start.value = '09:00'; form.end.value = '12:00'; } syncTimes(); });
      syncTimes();
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const allDay = form.allDay.checked || !fd.get('start');
        const date = fd.get('date'); let endDate = fd.get('endDate');
        if (!date) endDate = '';
        if (endDate && endDate < date) { toast('End date is before the start date'); form.endDate.focus(); return; }
        if (!allDay && !endDate && fd.get('end') && fd.get('end') <= fd.get('start')) { toast('End time must be after the start time'); form.end.focus(); return; }
        const next = {
          name: fd.get('name').trim(), notes: fd.get('notes').trim(),
          conditions: fd.getAll('cond').map((c) => c.trim()).filter(Boolean),
          date, endDate: endDate === date ? '' : endDate, allDay, start: allDay ? '' : fd.get('start'), end: allDay ? '' : fd.get('end'),
        };
        const target = findProject(fd.get('pid'));
        if (isLeave(target)) { next.conditions = []; next.kind = fd.get('kind'); next.outcome = null; next.comment = ''; }
        if (found) {
          Object.assign(s, next);
          if (target.id !== found.p.id) { found.p.stages.splice(found.i, 1); target.stages.push(s); }
        } else {
          target.stages.push({ id: uid('s'), ...next, outcome: null, comment: '' });
        }
        closeModal();
        commit(isLeave(target) ? (found ? 'Day off saved' : 'Day off added') : found ? 'Stage saved' : 'Stage added');
      });
    },
  });
}

function openProjectForm(id) {
  const p = id ? findProject(id) : null;
  const color = p?.color || COLORS[state.data.projects.length % COLORS.length];
  openModal({
    title: p ? 'Edit project' : 'New project',
    body: `<form id="pj-form" autocomplete="off">
      <label class="field"><span>Project title</span><input type="text" name="title" required value="${esc(p?.title || '')}"></label>
      <label class="field"><span>Description (optional)</span><textarea name="description" rows="3">${esc(p?.description || '')}</textarea></label>
      <label class="field"><span>Type</span><select name="type">
        <option value="research" ${!isLeave(p) ? 'selected' : ''}>Research project</option>
        <option value="leave" ${isLeave(p) ? 'selected' : ''}>🏖 Holiday &amp; leave (white, no status updates)</option></select></label>
      <div class="research-only"><label class="field"><span>Status</span><select name="status">${['ongoing', 'paused', 'completed'].map((v) => `<option value="${v}" ${(p?.status || 'ongoing') === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></label>
      <div class="field"><span class="muted small" style="font-weight:600;display:block;margin-bottom:6px">Colour</span>
        <div class="swatches">${COLORS.map((c) => `<label><input type="radio" name="color" value="${c}" ${c === color ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div></div>
      <p class="help" style="margin-top:6px">Projects with the same colour are grouped together on the dashboard.</p></div>
      <p class="help leave-only">Holidays, personal appointments and university closures. They always show in white and never ask whether they went as planned.</p>
    </form>`,
    footer: `${p ? `<button class="btn danger" data-act="delete-project" data-id="${p.id}">Delete</button><span class="spacer"></span>` : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="pj-form">${p ? 'Save' : 'Create'}</button>`,
    onMount(m) {
      const form = $('#pj-form', m);
      const syncType = () => {
        const leave = form.type.value === 'leave';
        $$('.leave-only', m).forEach((el) => el.classList.toggle('hidden', !leave));
        $$('.research-only', m).forEach((el) => el.classList.toggle('hidden', leave));
      };
      form.type.addEventListener('change', syncType); syncType();
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const type = fd.get('type') === 'leave' ? 'leave' : 'research';
        const v = { title: fd.get('title').trim(), description: fd.get('description').trim(), type, status: type === 'leave' ? 'ongoing' : fd.get('status'), color: fd.get('color') || color };
        if (type === 'leave' && p && !isLeave(p) && p.stages.length && !confirm('Turn this project into “Holiday & leave”? Its stages will lose their results and conditions.')) return;
        if (type === 'leave') for (const st of p?.stages || []) { st.outcome = null; st.conditions = []; st.comment = ''; st.kind ||= 'other'; }
        if (p) Object.assign(p, v);
        else { const np = { id: uid('p'), ...v, stages: [] }; state.data.projects.push(np); location.hash = `#/project/${np.id}`; }
        closeModal();
        commit(p ? 'Project saved' : 'Project created');
      });
    },
  });
}

function openSettings(note = '') {
  const g = state.gh; const meta = state.data.meta;
  openModal({
    title: 'Settings',
    body: `<form id="set-form" autocomplete="off">
      ${note ? `<div class="banner" style="padding:0;margin:0 0 14px"><div class="inner info">${esc(note)}</div></div>` : ''}
      <h3 style="margin-bottom:10px">Dashboard</h3>
      <label class="field"><span>Title</span><input type="text" name="title" value="${esc(meta.title)}"></label>
      <label class="field"><span>Subtitle</span><input type="text" name="subtitle" value="${esc(meta.subtitle)}" placeholder="e.g. your name · lab"></label>

      <h3 style="margin:18px 0 6px">Publishing to GitHub</h3>
      <p class="help" style="margin:0 0 12px">Changes are saved into <code>data.json</code> in your repository, which GitHub Pages serves to visitors. The token is stored only in this browser.</p>
      <div class="grid2">
        <label class="field"><span>GitHub user / org</span><input type="text" name="owner" value="${esc(g.owner)}" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Repository</span><input type="text" name="repo" value="${esc(g.repo)}" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Branch</span><input type="text" name="branch" value="${esc(g.branch)}" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Data file</span><input type="text" name="path" value="${esc(g.path)}" autocapitalize="off" spellcheck="false"></label>
      </div>
      <label class="field"><span>Access token</span><input type="password" name="token" value="${esc(g.token)}" placeholder="github_pat_…" autocapitalize="off" spellcheck="false"></label>
      <p class="help">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> limited to this one repository with <b>Contents: Read and write</b>.</p>
      <div class="row"><button type="button" class="btn sm" id="gh-load">⬇ Load latest from GitHub</button>${g.token ? '<button type="button" class="btn sm danger" id="gh-forget">Forget token</button>' : ''}</div>

      <h3 style="margin:18px 0 6px">Data</h3>
      <div class="row">
        <label class="btn sm" style="cursor:pointer">⬆ Import .json<input type="file" id="imp" accept="application/json,.json" hidden></label>
        <button type="button" class="btn sm" data-act="export">⇪ Export…</button>
        <button type="button" class="btn sm danger" id="leave-owner">Stop editing on this device</button>
      </div>
    </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="set-form">Save</button>',
    onMount(m) {
      const form = $('#set-form', m);
      const readGh = () => {
        const fd = new FormData(form);
        state.gh = { owner: fd.get('owner').trim(), repo: fd.get('repo').trim(), branch: fd.get('branch').trim() || 'main', path: fd.get('path').trim().replace(/^\/+/, '') || 'data.json', token: fd.get('token').trim() };
        store.set(KEY.gh, state.gh);
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault(); readGh();
        const fd = new FormData(form);
        const t = fd.get('title').trim() || 'Research Progress'; const sub = fd.get('subtitle').trim();
        const changed = t !== meta.title || sub !== meta.subtitle;
        meta.title = t; meta.subtitle = sub;
        closeModal();
        if (changed) commit('Settings saved'); else { render(); toast('Settings saved'); }
      });
      $('#gh-load', m).addEventListener('click', async () => {
        readGh();
        if (!ghReady()) { toast('Fill in user, repository and token first'); return; }
        if (state.dirty && !confirm('Replace your unpublished changes with the version on GitHub?')) return;
        if (await loadFromGitHub()) closeModal();
      });
      $('#gh-forget', m)?.addEventListener('click', () => { state.gh.token = ''; store.set(KEY.gh, state.gh); form.token.value = ''; toast('Token removed from this device'); });
      $('#leave-owner', m).addEventListener('click', () => {
        if (state.dirty && !confirm('You have unpublished changes. Leave editing anyway? (Your draft stays on this device.)')) return;
        state.owner = false; state.edit = false; store.del(KEY.owner); store.set(KEY.edit, false);
        closeModal(); render(); toast('This device is now view-only. Open the page with ?admin to edit again.', 4500);
      });
      $('#imp', m).addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try {
          const incoming = normalize(JSON.parse(await file.text()));
          const replace = confirm(`Import ${incoming.projects.length} project(s).\n\nOK = replace ALL current data\nCancel = merge (add new projects, update ones with the same id)`);
          if (replace) state.data = incoming;
          else for (const p of incoming.projects) { const i = state.data.projects.findIndex((x) => x.id === p.id); if (i >= 0) state.data.projects[i] = p; else state.data.projects.push(p); }
          closeModal(); commit('Imported');
        } catch (err) { toast(`Import failed: ${err.message}`, 5000); }
      });
    },
  });
}

// Lets the owner unlock editing without the ?admin URL (e.g. in a Home Screen
// web app, which has its own storage and opens the manifest start URL).
// A token that can read the repository through the API is the proof of ownership.
function openOwnerSignIn() {
  const g = state.gh;
  openModal({
    title: 'Owner sign-in',
    body: `<form id="own-form" autocomplete="off">
      <p class="muted small" style="margin-top:0">Paste your GitHub access token to edit on this device. Visitors don't need this; they can only view.</p>
      <div class="grid2">
        <label class="field"><span>GitHub user / org</span><input type="text" name="owner" value="${esc(g.owner)}" autocapitalize="off" spellcheck="false" required></label>
        <label class="field"><span>Repository</span><input type="text" name="repo" value="${esc(g.repo)}" autocapitalize="off" spellcheck="false" required></label>
      </div>
      <label class="field"><span>Access token</span><input type="password" name="token" value="${esc(g.token)}" placeholder="github_pat_…" autocapitalize="off" spellcheck="false" required></label>
    </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="own-form">Sign in</button>',
    onMount(m) {
      const form = $('#own-form', m);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('.modal-foot [type=submit]', m);
        btn.disabled = true; btn.textContent = 'Checking…';
        const prev = state.gh;
        state.gh = { ...prev, owner: form.owner.value.trim(), repo: form.repo.value.trim(), token: form.token.value.trim() };
        try {
          const { data, sha } = await ghGet();
          store.set(KEY.gh, state.gh);
          state.owner = true; state.edit = true;
          store.set(KEY.owner, true); store.set(KEY.edit, true);
          state.data = normalize(data); state.sha = sha; state.dirty = false; saveDraft();
          closeModal(); render();
          toast('Signed in ✓  You can edit on this device now.', 3500);
        } catch (err) {
          state.gh = prev;
          btn.disabled = false; btn.textContent = 'Sign in';
          toast(err.status === 401 ? 'That token was not accepted by GitHub' : err.status === 404 ? 'Repository not found, or the token has no access to it' : `Sign-in failed: ${err.message}`, 5000);
        }
      });
    },
  });
}

// The view-only link for visitors: this page without ?admin or any route.
const viewerUrl = () => `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
function openShare() {
  const url = viewerUrl();
  openModal({
    title: 'Share with visitors',
    body: `<p class="muted small" style="margin-top:0">Anyone with this link can follow your progress. It is view-only — nobody can edit through it.</p>
      <input type="text" id="share-url" readonly value="${esc(url)}" aria-label="Visitor link">`,
    footer: `${navigator.share ? '<button class="btn" id="share-native">Share…</button>' : ''}<button class="btn primary" id="share-copy">Copy link</button>`,
    onMount(m) {
      const input = $('#share-url', m);
      input.addEventListener('focus', () => input.select());
      $('#share-copy', m).addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); }
        catch { input.focus(); input.setSelectionRange(0, url.length); document.execCommand('copy'); }
        toast('Link copied ✓');
      });
      $('#share-native', m)?.addEventListener('click', () => {
        navigator.share({ title: state.data.meta.title, text: `${state.data.meta.title} — research progress`, url }).catch(() => {});
      });
    },
  });
}

function duplicateStage(id) {
  const f = findStage(id); if (!f) return;
  const copy = { ...structuredClone(f.s), id: uid('s'), name: /\(repeat\)$/.test(f.s.name) ? f.s.name : `${f.s.name} (repeat)`, outcome: null, comment: '', date: '', endDate: '' };
  f.p.stages.splice(f.i + 1, 0, copy);
  state.dirty = true; saveDraft(); render();
  openStageForm({ id: copy.id });
  toast('Pick a new date for the repeat');
}

// ---------------------------------------------------------------- events
const actions = {
  'owner-signin'() { openOwnerSignIn(); },
  'toggle-edit'() { state.edit = !state.edit; store.set(KEY.edit, state.edit); render(); if (state.edit && !ghReady()) toast('Tip: connect GitHub in ⚙︎ Settings to publish changes', 4000); },
  publish,
  discard() {
    if (!confirm('Discard all unpublished changes on this device?')) return;
    store.del(KEY.draft); state.dirty = false;
    (ghReady() ? loadFromGitHub({ quiet: true }) : fetchPublished().then((d) => { state.data = normalize(d); state.sha = null; saveDraft(); render(); })).then(() => toast('Changes discarded'));
  },
  settings() { openSettings(); },
  export() { closeModal(); openExport(); },
  dl(el) {
    const { kind, scope } = el.dataset;
    closeModal();
    if (kind === 'json') exportJSON(scope);
    else if (kind === 'csv') exportCSV(scope);
    else if (kind === 'ics') exportICS(scope);
    else location.hash = `#/report/${scope === 'all' ? '' : encodeURIComponent(scope)}`;
  },
  print() { window.print(); },
  'new-project'() { openProjectForm(); },
  share() { openShare(); },
  'new-leave'(el) {
    closeModal();
    let p = state.data.projects.find(isLeave);
    if (!p) { p = { id: uid('p'), title: 'Holidays & leave', description: '', type: 'leave', status: 'ongoing', color: COLORS[7], stages: [] }; state.data.projects.push(p); }
    openStageForm({ pid: p.id, date: el.dataset.date || ymd(new Date()) });
  },
  'edit-project'(el) { openProjectForm(el.dataset.id); },
  'delete-project'(el) {
    const p = findProject(el.dataset.id); if (!p) return;
    if (!confirm(`Delete project “${p.title}” and all its ${p.stages.length} stages?`)) return;
    state.data.projects = state.data.projects.filter((x) => x !== p);
    closeModal(); location.hash = '#/'; commit('Project deleted');
  },
  'open-stage'(el) { openStage(el.dataset.id); },
  'new-stage'(el) { closeModal(); openStageForm({ pid: el.dataset.pid, date: el.dataset.date }); },
  'edit-stage'(el) { closeModal(); openStageForm({ id: el.dataset.id }); },
  'dup-stage'(el) { closeModal(); duplicateStage(el.dataset.id); },
  'delete-stage'(el) {
    const f = findStage(el.dataset.id); if (!f) return;
    if (!confirm(`Delete stage “${f.s.name}”?`)) return;
    f.p.stages.splice(f.i, 1); closeModal(); commit('Stage deleted');
  },
  'move-stage'(el) {
    const f = findStage(el.dataset.id); if (!f) return;
    const j = f.i + Number(el.dataset.dir); if (j < 0 || j >= f.p.stages.length) return;
    [f.p.stages[f.i], f.p.stages[j]] = [f.p.stages[j], f.p.stages[f.i]];
    commit();
  },
  outcome(el) { closeModal(); openOutcome(el.dataset.id, el.dataset.v); },
  'cal-view'(el) { state.cal.view = el.dataset.v; saveCal(); render(); },
  'cal-today'() { state.cal.cursor = ymd(new Date()); state.cal.day = state.cal.cursor; saveCal(); render(); },
  'cal-nav'(el) {
    const d = Number(el.dataset.d); const cur = parseYmd(state.cal.cursor);
    if (state.cal.view === 'month') cur.setMonth(cur.getMonth() + d, 1);
    else cur.setDate(cur.getDate() + d * (window.matchMedia('(max-width: 720px)').matches ? 3 : 7));
    state.cal.cursor = ymd(cur); saveCal(); render();
  },
  'cal-day'(el) {
    state.cal.day = el.dataset.date;
    const d = parseYmd(el.dataset.date); const cur = parseYmd(state.cal.cursor);
    if (d.getMonth() !== cur.getMonth()) state.cal.cursor = el.dataset.date;
    saveCal(); render();
  },
  'cal-slot'(el, e) {
    if (!state.edit || e.target !== el) return;
    const y = e.clientY - el.getBoundingClientRect().top;
    const m = Math.max(0, Math.min(23 * 60, Math.floor((y / HOUR_H) * 2) * 30));
    openStageForm({ date: el.dataset.date, start: fromMin(m) });
  },
  'cal-project'(el) { state.cal.project = el.dataset.id; state.cal.cursor = ymd(new Date()); saveCal(); },
  'cal-past'(el) { state.cal.past = el.checked; saveCal(); render(); },
};
const saveCal = () => store.set(KEY.cal, state.cal);

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-nav]')) { closeModal(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.type === 'checkbox') { fn(el, e); return; }
  if (el.dataset.act !== 'cal-project') e.preventDefault();
  e.stopPropagation();
  fn(el, e);
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-change="cal-project"]')) { state.cal.project = e.target.value; saveCal(); render(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen()) closeModal(); });
window.addEventListener('hashchange', () => { closeModal(); render(); window.scrollTo(0, 0); });
let lastWide = window.matchMedia('(max-width: 720px)').matches;
window.addEventListener('resize', () => { const w = window.matchMedia('(max-width: 720px)').matches; if (w !== lastWide) { lastWide = w; if (!modalOpen()) render(); } });
// Statuses depend on the clock: refresh every minute, and when the app comes back to the foreground.
setInterval(() => { if (!modalOpen() && state.data) render(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !modalOpen() && state.data) render(); });

// ---------------------------------------------------------------- boot
function detectRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return {};
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg && !seg.includes('.') ? seg : `${m[1]}.github.io` };
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('admin')) store.set(KEY.owner, true);
  if (params.has('view')) store.del(KEY.owner);
  state.owner = !!store.get(KEY.owner);
  state.edit = state.owner && !!store.get(KEY.edit, false);
  state.gh = { ...state.gh, ...detectRepo(), ...(store.get(KEY.gh) || {}) };
  state.cal = { ...state.cal, ...(store.get(KEY.cal) || {}) };

  const draft = state.owner ? store.get(KEY.draft) : null;
  try {
    if (draft?.dirty && draft.data) {
      state.data = normalize(draft.data); state.sha = draft.sha || null; state.dirty = true;
    } else {
      state.data = normalize(await fetchPublished());
      if (state.owner && ghReady()) loadFromGitHub({ quiet: true });
    }
  } catch (e) {
    if (draft?.data) { state.data = normalize(draft.data); state.sha = draft.sha || null; }
    else {
      $('#view').innerHTML = `<div class="card empty"><h2>Could not load data</h2><p>${esc(e.message)}</p><p class="small">If you opened <code>index.html</code> directly from disk, serve the folder instead (e.g. <code>python3 -m http.server</code>) or open the GitHub Pages address.</p></div>`;
      return;
    }
  }
  render();
}
boot();
