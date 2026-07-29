// store.js
// -----------------------------------------------------------------------------
// The data layer for Client Vaults, backed by Supabase.
//
//   Postgres tables (see supabase/schema.sql):
//     clients     -> the registry of clients (name, business, access code)
//     notes       -> each client's Markdown notes (one row per note)
//     documents   -> metadata for each uploaded file (the bytes live in Storage)
//     signatures  -> the e-signature audit trail, one row per signed document
//
//   Supabase Storage:
//     bucket "documents", files stored at "<clientId>/<filename>"
//
// Every function here is async (it talks to Supabase over the network). The
// public function names and their return shapes are kept identical to the
// original file-based store, so the server and front end are unaffected.
// -----------------------------------------------------------------------------

const path = require('path');
const crypto = require('crypto');
const { supabase, isConfigured, BUCKET } = require('./supabase');

// The project root, still used by the server to locate /public and the .env file.
const ROOT = path.resolve(__dirname, '..');

// --- error helpers -----------------------------------------------------------

// A validation-style error -> HTTP 400.
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Wrap a Supabase error into a plain Error (surfaced as HTTP 500 by default).
function dbError(error) {
  const err = new Error(error && error.message ? error.message : 'Storage error.');
  err.status = error && error.status ? error.status : 500;
  err.code = error && error.code ? error.code : null;
  return err;
}

// --- small helpers -----------------------------------------------------------

// Turn "Bob's Bakery" into "bobs-bakery" for use as a client id.
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

// Documents keep their real extension (unlike notes), so sanitize but preserve
// the dot before the extension. No path separators survive path.basename().
function safeFileName(name) {
  const base = path.basename(String(name || '')).replace(/[^a-zA-Z0-9 ._()+-]/g, '').replace(/^\.+/, '').trim();
  return base || null;
}

// A small filename -> MIME type lookup so downloaded documents open correctly.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

function mimeFromName(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// --- row <-> app-object mapping ----------------------------------------------

function rowToClient(row) {
  return {
    id: row.id,
    name: row.name,
    business: row.business || '',
    contactEmail: row.contact_email || '',
    contactPhone: row.contact_phone || '',
    accessCode: row.access_code,
    createdAt: row.created_at,
  };
}

function rowToSignature(row) {
  return {
    document: row.document_name,
    signerName: row.signer_name,
    signatureImage: row.signature_image || null,
    signedAt: row.signed_at,
    ip: row.ip || null,
    userAgent: row.user_agent || null,
  };
}

// --- clients -----------------------------------------------------------------

async function listClients() {
  const { data, error } = await supabase()
    .from('clients')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw dbError(error);
  return (data || []).map(rowToClient);
}

async function getClient(id) {
  if (!id) return null;
  const { data, error } = await supabase().from('clients').select('*').eq('id', id).maybeSingle();
  if (error) throw dbError(error);
  return data ? rowToClient(data) : null;
}

async function getClientByCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  const { data, error } = await supabase()
    .from('clients')
    .select('*')
    .eq('access_code', normalized)
    .maybeSingle();
  if (error) throw dbError(error);
  return data ? rowToClient(data) : null;
}

async function createClient({ name, business, contactEmail, contactPhone, notes } = {}) {
  if (!name || !String(name).trim()) throw badRequest('A client name is required.');

  // Ensure a unique id even if two clients share a name.
  const base = slugify(name);
  let id = base;
  let suffix = 2;
  while (await getClient(id)) {
    id = `${base}-${suffix++}`;
  }

  // Insert, regenerating the access code in the rare event of a collision.
  let inserted = null;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    const row = {
      id,
      name: String(name).trim(),
      business: (business || '').trim(),
      contact_email: (contactEmail || '').trim(),
      contact_phone: (contactPhone || '').trim(),
      access_code: generateAccessCode(),
    };
    const { data, error } = await supabase().from('clients').insert(row).select().single();
    if (!error) {
      inserted = data;
      break;
    }
    // 23505 = unique_violation; only retry when it's the access code that clashed.
    if (error.code === '23505' && attempt < 4) continue;
    throw dbError(error);
  }

  const client = rowToClient(inserted);
  await seedVault(client, notes);
  return client;
}

async function deleteClient(id) {
  const existing = await getClient(id);
  if (!existing) return false;
  // Remove the client's document files from Storage first (rows cascade on delete).
  await removeAllDocumentFiles(id);
  const { error } = await supabase().from('clients').delete().eq('id', id);
  if (error) throw dbError(error);
  return true;
}

// --- vault notes -------------------------------------------------------------

async function listNotes(clientId) {
  const { data, error } = await supabase()
    .from('notes')
    .select('name, content, updated_at')
    .eq('client_id', clientId);
  if (error) throw dbError(error);
  return (data || [])
    .map((n) => ({
      name: n.name,
      updatedAt: n.updated_at,
      size: Buffer.byteLength(n.content || '', 'utf8'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function readNote(clientId, noteName) {
  const safe = safeNoteName(noteName);
  if (!safe) return null;
  const { data, error } = await supabase()
    .from('notes')
    .select('name, content')
    .eq('client_id', clientId)
    .eq('name', safe)
    .maybeSingle();
  if (error) throw dbError(error);
  return data ? { name: data.name, content: data.content || '' } : null;
}

async function writeNote(clientId, noteName, content) {
  const safe = safeNoteName(noteName);
  if (!safe) throw badRequest('Invalid note name.');
  if (!(await getClient(clientId))) throw badRequest('That client vault does not exist.');
  const { error } = await supabase()
    .from('notes')
    .upsert(
      { client_id: clientId, name: safe, content: content ?? '', updated_at: new Date().toISOString() },
      { onConflict: 'client_id,name' }
    );
  if (error) throw dbError(error);
  return { name: safe };
}

async function appendNote(clientId, noteName, content) {
  const existing = await readNote(clientId, noteName);
  const joined = existing ? `${existing.content.replace(/\s*$/, '')}\n\n${content}\n` : `${content}\n`;
  return writeNote(clientId, noteName, joined);
}

async function deleteNote(clientId, noteName) {
  const safe = safeNoteName(noteName);
  if (!safe) return false;
  const { data, error } = await supabase()
    .from('notes')
    .delete()
    .eq('client_id', clientId)
    .eq('name', safe)
    .select('name');
  if (error) throw dbError(error);
  return Boolean(data && data.length);
}

// --- documents (estimates, agreements, PDFs, images, etc.) -------------------
// Metadata lives in the `documents` table; the bytes live in the Storage bucket.

async function listDocuments(clientId) {
  const { data, error } = await supabase()
    .from('documents')
    .select('name, size, updated_at')
    .eq('client_id', clientId)
    .order('updated_at', { ascending: false });
  if (error) throw dbError(error);
  const sigs = await getSignaturesMap(clientId);
  return (data || []).map((d) => {
    const sig = sigs[d.name];
    return {
      name: d.name,
      size: d.size,
      updatedAt: d.updated_at,
      // A light summary only — the signature image is fetched separately.
      signature: sig ? { signerName: sig.signerName, signedAt: sig.signedAt } : null,
    };
  });
}

async function getDocumentRow(clientId, name) {
  const safe = safeFileName(name);
  if (!safe) return null;
  const { data, error } = await supabase()
    .from('documents')
    .select('*')
    .eq('client_id', clientId)
    .eq('name', safe)
    .maybeSingle();
  if (error) throw dbError(error);
  return data || null;
}

async function saveDocument(clientId, originalName, buffer) {
  if (!(await getClient(clientId))) throw badRequest('That client does not exist.');
  let safe = safeFileName(originalName);
  if (!safe) throw badRequest('Invalid file name.');

  // Avoid overwriting an existing document with the same name.
  const existing = await listDocuments(clientId);
  const taken = new Set(existing.map((d) => d.name));
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  let candidate = safe;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${stem} (${n++})${ext}`;
  }

  const storagePath = `${clientId}/${candidate}`;
  const contentType = mimeFromName(candidate);

  const { error: upErr } = await supabase()
    .storage.from(BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: false });
  if (upErr) throw dbError(upErr);

  const { error: insErr } = await supabase().from('documents').insert({
    client_id: clientId,
    name: candidate,
    size: buffer.length,
    content_type: contentType,
    storage_path: storagePath,
  });
  if (insErr) {
    // Roll back the uploaded file so we don't leave an orphan in Storage.
    await supabase().storage.from(BUCKET).remove([storagePath]);
    throw dbError(insErr);
  }
  return { name: candidate };
}

// Fetch a document's bytes for download. Returns { name, contentType, buffer }
// or null if it doesn't exist.
async function getDocumentData(clientId, name) {
  const row = await getDocumentRow(clientId, name);
  if (!row) return null;
  const { data: blob, error } = await supabase().storage.from(BUCKET).download(row.storage_path);
  if (error) throw dbError(error);
  const buffer = Buffer.from(await blob.arrayBuffer());
  return { name: row.name, contentType: row.content_type || 'application/octet-stream', buffer };
}

async function deleteDocument(clientId, name) {
  const row = await getDocumentRow(clientId, name);
  if (!row) return false;
  await supabase().storage.from(BUCKET).remove([row.storage_path]);
  const { error } = await supabase().from('documents').delete().eq('id', row.id);
  if (error) throw dbError(error);
  // Drop any signature tied to this document.
  await supabase().from('signatures').delete().eq('client_id', clientId).eq('document_name', row.name);
  return true;
}

// Remove every document file for a client from Storage (used when deleting a client).
async function removeAllDocumentFiles(clientId) {
  const { data, error } = await supabase()
    .from('documents')
    .select('storage_path')
    .eq('client_id', clientId);
  if (error) throw dbError(error);
  const paths = (data || []).map((d) => d.storage_path).filter(Boolean);
  if (paths.length) await supabase().storage.from(BUCKET).remove(paths);
}

// --- e-signatures ------------------------------------------------------------
// One row per signed document in the `signatures` table: who signed, when, from
// where, and the drawn signature image — a simple but auditable trail.

async function getSignaturesMap(clientId) {
  const { data, error } = await supabase().from('signatures').select('*').eq('client_id', clientId);
  if (error) throw dbError(error);
  const map = {};
  for (const row of data || []) map[row.document_name] = rowToSignature(row);
  return map;
}

async function getSignature(clientId, docName) {
  const safe = safeFileName(docName);
  if (!safe) return null;
  const { data, error } = await supabase()
    .from('signatures')
    .select('*')
    .eq('client_id', clientId)
    .eq('document_name', safe)
    .maybeSingle();
  if (error) throw dbError(error);
  return data ? rowToSignature(data) : null;
}

async function signDocument(clientId, docName, { signerName, signatureImage, ip, userAgent }) {
  const row = await getDocumentRow(clientId, docName);
  if (!row) throw badRequest('That document does not exist.');
  if (!signerName || !String(signerName).trim()) throw badRequest('A signer name is required.');
  const record = {
    client_id: clientId,
    document_name: row.name,
    signer_name: String(signerName).trim(),
    signature_image: signatureImage || null,
    signed_at: new Date().toISOString(),
    ip: ip || null,
    user_agent: userAgent || null,
  };
  const { error } = await supabase()
    .from('signatures')
    .upsert(record, { onConflict: 'client_id,document_name' });
  if (error) throw dbError(error);
  return { document: row.name, signerName: record.signer_name, signedAt: record.signed_at };
}

// --- starter content ---------------------------------------------------------

async function seedVault(client, extraNotes) {
  const today = new Date().toISOString().slice(0, 10);

  await writeNote(client.id, 'Profile.md', [
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

  await writeNote(client.id, 'Lead Generation Plan.md', [
    `# Lead Generation Plan — ${client.name}`,
    '',
    '_Ask the AI agent to build this out, or edit it yourself._',
    '',
    '## Channels',
    '## Offer',
    '## 30-day action plan',
    '',
  ].join('\n'));

  await writeNote(client.id, 'Funnel Content.md', [
    `# Funnel Content — ${client.name}`,
    '',
    '_Top-of-funnel awareness → middle-of-funnel nurture → bottom-of-funnel conversion._',
    '',
    '## Awareness (TOFU)',
    '## Nurture (MOFU)',
    '## Conversion (BOFU)',
    '',
  ].join('\n'));

  await writeNote(client.id, 'Notes.md', `# Notes — ${client.name}\n\n_Meeting notes, ideas, and reminders._\n`);
}

module.exports = {
  ROOT,
  isConfigured,
  slugify,
  safeNoteName,
  generateAccessCode,
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
  getDocumentData,
  deleteDocument,
  getSignature,
  signDocument,
};
