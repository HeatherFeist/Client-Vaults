# Client Vaults

An **Obsidian-style app for managing your clients.** Every client gets their own
private *vault* — a folder of notes holding their business profile, lead-generation
plan, and marketing funnel content — plus a place to store their estimates,
agreements, and important documents.

It comes with two superpowers:

- 🤖 **An AI agent.** Type a plain-English request like *"Add a new client, Bob's
  Bakery — a local bakery in Denver — and build them a 30-day lead-generation plan
  and funnel content"* and it creates the client and writes the content straight
  into their vault.
- 🔑 **Client access codes.** Each client gets a private code. They can log in to a
  read-only portal that shows **only their own vault** — never anyone else's — where
  they can read their notes, download their documents, and **e-sign** estimates and
  agreements.

---

## What's inside a vault

Each client's vault starts with four notes and grows from there:

| Note | What it's for |
|------|----------------|
| `Profile.md` | Business profile, goals, target audience |
| `Lead Generation Plan.md` | Channels, offer, and a 30-day action plan |
| `Funnel Content.md` | Awareness → nurture → conversion content |
| `Notes.md` | Meeting notes, ideas, reminders |

Notes are written and kept as plain **Markdown**, stored in your **Supabase**
database (see [Where your data lives](#where-your-data-lives) below). The
[Obsidian](https://obsidian.md)-style feel — a per-client vault of linked
Markdown notes — is the way you work with them here; if you also want to open
your notes inside the Obsidian app itself, see the note in that section.

Documents (PDFs, Word docs, images, spreadsheets, etc.) are stored per client in
Supabase Storage and can be signed by the client from their portal.

---

## Getting started

You'll need [Node.js](https://nodejs.org) version 20 or newer, and a free
**Supabase** project for storage (setup below — about 5 minutes).

```bash
# 1. Install the app's dependencies
npm install

# 2. Set up your settings file
cp .env.example .env
#    Then open .env and fill in your Supabase details (required — see
#    "Set up storage" below) and your Anthropic API key (for the AI agent).

# 3. Start the app
npm start
```

Then open **http://localhost:3000** in your browser.

- **Owner dashboard** (you): http://localhost:3000/
- **Client portal** (your clients): http://localhost:3000/portal.html

---

## Set up storage (Supabase)

Client Vaults keeps your clients, notes, documents, and signatures in
[Supabase](https://supabase.com) (a hosted database with file storage). It has a
free tier that's plenty for this.

1. Create a free account and a **new project** at <https://supabase.com>.
2. In your project, open **SQL Editor → New query**, paste in the contents of
   [`supabase/schema.sql`](supabase/schema.sql) from this repo, and click **Run**.
   That creates the tables and a private `documents` storage bucket.
3. Open **Project Settings → API** and copy two values into your `.env`:
   ```
   SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```
   Use the **`service_role`** key (not the `anon` key). It's a secret with full
   access — keep it server-side only, never in the browser or in git. The
   `.gitignore` already excludes your `.env` file.
4. Restart the app. The startup log will show `Storage: Supabase (connected)`.

---

## Setting up the AI agent

The agent uses Claude. To turn it on:

1. Get an API key from <https://console.anthropic.com/> → **API Keys**.
2. Open the `.env` file and paste it in:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Restart the app (`Ctrl+C`, then `npm start`).

The top-right corner of the dashboard shows a green dot when the agent is ready.

If your account uses a different Claude model, change `AGENT_MODEL` in `.env`.

**Things you can ask the agent:**

- *"Add a new client, Sunrise Yoga, a boutique yoga studio, and build them a
  lead-generation plan."*
- *"Write a 5-email welcome sequence for this client and save it as Email Sequence.md."*
- *"Sharpen this client's profile with a stronger positioning statement."*

When you're viewing a specific client, the agent automatically works on *that*
client's vault.

---

## How your clients use it

1. In the dashboard, open a client and copy their **access code** (e.g. `BRAVE-OTTER-7413`).
2. Send them the portal link (`/portal.html`) and their code.
3. They enter the code and see **only their vault** — notes to read, documents to
   download, and a **Sign** button on any document that needs their signature.

When a client signs, the app records who signed, the date and time, their IP
address, and their drawn signature image. You can view that record from the
document list in the dashboard.

---

## Where your data lives

Everything is stored in your **Supabase** project:

```
clients      (table)    ← the list of clients + their access codes
notes        (table)    ← each client's notes, as Markdown (one row per note)
documents    (table)    ← metadata for each uploaded file
signatures   (table)    ← e-signature records
Storage bucket "documents"  ← the actual document files
```

Because it's hosted, your data **persists across restarts and redeploys**, and
Supabase handles backups on its side. Nothing sensitive is stored in this repo
or in git.

**Want to open your notes in the Obsidian app?** Since notes now live in the
database rather than as loose files, they aren't a folder you can point Obsidian
at directly. Two options if you want that: (a) run a small export that writes the
`notes` rows out to `.md` files in an Obsidian vault folder, or (b) use Claude
inside Obsidian via a community plugin (e.g. *Copilot for Obsidian*). Ask and we
can add an export command.

---

## Protecting the dashboard

While you're testing on your own computer, the dashboard is open. Before you host
it anywhere other people could reach, set an owner password in `.env`:

```
OWNER_PASSWORD=something-only-you-know
```

The dashboard will then ask for that password before showing your clients. (Client
access codes protect the client portal separately.)

---

## Put it online (deploy to Render)

Client Vaults is a small **Node.js server**, so it needs a host that runs a
server — not a static-site host like Netlify or GitHub Pages (those only serve
plain files and can't run the app's `/api` engine or the AI agent). The easiest
fit is **[Render](https://render.com)**, and this repo already includes a
`render.yaml` blueprint so it deploys in a few clicks.

1. Set up your **Supabase** project first (see [Set up storage](#set-up-storage-supabase)
   above) — you'll need its URL and service_role key.
2. Push this project to GitHub (already done if you're reading this there).
3. Create a free account at <https://render.com> and connect your GitHub.
4. In Render, click **New +  →  Blueprint**, choose this repository, and click
   **Apply**. Render reads `render.yaml` and sets everything up.
5. When prompted, fill in the secret values:
   - **`SUPABASE_URL`** and **`SUPABASE_SERVICE_ROLE_KEY`** — from your Supabase
     project (Project Settings → API). Required for storage.
   - **`ANTHROPIC_API_KEY`** — your key from <https://console.anthropic.com/>
     (needed only for the AI agent; the app runs without it).
   - **`OWNER_PASSWORD`** — a password of your choice. **Set this** — otherwise
     anyone with the link can see your clients and use the agent.
6. Wait for the first deploy to finish, then open the URL Render gives you
   (something like `https://client-vaults.onrender.com`).

Because storage lives in Supabase, your client data **persists across deploys** —
nothing resets when Render restarts or redeploys the app.

**One thing to know about the free plan:** the app **goes to sleep after ~15
minutes** of no visitors. The next visit wakes it up and takes about 50 seconds
to load — after that it's fast again. Upgrading to Render's paid **Starter** plan
(change `plan: free` to `plan: starter` in `render.yaml`) keeps it always on.

---

## Roadmap / ideas for later

This is a working first version (an MVP). Natural next steps:

- **Stronger sign-in** for you (email + password, or single sign-on).
- **Notarized-grade e-signatures** by integrating a dedicated provider (e.g. DocuSign)
  when you need legally certified signing with a formal audit certificate.
- **Client-side search** across all vaults, tags, and links between notes (true
  Obsidian-style graph).

---

## Tech notes (for a developer)

- Node.js + Express 5 server (`src/server.js`)
- Supabase storage layer (`src/store.js`, client in `src/supabase.js`) —
  Postgres tables + a Storage bucket; schema in `supabase/schema.sql`
- AI agent via the Anthropic SDK with tool-use (`src/agent.js`)
- Vanilla HTML/CSS/JS front end (`public/`)
- File uploads via `multer`; Markdown rendered with `marked`

Run in auto-reload mode while developing with `npm run dev`.
