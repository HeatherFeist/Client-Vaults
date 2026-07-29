// store.js
// -----------------------------------------------------------------------------
// The data layer for Client Vaults.
//
// Two things live on disk:
//   1. data/clients.json  -> the registry of clients (name, business, access code)
//   2. vaults/<clientId>/ -> each client's vault: a folder of Markdown (.md) notes,
//                            exactly like an Obsidian vault.
//
// Keeping the notes as plain Markdown files means you can open the `vaults/`
// folder in Obsidian itself and everything just works.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
// Where the writable client data lives. Defaults to the project folder, but can
// be pointed at a persistent disk in hosting (e.g. Render) by setting DATA_ROOT.
// This keeps `data/` and `vaults/` together so a single mounted disk covers both.
const STORAGE_ROOT = process.env.DATA_ROOT ? path.resolve(process.env.DATA_ROOT) : ROOT;
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
const VAULTS_DIR = path.join(STORAGE_ROOT, 'vaults');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');

// --- small helpers -----------------------------------------------------------

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(VAULTS_DIR, { recursive: true });
  if (!fs.existsSync(CLIENTS_FILE)) {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify({ clients: [] }, null, 2));
  }
}

function readRegistry() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
  } catch {
    return { clients: [] };
  }
}

function writeRegistry(reg) {
  ensureDirs();
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(reg, null, 2));
}

// Turn "Bob's Bakery" into "bobs-bakery" for use as a folder name / id.
function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/['".]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'client';
}

// A friendly, hard-to-guess access code like "BRAVE-OTTER-7413".
const CODE_WORDS = [
  'BRAVE', 'OTTER', 'MAPLE', 'RIVER', 'AMBER', 'CEDAR', 'FALCON', 'LUNAR',
  'CORAL', 'DELTA', 'EMBER', 'FLINT', 'GROVE', 'HAVEN', 'IVORY', 'JASPER',
  'KAYAK', 'LOTUS', 'MESA', 'NOVA', 'ONYX', 'PRISM', 'QUARTZ', 'RAVEN',
  'SABLE', 'TIDAL', 'UMBER', 'VERVE', 'WILLOW', 'XENON', 'YONDER', 'ZEPHYR',
];

function generateAccessCode() {
  const w = () => CODE_WORDS[crypto.randomInt(CODE_WORDS.length)];
  const n = crypto.randomInt(1000, 10000);
  return `${w()}-${w()}-${n}`;
}

// Keep note filenames safe: no path traversal, always ends in exactly ".md".
function safeNoteName(name) {
  let base = path.basename(String(name || '')).trim();
  base = base.replace(/\.md$/i, '');                 // drop the extension if given
  base = base.replace(/[^a-zA-Z0-9 _-]/g, '').trim(); // then sanitize the stem
  if (!base) return null;
  return `${base}.md`;
}

function vaultDir(clientId) {
  return path.join(VAULTS_DIR, path.basename(clientId));
}

function docsDir(clientId) {
  return path.join(vaultDir(clientId), 'documents');
}

// Documents keep their real extension (unlike notes), so sanitize but preserve
// the dot before the extension. No path separators survive path.basename().
function safeFileName(name) {
  const base = path.basename(String(name || '')).replace(/[^a-zA-Z0-9 ._()+-]/g, '').replace(/^\.+/, '').trim();
  return base || null;
}

// --- clients -----------------------------------------------------------------

function listClients() {
  return readRegistry().clients;
}

function getClient(id) {
  return readRegistry().clients.find((c) => c.id === id) || null;
}

function getClientByCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  return readRegistry().clients.find((c) => c.accessCode === normalized) || null;
}

function createClient({ name, business, contactEmail, contactPhone, notes }) {
  if (!name || !String(name).trim()) throw new Error('A client name is required.');

  const reg = readRegistry();

  // Ensure a unique id even if two clients share a name.
  let id = slugify(name);
  let suffix = 2;
  while (reg.clients.some((c) => c.id === id)) {
    id = `${slugify(name)}-${suffix++}`;
  }

  const client = {
    id,
    name: String(name).trim(),
    business: (business || '').trim(),
    contactEmail: (contactEmail || '').trim(),
    contactPhone: (contactPhone || '').trim(),
    accessCode: generateAccessCode(),
    createdAt: new Date().toISOString(),
  };

  reg.clients.push(client);
  writeRegistry(reg);

  // Seed the vault with a starter set of notes.
  fs.mkdirSync(vaultDir(id), { recursive: true });
  seedVault(client, notes);

  return client;
}

function deleteClient(id) {
  const reg = readRegistry();
  const before = reg.clients.length;
  reg.clients = reg.clients.filter((c) => c.id !== id);
  writeRegistry(reg);
  // Remove the vault folder too.
  const dir = vaultDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return reg.clients.length < before;
}

// --- vault notes -------------------------------------------------------------

function listNotes(clientId) {
  const dir = vaultDir(clientId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, updatedAt: stat.mtime.toISOString(), size: stat.size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readNote(clientId, noteName) {
  const safe = safeNoteName(noteName);
  if (!safe) return null;
  const file = path.join(vaultDir(clientId), safe);
  if (!fs.existsSync(file)) return null;
  return { name: safe, content: fs.readFileSync(file, 'utf8') };
}

function writeNote(clientId, noteName, content) {
  const safe = safeNoteName(noteName);
  if (!safe) throw new Error('Invalid note name.');
  const dir = vaultDir(clientId);
  if (!fs.existsSync(dir)) throw new Error('That client vault does not exist.');
  fs.writeFileSync(path.join(dir, safe), content ?? '');
  return { name: safe };
}

function appendNote(clientId, noteName, content) {
  const existing = readNote(clientId, noteName);
  const joined = existing ? `${existing.content.replace(/\s*$/, '')}\n\n${content}\n` : `${content}\n`;
  return writeNote(clientId, noteName, joined);
}

function deleteNote(clientId, noteName) {
  const safe = safeNoteName(noteName);
  if (!safe) return false;
  const file = path.join(vaultDir(clientId), safe);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

// --- documents (estimates, agreements, PDFs, images, etc.) -------------------

function listDocuments(clientId) {
  const dir = docsDir(clientId);
  if (!fs.existsSync(dir)) return [];
  const sigs = getSignatures(clientId);
  return fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      const sig = sigs[f];
      return {
        name: f,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        // A light summary only — the signature image is fetched separately.
        signature: sig ? { signerName: sig.signerName, signedAt: sig.signedAt } : null,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// --- e-signatures ------------------------------------------------------------
// Signatures are recorded in vaults/<clientId>/signatures.json, keyed by the
// document filename. Each record captures who signed, when, from where, and the
// drawn signature image — a simple but auditable acknowledgement trail.

function signaturesFile(clientId) {
  return path.join(vaultDir(clientId), 'signatures.json');
}

function getSignatures(clientId) {
  const file = signaturesFile(clientId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function getSignature(clientId, docName) {
  const safe = safeFileName(docName);
  if (!safe) return null;
  return getSignatures(clientId)[safe] || null;
}

function signDocument(clientId, docName, { signerName, signatureImage, ip, userAgent }) {
  if (!documentPath(clientId, docName)) throw new Error('That document does not exist.');
  if (!signerName || !String(signerName).trim()) throw new Error('A signer name is required.');
  const safe = safeFileName(docName);
  const record = {
    document: safe,
    signerName: String(signerName).trim(),
    signatureImage: signatureImage || null,
    signedAt: new Date().toISOString(),
    ip: ip || null,
    userAgent: userAgent || null,
  };
  const sigs = getSignatures(clientId);
  sigs[safe] = record;
  fs.writeFileSync(signaturesFile(clientId), JSON.stringify(sigs, null, 2));
  return { document: safe, signerName: record.signerName, signedAt: record.signedAt };
}

function saveDocument(clientId, originalName, buffer) {
  if (!getClient(clientId)) throw new Error('That client does not exist.');
  let safe = safeFileName(originalName);
  if (!safe) throw new Error('Invalid file name.');
  const dir = docsDir(clientId);
  fs.mkdirSync(dir, { recursive: true });

  // Avoid overwriting an existing document with the same name.
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  let candidate = safe;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem} (${n++})${ext}`;
  }
  fs.writeFileSync(path.join(dir, candidate), buffer);
  return { name: candidate };
}

// Returns an absolute path only if the resolved file is safely inside the
// client's documents folder; otherwise null.
function documentPath(clientId, name) {
  const safe = safeFileName(name);
  if (!safe) return null;
  const dir = docsDir(clientId);
  const full = path.join(dir, safe);
  if (path.relative(dir, full).startsWith('..')) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

function deleteDocument(clientId, name) {
  const full = documentPath(clientId, name);
  if (!full) return false;
  fs.rmSync(full);
  return true;
}

// --- starter content ---------------------------------------------------------

function seedVault(client, extraNotes) {
  const today = new Date().toISOString().slice(0, 10);

  writeNote(client.id, 'Profile.md', [
    `# ${client.name} — Business Profile`,
    '',
    `- **Business:** ${client.business || '_add a short description_'}`,
    `- **Contact email:** ${client.contactEmail || '_add_'}`,
    `- **Contact phone:** ${client.contactPhone || '_add_'}`,
    `- **Client since:** ${today}`,
    '',
    '## About the business',
    extraNotes ? extraNotes : '_What do they do? Who do they serve? What makes them different?_',
    '',
    '## Goals',
    '- _e.g. Book 10 discovery calls per month_',
    '',
    '## Target audience',
    '- _Who is the ideal customer?_',
    '',
  ].join('\n'));

  writeNote(client.id, 'Lead Generation Plan.md', [
    `# Lead Generation Plan — ${client.name}`,
    '',
    '_Ask the AI agent to build this out, or edit it yourself._',
    '',
    '## Channels',
    '## Offer',
    '## 30-day action plan',
    '',
  ].join('\n'));

  writeNote(client.id, 'Funnel Content.md', [
    `# Funnel Content — ${client.name}`,
    '',
    '_Top-of-funnel awareness → middle-of-funnel nurture → bottom-of-funnel conversion._',
    '',
    '## Awareness (TOFU)',
    '## Nurture (MOFU)',
    '## Conversion (BOFU)',
    '',
  ].join('\n'));

  writeNote(client.id, 'Notes.md', `# Notes — ${client.name}\n\n_Meeting notes, ideas, and reminders._\n`);
}

module.exports = {
  ROOT,
  VAULTS_DIR,
  slugify,
  safeNoteName,
  listClients,
  getClient,
  getClientByCode,
  createClient,
  deleteClient,
  listNotes,
  readNote,
  writeNote,
  appendNote,
  deleteNote,
  listDocuments,
  saveDocument,
  documentPath,
  deleteDocument,
  getSignature,
  signDocument,
  generateAccessCode,
};
