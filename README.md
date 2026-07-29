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

Notes are plain **Markdown files** stored in the `vaults/` folder, so you can even
open that folder directly in [Obsidian](https://obsidian.md) and everything works.

Documents (PDFs, Word docs, images, spreadsheets, etc.) live alongside each vault
and can be signed by the client from their portal.

---

## Getting started

You'll need [Node.js](https://nodejs.org) version 20 or newer installed.

```bash
# 1. Install the app's dependencies
npm install

# 2. Set up your settings file
cp .env.example .env
#    Then open .env and paste in your Anthropic API key (for the AI agent).

# 3. Start the app
npm start
```

Then open **http://localhost:3000** in your browser.

- **Owner dashboard** (you): http://localhost:3000/
- **Client portal** (your clients): http://localhost:3000/portal.html

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

Everything is stored as ordinary files on your computer:

```
data/clients.json        ← the list of clients + their access codes
vaults/<client>/*.md     ← that client's notes (Markdown, Obsidian-compatible)
vaults/<client>/documents/   ← that client's uploaded files
vaults/<client>/signatures.json  ← e-signature records
```

These files hold real client information, so they are **deliberately not committed
to git** (see `.gitignore`). Back up the `data/` and `vaults/` folders however you
normally back up your files.

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

1. Push this project to GitHub (already done if you're reading this there).
2. Create a free account at <https://render.com> and connect your GitHub.
3. In Render, click **New +  →  Blueprint**, choose this repository, and click
   **Apply**. Render reads `render.yaml` and sets everything up.
4. When prompted, fill in two values:
   - **`ANTHROPIC_API_KEY`** — your key from <https://console.anthropic.com/>
     (needed only for the AI agent; the app runs without it).
   - **`OWNER_PASSWORD`** — a password of your choice. **Set this** — otherwise
     anyone with the link can see your clients and use the agent.
5. Wait for the first deploy to finish, then open the URL Render gives you
   (something like `https://client-vaults.onrender.com`).

**Two things to know about the free plan:**

- The app **goes to sleep after ~15 minutes** of no visitors. The next visit
  wakes it up and takes about 50 seconds to load — after that it's fast again.
- Saved data (clients, notes, documents, signatures) **resets on each redeploy**,
  because the free plan has no permanent disk. That's fine for trying it out.

**To keep client data permanently:** open `render.yaml`, change `plan: free` to
`plan: starter` (a small paid tier), and uncomment the `disk:` block and the
`DATA_ROOT` variable at the bottom of the file. That mounts a permanent disk at
`/var/data`, and the app stores everything there so it survives redeploys.

---

## Roadmap / ideas for later

This is a working first version (an MVP). Natural next steps:

- **Host it online** so you and your clients can reach it from anywhere (e.g. Render,
  Railway, or a small VPS). This would also move storage to a hosted database.
- **Stronger sign-in** for you (email + password, or single sign-on).
- **Notarized-grade e-signatures** by integrating a dedicated provider (e.g. DocuSign)
  when you need legally certified signing with a formal audit certificate.
- **Client-side search** across all vaults, tags, and links between notes (true
  Obsidian-style graph).

---

## Tech notes (for a developer)

- Node.js + Express server (`src/server.js`)
- Filesystem storage layer (`src/store.js`) — no database required
- AI agent via the Anthropic SDK with tool-use (`src/agent.js`)
- Vanilla HTML/CSS/JS front end (`public/`)
- File uploads via `multer`; Markdown rendered with `marked`

Run in auto-reload mode while developing with `npm run dev`.
