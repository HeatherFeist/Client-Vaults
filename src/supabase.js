// supabase.js
// -----------------------------------------------------------------------------
// A single shared Supabase client for the whole app.
//
// The app runs entirely on the server, so it uses the *service role* key, which
// has full access and bypasses Row Level Security. That key must NEVER be sent
// to the browser or committed to git — it lives only in the server's env vars
// (locally in .env, in hosting as a secret). See .env.example / README.
// -----------------------------------------------------------------------------

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

// The Storage bucket that holds client documents. Must match the bucket created
// by supabase/schema.sql (default: "documents").
const BUCKET = process.env.SUPABASE_BUCKET || 'documents';

let _client = null;

// Returns true when the Supabase connection details are present.
function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

// Returns the shared client, creating it on first use. Throws a clear,
// user-friendly error (surfaced as HTTP 503) when storage isn't configured yet,
// so the app degrades gracefully instead of crashing.
function supabase() {
  if (!isConfigured()) {
    const err = new Error(
      'Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
        '(see .env.example), then restart the app.'
    );
    err.status = 503;
    err.code = 'NO_SUPABASE';
    throw err;
  }
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

module.exports = { supabase, isConfigured, BUCKET };
