// Contract check against a running server.
// Usage: BASE_URL=http://localhost:3000 API_TOKEN=xxx node test.js
import assert from 'node:assert/strict';
import { sortByRules } from './sort.js';

// Fallback sorting rules: [message, category, urgency]
for (const [message, category, urgency] of [
  ['Can you come Tuesday?', 'booking', 'normal'],
  ['Is 3pm on Friday available?', 'booking', 'normal'],
  ['Please fix my leaking sink ASAP', 'booking', 'high'],
  ['Pipe burst in the kitchen, please send someone now', 'booking', 'high'],
  ['I need my aircon serviced next month', 'booking', 'low'],
  ['How much do you charge for a deep clean? No rush.', 'question', 'low'],
  ['Do you offer window cleaning?', 'question', 'normal'],
  ['Worst service ever, I want a refund', 'complaint', 'high'],
  ['Your cleaner never showed up yesterday', 'complaint', 'high'],
  ["The aircon you serviced still doesn't work", 'complaint', 'high'],
  ['We are hiring, send your CV', 'other', 'normal'],
  ['Hello there', 'other', 'normal'],
]) {
  assert.deepEqual(sortByRules({ message }), { category, urgency }, message);
}

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TOKEN = process.env.API_TOKEN;
assert.ok(TOKEN, 'set API_TOKEN');
const auth = { Authorization: `Bearer ${TOKEN}` };

async function call(method, path, body, headers = auth) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const good = { name: 'Ana Cruz  ', email: 'ana@example.com', phone: '', service: 'cleaning', message: 'Can you come Tuesday? <b>ñ</b> 🙂' };

// Create
let r = await call('POST', '/api/leads', good, {});
assert.equal(r.status, 201, JSON.stringify(r.body));
const lead = r.body;
assert.equal(lead.name, good.name, 'text comes back exactly as typed');
assert.equal(lead.message, good.message);
assert.deepEqual(Object.keys(lead), ['id', 'name', 'email', 'phone', 'service', 'message', 'category', 'urgency', 'status', 'note', 'created_at']);
assert.equal(lead.status, 'new');
assert.equal(lead.note, '');
assert.match(lead.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
assert.ok(['booking', 'question', 'complaint', 'other'].includes(lead.category));
assert.ok(['high', 'normal', 'low'].includes(lead.urgency));

// Bad input -> 400 with error
for (const bad of [
  {}, { ...good, name: '' }, { ...good, name: '   ' }, { ...good, name: 'x'.repeat(101) }, { ...good, email: 'nope' },
  { ...good, service: 'plumbing' }, { ...good, message: '' }, { ...good, message: 'x'.repeat(2001) },
  { ...good, name: 123 }, { ...good, phone: '1'.repeat(51) }, [], 'not json{',
]) {
  r = await call('POST', '/api/leads', bad, {});
  assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad).slice(0, 60)}`);
  assert.equal(typeof r.body.error, 'string');
}
r = await call('POST', '/api/leads', { ...good, name: '🙂'.repeat(100) }, {});
assert.equal(r.status, 201, '100 emoji = 100 characters');

// Auth
for (const h of [{}, { Authorization: 'Bearer wrong' }, { Authorization: TOKEN }]) {
  assert.equal((await call('GET', '/api/leads', undefined, h)).status, 401);
  assert.equal((await call('GET', `/api/leads/${lead.id}`, undefined, h)).status, 401);
  assert.equal((await call('PATCH', `/api/leads/${lead.id}`, { status: 'won' }, h)).status, 401);
}

// List, newest first, filters
await call('POST', '/api/leads', { ...good, message: 'Second one' }, {});
r = await call('GET', '/api/leads');
assert.equal(r.status, 200);
assert.ok(Array.isArray(r.body.leads));
assert.equal(r.body.leads[0].message, 'Second one');
assert.ok(r.body.leads.every((l, i, a) => i === 0 || a[i - 1].created_at >= l.created_at));

// Get / 404
r = await call('GET', `/api/leads/${lead.id}`);
assert.equal(r.status, 200);
assert.deepEqual(r.body, lead);
assert.equal((await call('GET', '/api/leads/999999999')).status, 404);
assert.equal((await call('GET', '/api/leads/abc')).status, 404);
assert.equal((await call('PATCH', '/api/leads/999999999', { status: 'won' })).status, 404);

// Patch
r = await call('PATCH', `/api/leads/${lead.id}`, { status: 'won' });
assert.equal(r.status, 200);
assert.equal(r.body.status, 'won');
r = await call('PATCH', `/api/leads/${lead.id}`, { note: 'Called back' });
assert.equal(r.body.note, 'Called back');
assert.equal(r.body.status, 'won', 'note-only patch keeps status');
r = await call('PATCH', `/api/leads/${lead.id}`, { status: 'contacted', note: 'Both' });
assert.equal(r.body.status, 'contacted');
assert.equal(r.body.note, 'Both');
assert.equal((await call('PATCH', `/api/leads/${lead.id}`, { status: 'maybe' })).status, 400);
assert.equal((await call('PATCH', `/api/leads/${lead.id}`, {})).status, 400);

r = await call('GET', `/api/leads?status=contacted&category=${lead.category}`);
assert.ok(r.body.leads.some((l) => l.id === lead.id));
assert.ok(r.body.leads.every((l) => l.status === 'contacted' && l.category === lead.category));
r = await call('GET', '/api/leads?status=foo');
assert.equal(r.status, 200);
assert.deepEqual(r.body.leads, [], 'unknown filter matches nothing');
r = await call('POST', '/api/leads', { ...good, phone: '0917 123 4567 ext 2' }, {});
assert.equal(r.status, 201, 'free-form phone is accepted');
r = await call('GET', '/api/leads?status=new');
assert.ok(r.body.leads.every((l) => l.status === 'new') && !r.body.leads.some((l) => l.id === lead.id));

console.log('All checks passed against', BASE);
