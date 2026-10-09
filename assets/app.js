// Research Progress Dashboard — a dependency-free static app.
// students.json lists every student; each student's progress lives in its own
// JSON file (in this repository or in the student's own repository). Viewers
// read those files (read-only). A student signs in with a GitHub token, edits
// their own dashboard on their device and publishes by committing their file
// through the GitHub REST API. Only the student whose GitHub username matches
// an entry may edit it; admins listed in students.json manage the roster.

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
// Who can see a day off. The data files are public, so private details are
// never published: they stay on the student's own device (see "private leave").
const PRIVACY = {
  '':     { label: 'Everyone sees the details' },
  busy:   { label: 'Others only see that I’m away', short: '🔒 Details hidden from others' },
  hidden: { label: 'Only me (not published at all)', short: '🙈 Only visible to you' },
};
const KEY = { private: 'rpd.private', home: 'rpd.home', auth: 'rpd.auth', hub: 'rpd.hub', draft: 'rpd.draft', edit: 'rpd.edit', cal: 'rpd.cal', legacyGh: 'rpd.gh', legacyOwner: 'rpd.owner' };
const REGISTRY = 'students.json';

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
const startOfWeek = (d) => addDays(startOfDay(d), -d.getDay()); // weeks run Sunday → Saturday
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
  registry: null,   // students.json: { meta, students: [{ id, name, github, repo?, branch?, path? }] }
  students: new Map(), // id → record { entry, data, sha, dirty, error, loading }
  rec: null,        // the student whose pages are open
  auth: { token: '', login: '' }, // GitHub identity signed in on this device
  hub: { owner: '', repo: '', branch: 'main' }, // the repository that hosts this site and students.json
  hubLocked: false, // on GitHub Pages the hub is known from the address and can't be changed
  editPref: false,  // the signed-in student wants edit controls
  homeView: 'list', // overview layout: 'list' or 'cards' (remembered per device)
  edit: false,      // edit controls visible (editPref and allowed to edit the open student)
  cal: { view: 'month', cursor: ymd(new Date()), project: 'all', day: ymd(new Date()), past: false },
  statuses: new Map(),
};
// The open student's data, blob sha (for safe updates) and unpublished-changes flag.
for (const k of ['data', 'sha', 'dirty']) {
  Object.defineProperty(state, k, { get: () => state.rec?.[k] ?? (k === 'dirty' ? false : null), set: (v) => { if (state.rec) state.rec[k] = v; } });
}

// ---------------------------------------------------------------- students & permissions
const sameUser = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
const canEdit = (rec = state.rec) => !!(rec && state.auth.token && sameUser(rec.entry.github, state.auth.login));
const isAdmin = () => !!state.auth.token && (state.registry?.meta.admins || []).some((a) => sameUser(a, state.auth.login));
const myRecord = () => [...state.students.values()].find((r) => canEdit(r)) || null;

function normalizeRegistry(r) {
  const reg = r && typeof r === 'object' ? r : {};
  reg.meta = { title: 'Research Progress', subtitle: '', admins: [], ...(reg.meta || {}) };
  reg.meta.admins = Array.isArray(reg.meta.admins) ? reg.meta.admins.map(String) : [];
  reg.meta.grades = Array.isArray(reg.meta.grades) && reg.meta.grades.length ? reg.meta.grades.map(String) : DEFAULT_GRADES;
  reg.meta.comments = { url: '', key: '', ...(reg.meta.comments || {}) };
  const seen = new Set();
  reg.students = (Array.isArray(reg.students) ? reg.students : []).filter((st) => st && typeof st === 'object').map((st) => {
    const e = { ...st, name: String(st.name || st.id || 'Student'), github: String(st.github || ''), grade: String(st.grade || '').trim() };
    e.id = slug(st.id || e.name);
    while (seen.has(e.id)) e.id = `${e.id}-2`;
    seen.add(e.id);
    return e;
  });
  return reg;
}

function setRegistry(reg) {
  state.registry = normalizeRegistry(reg);
  const old = state.students;
  state.students = new Map(state.registry.students.map((entry) => {
    const prev = old.get(entry.id);
    if (prev) { prev.entry = entry; return [entry.id, prev]; }
    return [entry.id, { entry, data: null, sha: null, dirty: false, error: '', loading: null, gen: 0 }];
  }));
  if (state.rec && !state.students.has(state.rec.entry.id)) state.rec = null;
}

// Where a student's data file lives. By default it sits next to the site
// (students/<id>.json in the hub repository); `repo` points it at the
// student's own repository instead, where GitHub itself enforces who may write.
function target(rec) {
  const e = rec.entry;
  if (e.repo) {
    const [owner, repo] = e.repo.split('/');
    return { owner, repo, branch: e.branch || 'main', path: e.path || 'data.json', external: true };
  }
  return { owner: state.hub.owner, repo: state.hub.repo, branch: state.hub.branch || 'main', path: e.path || `students/${e.id}.json`, external: false };
}
function publicUrl(rec) {
  const t = target(rec);
  const path = t.path.split('/').map(encodeURIComponent).join('/');
  return t.external ? `https://raw.githubusercontent.com/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/${encodeURIComponent(t.branch)}/${path}` : path;
}
const href = (p = '', rec = state.rec) => `#/s/${encodeURIComponent(rec?.entry.id || '')}${p ? `/${p}` : ''}`;
const projHref = (id) => href(`project/${encodeURIComponent(id)}`);

// ---------------------------------------------------------------- data model
function normalize(d) {
  const data = d && typeof d === 'object' ? d : {};
  data.meta = { title: 'Research Progress', subtitle: '', updated: '', ...(data.meta || {}) };
  data.meta.comments = { url: '', key: '', ...(data.meta.comments || {}) };
  data.meta.hiddenComments = Array.isArray(data.meta.hiddenComments) ? data.meta.hiddenComments : [];
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  for (const p of data.projects) {
    p.id ||= uid('p');
    p.title ||= 'Untitled project';
    p.description ??= '';
    p.status ||= 'ongoing';
    p.color ||= COLORS[0];
    p.type = ['leave', 'event'].includes(p.type) ? p.type : 'research';
    if (p.type !== 'research') p.status = 'ongoing';
    p.top = p.type === 'event' && !!p.top;            // event shown at the top of the dashboard
    p.comments = p.type === 'event' && !!p.comments;  // visitors may comment on its entries
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
      if (p.type === 'leave' && PRIVACY[s.privacy]) { if (!s.privacy) delete s.privacy; } else delete s.privacy;
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

function computeStatuses(now = new Date(), data = state.data) {
  const map = new Map();
  for (const p of data.projects) {
    if (isLeave(p)) { for (const s of p.stages) map.set(s.id, 'off'); continue; }
    let next = null; let nextStart = Infinity;
    for (const s of p.stages) {
      let st;
      if (s.outcome === 'done') st = 'done';
      else if (s.outcome === 'failed') st = 'failed';
      else {
        const r = stageRange(s);
        if (!r) st = 'unscheduled';
        else if (r.start <= now) st = 'overdue'; // asks for a result as soon as the stage starts
        else { st = 'planned'; if (r.start < nextStart) { nextStart = r.start; next = s; } }
      }
      map.set(s.id, st);
    }
    if (next) map.set(next.id, 'upcoming');
  }
  return map;
}
const statusOf = (s) => state.statuses.get(s.id) || 'planned';
const isLeave = (p) => p?.type === 'leave';
// Special events (regular meetings, seminars, lab activities): stages keep their
// status colours and update prompts, but the project is not an "ongoing project"
// (no progress bar, not in the stats) and is always listed in the calendar and stage form.
const isEvent = (p) => p?.type === 'event';
const isResearch = (p) => !isLeave(p) && !isEvent(p);
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
const draftKey = (rec) => `${KEY.draft}.${rec.entry.id}`;
function saveDraft(rec = state.rec) {
  if (!rec) return;
  store.set(draftKey(rec), { data: rec.data, sha: rec.sha, dirty: rec.dirty });
  savePrivate(rec);
}

// ---- private leave
// A day off marked "busy" is published with only its type and dates; one marked
// "hidden" is not published at all. What others must not see is kept in this
// device's storage and put back whenever the student's own data is loaded.
const privateKey = (rec) => `${KEY.private}.${rec.entry.id}`;
const privateStages = (data) => data.projects.filter(isLeave).flatMap((p) => p.stages.filter((s) => s.privacy).map((s) => ({ p, s })));
function savePrivate(rec) {
  if (!canEdit(rec) || !rec.data) return;
  const out = {};
  for (const { p, s } of privateStages(rec.data)) out[s.id] = s.privacy === 'hidden' ? { ...structuredClone(s), pid: p.id } : { privacy: 'busy', name: s.name, notes: s.notes };
  if (Object.keys(out).length) store.set(privateKey(rec), out); else store.del(privateKey(rec));
}
function mergePrivate(rec, data) {
  const saved = canEdit(rec) ? store.get(privateKey(rec)) : null;
  if (!saved) return data;
  const have = new Map(data.projects.flatMap((p) => p.stages.map((s) => [s.id, s])));
  for (const [id, v] of Object.entries(saved)) {
    const s = have.get(id);
    if (v.privacy === 'busy') { if (s?.privacy === 'busy') Object.assign(s, { name: v.name, notes: v.notes }); continue; }
    if (v.privacy !== 'hidden' || s) continue;
    let p = data.projects.find((x) => x.id === v.pid && isLeave(x)) || data.projects.find(isLeave);
    if (!p) { p = { id: v.pid || uid('p'), title: 'Holidays & leave', description: '', type: 'leave', status: 'ongoing', color: COLORS[7], stages: [] }; data.projects.push(p); }
    const { pid, ...stage } = v;
    p.stages.push(stage);
  }
  return normalize(data);
}
// The copy that goes online: busy days off lose their title and notes, hidden ones are left out.
function publicCopy(data) {
  const out = structuredClone(data);
  for (const p of out.projects) for (const s of p.stages) if (!s.privacy) delete s.privacy;
  for (const p of out.projects.filter(isLeave)) {
    p.stages = p.stages.filter((s) => s.privacy !== 'hidden').map((s) => (s.privacy === 'busy' ? { ...s, name: (LEAVE_KINDS[s.kind] || LEAVE_KINDS.other).label, notes: '' } : s));
  }
  return out;
}

function commit(msg) {
  state.dirty = true;
  saveDraft();
  render();
  if (msg) toast(msg);
}

async function fetchJSON(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) { const e = new Error(`${url.split('?')[0].split('/').pop()}: HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}
const emptyData = (rec) => normalize({ meta: { title: rec.entry.name, subtitle: '' }, projects: [] });

async function fetchPublished(rec = state.rec) {
  try { return normalize(await fetchJSON(publicUrl(rec))); }
  catch (e) { if (e.status === 404) return emptyData(rec); throw e; } // a new student who has not published yet
}

// Loads a student's data once: their unpublished draft on their own device,
// otherwise the published file (refreshed from the GitHub API when it is theirs).
function ensureLoaded(rec) {
  if (rec.data || rec.loading) return rec.loading || Promise.resolve();
  rec.error = '';
  const gen = rec.gen;
  rec.loading = (async () => {
    const draft = canEdit(rec) ? store.get(draftKey(rec)) : null;
    let data = null; let sha = null; let dirty = false; let error = '';
    try {
      if (draft?.dirty && draft.data) { data = normalize(draft.data); sha = draft.sha || null; dirty = true; }
      else data = mergePrivate(rec, await fetchPublished(rec));
    } catch (e) {
      if (draft?.data) { data = normalize(draft.data); sha = draft.sha || null; }
      else error = e.message;
    }
    if (rec.gen !== gen) return; // reset meanwhile (e.g. signed in): a newer load owns the record
    Object.assign(rec, { data, sha, dirty, error, loading: null });
    if (data && !dirty && canEdit(rec)) loadFromGitHub(rec, { quiet: true });
  })();
  return rec.loading;
}
// Forget a loaded record so the next render loads it again.
function resetRecord(rec) { rec.gen++; Object.assign(rec, { data: null, sha: null, dirty: false, error: '', loading: null }); }

// ---- GitHub contents API
const b64enc = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function ghApi(url, { method = 'GET', body, token = state.auth.token } = {}) {
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
function ghUrl({ owner, repo, path }) {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}
async function ghGet(t) {
  const j = await ghApi(`${ghUrl(t)}?ref=${encodeURIComponent(t.branch)}&t=${Date.now()}`);
  return { data: JSON.parse(b64dec(j.content)), sha: j.sha };
}
async function ghPut(t, text, sha, message) {
  const j = await ghApi(ghUrl(t), { method: 'PUT', body: { message, content: b64enc(text), branch: t.branch, ...(sha ? { sha } : {}) } });
  return j.content.sha;
}
const ghReady = (rec = state.rec) => { const t = rec && target(rec); return !!(state.auth.token && t?.owner && t?.repo); };
const hubReady = () => !!(state.auth.token && state.hub.owner && state.hub.repo);
const hubTarget = () => ({ ...state.hub, branch: state.hub.branch || 'main', path: REGISTRY });

async function loadFromGitHub(rec = state.rec, { quiet = false } = {}) {
  if (!ghReady(rec)) return false;
  try {
    const { data, sha } = await ghGet(target(rec));
    rec.data = mergePrivate(rec, normalize(data)); rec.sha = sha; rec.dirty = false;
    saveDraft(rec); render();
    if (!quiet) toast('Loaded latest version from GitHub');
    return true;
  } catch (e) {
    if (e.status === 404) { rec.sha = null; return false; } // nothing published yet
    if (!quiet) toast(`Could not load from GitHub: ${e.message}`, 5000);
    return false;
  }
}

async function publish() {
  const rec = state.rec;
  if (!canEdit(rec)) { openSignIn('Sign in as this student to publish changes.'); return; }
  if (!ghReady(rec)) { openSignIn('The repository for this dashboard is not set. Fill it in under “Site repository”.'); return; }
  const btn = $('[data-act="publish"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  const t = target(rec);
  rec.data.meta.updated = new Date().toISOString();
  savePrivate(rec);
  const text = `${JSON.stringify(publicCopy(rec.data), null, 2)}\n`;
  const message = `Update research progress: ${rec.entry.name} (${new Date().toLocaleString(LOCALE)})`;
  try {
    if (!rec.sha) { try { rec.sha = (await ghGet(t)).sha; } catch (e) { if (e.status !== 404) throw e; } }
    try {
      rec.sha = await ghPut(t, text, rec.sha, message);
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      if (!confirm('The online version changed since you loaded it (perhaps edited on another device).\n\nOK = overwrite it with this version\nCancel = keep your changes as a local draft')) throw new Error('Publish cancelled');
      rec.sha = (await ghGet(t)).sha;
      rec.sha = await ghPut(t, text, rec.sha, message);
    }
    rec.dirty = false; saveDraft(rec); render();
    toast('Published ✓  Visitors will see it within a minute or two.', 4000);
  } catch (e) {
    render();
    const why = e.status === 403 || e.status === 404 ? `your token cannot write to ${t.owner}/${t.repo}. Ask the admin for access, or check the token's repository and “Contents: Read and write” permission.` : e.message;
    toast(e.message === 'Publish cancelled' ? e.message : `Publish failed: ${why}`, 7000);
  }
}

// The roster (students.json) is changed straight on GitHub by an admin:
// read the latest version, apply the change, and commit it.
async function saveRegistry(change, message) {
  if (!isAdmin()) throw new Error('Only admins can change the student list');
  if (!hubReady()) throw new Error('Set the site repository in Sign in → Site repository first');
  const t = hubTarget();
  let reg; let sha = null;
  try { const got = await ghGet(t); reg = got.data; sha = got.sha; }
  catch (e) { if (e.status !== 404) throw e; reg = JSON.parse(JSON.stringify(state.registry)); }
  reg = normalizeRegistry(reg);
  change(reg);
  for (const st of reg.students) if (!st.grade) delete st.grade;
  await ghPut(t, `${JSON.stringify(reg, null, 2)}\n`, sha, message);
  setRegistry(reg);
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
  const slide = `<div class="export-group"><h3>For the next meeting</h3><div class="export-list">
      <button class="btn" data-act="meeting-slide">📽 Plan slide (.pptx, 4:3) <small>what you'll do until the next meeting</small></button>
    </div></div>`;
  const group = (scope, title) => `
    <div class="export-group"><h3>${esc(title)}</h3><div class="export-list">
      <button class="btn" data-act="dl" data-kind="report" data-scope="${scope}">🖨️ Printable report / PDF <small>print or save as PDF</small></button>
      <button class="btn" data-act="dl" data-kind="csv" data-scope="${scope}">📊 Spreadsheet (.csv) <small>Excel, Numbers, Sheets</small></button>
      <button class="btn" data-act="dl" data-kind="ics" data-scope="${scope}">📅 Calendar (.ics) <small>Google / Apple Calendar</small></button>
      <button class="btn" data-act="dl" data-kind="json" data-scope="${scope}">💾 Full data (.json) <small>backup, re-import</small></button>
    </div></div>`;
  openModal({
    title: 'Export',
    body: `${slide}${p ? group(p.id, `This project — ${p.title}`) : ''}${group('all', 'All projects')}
      <p class="help" style="margin-top:14px">On iPhone, downloaded files go to the Files app (Downloads). Open the .ics file to add the schedule to your calendar.</p>`,
  });
}

// ---------------------------------------------------------------- meeting slide
// One 4:3 PowerPoint slide with what the student plans to do until the next
// meeting: stages grouped by project, with their dates, experiment conditions
// and notes. A single layout model drives both the in-app preview and the .pptx,
// and it steps down in size (then drops notes, then extra conditions, then
// stages) so the slide never looks cramped.
const SLIDE = { w: 10, h: 7.5, m: 0.75, top: 1.85, bottom: 6.7, card: 'F3F5F9' };
const SLIDE_INK = { title: '1E2761', text: '1B2130', muted: '5B6475', faint: '8A93A3' };
// Results of stages that already took place, in the dashboard's status colours.
const SLIDE_RESULT = {
  done:    { mark: '✓', label: 'Done as planned', color: '1F8A4C' },
  failed:  { mark: '✕', label: 'Not as planned', color: 'C2302F' },
  overdue: { mark: '!', label: 'Result not recorded yet', color: 'B86200' },
};
const SLIDE_TIERS = [
  { proj: 16, name: 15, date: 12, detail: 12, rowGap: 0.14, groupGap: 0.45 },
  { proj: 15, name: 14, date: 11, detail: 11, rowGap: 0.1, groupGap: 0.38 },
];

// Where the next meeting is: the next entry of a pinned special event (or of an
// event called "…meeting…") after today.
function nextMeetingDate() {
  const events = state.data.projects.filter(isEvent);
  const pick = events.filter((p) => p.top).concat(events.filter((p) => !p.top && /meeting/i.test(p.title)));
  const today = ymd(new Date());
  const dates = pick.flatMap((p) => p.stages.map((s) => s.date)).filter((d) => d && d > today).sort();
  return dates[0] ? { date: dates[0], pids: new Set(pick.map((p) => p.id)) } : { date: '', pids: new Set(pick.map((p) => p.id)) };
}

function slideDateLabel(s) {
  const a = parseYmd(s.date);
  const day = (d) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
  if (s.endDate && s.endDate > s.date) {
    const b = parseYmd(s.endDate);
    return a.getMonth() === b.getMonth() ? `${a.getDate()}–${fmt(b, { day: 'numeric', month: 'short' })}` : `${fmtShort(a)} – ${fmtShort(b)}`;
  }
  return s.allDay ? day(a) : `${day(a)}\n${s.start}${s.end ? `–${s.end}` : ''}`;
}

// What goes on the slide, before any layout.
function slideContent({ from, to, pids, leave }) {
  const a = parseYmd(from); const b = addDays(parseYmd(to), 1);
  const inRange = (s) => { const r = stageRange(s); return r && r.start < b && r.end >= a; };
  const groups = [];
  for (const p of byColor()) {
    if (!pids.has(p.id) || isLeave(p)) continue;
    const items = p.stages.filter(inRange).sort((x, y) => stageRange(x).start - stageRange(y).start)
      .map((s) => {
        const st = statusOf(s);
        const result = s.outcome || (st === 'overdue' ? 'overdue' : null);
        return { s, date: slideDateLabel(s), name: s.name, conds: s.conditions.filter(Boolean), notes: s.notes.trim(), result, comment: (s.comment || '').trim() };
      });
    if (items.length) groups.push({ p, items, first: stageRange(items[0].s).start });
  }
  groups.sort((x, y) => x.first - y.first);
  // Days off as they look to others: private details are never put on a slide.
  const away = !leave ? [] : state.data.projects.filter(isLeave).flatMap((p) => p.stages).filter((s) => s.privacy !== 'hidden' && inRange(s))
    .sort((x, y) => (x.date < y.date ? -1 : 1)).map((s) => `${slideDateLabel(s).replace('\n', ' ')} (${s.privacy === 'busy' ? (LEAVE_KINDS[s.kind] || LEAVE_KINDS.other).label : s.name})`);
  return { groups, away };
}

// Rough text height (inches) for a box of the given width, used to fit the slide.
function textLines(text, widthIn, pt) {
  const perLine = Math.max(8, Math.floor((widthIn * 72) / (pt * 0.5)));
  return String(text).split('\n').reduce((n, line) => {
    const w = [...line].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    return n + Math.max(1, Math.ceil(w / perLine));
  }, 0);
}
const lineH = (pt) => (pt * 1.25) / 72;

// Lays the content out; returns positioned boxes plus what had to be left out.
function slideLayout(content, opts, meta) {
  const { m, top, bottom, w } = SLIDE;
  const awayText = content.away.length ? `Away: ${content.away.join(' · ')}` : '';
  const awayH = (t) => (awayText ? textLines(awayText, w - 2 * m, t.detail) * lineH(t.detail) : 0);
  const tryLayout = (t, { notes, maxConds, reserve = 0, until = Infinity }) => {
    const limit = bottom - reserve - (awayText ? awayH(t) + 0.1 : 0);
    const boxes = []; let y = top; let shown = 0; let total = 0; let cut = false;
    const dateX = m + 0.32; const dateW = 1.3; const nameX = dateX + dateW + 0.15; const nameW = w - m - nameX;
    for (const g of content.groups) {
      total += g.items.length;
      if (cut) continue;
      const head = lineH(t.proj);
      if (y + head + lineH(t.name) > limit) { cut = true; continue; }
      const groupStart = boxes.length; const yStart = y;
      boxes.push({ kind: 'dot', x: m, y: y + head / 2 - 0.08, w: 0.16, h: 0.16, color: g.p.color.replace('#', '') });
      boxes.push({ kind: 'text', x: m + 0.32, y, w: w - 2 * m - 0.32, h: head, text: g.p.title, pt: t.proj, bold: true, color: SLIDE_INK.title });
      y += head + 0.06;
      let placed = 0;
      for (const it of g.items) {
        if (stageRange(it.s).start > until) continue; // later stages are summed up below
        const detail = [];
        if (opts.conds && it.conds.length) {
          const cs = it.conds.slice(0, maxConds).map((c, i) => `Condition ${i + 1}: ${c}`);
          if (it.conds.length > maxConds) cs.push(`+${it.conds.length - maxConds} more condition${it.conds.length - maxConds > 1 ? 's' : ''}`);
          detail.push(...cs);
        }
        const noteText = opts.notes && notes && it.notes ? it.notes : '';
        const res = opts.results && it.result ? SLIDE_RESULT[it.result] : null;
        // A green ✓ says "done" on its own; a result line is added only when it tells more.
        const resLine = res && (it.result !== 'done' || it.comment);
        const resText = resLine ? `${res.label}${it.comment ? `: ${it.comment}` : ''}` : '';
        const resH = resText ? textLines(resText, nameW, t.detail) * lineH(t.detail) : 0;
        const nameText = `${res ? `${res.mark} ` : ''}${it.name}`;
        const nameH = textLines(nameText, nameW, t.name) * lineH(t.name);
        const detH = detail.length ? textLines(detail.join('\n'), nameW, t.detail) * lineH(t.detail) : 0;
        const noteH = noteText ? textLines(noteText, nameW, t.detail) * lineH(t.detail) : 0;
        const dateH = textLines(it.date, dateW, t.date) * lineH(t.date);
        const h = Math.max(dateH, nameH + (resH ? resH + 0.03 : 0) + (detH ? detH + 0.03 : 0) + (noteH ? noteH + 0.03 : 0));
        if (y + h > limit) { cut = true; break; }
        boxes.push({ kind: 'text', x: dateX, y: y + 0.02, w: dateW, h: dateH, text: it.date, pt: t.date, bold: true, color: SLIDE_INK.muted });
        let yy = y;
        boxes.push({ kind: 'text', x: nameX, y: yy, w: nameW, h: nameH, text: nameText, pt: t.name, bold: true, color: SLIDE_INK.text,
          runs: res ? [{ text: `${res.mark} `, color: res.color }, { text: it.name }] : null });
        yy += nameH + 0.03;
        if (resH) { boxes.push({ kind: 'text', x: nameX, y: yy, w: nameW, h: resH, text: resText, pt: t.detail, color: res.color, runs: [{ text: res.label, bold: true }, ...(it.comment ? [{ text: `: ${it.comment}` }] : [])] }); yy += resH + 0.03; }
        if (detH) { boxes.push({ kind: 'text', x: nameX, y: yy, w: nameW, h: detH, text: detail.join('\n'), pt: t.detail, color: SLIDE_INK.muted }); yy += detH + 0.03; }
        if (noteH) boxes.push({ kind: 'text', x: nameX, y: yy, w: nameW, h: noteH, text: noteText, pt: t.detail, italic: true, color: SLIDE_INK.faint });
        y += h + t.rowGap; shown++; placed++;
      }
      if (!placed) { boxes.length = groupStart; y = yStart; continue; } // no project heading without stages
      // Each project sits on a soft rounded card, drawn underneath its text.
      boxes.splice(groupStart, 0, { kind: 'card', x: m - 0.2, y: yStart - 0.14, w: w - 2 * m + 0.4, h: y - t.rowGap - yStart + 0.28, color: SLIDE.card });
      y += t.groupGap - t.rowGap;
    }
    return { boxes, shown, total, cut, y, t };
  };
  // The "Away" line goes after the projects (and after "+N more", if any).
  const addAway = (r, yAt) => { if (awayText) r.boxes.push({ kind: 'text', x: m, y: yAt, w: w - 2 * m, h: awayH(r.t), text: awayText, pt: r.t.detail, color: SLIDE_INK.muted }); };
  // Try the roomiest version first, then make room step by step; as a last
  // resort keep what fits and say how many stages were left out.
  const steps = [];
  for (const t of SLIDE_TIERS) steps.push({ t, notes: true, maxConds: 99, note: '' });
  steps.push({ t: SLIDE_TIERS[1], notes: false, maxConds: 99, note: 'Notes were left out to fit one slide (they are in the speaker notes).' });
  steps.push({ t: SLIDE_TIERS[1], notes: false, maxConds: 2, note: 'Notes and some conditions were left out to fit one slide (all of them are in the speaker notes).' });
  let res;
  for (const st of steps) { res = { ...tryLayout(st.t, st), note: st.note }; if (!res.cut) break; }
  if (res.cut) {
    // Keep the nearest stages of every project and leave out the latest ones.
    const all = content.groups.flatMap((g) => g.items.map((it) => +stageRange(it.s).start));
    const starts = [...new Set(all)].sort((x, y) => y - x);
    for (const until of starts) {
      res = { ...tryLayout(SLIDE_TIERS[1], { notes: false, maxConds: 2, reserve: 0.4, until }), until };
      if (!res.cut) break;
    }
    const left = res.total - res.shown;
    let yAt = res.y + 0.02;
    if (left > 0) {
      const firstLeft = Math.min(...all.filter((x) => x > res.until)); // the earliest stage left out
      const fromTxt = Number.isFinite(firstLeft) ? ` from ${fmt(new Date(firstLeft), { day: 'numeric', month: 'short' })}` : '';
      res.boxes.push({ kind: 'text', x: m + 0.32, y: yAt, w: 7, h: lineH(11), text: `+${left} more stage${left > 1 ? 's' : ''}${fromTxt} — see the dashboard`, pt: 11, italic: true, color: SLIDE_INK.faint });
      yAt += lineH(11) + 0.12;
    }
    addAway(res, yAt);
    res.note = `Too much for one slide: ${left ? `the ${left} latest stage${left > 1 ? 's were' : ' was'} summed up as “+${left} more”, and ` : ''}notes and some conditions were left out (all of them are in the speaker notes). Try a shorter timespan or fewer projects.`;
  } else addAway(res, res.y + 0.02);
  const head = [
    { kind: 'text', x: SLIDE.m, y: 0.5, w: SLIDE.w - 2 * SLIDE.m, h: 0.7, text: meta.title, pt: 30, bold: true, color: SLIDE_INK.title },
    { kind: 'text', x: SLIDE.m, y: 1.15, w: SLIDE.w - 2 * SLIDE.m, h: 0.35, text: meta.subtitle, pt: 14, color: SLIDE_INK.muted },
  ];
  const foot = { kind: 'text', x: SLIDE.m, y: 7.0, w: SLIDE.w - 2 * SLIDE.m, h: 0.25, text: meta.footer, pt: 9, color: SLIDE_INK.faint, align: 'right' };
  const empty = !content.groups.length && !content.away.length
    ? [{ kind: 'text', x: SLIDE.m, y: SLIDE.top, w: SLIDE.w - 2 * SLIDE.m, h: 0.4, text: 'Nothing planned in this period.', pt: 16, italic: true, color: SLIDE_INK.muted }] : [];
  return { boxes: [...head, ...res.boxes, ...empty, foot], note: res.note };
}

function slidePreviewHtml(layout) {
  const pct = (v, of) => `${(v / of) * 100}%`;
  return `<div class="slide-preview" aria-label="Slide preview">${layout.boxes.map((b) => (b.kind === 'card'
    ? `<span style="left:${pct(b.x, SLIDE.w)};top:${pct(b.y, SLIDE.h)};width:${pct(b.w, SLIDE.w)};height:${pct(b.h, SLIDE.h)};background:#${b.color};border-radius:1.2cqw"></span>`
    : b.kind === 'dot'
    ? `<span style="left:${pct(b.x, SLIDE.w)};top:${pct(b.y, SLIDE.h)};width:${pct(b.w, SLIDE.w)};height:${pct(b.h, SLIDE.h)};background:#${esc(b.color)};border-radius:50%"></span>`
    : `<div style="left:${pct(b.x, SLIDE.w)};top:${pct(b.y, SLIDE.h)};width:${pct(b.w, SLIDE.w)};font-size:${(b.pt * 0.1389).toFixed(3)}cqw;color:#${b.color};${b.bold ? 'font-weight:700;' : ''}${b.italic ? 'font-style:italic;' : ''}${b.align ? `text-align:${b.align};` : ''}">${b.runs ? b.runs.map((r) => `<span style="${r.color ? `color:#${r.color};` : ''}${r.bold ? 'font-weight:700;' : ''}">${esc(r.text)}</span>`).join('') : esc(b.text)}</div>`)).join('')}</div>`;
}

let pptxLoading = null;
function loadPptx() {
  if (window.PptxGenJS) return Promise.resolve();
  pptxLoading ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'assets/vendor/pptxgen.bundle.js';
    sc.onload = () => resolve();
    sc.onerror = () => { pptxLoading = null; reject(new Error('could not load the slide maker')); };
    document.head.appendChild(sc);
  });
  return pptxLoading;
}

async function writeSlide(layout, meta, notesText) {
  await loadPptx();
  const pres = new window.PptxGenJS();
  pres.layout = 'LAYOUT_4x3'; // 10" × 7.5", the lab's slide size
  pres.title = meta.title; pres.author = meta.author;
  pres.theme = { headFontFace: 'Calibri', bodyFontFace: 'Calibri' };
  const sl = pres.addSlide();
  sl.background = { color: 'FFFFFF' };
  for (const b of layout.boxes) {
    if (b.kind === 'card') { sl.addShape(pres.ShapeType.roundRect, { x: b.x, y: b.y, w: b.w, h: b.h, rectRadius: 0.12, fill: { color: b.color }, line: { color: b.color, width: 0 } }); continue; }
    if (b.kind === 'dot') { sl.addShape(pres.ShapeType.ellipse, { x: b.x, y: b.y, w: b.w, h: b.h, fill: { color: b.color }, line: { color: b.color, width: 0 } }); continue; }
    const body = b.runs ? b.runs.map((r) => ({ text: r.text, options: { ...(r.color ? { color: r.color } : {}), ...(r.bold != null ? { bold: r.bold } : {}) } })) : b.text;
    sl.addText(body, { x: b.x, y: b.y, w: b.w, h: Math.max(b.h, lineH(b.pt)), fontFace: 'Calibri', fontSize: b.pt, bold: !!b.bold, italic: !!b.italic, color: b.color, align: b.align || 'left', valign: 'top', margin: 0, isTextBox: true, fit: 'none', paraSpaceAfter: 0 });
  }
  if (notesText) sl.addNotes(notesText);
  return pres.write({ outputType: 'blob' });
}

function openMeetingSlide() {
  const meet = nextMeetingDate();
  const today = ymd(new Date());
  const projects = byColor().filter((p) => (isResearch(p) && p.status === 'ongoing') || isEvent(p));
  const name = state.rec?.entry.name || state.data.meta.title;
  const st = { from: today, to: meet.date || ymd(addDays(new Date(), 7)), conds: true, notes: true, leave: true, results: true, pids: new Set(projects.filter((p) => !meet.pids.has(p.id)).map((p) => p.id)), title: meet.date ? 'Plan until the next meeting' : 'Plan for the coming week' };
  const quick = [
    ...(meet.date ? [[meet.date, `Until next meeting (${fmt(parseYmd(meet.date), { weekday: 'short', day: 'numeric', month: 'short' })})`]] : []),
    [ymd(addDays(new Date(), 7)), '1 week'], [ymd(addDays(new Date(), 14)), '2 weeks'],
  ];
  const range = () => { const a = parseYmd(st.from); const b = parseYmd(st.to); return a.getFullYear() === b.getFullYear() ? `${fmt(a, { weekday: 'short', day: 'numeric', month: 'short' })} – ${fmtDay(b)}` : `${fmtDay(a)} – ${fmtDay(b)}`; };
  const meta = () => ({ title: st.title.trim() || 'Plan', subtitle: `${name} · ${range()}`, footer: `Research Progress · ${fmtDay(new Date())}`, author: name });
  const build = () => slideLayout(slideContent(st), st, meta());
  openModal({
    title: 'Plan slide for the next meeting',
    body: `<form id="ms-form" autocomplete="off">
      <div class="grid2">
        <label class="field"><span>From</span><input type="date" name="from" value="${st.from}"></label>
        <label class="field"><span>Until (inclusive)</span><input type="date" name="to" value="${st.to}"></label>
      </div>
      <div class="row" style="margin:-4px 0 12px">${quick.map(([d, l]) => `<button type="button" class="btn sm" data-to="${d}">${esc(l)}</button>`).join('')}</div>
      <label class="field"><span>Slide title</span><input type="text" name="title" value="${esc(st.title)}"></label>
      <div class="field"><span class="muted small" style="font-weight:600;display:block;margin-bottom:6px">Include</span>
        <div class="ms-checks">${projects.map((p) => `<label class="check"><input type="checkbox" name="pid" value="${esc(p.id)}" ${st.pids.has(p.id) ? 'checked' : ''}><span class="dot" style="background:${esc(p.color)}"></span>${isEvent(p) ? '📌 ' : ''}${esc(p.title)}</label>`).join('')}
          <label class="check"><input type="checkbox" name="leave" ${st.leave ? 'checked' : ''}>🏖 Days off</label>
          <label class="check"><input type="checkbox" name="conds" checked>Experiment conditions</label>
          <label class="check"><input type="checkbox" name="notes" checked>Notes</label>
          <label class="check"><input type="checkbox" name="results" checked>Results of past stages</label></div></div>
      <div id="ms-preview"></div>
      <p class="help" id="ms-note" style="margin-top:8px"></p>
    </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="ms-form">⬇ Download .pptx</button>',
    onMount(m) {
      const form = $('#ms-form', m);
      const sync = () => {
        st.from = form.from.value || today; st.to = form.to.value || st.from;
        if (st.to < st.from) st.to = st.from;
        st.title = form.title.value; st.conds = form.conds.checked; st.notes = form.notes.checked; st.leave = form.leave.checked; st.results = form.results.checked;
        st.pids = new Set($$('input[name=pid]:checked', form).map((x) => x.value));
        const lay = build();
        $('#ms-preview', m).innerHTML = slidePreviewHtml(lay);
        $('#ms-note', m).textContent = lay.note || 'Preview of the slide (4:3). Full notes and conditions also go into the speaker notes.';
      };
      form.addEventListener('input', sync); form.addEventListener('change', sync);
      $$('[data-to]', m).forEach((b) => b.addEventListener('click', () => { form.to.value = b.dataset.to; sync(); }));
      sync();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('.modal-foot [type=submit]', m); btn.disabled = true; btn.textContent = 'Making slide…';
        try {
          const content = slideContent(st);
          const notes = content.groups.map((g) => `${g.p.title}\n${g.items.map((it) => `- ${it.date.replace('\n', ' ')}: ${it.name}${it.result ? `\n    Result: ${SLIDE_RESULT[it.result].label}${it.comment ? ` (${it.comment})` : ''}` : ''}${it.conds.map((c, i) => `\n    Condition ${i + 1}: ${c}`).join('')}${it.notes ? `\n    Note: ${it.notes}` : ''}`).join('\n')}`).join('\n\n');
          const blob = await writeSlide(build(), meta(), notes);
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = `plan-${slug(name)}-${st.from}.pptx`;
          document.body.appendChild(a); a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
          closeModal(); toast(`Downloaded ${a.download}`);
        } catch (err) {
          btn.disabled = false; btn.textContent = '⬇ Download .pptx';
          toast(`Could not make the slide: ${err.message}`, 5000);
        }
      });
    },
  });
}

// ---------------------------------------------------------------- routing
// #/                      all students (overview)
// #/s/<student>           a student's dashboard
// #/s/<student>/calendar | completed | project/<id> | report/<scope>
// Links from the single-user version (#/project/<id>, #/calendar, …) open the first student.
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const dec = (v) => { try { return decodeURIComponent(v || ''); } catch { return v || ''; } };
  if (parts[0] === 's' && parts[1]) {
    const sid = dec(parts[1]); const [name, id] = parts.slice(2);
    if (name === 'project' && id) return { name: 'project', id: dec(id), sid };
    if (name === 'calendar') return { name: 'calendar', sid };
    if (name === 'completed') return { name: 'completed', sid };
    if (name === 'report') return { name: 'report', id: id ? dec(id) : 'all', sid };
    return { name: 'dashboard', sid };
  }
  if (['project', 'calendar', 'completed', 'report'].includes(parts[0])) return { name: 'legacy', rest: parts.join('/') };
  return { name: 'home' };
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
  const projects = all.filter(isResearch);
  const leave = all.filter(isLeave);
  const events = all.filter(isEvent);
  const topEvents = events.filter((p) => p.top);
  const otherEvents = events.filter((p) => !p.top);
  const now = new Date();
  const ongoing = projects.filter((p) => p.status === 'ongoing');
  const inactive = projects.filter((p) => p.status !== 'ongoing');
  const overdue = allItems().filter((x) => x.st === 'overdue').sort((a, b) => a.r.start - b.r.start);
  const in7 = addDays(now, 7);
  const soon = allItems((p) => isLeave(p) || isEvent(p) || p.status === 'ongoing').filter((x) => x.r && x.r.end >= now && !x.s.outcome && x.st !== 'overdue' && x.r.start <= in7).sort((a, b) => a.r.start - b.r.start);

  return `
    <div class="crumbs"><a href="#/">← All students</a></div>
    <div class="page-head">
      <div><h1>${esc(meta.title)}</h1>${meta.subtitle ? `<div class="sub">${esc(meta.subtitle)}</div>` : ''}</div>
    </div>
    <div class="stats">
      <div class="card stat"><div class="k">Ongoing projects</div><div class="v">${ongoing.length}</div></div>
      <div class="card stat"><div class="k">Upcoming tasks</div><div class="v">${soon.filter((x) => x.st !== 'off').length}</div></div>
      <div class="card stat ${overdue.length ? 'warn' : ''}"><div class="k">Updates</div><div class="v">${overdue.length}</div></div>
    </div>

    ${overdue.length ? `<div class="section-title">${state.edit ? 'Needs your update' : 'Awaiting update'} <span class="count">${overdue.length}</span></div>
      <div class="mini-list">${overdue.map((x) => miniRow(x, true)).join('')}</div>` : ''}

    ${topEvents.map(topEventSection).join('')}

    ${soon.length ? `<div class="section-title">Coming up · next 7 days</div><div class="mini-list">${soon.map((x) => miniRow(x)).join('')}</div>` : ''}

    <div class="section-title">Ongoing projects <span class="count">${ongoing.length}</span></div>
    ${ongoing.length ? `<div class="projects">${ongoing.map(projectCard).join('')}</div>`
      : '<div class="card empty">No ongoing projects yet.</div>'}
    ${state.edit ? '<div class="row" style="margin-top:12px"><button class="btn primary" data-act="new-project">＋ New project</button></div>' : ''}

    ${otherEvents.length ? `<div class="section-title">Special events</div><div class="projects">${otherEvents.map(eventCard).join('')}</div>` : ''}

    ${leave.length || state.edit ? `<div class="section-title">Holidays &amp; leave</div>
      ${leave.length ? `<div class="projects">${leave.map(leaveCard).join('')}</div>` : ''}
      ${state.edit ? '<div class="row" style="margin-top:12px"><button class="btn" data-act="new-leave">＋ Day off</button></div>' : ''}` : ''}

    ${inactive.length ? `<a class="card archive-link" href="${href('completed')}"><span class="ico">🗂</span><span><b>Paused &amp; completed projects</b><br><span class="muted small">${inactive.length} project${inactive.length > 1 ? 's' : ''} · in the Archive tab</span></span><span class="spacer"></span><span aria-hidden="true">›</span></a>` : ''}
    <div style="margin-top:18px">${legend()}</div>`;
}

// A special event pinned to the top of the dashboard (e.g. Meeting):
// the two most recent entries and the next one.
function topEventSection(p) {
  const now = new Date();
  const items = p.stages.map((s) => ({ p, s, st: statusOf(s), r: stageRange(s) })).filter((x) => x.r).sort((a, b) => a.r.start - b.r.start);
  const past = items.filter((x) => x.r.end < now).slice(-2);
  const next = items.filter((x) => x.r.end >= now).slice(0, 1);
  const rows = [...past, ...next];
  return `<div class="section-title">📌 ${esc(p.title)}<span class="spacer"></span><a class="small" href="${projHref(p.id)}" style="text-transform:none;letter-spacing:0">All ›</a></div>
    ${rows.length ? `<div class="mini-list">${rows.map((x) => miniRow(x)).join('')}</div>` : `<div class="card empty" style="padding:16px">Nothing scheduled yet.</div>`}
    ${p.comments ? '<p class="muted small" style="margin:6px 2px 0">💬 Tap a meeting to read or add comments.</p>' : ''}
    ${state.edit ? `<div class="row" style="margin-top:10px"><button class="btn sm" data-act="new-stage" data-pid="${p.id}">＋ Add ${esc(p.title.toLowerCase())}</button></div>` : ''}`;
}

function viewCompleted() {
  const list = byColor().filter(isResearch);
  const paused = list.filter((p) => p.status === 'paused');
  const done = list.filter((p) => p.status === 'completed');
  return `
    <div class="page-head"><div><h1>Archive</h1><div class="sub">Paused and completed projects are kept here so the dashboard stays short.</div></div></div>
    <div class="section-title">Paused <span class="count">${paused.length}</span></div>
    ${paused.length ? `<div class="projects">${paused.map(projectCard).join('')}</div>` : '<p class="muted small">No paused projects.</p>'}
    <div class="section-title">Completed <span class="count">${done.length}</span></div>
    ${done.length ? `<div class="projects">${done.map(projectCard).join('')}</div>`
      : '<p class="muted small">No completed projects yet. Set a project’s status to <b>Completed</b> (✎ Edit project) to move it here.</p>'}`;
}

function projectCard(p) {
  const c = progressOf(p);
  const nextS = p.stages.find((s) => ['upcoming', 'inprogress'].includes(statusOf(s)));
  return `<a class="card project-card" href="${projHref(p.id)}" style="--pc:${esc(p.color)}">
    <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap"><h3>${esc(p.title)}</h3>${p.status !== 'ongoing' ? `<span class="pill">${esc(p.status)}</span>` : ''}</div>
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
    <div class="pc-foot">
      ${pbar(c)}${progressMeta(c)}
      ${nextS ? `<div class="next-chip tinted st-${statusOf(nextS)}"><span>${STATUS[statusOf(nextS)].icon}</span><div><div class="t">${esc(nextS.name)}</div><div>${esc(fmtWhen(nextS))}</div></div></div>`
        : c.total && c.done === c.counted ? '<div class="next-chip tinted st-done">✓ All stages completed</div>' : ''}
    </div></a>`;
}

function eventCard(p) {
  const now = new Date();
  const next = p.stages.map((s) => ({ s, st: statusOf(s), r: stageRange(s) })).filter((x) => x.r && x.r.end >= now && !x.s.outcome).sort((a, b) => a.r.start - b.r.start);
  return `<a class="card project-card" href="${projHref(p.id)}" style="--pc:${esc(p.color)}">
    <h3>📌 ${esc(p.title)}</h3>
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
    <div class="pc-foot">
      ${next.length ? next.slice(0, 3).map(({ s, st }) => `<div class="next-chip tinted st-${st}"><span>${STATUS[st].icon}</span><div><div class="t">${esc(s.name)}</div><div>${esc(fmtWhen(s))}</div></div></div>`).join('')
        : '<div class="muted small">Nothing scheduled.</div>'}
      ${next.length > 3 ? `<div class="muted small">+${next.length - 3} more</div>` : ''}
    </div></a>`;
}

function leaveCard(p) {
  const today0 = startOfDay(new Date());
  const next = p.stages.map((s) => ({ s, r: stageRange(s) })).filter((x) => x.r && x.r.end >= today0).sort((a, b) => a.r.start - b.r.start);
  return `<a class="card project-card leave-card" href="${projHref(p.id)}" style="--pc:${LEAVE_COLOR}">
    <h3>🏖 ${esc(p.title)}</h3>
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
    <div class="pc-foot">
      ${next.length ? next.slice(0, 3).map(({ s }) => `<div class="next-chip tinted st-off"><span>${stInfo(s).icon}</span><div><div class="t">${esc(s.name)}</div><div>${esc(fmtWhen(s))}</div></div></div>`).join('')
        : '<div class="muted small">No upcoming days off.</div>'}
      ${next.length > 3 ? `<div class="muted small">+${next.length - 3} more</div>` : ''}
    </div></a>`;
}

// Shown to the student only: who else can see this day off.
const privacyNote = (s) => (s.privacy && canEdit() ? `<div class="privacy-note">${PRIVACY[s.privacy].short}</div>` : '');

function stageCard(p, s, i, sorted = false) {
  const st = statusOf(s);
  const E = state.edit;
  if (st === 'off') {
    return `<li class="stage st-off" data-act="open-stage" data-id="${s.id}">
    <div class="stage-num">${stInfo(s).icon}</div>
    <div class="stage-main">
      <div class="stage-top"><h3>${esc(s.name)}</h3>${badge(st, s)}</div>
      <div class="when">🗓 ${esc(fmtWhen(s))}</div>
      ${privacyNote(s)}
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      ${E ? `<div class="stage-actions"><button class="btn sm" data-act="edit-stage" data-id="${s.id}">✎ Edit</button><button class="btn sm danger" data-act="delete-stage" data-id="${s.id}">Delete</button></div>` : ''}
    </div></li>`;
  }
  return `<li class="stage st-${st}" data-act="open-stage" data-id="${s.id}">
    <div class="stage-num">${s.outcome === 'done' ? '✓' : s.outcome === 'failed' ? '✕' : sorted ? '•' : i + 1}</div>
    <div class="stage-main">
      <div class="stage-top"><h3>${esc(s.name)}</h3>${badge(st, s)}</div>
      <div class="when">🗓 ${esc(fmtWhen(s))}</div>
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      ${s.conditions.length ? `<ol class="conds">${s.conditions.map((c, k) => `<li><b>Condition ${k + 1}</b><span>${esc(c)}</span></li>`).join('')}</ol>` : ''}
      ${s.comment ? `<div class="comment"><b>${s.outcome === 'failed' ? 'Why it did not go as planned' : 'Comment'}</b>${esc(s.comment)}</div>` : ''}
      ${st === 'overdue' ? `<div class="needs-update"><strong>This stage has started — did it go as planned?</strong>${E ? outcomeButtons(s) : ''}</div>` : ''}
      ${E ? `<div class="stage-actions">
        ${st !== 'overdue' ? `<button class="btn sm" data-act="outcome" data-id="${s.id}">Update result</button>` : ''}
        <button class="btn sm" data-act="edit-stage" data-id="${s.id}">✎ Edit</button>
        ${s.outcome === 'failed' ? `<button class="btn sm" data-act="dup-stage" data-id="${s.id}">↻ Reschedule as new stage</button>` : ''}
        ${sorted ? '' : `<button class="btn sm" data-act="move-stage" data-id="${s.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="btn sm" data-act="move-stage" data-id="${s.id}" data-dir="1" ${i === p.stages.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>`}
        <button class="btn sm danger" data-act="delete-stage" data-id="${s.id}">Delete</button>
      </div>` : ''}
    </div></li>`;
}

function viewProject(id) {
  const p = findProject(id);
  if (!p) return `<div class="card empty">Project not found. <a href="${href()}">Back to dashboard</a></div>`;
  if (isLeave(p)) return viewLeave(p);
  if (isEvent(p)) return viewEvent(p);
  const c = progressOf(p);
  return `
    <div class="crumbs"><a href="${href()}">← Dashboard</a></div>
    <div class="card proj-head" style="--pc:${esc(p.color)}">
      <div class="row" style="align-items:flex-start"><h1>${esc(p.title)}</h1><span class="pill">${esc(p.status)}</span></div>
      ${p.description ? `<p class="muted" style="margin:6px 0 0;white-space:pre-wrap">${esc(p.description)}</p>` : ''}
      <div class="proj-progress">${progressMeta(c)}${pbar(c, true)}</div>
      <div class="row no-print" style="margin-top:14px">
        ${state.edit ? `<button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add stage</button>
          <button class="btn" data-act="edit-project" data-id="${p.id}">✎ Edit project</button>` : ''}
        <a class="btn" href="${href('calendar')}" data-act="cal-project" data-id="${p.id}">📅 Calendar</a>
        <button class="btn" data-act="export">⇪ Export</button>
      </div>
    </div>
    <div class="section-title">Stages <span class="count">${p.stages.length}</span><span class="spacer"></span></div>
    <div class="no-print" style="margin:-4px 0 6px">${legend()}</div>
    ${p.stages.length ? `<ol class="timeline">${p.stages.map((s, i) => stageCard(p, s, i)).join('')}</ol>`
      : `<div class="card empty">No stages yet.${state.edit ? `<br><button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add the first stage</button>` : ''}</div>`}`;
}

function viewEvent(p) {
  // Event entries are shown by date: upcoming first, then past (newest first).
  const byDate = [...p.stages].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.start || '').localeCompare(b.start || ''));
  const now = new Date();
  const isPast = (s) => { const r = stageRange(s); return r && r.end < now && s.outcome; };
  const upcoming = byDate.filter((s) => !isPast(s));
  const past = byDate.filter(isPast).reverse();
  const list = (xs) => `<ol class="timeline">${xs.map((s) => stageCard(p, s, 0, true)).join('')}</ol>`;
  return `
    <div class="crumbs"><a href="${href()}">← Dashboard</a></div>
    <div class="card proj-head" style="--pc:${esc(p.color)}">
      <div class="row" style="align-items:flex-start"><h1>📌 ${esc(p.title)}</h1><span class="pill">Special event</span></div>
      ${p.description ? `<p class="muted" style="margin:6px 0 0;white-space:pre-wrap">${esc(p.description)}</p>` : ''}
      <div class="row no-print" style="margin-top:14px">
        ${state.edit ? `<button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add entry</button>
          <button class="btn" data-act="edit-project" data-id="${p.id}">✎ Edit</button>` : ''}
        <a class="btn" href="${href('calendar')}" data-act="cal-project" data-id="${p.id}">📅 Calendar</a>
        <button class="btn" data-act="export">⇪ Export</button>
      </div>
    </div>
    <div class="section-title">Upcoming &amp; to update <span class="count">${upcoming.length}</span></div>
    <div class="no-print" style="margin:-4px 0 6px">${legend()}</div>
    ${upcoming.length ? list(upcoming) : `<div class="card empty">Nothing scheduled.${state.edit ? `<br><button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add entry</button>` : ''}</div>`}
    ${past.length ? `<div class="section-title">Past <span class="count">${past.length}</span></div>${list(past)}` : ''}`;
}

function viewLeave(p) {
  // Days off are always shown in date order (unscheduled ones last).
  const days = [...p.stages].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const today = ymd(new Date());
  const upcoming = days.filter((s) => !s.date || (s.endDate || s.date) >= today);
  const past = days.filter((s) => s.date && (s.endDate || s.date) < today);
  const list = (xs) => `<ol class="timeline">${xs.map((s) => stageCard(p, s, 0)).join('')}</ol>`;
  return `
    <div class="crumbs"><a href="${href()}">← Dashboard</a></div>
    <div class="card proj-head" style="--pc:#cbd5e1">
      <div class="row" style="align-items:flex-start"><h1>🏖 ${esc(p.title)}</h1><span class="pill">Holiday &amp; leave</span></div>
      <p class="muted" style="margin:6px 0 0;white-space:pre-wrap">${esc(p.description || 'Public holidays, personal appointments and days the university is closed. These never ask for a status update.')}</p>
      <div class="row no-print" style="margin-top:14px">
        ${state.edit ? `<button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add day off</button>
          <button class="btn" data-act="edit-project" data-id="${p.id}">✎ Edit</button>` : ''}
        <a class="btn" href="${href('calendar')}" data-act="cal-project" data-id="${p.id}">📅 Calendar</a>
      </div>
    </div>
    <div class="section-title">Upcoming <span class="count">${upcoming.length}</span></div>
    ${upcoming.length ? list(upcoming) : `<div class="card empty">No upcoming days off.${state.edit ? `<br><button class="btn primary" data-act="new-stage" data-pid="${p.id}">＋ Add day off</button>` : ''}</div>`}
    ${past.length ? `<div class="section-title">Past <span class="count">${past.length}</span></div>${list(past.reverse())}` : ''}`;
}

// ---- calendar
// The calendar only offers ongoing research projects and holiday/leave projects;
// paused and completed ones are left out (unless opened from their project page).
const calProjects = () => byColor().filter((p) => !isResearch(p) || p.status === 'ongoing');
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
  return `<div class="legend cal-legend">${['upcoming', 'done', 'failed', 'overdue'].map((k) => `<span class="st-${k}"><span class="sdot"></span>${STATUS[k].label}</span>`).join('')}</div>`;
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
      <div class="month-head">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div>${d}</div>`).join('')}</div>
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
    <div class="row no-print" style="margin-bottom:14px"><a class="btn" href="${scope !== 'all' && findProject(scope) ? projHref(scope) : href()}">← Back</a><span class="spacer"></span><button class="btn primary" data-act="print">🖨️ Print / Save as PDF</button></div>
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

// ---- all students (overview)
// Built for a supervisor skimming the whole group: what each student is working
// on, how far along each project is, what's next, who is away this week and how
// recently they updated. Students are grouped by grade.
const DEFAULT_GRADES = ['D3', 'D2', 'D1', 'M2', 'M1', 'B4'];
const STALE_DAYS = [7, 14]; // updated longer ago → orange, then red

function summarize(rec, now = new Date()) {
  const d = rec.data; const sts = computeStatuses(now, d);
  const today0 = startOfDay(now); const in7 = addDays(today0, 7);
  const projects = byColor(d.projects).filter((p) => isResearch(p) && p.status === 'ongoing').map((p) => {
    let done = 0; let counted = 0;
    for (const s of p.stages) { const st = sts.get(s.id); if (st === 'done') done++; if (st !== 'failed') counted++; }
    return { p, done, counted, pct: counted ? Math.round((done / counted) * 100) : 0 };
  });
  let next = null;
  for (const { p } of projects) {
    for (const s of p.stages) {
      const st = sts.get(s.id);
      if (st === 'upcoming' || st === 'inprogress') { const r = stageRange(s); if (!next || r.start < next.r.start) next = { p, s, st, r }; }
    }
  }
  const away = d.projects.filter(isLeave).flatMap((p) => p.stages).map((s) => ({ s, r: stageRange(s) }))
    .filter((x) => x.r && x.r.end >= today0 && x.r.start < in7).sort((a, b) => a.r.start - b.r.start);
  return { projects, next, away };
}

// How fresh the student's last publish is: '' (recent), 'stale' (≥ 1 week), 'old' (≥ 2 weeks).
function freshness(rec) {
  const u = rec.data?.meta.updated;
  if (!u) return { cls: 'old', text: 'Not updated yet' };
  const days = (Date.now() - new Date(u)) / 864e5;
  return { cls: days >= STALE_DAYS[1] ? 'old' : days >= STALE_DAYS[0] ? 'stale' : '', text: `Updated ${relTime(u)}` };
}

const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
const avatarColor = (id) => COLORS[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
function relTime(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  const days = Math.round(mins / 1440);
  return days < 30 ? `${days} day${days > 1 ? 's' : ''} ago` : `on ${fmt(new Date(iso), { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
const fmtAway = (x) => (x.s.endDate && x.s.endDate > x.s.date ? `${fmtShort(x.r.start)}–${fmtShort(x.r.end)}` : fmt(x.r.start, { weekday: 'short', day: 'numeric', month: 'short' }));

// Grade groups in the order set in students.json (meta.grades); unknown grades
// follow alphabetically, students without a grade come last.
function gradeGroups(recs) {
  const order = state.registry.meta.grades;
  const key = (g) => { const i = order.findIndex((x) => sameUser(x, g)); return i >= 0 ? i : g ? order.length : order.length + 1; };
  const sorted = [...recs].sort((a, b) => key(a.entry.grade) - key(b.entry.grade) || String(a.entry.grade).localeCompare(String(b.entry.grade)) || a.entry.name.localeCompare(b.entry.name));
  const groups = [];
  for (const r of sorted) {
    const g = r.entry.grade || '';
    if (!groups.length || !sameUser(groups.at(-1).grade || '-', g || '-')) groups.push({ grade: g, recs: [] });
    groups.at(-1).recs.push(r);
  }
  return groups;
}

const gradeTag = (e) => (e.grade ? ` <span class="grade">${esc(e.grade)}</span>` : '');
const avatar = (e, cls = '') => `<span class="avatar ${cls}" style="--av:${avatarColor(e.id)}" aria-hidden="true">${esc(initials(e.name))}</span>`;
const projLine = (x) => `<div class="sp" title="${esc(`${x.p.title} · ${x.done}/${x.counted} stages done`)}"><span class="sp-name"><i style="background:${esc(x.p.color)}"></i>${esc(x.p.title)}</span>
  <span class="pbar sm"><span class="seg-done" style="width:${x.pct}%"></span></span><b>${x.pct}%</b></div>`;
const nextLine = (m) => (m.next ? `<div class="sr-next tinted st-${m.next.st}"><span>${STATUS[m.next.st].icon}</span><span><b>${esc(m.next.s.name)}</b> · ${esc(fmtWhen(m.next.s).replace(/ · All day$/, ''))}</span></div>` : '<div class="muted small">Nothing scheduled</div>');
const awayLine = (m) => (m.away.length ? `<div class="sr-away">🏖 Away ${m.away.slice(0, 2).map((x) => esc(fmtAway(x))).join(', ')}${m.away.length > 2 ? ' …' : ''}</div>` : '');

function studentRow(rec) {
  const e = rec.entry; const f = freshness(rec);
  const who = `<div class="sr-who">${avatar(e, 'sm')}<div class="sc-name"><b>${esc(e.name)}</b>${gradeTag(e)}${canEdit(rec) ? ' <span class="pill you">You</span>' : ''}<div class="muted small">${esc(rec.data?.meta.subtitle || '')}</div></div></div>`;
  let body;
  if (rec.error) body = `<div class="sr-body muted small">Could not load (${esc(rec.error)})</div>`;
  else if (!rec.data) body = '<div class="sr-body muted small">Loading…</div>';
  else {
    const m = summarize(rec);
    body = `<div class="sr-projects">${m.projects.length ? m.projects.map(projLine).join('') : '<div class="muted small">No ongoing projects</div>'}</div>
      <div class="sr-now">${nextLine(m)}${awayLine(m)}</div>
      <div class="sr-upd fresh ${f.cls}">${esc(f.text)}</div>`;
  }
  return `<a class="srow student-item" href="${href('', rec)}" data-name="${esc(`${e.name} ${e.github} ${e.grade || ''}`.toLowerCase())}">${who}${body}</a>`;
}

function studentCard(rec) {
  const e = rec.entry; const f = freshness(rec);
  const head = `<div class="sc-head">${avatar(e)}
    <div class="sc-name"><h3>${esc(e.name)}${gradeTag(e)}</h3><div class="muted small">${esc(rec.data?.meta.subtitle || '')}</div></div>
    ${canEdit(rec) ? '<span class="pill you">You</span>' : ''}</div>`;
  let body;
  if (rec.error) body = `<p class="muted small">Could not load (${esc(rec.error)}).</p>`;
  else if (!rec.data) body = '<p class="muted small">Loading…</p>';
  else {
    const m = summarize(rec);
    body = `<div class="pc-foot">
      <div class="sr-projects">${m.projects.length ? m.projects.map(projLine).join('') : '<div class="muted small">No ongoing projects</div>'}</div>
      ${nextLine(m)}${awayLine(m)}
      <div class="fresh ${f.cls} small">${esc(f.text)}</div>
    </div>`;
  }
  return `<a class="card project-card student-card student-item" href="${href('', rec)}" data-name="${esc(`${e.name} ${e.github} ${e.grade || ''}`.toLowerCase())}" style="--pc:${avatarColor(e.id)}">${head}${body}</a>`;
}

function viewHome() {
  const { meta } = state.registry;
  // One list in grade order (D3 → B4, then other grades, then no grade); the grade sits next to each name.
  const recs = gradeGroups([...state.students.values()]).flatMap((g) => g.recs);
  const cards = state.homeView === 'cards';
  return `
    <div class="page-head">
      <div><h1>${esc(meta.title)}</h1>${meta.subtitle ? `<div class="sub">${esc(meta.subtitle)}</div>` : ''}</div>
    </div>
    <form class="home-search" data-form="student-search" role="search">
      <input type="search" class="filter" data-input="student-filter" placeholder="🔍 Search by name…" aria-label="Search students" autocomplete="off" enterkeyhint="go">
    </form>
    <div class="home-bar">
      <span class="muted small" id="student-count">${recs.length} member${recs.length === 1 ? '' : 's'}</span>
      <span class="spacer"></span>
      <div class="seg" role="group" aria-label="Layout">${[['list', '☰ List'], ['cards', '▦ Cards']].map(([k, l]) => `<button data-act="home-view" data-v="${k}" class="${state.homeView === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${isAdmin() ? '<button class="btn sm" data-act="roster">👥 Manage</button>' : ''}
    </div>
    ${!recs.length ? `<div class="card empty">No students yet.${isAdmin() ? '<br><button class="btn primary" data-act="add-student">＋ Add a student</button>' : ' An admin adds students to <code>students.json</code>.'}</div>`
      : cards ? `<div class="projects students">${recs.map(studentCard).join('')}</div>`
      : `<div class="slist">${recs.map(studentRow).join('')}</div>`}
    <p class="muted small hidden" id="no-match">No member matches your search.</p>
    <div class="legend fresh-legend"><span class="fresh">Updated in the last week</span><span class="fresh stale">1–2 weeks ago</span><span class="fresh old">Over 2 weeks ago</span></div>`;
}

// ---------------------------------------------------------------- main render
const TABS = [
  ['dashboard', '', '▦', 'Dashboard'],
  ['calendar', 'calendar', '📅', 'Calendar'],
  ['completed', 'completed', '🗂', 'Archive'],
];
function renderChrome(route) {
  const home = route.name === 'home';
  document.body.classList.toggle('no-tabs', home);
  const p = route.name === 'project' && state.data ? findProject(route.id) : null;
  const active = home ? 'home' : ['calendar', 'completed'].includes(route.name) ? route.name
    : p && isResearch(p) && p.status !== 'ongoing' ? 'completed' : route.name === 'report' ? '' : 'dashboard';
  // No "Students" tab: "← All students" on the dashboard and the logo lead back to the overview.
  $('.tabs').innerHTML = `${home ? '' : `${TABS.map(([k, path, ico, label]) => `<a href="${href(path)}" class="${active === k ? 'active' : ''}"><span class="tab-ico" aria-hidden="true">${ico}</span><span>${label}</span></a>`).join('')}
    <button type="button" data-act="export"><span class="tab-ico" aria-hidden="true">⇪</span><span>Export</span></button>`}`;

  let actions = '<button class="btn sm" data-act="share" aria-label="Share visitor link">🔗<span class="lbl-long"> Share</span></button>';
  const me = home && myRecord();
  if (me) actions = `<a class="btn sm" href="${href('', me)}">${avatar(me.entry, 'xs')}<span class="lbl-long"> My page</span></a>${actions}`;
  if (!home && canEdit()) {
    if (state.dirty) actions += '<button class="btn sm primary pulse" data-act="publish">⬆ Publish</button>';
    actions += state.edit
      ? '<button class="btn sm" data-act="settings" aria-label="Settings">⚙︎</button><button class="btn sm" data-act="toggle-edit">Done</button>'
      : '<button class="btn sm" data-act="toggle-edit">✎ Edit</button>';
  }
  $('#top-actions').innerHTML = actions;

  const who = state.auth.token
    ? `Signed in as <b>@${esc(state.auth.login || '…')}</b> · <a href="#" data-act="account">Account</a>`
    : 'View only · <a href="#" data-act="signin">Student sign-in</a>';
  const updated = !home && state.data?.meta.updated ? `Last updated ${esc(new Date(state.data.meta.updated).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }))}` : '';
  const mode = !home && canEdit() ? (state.edit ? ' · Editing your dashboard' : ' · Your dashboard') : !home && state.auth.token ? ' · View only' : '';
  $('#foot').innerHTML = `<span>${updated}</span><span>${who}${mode}</span>`;
}

function render() {
  if (!state.registry) return;
  const route = parseRoute();
  if (route.name === 'legacy') {
    const first = state.registry.students[0];
    location.replace(first ? `#/s/${encodeURIComponent(first.id)}/${route.rest}` : '#/');
    return;
  }
  const v = $('#view');
  if (route.name === 'home') {
    state.rec = null; state.edit = false;
    for (const rec of state.students.values()) if (!rec.data && !rec.error && !rec.loading) ensureLoaded(rec).then(() => { if (parseRoute().name === 'home' && !modalOpen()) render(); });
    document.title = state.registry.meta.title;
    $('#brand-title').textContent = state.registry.meta.title;
    renderChrome(route);
    $('#banner').innerHTML = '';
    const q = $('[data-input="student-filter"]')?.value || '';
    v.innerHTML = viewHome();
    if (q) { const f = $('[data-input="student-filter"]'); if (f) { f.value = q; filterStudents(q); } }
    return;
  }

  const rec = state.students.get(route.sid);
  if (!rec) {
    state.rec = null; state.edit = false;
    renderChrome({ name: 'home' }); $('#banner').innerHTML = '';
    v.innerHTML = '<div class="card empty">Student not found. <a href="#/">See all students</a></div>';
    return;
  }
  state.rec = rec;
  state.edit = state.editPref && canEdit(rec);
  if (!rec.data) {
    $('#brand-title').textContent = rec.entry.name;
    renderChrome(route); $('#banner').innerHTML = '';
    v.innerHTML = rec.error
      ? `<div class="card empty"><h2>Could not load ${esc(rec.entry.name)}’s data</h2><p>${esc(rec.error)}</p><p class="small">If you opened <code>index.html</code> directly from disk, serve the folder instead (e.g. <code>python3 -m http.server</code>) or open the GitHub Pages address.</p></div>`
      : '<p class="muted loading">Loading…</p>';
    if (!rec.error) ensureLoaded(rec).then(() => { if (state.rec === rec) render(); });
    return;
  }

  state.statuses = computeStatuses();
  if (!['all', 'everything'].includes(state.cal.project) && !findProject(state.cal.project)) state.cal.project = 'all';
  const { meta } = state.data;
  document.title = route.name === 'project' ? `${findProject(route.id)?.title || 'Project'} · ${meta.title}` : meta.title;
  $('#brand-title').textContent = meta.title;
  renderChrome(route);

  // banner
  const overdue = [...state.statuses.values()].filter((x) => x === 'overdue').length;
  let banner = '';
  if (canEdit() && state.dirty) banner = `<div class="banner"><div class="inner info">You have unpublished changes. Visitors still see the previous version.<span class="spacer"></span><button class="btn sm primary" data-act="publish">Publish now</button><button class="btn sm ghost" data-act="discard">Discard</button></div></div>`;
  else if (state.edit && overdue && route.name !== 'dashboard') banner = `<div class="banner"><div class="inner st-overdue">⏰ ${overdue} stage${overdue > 1 ? 's' : ''} need${overdue > 1 ? '' : 's'} an update.<span class="spacer"></span><a class="btn sm" href="${href()}">Review</a></div></div>`;
  $('#banner').innerHTML = banner;

  // view
  const scroll = $('#wk-scroll')?.scrollTop;
  v.innerHTML = route.name === 'project' ? viewProject(route.id)
    : route.name === 'calendar' ? viewCalendar()
    : route.name === 'report' ? viewReport(route.id)
    : route.name === 'completed' ? viewCompleted()
    : viewDashboard();
  const wk = $('#wk-scroll');
  if (wk) wk.scrollTop = scroll ?? Math.max(0, (Math.min(new Date().getHours(), 16) - 1) * HOUR_H - 20) ;
}

function filterStudents(q) {
  const t = q.trim().toLowerCase();
  const items = $$('.student-item');
  items.forEach((c) => c.classList.toggle('hidden', !!t && !c.dataset.name.includes(t)));
  const shown = items.filter((c) => !c.classList.contains('hidden')).length;
  $('.slist')?.classList.toggle('hidden', !shown);
  $('#no-match')?.classList.toggle('hidden', !!shown);
  const count = $('#student-count');
  if (count) count.textContent = t ? `${shown} of ${items.length} member${items.length === 1 ? '' : 's'}` : `${items.length} member${items.length === 1 ? '' : 's'}`;
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
      <div class="row"><span class="mini" style="padding:0;background:none;border:0;cursor:auto"><span class="dot" style="background:${esc(projColor(p))}"></span></span><a href="${projHref(p.id)}" data-close-nav>${esc(p.title)}</a><span class="spacer"></span>${badge(st, s)}</div>
      <div class="when" style="font-size:.95rem">🗓 ${esc(fmtWhen(s))}</div>
      ${privacyNote(s)}
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      ${s.conditions.length ? `<div class="st-${st}"><ol class="conds">${s.conditions.map((c, k) => `<li><b>Condition ${k + 1}</b><span>${esc(c)}</span></li>`).join('')}</ol></div>` : isResearch(p) ? '<p class="muted small">No experiment conditions listed.</p>' : ''}
      ${s.comment ? `<div class="st-${st}"><div class="comment"><b>${s.outcome === 'failed' ? 'Why it did not go as planned' : 'Comment'}</b>${esc(s.comment)}</div></div>` : ''}
      ${st === 'overdue' ? `<div class="needs-update"><strong>This stage has started — did it go as planned?</strong></div>` : ''}
      ${p.comments ? commentsBox() : ''}
    </div>`,
    onMount: p.comments ? (m) => mountComments(m, s) : undefined,
    footer: E && st === 'off' ? `<button class="btn danger" data-act="delete-stage" data-id="${s.id}">Delete</button><span class="spacer"></span>
        <button class="btn primary" data-act="edit-stage" data-id="${s.id}">✎ Edit</button>`
      : E ? `<button class="btn danger" data-act="delete-stage" data-id="${s.id}">Delete</button><span class="spacer"></span>
        ${s.outcome === 'failed' ? `<button class="btn" data-act="dup-stage" data-id="${s.id}">↻ Reschedule</button>` : ''}
        <button class="btn" data-act="edit-stage" data-id="${s.id}">✎ Edit</button>
        <button class="btn primary" data-act="outcome" data-id="${s.id}">Update result</button>`
      : `<a class="btn" href="${projHref(p.id)}" data-close-nav>Open project</a>`,
  });
}

// ---------------------------------------------------------------- visitor comments
// Comments live in a Supabase table (free tier). The project URL and the public
// "anon"/publishable key are stored in the student's data file (or, as a shared
// default, in students.json); row-level security only allows reading and adding
// comments. The student hides unwanted ones via meta.hiddenComments.
const COMMENTS_SQL = `create table public.comments (
  id bigint generated always as identity primary key,
  stage_id text not null check (char_length(stage_id) <= 64),
  name text check (char_length(name) <= 60),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
alter table public.comments enable row level security;
grant select, insert on public.comments to anon;
create policy "Anyone can read comments" on public.comments
  for select to anon using (true);
create policy "Anyone can add comments" on public.comments
  for insert to anon with check (true);`;

function commentsCfg() {
  const own = state.data.meta.comments || {};
  const c = own.url && own.key ? own : state.registry?.meta.comments || {};
  return c.url && c.key ? { url: c.url.trim().replace(/\/+$/, ''), key: c.key.trim() } : null;
}
async function sbFetch(path, opts = {}) {
  const c = commentsCfg();
  if (!c) throw new Error('Comments are not set up');
  const headers = { apikey: c.key, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (c.key.startsWith('eyJ')) headers.Authorization = `Bearer ${c.key}`; // legacy JWT anon key
  const res = await fetch(`${c.url}/rest/v1/${path}`, { ...opts, headers, cache: 'no-store' });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || `HTTP ${res.status}`); }
  const text = await res.text(); // inserts with Prefer: return=minimal answer 201 with an empty body
  return text ? JSON.parse(text) : null;
}

function commentsBox() {
  return `<section class="comments">
    <h3>💬 Comments from members</h3>
    <div id="cm-list" class="cm-list"><p class="muted small">Loading comments…</p></div>
    ${commentsCfg() ? `<form id="cm-form" class="cm-form" autocomplete="off">
      <input type="text" name="name" maxlength="60" placeholder="Your name (optional — leave empty to stay anonymous)" aria-label="Your name (optional)">
      <textarea name="body" required maxlength="2000" rows="3" placeholder="Write a comment…" aria-label="Comment"></textarea>
      <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="row"><span class="muted small">Visible to everyone who opens this dashboard.</span><span class="spacer"></span><button class="btn sm primary" type="submit">Post comment</button></div>
    </form>` : ''}
  </section>`;
}

function mountComments(m, s) {
  const list = $('#cm-list', m); const form = $('#cm-form', m);
  if (!commentsCfg()) {
    list.innerHTML = `<p class="muted small">Comments aren't switched on yet.${canEdit() ? ' Set them up in ⚙︎ Settings → Visitor comments.' : ''}</p>`;
    return;
  }
  const hidden = () => new Set(state.data.meta.hiddenComments.map(String));
  let rows = [];
  const draw = () => {
    const h = hidden();
    const visible = rows.filter((r) => state.edit || !h.has(String(r.id)));
    list.innerHTML = visible.length ? visible.map((r) => {
      const isHidden = h.has(String(r.id));
      return `<div class="cm ${isHidden ? 'cm-hidden' : ''}">
        <div class="cm-head"><b>${esc(r.name || 'Anonymous')}</b><span class="muted small">${esc(new Date(r.created_at).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }))}</span>
          ${state.edit ? `<span class="spacer"></span><button type="button" class="btn sm ghost" data-cm-toggle="${esc(r.id)}">${isHidden ? 'Unhide' : 'Hide'}</button>` : ''}</div>
        <div class="cm-body">${esc(r.body)}</div>${isHidden ? '<div class="muted small">Hidden from visitors</div>' : ''}</div>`;
    }).join('') : '<p class="muted small">No comments yet. Be the first!</p>';
  };
  const load = async () => {
    try { rows = await sbFetch(`comments?stage_id=eq.${encodeURIComponent(s.id)}&select=id,name,body,created_at&order=created_at.asc`) || []; draw(); }
    catch (e) { list.innerHTML = `<p class="muted small">Could not load comments (${esc(e.message)}).</p>`; }
  };
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cm-toggle]'); if (!b) return;
    e.stopPropagation();
    const id = b.dataset.cmToggle; const arr = state.data.meta.hiddenComments.map(String);
    state.data.meta.hiddenComments = arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
    state.dirty = true; saveDraft(); draw(); render(); // render() refreshes the Publish button; the modal stays open
    toast(arr.includes(id) ? 'Comment visible again — Publish to apply' : 'Comment hidden — Publish to apply');
  });
  if (form) {
    form.name.value = store.get('rpd.cname', '') || '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.website.value) return; // spam bot honeypot
      const body = form.body.value.trim(); const name = form.name.value.trim();
      if (!body) { form.body.reportValidity(); return; }
      const btn = $('[type=submit]', form); btn.disabled = true; btn.textContent = 'Posting…';
      try {
        await sbFetch('comments', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ stage_id: s.id, name: name || null, body }) });
        store.set('rpd.cname', name);
        form.body.value = '';
        toast('Comment posted ✓');
        await load();
      } catch (err) { toast(`Could not post: ${err.message}`, 5000); }
      btn.disabled = false; btn.textContent = 'Post comment';
    });
  }
  load();
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
  // Offer ongoing research projects and special events; a holiday/leave project only
  // when adding or editing a day off, and the stage's own project when editing.
  const listed = byColor().filter((p) => (isResearch(p) && p.status === 'ongoing') || isEvent(p));
  const pref = findProject(pid) || (found && found.p) || findProject(state.cal.project);
  const projectId = (pref && (listed.includes(pref) || isLeave(pref) || found) ? pref.id : listed[0]?.id) || state.data.projects[0]?.id;
  const choices = [...listed];
  const own = findProject(projectId);
  if (own && !choices.includes(own)) choices.push(own);
  if (!state.data.projects.length) { toast('Create a project first'); openProjectForm(); return; }
  const conds = s.conditions.length ? [...s.conditions] : [''];
  const condRow = (v, i) => `<div class="cond-row"><span class="lab">Condition ${i + 1}</span><textarea name="cond" rows="1" placeholder="e.g. 35 °C, pH 7, 3 replicates">${esc(v)}</textarea><button type="button" class="icon-btn" data-rm aria-label="Remove condition">✕</button></div>`;
  openModal({
    title: found ? 'Edit stage' : 'New stage',
    body: `<form id="st-form" autocomplete="off">
      <label class="field"><span>Project</span><select name="pid">${choices.map((p) => `<option value="${esc(p.id)}" ${p.id === projectId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select></label>
      <label class="field leave-only"><span>Type of day off</span><select name="kind">${Object.entries(LEAVE_KINDS).map(([k, v]) => `<option value="${k}" ${(s.kind || 'holiday') === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}</select></label>
      <label class="field leave-only"><span>Who can see it</span><select name="privacy">${Object.entries(PRIVACY).map(([k, v]) => `<option value="${k}" ${(s.privacy || '') === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <p class="help leave-only" id="privacy-help"></p>
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
      const syncPrivacy = () => {
        const v = form.privacy.value;
        $('#privacy-help', m).textContent = v === 'busy'
          ? `Others see “${(LEAVE_KINDS[form.kind.value] || LEAVE_KINDS.other).label}” and the dates only. The title and notes stay on this device and aren't published.`
          : v === 'hidden' ? 'Not published at all: nobody else sees it, not even that you’re away. It stays on this device only.'
          : 'Title, dates and notes are visible to everyone who opens the dashboard.';
      };
      form.privacy.addEventListener('change', syncPrivacy); form.kind.addEventListener('change', syncPrivacy); syncPrivacy();
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
        if (isLeave(target)) { next.conditions = []; next.kind = fd.get('kind'); next.outcome = null; next.comment = ''; next.privacy = PRIVACY[fd.get('privacy')] ? fd.get('privacy') : ''; }
        else next.privacy = '';
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
        <option value="research" ${isResearch(p) ? 'selected' : ''}>Research project</option>
        <option value="event" ${isEvent(p) ? 'selected' : ''}>📌 Special event (meetings, activities)</option>
        <option value="leave" ${isLeave(p) ? 'selected' : ''}>🏖 Holiday &amp; leave (white, no status updates)</option></select></label>
      <div class="research-only"><label class="field rs-only"><span>Status</span><select name="status">${['ongoing', 'paused', 'completed'].map((v) => `<option value="${v}" ${(p?.status || 'ongoing') === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></label>
      <div class="field"><span class="muted small" style="font-weight:600;display:block;margin-bottom:6px">Colour</span>
        <div class="swatches">${COLORS.map((c) => `<label><input type="radio" name="color" value="${c}" ${c === color ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div></div>
      <p class="help" style="margin-top:6px">Projects with the same colour are grouped together on the dashboard.</p></div>
      <label class="check ev-only"><input type="checkbox" name="top" ${p?.top ? 'checked' : ''}> Show at the top of the dashboard (last 2 + next entry)</label>
      <label class="check ev-only"><input type="checkbox" name="comments" ${p?.comments ? 'checked' : ''}> Allow visitor comments on its entries</label>
      <p class="help ev-only">Regular meetings, slide preparation, seminars and other activities. Entries keep their status colours and update prompts, but the event isn't counted as an ongoing project.</p>
      <p class="help leave-only">Holidays, personal appointments and university closures. They always show in white and never ask whether they went as planned.</p>
    </form>`,
    footer: `${p ? `<button class="btn danger" data-act="delete-project" data-id="${p.id}">Delete</button><span class="spacer"></span>` : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="pj-form">${p ? 'Save' : 'Create'}</button>`,
    onMount(m) {
      const form = $('#pj-form', m);
      const syncType = () => {
        const leave = form.type.value === 'leave';
        $$('.leave-only', m).forEach((el) => el.classList.toggle('hidden', !leave));
        $$('.research-only', m).forEach((el) => el.classList.toggle('hidden', leave));
        $$('.rs-only', m).forEach((el) => el.classList.toggle('hidden', form.type.value !== 'research'));
        $$('.ev-only', m).forEach((el) => el.classList.toggle('hidden', form.type.value !== 'event'));
      };
      form.type.addEventListener('change', syncType); syncType();
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const type = ['leave', 'event'].includes(fd.get('type')) ? fd.get('type') : 'research';
        const v = { title: fd.get('title').trim(), description: fd.get('description').trim(), type, status: type === 'research' ? fd.get('status') : 'ongoing', color: fd.get('color') || color, top: type === 'event' && !!fd.get('top'), comments: type === 'event' && !!fd.get('comments') };
        if (type === 'leave' && p && !isLeave(p) && p.stages.length && !confirm('Turn this project into “Holiday & leave”? Its stages will lose their results and conditions.')) return;
        if (type === 'leave') for (const st of p?.stages || []) { st.outcome = null; st.conditions = []; st.comment = ''; st.kind ||= 'other'; }
        if (p) Object.assign(p, v);
        else { const np = { id: uid('p'), ...v, stages: [] }; state.data.projects.push(np); location.hash = projHref(np.id); }
        closeModal();
        commit(p ? 'Project saved' : 'Project created');
      });
    },
  });
}

function openSettings(note = '') {
  const rec = state.rec; const meta = state.data.meta; const t = target(rec);
  openModal({
    title: 'Settings',
    body: `<form id="set-form" autocomplete="off">
      ${note ? `<div class="banner" style="padding:0;margin:0 0 14px"><div class="inner info">${esc(note)}</div></div>` : ''}
      <h3 style="margin-bottom:10px">My dashboard</h3>
      <label class="field"><span>Title</span><input type="text" name="title" value="${esc(meta.title)}"></label>
      <label class="field"><span>Subtitle</span><input type="text" name="subtitle" value="${esc(meta.subtitle)}" placeholder="e.g. PhD course until 2028 · lab"></label>

      <h3 style="margin:18px 0 6px">Publishing</h3>
      <p class="help" style="margin:0 0 12px">Your changes are saved into <code>${esc(`${t.owner}/${t.repo}`)}</code> → <code>${esc(t.path)}</code> (branch <code>${esc(t.branch)}</code>). Only <b>@${esc(rec.entry.github)}</b> can edit this dashboard.</p>
      <div class="row"><button type="button" class="btn sm" id="gh-load">⬇ Load latest from GitHub</button><button type="button" class="btn sm" data-act="account">Account…</button></div>

      <h3 style="margin:18px 0 6px">Visitor comments</h3>
      <p class="help" style="margin:0 0 12px">Comments on meeting entries are stored in a free <a href="https://supabase.com/dashboard" target="_blank" rel="noopener">Supabase</a> project. See the README for the 5-minute setup. These two values are public by design and are published with the dashboard. Leave them empty to use the group's shared setup${state.registry.meta.comments.url ? ' (set)' : ' (none yet)'}.</p>
      <label class="field"><span>Supabase project URL</span><input type="text" name="sbUrl" value="${esc(meta.comments.url)}" placeholder="https://xxxx.supabase.co" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Public key (anon / publishable)</span><input type="text" name="sbKey" value="${esc(meta.comments.key)}" placeholder="sb_publishable_… or eyJ…" autocapitalize="off" spellcheck="false"></label>
      <div class="row"><button type="button" class="btn sm" id="sql-copy">⧉ Copy setup SQL</button></div>

      <h3 style="margin:18px 0 6px">Data</h3>
      <div class="row">
        <label class="btn sm" style="cursor:pointer">⬆ Import .json<input type="file" id="imp" accept="application/json,.json" hidden></label>
        <button type="button" class="btn sm" data-act="export">⇪ Export…</button>
      </div>
    </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="set-form">Save</button>',
    onMount(m) {
      const form = $('#set-form', m);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const ti = fd.get('title').trim() || rec.entry.name; const sub = fd.get('subtitle').trim();
        const sb = { url: fd.get('sbUrl').trim(), key: fd.get('sbKey').trim() };
        const changed = ti !== meta.title || sub !== meta.subtitle || sb.url !== meta.comments.url || sb.key !== meta.comments.key;
        meta.title = ti; meta.subtitle = sub; meta.comments = sb;
        closeModal();
        if (changed) commit('Settings saved'); else { render(); toast('Settings saved'); }
      });
      $('#sql-copy', m).addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(COMMENTS_SQL); toast('Setup SQL copied ✓'); }
        catch { openModal({ title: 'Setup SQL', body: `<textarea readonly rows="14" style="font-family:monospace;font-size:13px">${esc(COMMENTS_SQL)}</textarea>` }); }
      });
      $('#gh-load', m).addEventListener('click', async () => {
        if (state.dirty && !confirm('Replace your unpublished changes with the version on GitHub?')) return;
        if (await loadFromGitHub(rec)) closeModal();
        else toast('Nothing published on GitHub yet, or the token cannot read it', 5000);
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

// Signing in = pasting a GitHub token. GitHub tells us whose token it is, and
// that username decides which dashboard (if any) this device may edit.
async function whoAmI(token) {
  const j = await ghApi('https://api.github.com/user', { token });
  return j.login;
}
const hubFields = () => (state.hubLocked
  ? `<p class="help" style="margin:10px 0 0">Site repository: <code>${esc(`${state.hub.owner}/${state.hub.repo}`)}</code> (branch <code>${esc(state.hub.branch)}</code>), set by this site's address.</p>`
  : `<details class="adv"${state.hub.owner && state.hub.repo ? '' : ' open'}><summary>Site repository</summary>
    <p class="help" style="margin:8px 0 10px">The repository that hosts this site and <code>${REGISTRY}</code>. It is detected automatically on GitHub Pages.</p>
    <div class="grid2">
      <label class="field"><span>GitHub user / org</span><input type="text" name="hubOwner" value="${esc(state.hub.owner)}" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Repository</span><input type="text" name="hubRepo" value="${esc(state.hub.repo)}" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Branch</span><input type="text" name="hubBranch" value="${esc(state.hub.branch)}" autocapitalize="off" spellcheck="false"></label>
    </div></details>`);
const readHub = (form) => {
  if (state.hubLocked) return;
  state.hub = { owner: form.hubOwner.value.trim(), repo: form.hubRepo.value.trim(), branch: form.hubBranch.value.trim() || 'main' };
  store.set(KEY.hub, state.hub);
};

function openSignIn(note = '') {
  openModal({
    title: 'Student sign-in',
    body: `<form id="own-form" autocomplete="off">
      ${note ? `<div class="banner" style="padding:0;margin:0 0 14px"><div class="inner info">${esc(note)}</div></div>` : ''}
      <p class="muted small" style="margin-top:0">Paste your GitHub access token to edit <b>your own</b> dashboard on this device. Visitors don't need this; they can only view.</p>
      <label class="field"><span>Access token</span><input type="password" name="token" value="${esc(state.auth.token)}" placeholder="github_pat_…" autocapitalize="off" spellcheck="false" required></label>
      <p class="help">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> for the repository that holds your data, with <b>Contents: Read and write</b>. The token stays in this browser and is only sent to <code>api.github.com</code>.</p>
      ${hubFields()}
    </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="own-form">Sign in</button>',
    onMount(m) {
      const form = $('#own-form', m);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('.modal-foot [type=submit]', m);
        btn.disabled = true; btn.textContent = 'Checking…';
        const token = form.token.value.trim();
        try {
          const login = await whoAmI(token);
          readHub(form);
          signIn(token, login);
          closeModal();
          const me = myRecord();
          if (me) {
            state.editPref = true; store.set(KEY.edit, true);
            location.hash = href('', me);
            render();
            toast(`Signed in as @${login} ✓  You can edit your dashboard now.`, 3500);
          } else {
            render();
            toast(isAdmin() ? `Signed in as @${login} (admin) ✓` : `Signed in as @${login}, but no student uses this GitHub account yet. Ask an admin to add you.`, 6000);
          }
        } catch (err) {
          btn.disabled = false; btn.textContent = 'Sign in';
          toast(err.status === 401 ? 'That token was not accepted by GitHub' : `Sign-in failed: ${err.message}`, 5000);
        }
      });
    },
  });
}

function signIn(token, login) {
  state.auth = { token, login };
  store.set(KEY.auth, state.auth);
  // Records loaded before signing in may now be ours: reload them to pick up a draft and the API version.
  for (const rec of state.students.values()) if (canEdit(rec) && !rec.dirty) resetRecord(rec);
  if (isAdmin()) refreshRegistry();
}

function openAccount() {
  const me = myRecord();
  openModal({
    title: 'Account',
    body: `<form id="acc-form" autocomplete="off">
      <p style="margin-top:0">Signed in as <b>@${esc(state.auth.login || '…')}</b>${isAdmin() ? ' <span class="pill">admin</span>' : ''}</p>
      <p class="muted small">${me ? `You can edit <a href="${href('', me)}" data-close-nav>${esc(me.entry.name)}</a>. Everyone else's dashboards are view-only for you.` : 'No student uses this GitHub account, so every dashboard is view-only for you.'}</p>
      ${hubFields()}
    </form>`,
    footer: '<button class="btn danger" id="sign-out">Sign out on this device</button><span class="spacer"></span><button class="btn" data-close>Close</button><button class="btn primary" type="submit" form="acc-form">Save</button>',
    onMount(m) {
      const form = $('#acc-form', m);
      form.addEventListener('submit', (e) => { e.preventDefault(); readHub(form); closeModal(); render(); toast('Saved'); });
      $('#sign-out', m).addEventListener('click', () => {
        const dirty = [...state.students.values()].some((r) => canEdit(r) && r.dirty);
        if (dirty && !confirm('You have unpublished changes. Sign out anyway? (Your draft stays on this device.)')) return;
        state.auth = { token: '', login: '' }; store.del(KEY.auth);
        state.editPref = false; store.set(KEY.edit, false);
        for (const rec of state.students.values()) if (rec.dirty) resetRecord(rec);
        closeModal(); render(); toast('Signed out. This device is view-only now.', 4000);
      });
    },
  });
}

// ---- roster (admins)
async function refreshRegistry() {
  if (!hubReady()) return;
  try { setRegistry((await ghGet(hubTarget())).data); render(); } catch { /* keep the published copy */ }
}

function openRoster() {
  const list = gradeGroups([...state.students.values()]).flatMap((g) => g.recs.map((r) => r.entry));
  openModal({
    title: 'Manage students',
    body: `<p class="muted small" style="margin-top:0">Each student signs in with their own GitHub account and can only edit their own dashboard. Changes here are committed to <code>${REGISTRY}</code> right away.</p>
      <div class="mini-list">${list.map((e) => `<div class="mini st-planned" style="cursor:auto">
        <span class="avatar sm" style="--av:${avatarColor(e.id)}" aria-hidden="true">${esc(initials(e.name))}</span>
        <div class="body"><div class="t">${esc(e.name)}${e.grade ? ` <span class="pill">${esc(e.grade)}</span>` : ''}</div><div class="s">@${esc(e.github || '—')} · ${esc(e.repo ? `${e.repo}/${e.path || 'data.json'}` : e.path || `students/${e.id}.json`)}</div></div>
        <div class="acts"><button class="btn sm" data-act="edit-student" data-id="${esc(e.id)}">✎ Edit</button></div></div>`).join('') || '<p class="muted small">No students yet.</p>'}</div>`,
    footer: '<button class="btn" data-close>Close</button><button class="btn primary" data-act="add-student">＋ Add student</button>',
  });
}

function openStudentForm(id) {
  const e = id ? state.registry.students.find((x) => x.id === id) : null;
  const own = !!e?.repo;
  openModal({
    title: e ? 'Edit student' : 'Add student',
    body: `<form id="stu-form" autocomplete="off">
      <label class="field"><span>Name</span><input type="text" name="name" required value="${esc(e?.name || '')}" placeholder="e.g. Purin"></label>
      <div class="grid2">
        <label class="field"><span>Grade</span><input type="text" name="grade" list="grade-list" value="${esc(e?.grade || '')}" placeholder="e.g. D2, M1" autocapitalize="characters" spellcheck="false">
          <datalist id="grade-list">${state.registry.meta.grades.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
        <label class="field"><span>GitHub username</span><input type="text" name="github" required value="${esc(e?.github || '')}" placeholder="e.g. octocat" autocapitalize="off" spellcheck="false"></label>
      </div>
      <p class="help">Only this GitHub account can edit the student's dashboard.</p>
      <label class="field"><span>Page address</span><input type="text" name="id" value="${esc(e?.id || '')}" placeholder="made from the name" autocapitalize="off" spellcheck="false" ${e ? 'disabled' : ''}></label>
      <p class="help">The link is <code>#/s/<i>address</i></code>.${e ? ' It can’t be changed once created.' : ''}</p>
      <label class="field"><span>Where the data is stored</span><select name="where">
        <option value="hub" ${own ? '' : 'selected'}>In this repository (students/&lt;address&gt;.json)</option>
        <option value="own" ${own ? 'selected' : ''}>In the student's own repository</option></select></label>
      <div class="own-only">
        <div class="grid2">
          <label class="field"><span>Repository (owner/name)</span><input type="text" name="repo" value="${esc(e?.repo || '')}" placeholder="octocat/research-data" autocapitalize="off" spellcheck="false"></label>
          <label class="field"><span>Branch</span><input type="text" name="branch" value="${esc(e?.branch || 'main')}" autocapitalize="off" spellcheck="false"></label>
        </div>
        <label class="field"><span>Data file</span><input type="text" name="path" value="${esc(e?.repo ? e.path || 'data.json' : 'data.json')}" autocapitalize="off" spellcheck="false"></label>
      </div>
      <p class="help hub-only">The student needs write access to this repository (Settings → Collaborators). The app only lets them edit their own file; the commit history shows who changed what.</p>
      <p class="help own-only">Strict separation: GitHub itself stops anyone but the student from writing. The repository must be public so visitors can read it.</p>
    </form>`,
    footer: `${e ? '<button class="btn danger" id="stu-del">Remove</button><span class="spacer"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="stu-form">${e ? 'Save' : 'Add'}</button>`,
    onMount(m) {
      const form = $('#stu-form', m);
      const sync = () => {
        const o = form.where.value === 'own';
        $$('.own-only', m).forEach((el) => el.classList.toggle('hidden', !o));
        $$('.hub-only', m).forEach((el) => el.classList.toggle('hidden', o));
        form.repo.required = o;
      };
      form.where.addEventListener('change', sync); sync();
      const save = async (change, msg, done) => {
        $$('.modal-foot .btn', m).forEach((b) => { b.disabled = true; });
        try { await saveRegistry(change, msg); closeModal(); render(); toast(done, 4000); }
        catch (err) { $$('.modal-foot .btn', m).forEach((b) => { b.disabled = false; }); toast(`Could not save: ${err.message}`, 6000); }
      };
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        const v = { name: fd.get('name').trim(), grade: fd.get('grade').trim(), github: fd.get('github').trim().replace(/^@/, '') };
        if (fd.get('where') === 'own') {
          const repo = fd.get('repo').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Repository should look like owner/name'); form.repo.focus(); return; }
          Object.assign(v, { repo, branch: fd.get('branch').trim() || 'main', path: fd.get('path').trim().replace(/^\/+/, '') || 'data.json' });
        }
        const sid = e ? e.id : slug(fd.get('id').trim() || v.name);
        if (!e && state.registry.students.some((x) => x.id === sid)) { toast('That page address is already used'); form.id.focus(); return; }
        save((reg) => {
          const i = reg.students.findIndex((x) => x.id === sid);
          const entry = { id: sid, ...v };
          if (!entry.grade) delete entry.grade;
          if (i >= 0) { const { repo, branch, path, grade, ...rest } = reg.students[i]; reg.students[i] = { ...rest, ...entry }; }
          else reg.students.push(entry);
        }, `${e ? 'Update' : 'Add'} student: ${v.name}`, e ? 'Student saved ✓' : `${v.name} added ✓  Visitors will see them within a minute or two.`);
      });
      $('#stu-del', m)?.addEventListener('click', () => {
        if (!confirm(`Remove ${e.name} from the student list?\n\nTheir data file is kept on GitHub; adding them again with the same address brings it back.`)) return;
        save((reg) => { reg.students = reg.students.filter((x) => x.id !== e.id); }, `Remove student: ${e.name}`, `${e.name} removed`);
      });
    },
  });
}

// The view-only link for visitors: this page without ?admin, on the current student.
const viewerUrl = () => `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
function openShare() {
  const rec = state.rec;
  const url = rec ? `${viewerUrl()}${href('', rec)}` : viewerUrl();
  const title = rec ? state.data?.meta.title || rec.entry.name : state.registry.meta.title;
  openModal({
    title: 'Share with visitors',
    body: `<p class="muted small" style="margin-top:0">Anyone with this link can follow ${rec ? `${esc(rec.entry.name)}’s` : 'everyone’s'} progress. It is view-only — nobody can edit through it.</p>
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
        navigator.share({ title, text: `${title} — research progress`, url }).catch(() => {});
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
  signin() { openSignIn(); },
  account() { closeModal(); openAccount(); },
  roster() { openRoster(); },
  'home-view'(el) { state.homeView = el.dataset.v; store.set(KEY.home, state.homeView); render(); },
  'add-student'() { closeModal(); openStudentForm(); },
  'edit-student'(el) { closeModal(); openStudentForm(el.dataset.id); },
  'toggle-edit'() { state.editPref = !state.edit; store.set(KEY.edit, state.editPref); render(); },
  publish,
  async discard() {
    if (!confirm('Discard all unpublished changes on this device?')) return;
    const rec = state.rec;
    store.del(draftKey(rec)); rec.dirty = false;
    if (!(await loadFromGitHub(rec, { quiet: true }))) { rec.data = mergePrivate(rec, await fetchPublished(rec).catch(() => emptyData(rec))); rec.sha = null; render(); }
    toast('Changes discarded');
  },
  settings() { openSettings(); },
  export() { closeModal(); openExport(); },
  'meeting-slide'() { closeModal(); openMeetingSlide(); },
  dl(el) {
    const { kind, scope } = el.dataset;
    closeModal();
    if (kind === 'json') exportJSON(scope);
    else if (kind === 'csv') exportCSV(scope);
    else if (kind === 'ics') exportICS(scope);
    else location.hash = href(`report/${scope === 'all' ? '' : encodeURIComponent(scope)}`);
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
    closeModal(); location.hash = href(); commit('Project deleted');
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
document.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-form="student-search"]')) return;
  e.preventDefault();
  const first = $$('.student-item').find((c) => !c.classList.contains('hidden'));
  if (first) location.hash = first.getAttribute('href');
});
document.addEventListener('input', (e) => {
  if (e.target.matches('[data-input="student-filter"]')) filterStudents(e.target.value);
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

// Moves what the single-user version kept on this device (token, draft) over
// to the student it belonged to.
function migrateLegacy() {
  const gh = store.get(KEY.legacyGh);
  if (gh?.token && !state.auth.token) state.auth = { token: gh.token, login: '' };
  if (gh?.owner && gh?.repo && !state.hubLocked && !store.get(KEY.hub) && !(state.hub.owner && state.hub.repo)) {
    state.hub = { owner: gh.owner, repo: gh.repo, branch: gh.branch || 'main' };
    store.set(KEY.hub, state.hub);
  }
  const draft = store.get(KEY.draft);
  if (draft?.data) {
    const rec = [...state.students.values()].find((r) => sameUser(r.entry.github, gh?.owner)) || state.students.values().next().value;
    if (rec && !store.get(draftKey(rec))) store.set(draftKey(rec), draft);
  }
  store.del(KEY.draft); store.del(KEY.legacyGh); store.del(KEY.legacyOwner);
}

async function boot() {
  const params = new URLSearchParams(location.search);
  state.auth = { token: '', login: '', ...(store.get(KEY.auth) || {}) };
  // On GitHub Pages the address says which repository hosts the site, so that
  // always wins over anything saved on this device; elsewhere (e.g. localhost)
  // it is whatever was entered in the sign-in dialog.
  const detected = detectRepo();
  state.hubLocked = !!detected.owner;
  state.hub = state.hubLocked ? { ...detected, branch: 'main' } : { ...state.hub, ...(store.get(KEY.hub) || {}) };
  if (state.hubLocked) store.del(KEY.hub);
  state.editPref = !!store.get(KEY.edit, false);
  state.homeView = store.get(KEY.home) === 'cards' ? 'cards' : 'list';
  state.cal = { ...state.cal, ...(store.get(KEY.cal) || {}) };

  try {
    setRegistry(await fetchJSON(REGISTRY));
  } catch (e) {
    if (e.status !== 404) {
      $('#view').innerHTML = `<div class="card empty"><h2>Could not load the student list</h2><p>${esc(e.message)}</p><p class="small">If you opened <code>index.html</code> directly from disk, serve the folder instead (e.g. <code>python3 -m http.server</code>) or open the GitHub Pages address.</p></div>`;
      return;
    }
    // No students.json: a single-user site that still keeps everything in data.json.
    setRegistry({ meta: { title: 'Research Progress' }, students: [{ id: 'me', name: 'My research', github: state.hub.owner, path: 'data.json' }] });
  }
  migrateLegacy();
  if (state.auth.token) {
    // A token carried over from the single-user version: ask GitHub whose it is
    // before loading anything, so the right draft and edit rights apply.
    if (!state.auth.login) { try { state.auth.login = await whoAmI(state.auth.token); } catch { /* offline: stays view-only for now */ } }
    store.set(KEY.auth, state.auth);
    if (isAdmin()) refreshRegistry();
  }
  render();
  if (params.has('admin') && !state.auth.token) openSignIn();
}
boot();
