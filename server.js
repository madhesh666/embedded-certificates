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
const supabase = require('./config/supabase');

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

// --- upload ---//
// --- Supabase PDF upload ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

app.post('/api/admin/upload', requireAdmin, (req, res) => {
  upload.single('pdf')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Please choose a PDF file' });

    const event = (req.body.event || '').trim();
    const category = (req.body.category || 'Participation').trim();

    if (!event) {
      return res.status(400).json({ error: 'Event name is required' });
    }

    const id = uid();
    const storagePath = `${id}.pdf`;

    try {
      const buf = req.file.buffer;
      const pages = await extractPages(buf);

      // Upload PDF to private Supabase Storage bucket
      const { error: storageError } = await supabase.storage
        .from('certificates')
        .upload(storagePath, buf, {
          contentType: 'application/pdf',
          upsert: false
        });

      if (storageError) throw storageError;

      // Save batch details in Supabase Database
      const { error: batchError } = await supabase
        .from('batches')
        .insert({
          id,
          event,
          category,
          filename: req.file.originalname,
          storage_path: storagePath
        });

      if (batchError) {
        await supabase.storage.from('certificates').remove([storagePath]);
        throw batchError;
      }

      // Save individual certificate pages
      const certificateRows = pages.map(p => ({
        batch_id: id,
        page_number: p.page,
        student_name: p.name || '',
        extracted_text: p.text || ''
      }));

      if (certificateRows.length) {
        const { error: pagesError } = await supabase
          .from('certificates')
          .insert(certificateRows);

        if (pagesError) {
          await supabase.from('batches').delete().eq('id', id);
          await supabase.storage.from('certificates').remove([storagePath]);
          throw pagesError;
        }
      }

      const named = pages.filter(p => p.name).length;
      const empty = pages.filter(p => !p.text.trim()).length;

      res.json({
        ok: true,
        id,
        pages: pages.length,
        namesDetected: named,
        pagesWithoutText: empty
      });

    } catch (e) {
      console.error('Supabase upload error:', e);
      res.status(500).json({
        error: 'Upload failed. Please check Supabase configuration and database permissions.'
      });
    }
  });
});

app.get('/api/admin/batches', requireAdmin, async (req, res) => {
  try {
    const { data: batches, error: batchError } = await supabase
      .from('batches')
      .select('*')
      .order('uploaded_at', { ascending: false });

    if (batchError) throw batchError;

    const { data: certificates, error: certError } = await supabase
      .from('certificates')
      .select('batch_id, page_number, student_name, extracted_text')
      .order('page_number', { ascending: true });

    if (certError) throw certError;

    const result = batches.map(b => ({
      id: b.id,
      event: b.event,
      category: b.category,
      filename: b.filename,
      uploadedAt: b.uploaded_at,
      pages: certificates
        .filter(p => p.batch_id === b.id)
        .map(p => ({
          page: p.page_number,
          name: p.student_name || '',
          snippet: (p.extracted_text || '').replace(/\s+/g, ' ').slice(0, 140)
        }))
    }));

    res.json(result);

  } catch (error) {
    console.error('Admin batches error:', error);
    res.status(500).json({ error: 'Could not load batches from database' });
  }
});
app.patch('/api/admin/batches/:id/page/:page', requireAdmin, async (req, res) => {
  try {
    const pageNumber = Number(req.params.page);
    const name = String((req.body || {}).name || '').trim().slice(0, 80);

    const { data, error } = await supabase
      .from('certificates')
      .update({ student_name: name })
      .eq('batch_id', req.params.id)
      .eq('page_number', pageNumber)
      .select('id');

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json({ ok: true });

  } catch (error) {
    console.error('Student name update error:', error);
    res.status(500).json({ error: 'Could not update student name' });
  }
});
app.patch('/api/admin/batches/:id', requireAdmin, async (req, res) => {
  try {
    const { event, category } = req.body || {};
    const updates = {};

    if (typeof event === 'string' && event.trim()) {
      updates.event = event.trim();
    }

    if (typeof category === 'string' && category.trim()) {
      updates.category = category.trim();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const { data, error } = await supabase
      .from('batches')
      .update(updates)
      .eq('id', req.params.id)
      .select('id');

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json({ ok: true });

  } catch (error) {
    console.error('Batch update error:', error);
    res.status(500).json({ error: 'Could not update batch' });
  }
});
app.delete('/api/admin/batches/:id', requireAdmin, async (req, res) => {
  try {
    const { data: batch, error: findError } = await supabase
      .from('batches')
      .select('id, storage_path')
      .eq('id', req.params.id)
      .maybeSingle();

    if (findError) throw findError;

    if (!batch) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Delete PDF from Supabase Storage
    const { error: storageError } = await supabase.storage
      .from('certificates')
      .remove([batch.storage_path]);

    if (storageError) throw storageError;

    // Delete batch; certificate rows are deleted by ON DELETE CASCADE
    const { error: deleteError } = await supabase
      .from('batches')
      .delete()
      .eq('id', req.params.id);

    if (deleteError) throw deleteError;

    res.json({ ok: true });

  } catch (error) {
    console.error('Batch delete error:', error);
    res.status(500).json({ error: 'Could not delete batch' });
  }
});

app.get('/api/admin/feedback', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('feedback')
      .select('*')
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    const result = data.map(f => ({
      at: f.submitted_at,
      name: f.name,
      dept: f.department || '',
      year: f.year || '',
      event: f.event || '',
      rating: f.rating,
      liked: f.liked || '',
      improve: f.improve || '',
      comments: f.comments || ''
    }));

    res.json(result);

  } catch (error) {
    console.error('Feedback fetch error:', error);
    res.status(500).json({ error: 'Could not load feedback' });
  }
});
app.get('/api/admin/feedback.csv', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('feedback')
      .select('*')
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

    const rows = [
      ['Date', 'Name', 'Department', 'Year', 'Event', 'Rating', 'Liked', 'Improve', 'Comments']
    ];

    data.forEach(f => rows.push([
      f.submitted_at,
      f.name,
      f.department,
      f.year,
      f.event,
      f.rating,
      f.liked,
      f.improve,
      f.comments
    ]));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="embeddedxplore2k26-feedback.csv"');
    res.send('\uFEFF' + rows.map(r => r.map(q).join(',')).join('\n'));

  } catch (error) {
    console.error('Feedback CSV error:', error);
    res.status(500).json({ error: 'Could not export feedback CSV' });
  }
});
app.get('/api/admin/downloads', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('downloads')
      .select('*')
      .order('downloaded_at', { ascending: false });

    if (error) throw error;

    const result = data.map(d => ({
      at: d.downloaded_at,
      name: d.name || '',
      dept: d.department || '',
      year: d.year || '',
      event: d.event || '',
      category: d.category || '',
      certName: d.certificate_name || ''
    }));

    res.json(result);

  } catch (error) {
    console.error('Downloads fetch error:', error);
    res.status(500).json({ error: 'Could not load download history' });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [batches, certificates, downloads, feedback] = await Promise.all([
      supabase.from('batches').select('id', { count: 'exact', head: true }),
      supabase.from('certificates').select('id', { count: 'exact', head: true }),
      supabase.from('downloads').select('id', { count: 'exact', head: true }),
      supabase.from('feedback').select('rating')
    ]);

    if (batches.error) throw batches.error;
    if (certificates.error) throw certificates.error;
    if (downloads.error) throw downloads.error;
    if (feedback.error) throw feedback.error;

    const ratings = (feedback.data || [])
      .map(f => Number(f.rating))
      .filter(r => r >= 1 && r <= 5);

    const avgRating = ratings.length
      ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2))
      : 0;

    res.json({
      batches: batches.count || 0,
      certificates: certificates.count || 0,
      downloads: downloads.count || 0,
      feedback: (feedback.data || []).length,
      avgRating
    });

  } catch (error) {
    console.error('Stats fetch error:', error);
    res.status(500).json({ error: 'Could not load dashboard statistics' });
  }
});
// ---------- STUDENT API ----------
app.get('/api/events', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('batches')
      .select('event')
      .order('event', { ascending: true });

    if (error) throw error;

    const events = [...new Set(
      (data || []).map(b => b.event).filter(Boolean)
    )];

    res.json(events);

  } catch (error) {
    console.error('Events fetch error:', error);
    res.status(500).json({ error: 'Could not load events' });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = norm(req.query.name);
    const tokens = q.split(' ').filter(Boolean);

    if (q.length < 3 || !tokens.some(t => t.length >= 3)) {
      return res.status(400).json({
        error: 'Please enter at least 3 letters of your name.'
      });
    }

    const { data, error } = await supabase
      .from('certificates')
      .select(`
        batch_id,
        page_number,
        student_name,
        extracted_text,
        batches!inner (
          event,
          category
        )
      `);

    if (error) throw error;

    const regs = tokens.map(t => new RegExp('(^|[^a-z])' + esc(t)));
    const results = [];

    for (const p of data || []) {
      const hay = norm((p.student_name || '') + ' ' + (p.extracted_text || ''));

      if (regs.every(r => r.test(hay))) {
        const nameN = norm(p.student_name || '');

        results.push({
          id: p.batch_id,
          page: p.page_number,
          event: p.batches.event,
          category: p.batches.category,
          name: p.student_name || '',
          score:
            (nameN && nameN.includes(q) ? 2 : 0) +
            (nameN && regs.every(r => r.test(nameN)) ? 1 : 0)
        });
      }
    }

    results.sort((a, b) => b.score - a.score);

    res.json(results.slice(0, 20).map(({ score, ...r }) => r));

  } catch (error) {
    console.error('Certificate search error:', error);
    res.status(500).json({ error: 'Certificate search failed' });
  }
});
// ---------- CERTIFICATE PDF API ----------
app.get('/api/cert/:id/:page', async (req, res) => {
  try {
    const pageNo = Number(req.params.page);

    if (!Number.isInteger(pageNo) || pageNo < 1) {
      return res.status(404).send('Certificate not found');
    }

    const { data: batch, error: batchError } = await supabase
      .from('batches')
      .select('id, event, category, storage_path')
      .eq('id', req.params.id)
      .maybeSingle();

    if (batchError) throw batchError;
    if (!batch) return res.status(404).send('Certificate not found');

    const { data: certificate, error: certError } = await supabase
      .from('certificates')
      .select('page_number, student_name')
      .eq('batch_id', batch.id)
      .eq('page_number', pageNo)
      .maybeSingle();

    if (certError) throw certError;
    if (!certificate) return res.status(404).send('Certificate not found');

    const { data: pdfFile, error: storageError } = await supabase.storage
      .from('certificates')
      .download(batch.storage_path);

    if (storageError) throw storageError;

    const pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());

    const src = await PDFDocument.load(pdfBuffer, {
      ignoreEncryption: true
    });

    if (pageNo > src.getPageCount()) {
      return res.status(404).send('Certificate page not found');
    }

    const out = await PDFDocument.create();
    const [page] = await out.copyPages(src, [pageNo - 1]);
    out.addPage(page);

    const bytes = Buffer.from(await out.save());

    if (req.query.dl === '1') {
      const { error: downloadError } = await supabase
        .from('downloads')
        .insert({
          name: String(req.query.n || '').slice(0, 80),
          department: String(req.query.d || '').slice(0, 60),
          year: String(req.query.y || '').slice(0, 20),
          event: batch.event,
          category: batch.category,
          certificate_name: certificate.student_name || '',
          batch_id: batch.id,
          page_number: pageNo
        });

      if (downloadError) throw downloadError;
    }

    const safe = (certificate.student_name || 'certificate')
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_|_$/g, '') || 'certificate';

    const category = batch.category.replace(/[^a-z0-9]+/gi, '');
    const filename = `Embeddedxplore2k26_${category}_${safe}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${req.query.dl === '1' ? 'attachment' : 'inline'}; filename="${filename}"`
    );

    res.send(bytes);

  } catch (error) {
    console.error('Certificate PDF error:', error);
    res.status(500).send('Could not generate certificate');
  }
});

app.post('/api/feedback', async (req, res) => {
  try {
    const b = req.body || {};
    const clip = (v, n) => String(v || '').trim().slice(0, n);
    const rating = Number(b.rating);

    if (!clip(b.name, 80) || !(rating >= 1 && rating <= 5)) {
      return res.status(400).json({
        error: 'Name and a star rating are required.'
      });
    }

    const { error } = await supabase
      .from('feedback')
      .insert({
        name: clip(b.name, 80),
        department: clip(b.dept, 60),
        year: clip(b.year, 20),
        event: clip(b.event, 120),
        rating,
        liked: clip(b.liked, 1000),
        improve: clip(b.improve, 1000),
        comments: clip(b.comments, 1000)
      });

    if (error) throw error;

    res.json({ ok: true });

  } catch (error) {
    console.error('Feedback save error:', error);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});
app.listen(PORT, () => {
  console.log(`\n  Embeddedxplore2k26 Certificate Portal`);
  console.log(`  Student page : http://localhost:${PORT}/`);
  console.log(`  Admin page   : http://localhost:${PORT}/admin.html`);
  console.log(`  Admin login  : ${ADMIN_USER} / ${ADMIN_PASS === 'Embedded@2k26' ? ADMIN_PASS + '  (change via ADMIN_PASS env var)' : '(from ADMIN_PASS env)'}\n`);
});
