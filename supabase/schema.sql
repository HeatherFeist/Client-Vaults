-- Client Vaults — Supabase schema
-- =============================================================================
-- HOW TO USE:
--   1. Create a free project at https://supabase.com
--   2. In the project, open  SQL Editor → New query
--   3. Paste this entire file and click  Run
--   4. Then copy your Project URL and service_role key from
--        Project Settings → API
--      into the app's SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY settings.
--
-- Running this file again later is safe — it only creates things that are
-- missing (every statement uses "if not exists" / "on conflict do nothing").
-- =============================================================================

-- --- Tables ------------------------------------------------------------------

-- The registry of clients. `id` is a URL-safe slug like "bobs-bakery".
create table if not exists public.clients (
  id            text primary key,
  name          text not null,
  business      text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  access_code   text not null unique,
  created_at    timestamptz not null default now()
);

-- Each client's Markdown notes — one row per note (e.g. "Profile.md").
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null references public.clients(id) on delete cascade,
  name       text not null,
  content    text not null default '',
  updated_at timestamptz not null default now(),
  unique (client_id, name)
);

-- Metadata for each uploaded document. The file bytes live in Storage
-- (bucket "documents"); `storage_path` points at them.
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null references public.clients(id) on delete cascade,
  name         text not null,
  size         bigint not null default 0,
  content_type text not null default 'application/octet-stream',
  storage_path text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (client_id, name)
);

-- The e-signature audit trail — one row per signed document.
create table if not exists public.signatures (
  id              uuid primary key default gen_random_uuid(),
  client_id       text not null references public.clients(id) on delete cascade,
  document_name   text not null,
  signer_name     text not null,
  signature_image text,
  ip              text,
  user_agent      text,
  signed_at       timestamptz not null default now(),
  unique (client_id, document_name)
);

-- Helpful indexes for the "everything for one client" lookups the app does.
create index if not exists notes_client_idx      on public.notes (client_id);
create index if not exists documents_client_idx  on public.documents (client_id);
create index if not exists signatures_client_idx on public.signatures (client_id);

-- --- Security ----------------------------------------------------------------
-- The app talks to Supabase only from its own server, using the service_role
-- key, which bypasses Row Level Security. We enable RLS and add NO policies, so
-- the public "anon" key can't read or write any of this data. Keep the
-- service_role key server-side only (never in the browser, never in git).

alter table public.clients    enable row level security;
alter table public.notes      enable row level security;
alter table public.documents  enable row level security;
alter table public.signatures enable row level security;

-- --- Storage -----------------------------------------------------------------
-- A private bucket for client documents. The app reads/writes it with the
-- service_role key; it is not publicly accessible.

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;
