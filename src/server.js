// server.js
// -----------------------------------------------------------------------------
// The web server. It serves the UI (in /public) and a small JSON API:
//
//   Owner side (managing all clients):
//     GET    /api/clients                       list clients
//     POST   /api/clients                       create a client
//     DELETE /api/clients/:id                   remove a client + vault
//     GET    /api/clients/:id/notes             list notes in a vault
//     GET    /api/clients/:id/notes/:name       read one note (raw + rendered)
//     PUT    /api/clients/:id/notes/:name       save one note
//     DELETE /api/clients/:id/notes/:name       delete one note
//     POST   /api/agent                         run the AI agent
//
//   Client side (a client viewing only their own vault, via access code):
//     POST   /api/portal/login                  exchange access code for client info
//     GET    /api/portal/:code/notes            list that client's notes
//     GET    /api/portal/:code/notes/:name      read one note (rendered, read-only)
//
// Data is stored in Supabase (see src/store.js). Route handlers are async and
// let rejected promises bubble to the JSON error handler at the bottom (a
// feature of Express 5), so storage errors return a clean message.
// -----------------------------------------------------------------------------

const path = require('path');
const express = require('express');
const multer = require('multer');
const { marked } = require('marked');
const store = require('./store');
const { runAgent, MODEL } = require('./agent');

// Uploaded documents are held in memory then written into Supabase Storage.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Load .env if present (no dependency needed — tiny hand-rolled parser).
loadDotEnv();

const app = express();
app.use(express.json({ limit: '6mb' })); // roomy enough for a drawn signature image
app.use(express.static(path.join(store.ROOT, 'public')));

const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';

// --- owner auth (optional) ---------------------------------------------------
// If OWNER_PASSWORD is set, owner routes require an "x-owner-key" header that
// matches it. If it's blank (e.g. while testing locally), owner routes are open.
function requireOwner(req, res, next) {
  if (!OWNER_PASSWORD) return next();
  if (req.get('x-owner-key') === OWNER_PASSWORD) return next();
  return res.status(401).json({ error: 'Owner password required or incorrect.' });
}

// Send a document's bytes as a browser download.
function sendDocument(res, doc) {
  const safeName = doc.name.replace(/["\\]/g, '');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Content-Type', doc.contentType || 'application/octet-stream');
  res.send(doc.buffer);
}

// Tells the UI whether a password is needed, without revealing it.
app.get('/api/config', (req, res) => {
  res.json({
    ownerProtected: Boolean(OWNER_PASSWORD),
    agentModel: MODEL,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    storageConfigured: store.isConfigured(),
  });
});

app.post('/api/owner/check', (req, res) => {
  if (!OWNER_PASSWORD) return res.json({ ok: true });
  res.json({ ok: req.body && req.body.password === OWNER_PASSWORD });
});

// --- owner: clients ----------------------------------------------------------

app.get('/api/clients', requireOwner, async (req, res) => {
  res.json({ clients: await store.listClients() });
});

app.post('/api/clients', requireOwner, async (req, res) => {
  const client = await store.createClient(req.body || {});
  res.status(201).json({ client });
});

app.delete('/api/clients/:id', requireOwner, async (req, res) => {
  const ok = await store.deleteClient(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Client not found.' });
  res.json({ ok: true });
});

// --- owner: notes ------------------------------------------------------------

app.get('/api/clients/:id/notes', requireOwner, async (req, res) => {
  if (!(await store.getClient(req.params.id))) return res.status(404).json({ error: 'Client not found.' });
  res.json({ notes: await store.listNotes(req.params.id) });
});

app.get('/api/clients/:id/notes/:name', requireOwner, async (req, res) => {
  const note = await store.readNote(req.params.id, req.params.name);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  res.json({ name: note.name, content: note.content, html: marked.parse(note.content) });
});

app.put('/api/clients/:id/notes/:name', requireOwner, async (req, res) => {
  if (!(await store.getClient(req.params.id))) return res.status(404).json({ error: 'Client not found.' });
  const result = await store.writeNote(req.params.id, req.params.name, (req.body && req.body.content) || '');
  res.json({ ok: true, name: result.name });
});

app.delete('/api/clients/:id/notes/:name', requireOwner, async (req, res) => {
  const ok = await store.deleteNote(req.params.id, req.params.name);
  if (!ok) return res.status(404).json({ error: 'Note not found.' });
  res.json({ ok: true });
});

// --- owner: documents (estimates, agreements, files) -------------------------

app.get('/api/clients/:id/documents', requireOwner, async (req, res) => {
  if (!(await store.getClient(req.params.id))) return res.status(404).json({ error: 'Client not found.' });
  res.json({ documents: await store.listDocuments(req.params.id) });
});

app.post('/api/clients/:id/documents', requireOwner, upload.single('file'), async (req, res) => {
  if (!(await store.getClient(req.params.id))) return res.status(404).json({ error: 'Client not found.' });
  if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
  const saved = await store.saveDocument(req.params.id, req.file.originalname, req.file.buffer);
  res.status(201).json({ document: saved });
});

app.get('/api/clients/:id/documents/:name', requireOwner, async (req, res) => {
  const doc = await store.getDocumentData(req.params.id, req.params.name);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  sendDocument(res, doc);
});

app.delete('/api/clients/:id/documents/:name', requireOwner, async (req, res) => {
  const ok = await store.deleteDocument(req.params.id, req.params.name);
  if (!ok) return res.status(404).json({ error: 'Document not found.' });
  res.json({ ok: true });
});

// Owner views the full signature record (including the signature image) for a document.
app.get('/api/clients/:id/documents/:name/signature', requireOwner, async (req, res) => {
  const sig = await store.getSignature(req.params.id, req.params.name);
  if (!sig) return res.status(404).json({ error: 'No signature on file for this document.' });
  res.json({ signature: sig });
});

// --- owner: AI agent ---------------------------------------------------------

app.post('/api/agent', requireOwner, async (req, res) => {
  const prompt = req.body && req.body.prompt;
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: 'Please enter a prompt for the agent.' });
  }
  try {
    const result = await runAgent({ prompt: String(prompt), clientId: req.body.clientId || null });
    res.json(result);
  } catch (e) {
    const status = e.code === 'NO_API_KEY' ? 400 : 502;
    res.status(status).json({ error: e.message, code: e.code || null });
  }
});

// --- client portal (access-code protected) -----------------------------------

app.post('/api/portal/login', async (req, res) => {
  const client = await store.getClientByCode(req.body && req.body.code);
  if (!client) return res.status(401).json({ error: 'That access code was not recognized.' });
  res.json({ client: { id: client.id, name: client.name, business: client.business } });
});

async function resolvePortal(req, res, next) {
  try {
    const client = await store.getClientByCode(req.params.code);
    if (!client) return res.status(401).json({ error: 'Invalid access code.' });
    req.client = client;
    next();
  } catch (e) {
    next(e);
  }
}

app.get('/api/portal/:code/notes', resolvePortal, async (req, res) => {
  res.json({
    client: { name: req.client.name, business: req.client.business },
    notes: await store.listNotes(req.client.id),
  });
});

app.get('/api/portal/:code/notes/:name', resolvePortal, async (req, res) => {
  const note = await store.readNote(req.client.id, req.params.name);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  res.json({ name: note.name, html: marked.parse(note.content) });
});

// Clients can view and download their own documents (read-only).
app.get('/api/portal/:code/documents', resolvePortal, async (req, res) => {
  res.json({ documents: await store.listDocuments(req.client.id) });
});

app.get('/api/portal/:code/documents/:name', resolvePortal, async (req, res) => {
  const doc = await store.getDocumentData(req.client.id, req.params.name);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  sendDocument(res, doc);
});

// Client signs one of their documents (e-signature with audit trail).
app.post('/api/portal/:code/documents/:name/sign', resolvePortal, async (req, res) => {
  const record = await store.signDocument(req.client.id, req.params.name, {
    signerName: req.body && req.body.signerName,
    signatureImage: req.body && req.body.signatureImage,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.status(201).json({ signature: record });
});

// --- JSON error handler ------------------------------------------------------
// Express 5 forwards rejected promises from async handlers here, so any storage
// or validation error becomes a clean JSON response instead of a crash.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) console.error('Request failed:', err);
  res.status(status).json({ error: err.message || 'Something went wrong.', code: err.code || null });
});

// --- start -------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Client Vaults is running.`);
  console.log(`  Owner dashboard:  http://localhost:${PORT}/`);
  console.log(`  Client portal:    http://localhost:${PORT}/portal.html`);
  console.log(`  Storage:          ${store.isConfigured() ? 'Supabase (connected)' : 'NOT configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'}`);
  console.log(`  AI agent:         ${process.env.ANTHROPIC_API_KEY ? `enabled (model: ${MODEL})` : 'disabled — set ANTHROPIC_API_KEY'}\n`);
});

// --- tiny .env loader (avoids adding a dependency) ---------------------------
function loadDotEnv() {
  const fs = require('fs');
  const envPath = path.join(store.ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
