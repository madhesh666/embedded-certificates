/**
 * Embeddedxplore2k26 - Certificate Distribution Portal
 * Embedded Systems & Smart Electronics Club | Dept. of ECE | CKCET
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Embedded@2k26';

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- TINY JSON DB ----------
let db = { batches: [], feedback: [], downloads: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { console.error('DB read error', e); }
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const uid = () => crypto.randomBytes(6).toString('hex');

// ---------- PDF TEXT EXTRACTION ----------
async function extractPages(buffer) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // group items into lines by y coordinate
    const rows = new Map();
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(it);
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => items.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join(' ').replace(/\s+/g, ' ').trim());
    const text = lines.join('\n');
    pages.push({ page: i, text, name: guessName(text) });
  }
  return pages;
}

function guessName(text) {
  const flat = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');
  const re = /(?:certify that|presented to|awarded to|proudly presented to|proud to present|given to|certificate is awarded to|this is to certify that)\s*[:\-]?\s*(?:mr\.?|ms\.?|miss|mrs\.?|selvan|selvi)?\s*([A-Za-z][A-Za-z. ]{2,50}?)\s*(?:,|\bof\b|\bfrom\b|\bhas\b|\bfor\b|\bstudying\b|\bdepartment\b|\bdept\b|\bbearing\b|\ba student\b|\bstudent\b|\bsecured\b|\bparticipated\b|\bwon\b)/i;
  const m = flat.match(re);
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

const norm = s => (s || '').toLowerCase().replace(/[.\-_,]/g, ' ').replace(/\s+/g, ' ').trim();
const esc = s => s.replace(/[.*+?^${}()[\]\\|]/g, '\\$&');

// ---------- APP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- sessions (admin) ---
const sessions = new Map(); // token -> expiry
const SESSION_MS = 8 * 60 * 60 * 1000;
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function requireAdmin(req, res, next) {
  const t = parseCookies(req).admin_session;
  const exp = t && sessions.get(t);
  if (exp && exp > Date.now()) return next();
  res.status(401).json({ error: 'Admin login required' });
}

// --- login rate limit ---
const attempts = new Map(); // ip -> {n, until}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username, password } = req.body || {};
  if (safeEqual(username || '', ADMIN_USER) && safeEqual(password || '', ADMIN_PASS)) {
    attempts.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
    return res.json({ ok: true });
  }
  a.n += 1;
  if (a.n >= 5) { a.until = Date.now() + 5 * 60 * 1000; a.n = 0; }
  attempts.set(ip, a);
  res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/admin/logout', (req, res) => {
  const t = parseCookies(req).admin_session;
  if (t) sessions.delete(t);
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

// --- upload ---
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, uid() + '.pdf')
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

app.post('/api/admin/upload', requireAdmin, (req, res) => {
  upload.single('pdf')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Please choose a PDF file' });
    const event = (req.body.event || '').trim();
    const category = (req.body.category || 'Participation').trim();
    if (!event) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Event name is required' }); }
    try {
      const buf = fs.readFileSync(req.file.path);
      const pages = await extractPages(buf);
      const batch = {
        id: path.basename(req.file.filename, '.pdf'),
        event, category,
        filename: req.file.originalname,
        uploadedAt: new Date().toISOString(),
        pages
      };
      db.batches.push(batch);
      saveDb();
      const named = pages.filter(p => p.name).length;
      const empty = pages.filter(p => !p.text.trim()).length;
      res.json({ ok: true, id: batch.id, pages: pages.length, namesDetected: named, pagesWithoutText: empty });
    } catch (e) {
      console.error(e);
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: 'Could not read this PDF. Make sure it is a valid certificate PDF.' });
    }
  });
});

app.get('/api/admin/batches', requireAdmin, (req, res) => {
  res.json(db.batches.map(b => ({
    id: b.id, event: b.event, category: b.category, filename: b.filename, uploadedAt: b.uploadedAt,
    pages: b.pages.map(p => ({ page: p.page, name: p.name, snippet: p.text.replace(/\s+/g, ' ').slice(0, 140) }))
  })));
});

app.patch('/api/admin/batches/:id/page/:page', requireAdmin, (req, res) => {
  const b = db.batches.find(x => x.id === req.params.id);
  const p = b && b.pages.find(x => x.page === Number(req.params.page));
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.name = String((req.body || {}).name || '').trim().slice(0, 80);
  saveDb();
  res.json({ ok: true });
});

app.patch('/api/admin/batches/:id', requireAdmin, (req, res) => {
  const b = db.batches.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const { event, category } = req.body || {};
  if (event && event.trim()) b.event = event.trim();
  if (category && category.trim()) b.category = category.trim();
  saveDb();
  res.json({ ok: true });
});

app.delete('/api/admin/batches/:id', requireAdmin, (req, res) => {
  const i = db.batches.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const [b] = db.batches.splice(i, 1);
  fs.unlink(path.join(UPLOAD_DIR, b.id + '.pdf'), () => {});
  saveDb();
  res.json({ ok: true });
});

app.get('/api/admin/feedback', requireAdmin, (req, res) => res.json(db.feedback.slice().reverse()));

app.get('/api/admin/feedback.csv', requireAdmin, (req, res) => {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['Date', 'Name', 'Department', 'Year', 'Event', 'Rating', 'Liked', 'Improve', 'Comments']];
  db.feedback.forEach(f => rows.push([f.at, f.name, f.dept, f.year, f.event, f.rating, f.liked, f.improve, f.comments]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="embeddedxplore2k26-feedback.csv"');
  res.send('﻿' + rows.map(r => r.map(q).join(',')).join('\n'));
});

app.get('/api/admin/downloads', requireAdmin, (req, res) => res.json(db.downloads.slice().reverse()));

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const ratings = db.feedback.map(f => f.rating).filter(Boolean);
  res.json({
    batches: db.batches.length,
    certificates: db.batches.reduce((n, b) => n + b.pages.length, 0),
    downloads: db.downloads.length,
    feedback: db.feedback.length,
    avgRating: ratings.length ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : 0
  });
});

// ---------- STUDENT API ----------
app.get('/api/events', (req, res) => {
  res.json([...new Set(db.batches.map(b => b.event))]);
});

app.get('/api/search', (req, res) => {
  const q = norm(req.query.name);
  const tokens = q.split(' ').filter(Boolean);
  if (q.length < 3 || !tokens.some(t => t.length >= 3)) {
    return res.status(400).json({ error: 'Please enter at least 3 letters of your name.' });
  }
  const regs = tokens.map(t => new RegExp('(^|[^a-z])' + esc(t)));
  const results = [];
  for (const b of db.batches) {
    for (const p of b.pages) {
      const hay = norm(p.name + ' ' + p.text);
      if (regs.every(r => r.test(hay))) {
        const nameN = norm(p.name);
        results.push({
          id: b.id, page: p.page, event: b.event, category: b.category,
          name: p.name || '',
          score: (nameN && nameN.includes(q) ? 2 : 0) + (nameN && regs.every(r => r.test(nameN)) ? 1 : 0)
        });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  res.json(results.slice(0, 20).map(({ score, ...r }) => r));
});

app.get('/api/cert/:id/:page', async (req, res) => {
  const b = db.batches.find(x => x.id === req.params.id);
  const pageNo = Number(req.params.page);
  if (!b || !b.pages.find(p => p.page === pageNo)) return res.status(404).send('Certificate not found');
  try {
    const src = await PDFDocument.load(fs.readFileSync(path.join(UPLOAD_DIR, b.id + '.pdf')), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const [pg] = await out.copyPages(src, [pageNo - 1]);
    out.addPage(pg);
    const bytes = Buffer.from(await out.save());
    const p = b.pages.find(x => x.page === pageNo);
    if (req.query.dl === '1') {
      db.downloads.push({
        at: new Date().toISOString(),
        name: String(req.query.n || '').slice(0, 80),
        dept: String(req.query.d || '').slice(0, 60),
        year: String(req.query.y || '').slice(0, 20),
        event: b.event, category: b.category, certName: p.name || ''
      });
      if (db.downloads.length > 20000) db.downloads.shift();
      saveDb();
    }
    const safe = (p.name || 'certificate').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'certificate';
    const fname = `Embeddedxplore2k26_${b.category.replace(/[^a-z0-9]+/gi, '')}_${safe}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.dl === '1' ? 'attachment' : 'inline'}; filename="${fname}"`);
    res.send(bytes);
  } catch (e) {
    console.error(e);
    res.status(500).send('Could not generate certificate');
  }
});

app.post('/api/feedback', (req, res) => {
  const b = req.body || {};
  const clip = (v, n) => String(v || '').trim().slice(0, n);
  const rating = Number(b.rating);
  if (!clip(b.name, 80) || !(rating >= 1 && rating <= 5)) {
    return res.status(400).json({ error: 'Name and a star rating are required.' });
  }
  db.feedback.push({
    at: new Date().toISOString(),
    name: clip(b.name, 80), dept: clip(b.dept, 60), year: clip(b.year, 20),
    event: clip(b.event, 120), rating,
    liked: clip(b.liked, 1000), improve: clip(b.improve, 1000), comments: clip(b.comments, 1000)
  });
  saveDb();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n  Embeddedxplore2k26 Certificate Portal`);
  console.log(`  Student page : http://localhost:${PORT}/`);
  console.log(`  Admin page   : http://localhost:${PORT}/admin.html`);
  console.log(`  Admin login  : ${ADMIN_USER} / ${ADMIN_PASS === 'Embedded@2k26' ? ADMIN_PASS + '  (change via ADMIN_PASS env var)' : '(from ADMIN_PASS env)'}\n`);
});
