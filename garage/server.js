// לוח סטטוס רכבים במוסך — שרת קטן ללא תלויות.
// הפעלה: node server.js   (ברירת מחדל פורט 3000)
// משתני סביבה: PORT, EDIT_PIN (קוד לעריכה; אם לא מוגדר — כולם יכולים לערוך), DATA_FILE

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const EDIT_PIN = process.env.EDIT_PIN || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STAGES = [
  { id: 'reception',   label: 'קבלה',              color: '#64748b' },
  { id: 'diagnostics', label: 'אבחון / דיאגנוסטיקה', color: '#8b5cf6' },
  { id: 'approval',    label: 'ממתין לאישור לקוח',  color: '#f59e0b' },
  { id: 'parts',       label: 'ממתין לחלקים',       color: '#f97316' },
  { id: 'mechanics',   label: 'מכונאות',            color: '#3b82f6' },
  { id: 'electrical',  label: 'חשמל',               color: '#06b6d4' },
  { id: 'bodywork',    label: 'פחחות וצבע',          color: '#ec4899' },
  { id: 'qa',          label: 'בדיקה / נסיעת מבחן',  color: '#14b8a6' },
  { id: 'ready',       label: 'מוכן לאיסוף',         color: '#22c55e' },
  { id: 'delivered',   label: 'נמסר ללקוח',          color: '#334155' },
];
const STAGE_IDS = new Set(STAGES.map(s => s.id));

const EDITABLE_FIELDS = ['plate', 'model', 'kind', 'customer', 'phone', 'mechanic', 'task', 'priority', 'eta', 'notes'];
const MAX_LEN = { notes: 2000, task: 300 };

// ---------- אחסון ----------
let db = { vehicles: [] };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(db.vehicles)) db.vehicles = [];
} catch (e) {
  if (e.code !== 'ENOENT') console.error('שגיאה בקריאת קובץ הנתונים:', e.message);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db, null, 2), err => {
      if (err) return console.error('שגיאה בשמירה:', err.message);
      fs.rename(tmp, DATA_FILE, err2 => err2 && console.error('שגיאה בשמירה:', err2.message));
    });
  }, 200);
}

// ---------- זמן אמת (Server-Sent Events) ----------
const clients = new Set();
function snapshot() {
  return { stages: STAGES, vehicles: db.vehicles, pinRequired: !!EDIT_PIN };
}
function broadcast() {
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- עזרים ----------
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 100_000) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function pinOk(req) {
  if (!EDIT_PIN) return true;
  const given = String(req.headers['x-pin'] || '');
  const a = Buffer.from(given), b = Buffer.from(EDIT_PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clean(field, value) {
  let v = String(value ?? '').trim();
  v = v.slice(0, MAX_LEN[field] || 120);
  if (field === 'priority') v = v === 'urgent' ? 'urgent' : 'normal';
  return v;
}

function byName(body) {
  return String(body.by || '').trim().slice(0, 60) || 'לא ידוע';
}

function addHistory(v, by, note) {
  v.history = v.history || [];
  v.history.push({ at: new Date().toISOString(), stage: v.stage, task: v.task, by, note: note || '' });
  if (v.history.length > 200) v.history = v.history.slice(-200);
}

// ---------- API ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'vehicles', id?, action?]

  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot());

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/check-pin') {
    return send(res, pinOk(req) ? 200 : 401, { ok: pinOk(req) });
  }

  if (parts[1] !== 'vehicles') return send(res, 404, { error: 'not found' });
  if (!pinOk(req)) return send(res, 401, { error: 'קוד עריכה שגוי' });

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'בקשה לא תקינה' }); }
  const by = byName(body);
  const now = new Date().toISOString();

  // רכב חדש
  if (req.method === 'POST' && parts.length === 2) {
    const v = { id: crypto.randomUUID() };
    for (const f of EDITABLE_FIELDS) v[f] = clean(f, body[f]);
    if (!v.plate && !v.model) return send(res, 400, { error: 'יש להזין מספר רישוי או דגם' });
    v.stage = STAGE_IDS.has(body.stage) ? body.stage : 'reception';
    v.createdAt = v.stageSince = v.updatedAt = now;
    v.updatedBy = by;
    v.history = [];
    addHistory(v, by, 'הרכב נכנס למוסך');
    db.vehicles.push(v);
    save(); broadcast();
    return send(res, 201, v);
  }

  const v = db.vehicles.find(x => x.id === parts[2]);
  if (!v) return send(res, 404, { error: 'הרכב לא נמצא' });

  // שינוי שלב
  if (req.method === 'POST' && parts[3] === 'stage') {
    if (!STAGE_IDS.has(body.stage)) return send(res, 400, { error: 'שלב לא תקין' });
    const changed = v.stage !== body.stage;
    v.stage = body.stage;
    if (body.task !== undefined) v.task = clean('task', body.task);
    if (changed) v.stageSince = now;
    v.updatedAt = now;
    v.updatedBy = by;
    addHistory(v, by, clean('task', body.note));
    save(); broadcast();
    return send(res, 200, v);
  }

  // עדכון פרטים
  if (req.method === 'PATCH' && parts.length === 3) {
    let taskChanged = false;
    for (const f of EDITABLE_FIELDS) {
      if (body[f] === undefined) continue;
      const nv = clean(f, body[f]);
      if (f === 'task' && nv !== v.task) taskChanged = true;
      v[f] = nv;
    }
    v.updatedAt = now;
    v.updatedBy = by;
    if (taskChanged) addHistory(v, by, 'עדכון משימה');
    save(); broadcast();
    return send(res, 200, v);
  }

  // מחיקה
  if (req.method === 'DELETE' && parts.length === 3) {
    db.vehicles = db.vehicles.filter(x => x.id !== v.id);
    save(); broadcast();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}

// ---------- קבצים סטטיים ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '/tv') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(err => { console.error(err); send(res, 500, { error: 'שגיאת שרת' }); });
  } else {
    serveStatic(req, res, url);
  }
});

server.listen(PORT, () => {
  console.log(`\n🚒 לוח סטטוס המוסך פועל!`);
  console.log(`   במחשב הזה:   http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`   ברשת המוסך: http://${i.address}:${PORT}   (מסך טלוויזיה: /tv)`);
    }
  }
  console.log(EDIT_PIN ? '   עריכה מוגנת בקוד (EDIT_PIN).' : '   ⚠️  לא הוגדר EDIT_PIN — כל מי שברשת יכול לערוך.');
});
