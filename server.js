import express from 'express';
import crypto from 'node:crypto';
import { sortLead } from './sort.js';

const SERVICES = ['cleaning', 'repair', 'consultation', 'other'];
const STATUSES = ['new', 'contacted', 'won', 'lost'];
const SESSION_HOURS = 12;

// Postgres if DATABASE_URL is set, otherwise a local PGlite file.
let dbPromise;
function db() {
  dbPromise ??= (async () => {
    let client;
    if (process.env.DATABASE_URL) {
      const { default: pg } = await import('pg');
      client = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    } else {
      const { PGlite } = await import('@electric-sql/pglite');
      client = new PGlite(process.env.PGLITE_DIR || './.data');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      service TEXT NOT NULL CHECK (service IN ('cleaning','repair','consultation','other')),
      message TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('booking','question','complaint','other')),
      urgency TEXT NOT NULL CHECK (urgency IN ('high','normal','low')),
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','won','lost')),
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    return client;
  })().catch((err) => { dbPromise = undefined; throw err; });
  return dbPromise;
}
const query = async (sql, params) => (await db()).query(sql, params);

const toLead = (r) => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, service: r.service, message: r.message,
  category: r.category, urgency: r.urgency, status: r.status, note: r.note,
  created_at: new Date(r.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
});

const chars = (s) => [...s].length;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function textError(value, field, { required, max }) {
  if (value === undefined || value === null || value === '') return required ? `${field} is required` : null;
  if (typeof value !== 'string') return `${field} must be a string`;
  if (required && !value.trim()) return `${field} is required`;
  if (value.includes('\u0000')) return `${field} contains invalid characters`;
  if (chars(value) > max) return `${field} must be at most ${max} characters`;
  return null;
}

function validateLead(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'Body must be a JSON object';
  return textError(b.name, 'name', { required: true, max: 100 })
    || textError(b.email, 'email', { required: true, max: 254 })
    || (EMAIL.test(b.email) ? null : 'email must be a valid email address')
    || textError(b.phone, 'phone', { required: false, max: 50 })
    || (SERVICES.includes(b.service) ? null : `service must be one of: ${SERVICES.join(', ')}`)
    || textError(b.message, 'message', { required: true, max: 2000 });
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const secret = () => process.env.SESSION_SECRET || process.env.API_TOKEN || '';
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('hex');

function hasSession(req) {
  const m = /(?:^|;\s*)session=(\d+)\.([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!(m && secret() && Number(m[1]) > Date.now() && safeEqual(m[2], sign(m[1])));
}

function requireAuth(req, res, next) {
  const token = process.env.API_TOKEN;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (token && m && safeEqual(m[1], token)) return next();
  if (!req.headers.authorization && hasSession(req)) return next();
  res.status(401).json({ error: 'Missing or invalid token' });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const ok = process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD
    && typeof email === 'string' && typeof password === 'string'
    && safeEqual(email.trim().toLowerCase(), process.env.OWNER_EMAIL.toLowerCase())
    && safeEqual(password, process.env.OWNER_PASSWORD);
  if (!ok) return res.status(401).json({ error: 'Wrong email or password' });
  const exp = String(Date.now() + SESSION_HOURS * 3600e3);
  res.cookie('session', `${exp}.${sign(exp)}`, {
    httpOnly: true, sameSite: 'strict', secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: SESSION_HOURS * 3600e3, path: '/',
  });
  res.json({ ok: true });
});
app.post('/auth/logout', (req, res) => { res.clearCookie('session', { path: '/' }); res.json({ ok: true }); });
app.get('/auth/me', (req, res) => res.status(hasSession(req) ? 200 : 401).json({ ok: hasSession(req) }));

app.post('/api/leads', async (req, res) => {
  const error = validateLead(req.body);
  if (error) return res.status(400).json({ error });
  const b = req.body;
  const lead = { name: b.name, email: b.email, phone: b.phone || '', service: b.service, message: b.message };
  const { category, urgency } = await sortLead(lead);
  const { rows } = await query(
    `INSERT INTO leads (name, email, phone, service, message, category, urgency)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [lead.name, lead.email, lead.phone, lead.service, lead.message, category, urgency],
  );
  const saved = toLead(rows[0]);

  // Lead is saved already, so a failed webhook is only logged.
  if (process.env.WEBHOOK_URL) {
    try {
      const r = await fetch(process.env.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'lead.created', lead: saved }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) console.error('Webhook returned', r.status);
    } catch (err) {
      console.error('Webhook failed:', err.message);
    }
  }
  res.status(201).json(saved);
});

app.get('/api/leads', requireAuth, async (req, res) => {
  const { status, category } = req.query;
  // Unknown filter values match nothing.
  if ([status, category].some((v) => v !== undefined && typeof v !== 'string')) return res.json({ leads: [] });
  const where = [], params = [];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  const { rows } = await query(
    `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT 500`,
    params,
  );
  res.json({ leads: rows.map(toLead) });
});

// Non-numeric ids return 404 like a missing id.
const parseId = (s) => (/^\d{1,9}$/.test(s) ? Number(s) : null);

app.get('/api/leads/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = id ? await query('SELECT * FROM leads WHERE id = $1', [id]) : { rows: [] };
  if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
  res.json(toLead(rows[0]));
});

app.patch('/api/leads/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const { rows: found } = id ? await query('SELECT id FROM leads WHERE id = $1', [id]) : { rows: [] };
  if (!found.length) return res.status(404).json({ error: 'Lead not found' });

  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'Body must be a JSON object' });
  if (b.status === undefined && b.note === undefined) return res.status(400).json({ error: 'Send status and/or note' });
  if (b.status !== undefined && !STATUSES.includes(b.status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  if (b.note !== undefined) {
    if (typeof b.note !== 'string') return res.status(400).json({ error: 'note must be a string' });
    const err = textError(b.note, 'note', { required: false, max: 2000 });
    if (err) return res.status(400).json({ error: err });
  }
  const { rows } = await query(
    `UPDATE leads SET status = COALESCE($1, status), note = COALESCE($2, note) WHERE id = $3 RETURNING *`,
    [b.status ?? null, b.note ?? null, id],
  );
  res.json(toLead(rows[0]));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// JSON errors for bad bodies and anything unexpected.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body must be valid JSON' });
  if (err.type === 'entity.too.large') return res.status(400).json({ error: 'Body is too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong, please try again' });
});

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Lead inbox on http://localhost:${port}`));
}

export default app;
