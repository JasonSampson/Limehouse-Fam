# Limona — Staff Knowledge Base Chatbot

Limona lets Limehouse staff type a question ("what's the late rent notice
process?") and get a plain-language answer pulled from the company's own
uploaded documents (Word docs and PDFs), along with which document it came
from. If nothing in the documents answers the question, Limona says so
instead of guessing.

This README assumes no programming background — just follow the steps in
order.

## What you need before you start

1. **Node.js** installed (version 20 or newer). If you're not sure, open a
   terminal and run `node --version`.
2. **A Postgres database with the "pgvector" extension.** This is what
   makes document search work. If you already have Postgres running
   somewhere, ask whoever manages it whether pgvector is installed. If
   you're starting from scratch, a managed provider like Supabase or Neon
   gives you this out of the box, or you can install Postgres + the
   pgvector extension yourself.
3. **An Anthropic API key** (for generating answers) — get one at
   https://console.anthropic.com/ under Settings -> API Keys.

Turning documents and questions into something searchable (the "embeddings"
step) runs entirely on your own machine — no API key or account needed for
that at all. The first time you upload a document or ask a question, it
downloads a small (~80MB) model file once and caches it locally; every run
after that is instant.

The app will start and the admin screens will work even without the
Anthropic key — but the chat screen won't be able to answer anything until
it's set. See "What's blocked without API keys" below.

## Step 1: Install dependencies

From inside the `projects/limona` folder, run:

```
npm install
```

## Step 2: Set up your `.env` file

Copy `.env.example` to a new file named `.env` in the same folder, then
fill in the blanks:

- `DATABASE_URL` — the connection string for your Postgres database.
- `SESSION_COOKIE_SECRET` — any long random string (32+ characters). You can
  generate one with `openssl rand -hex 32` if you have that available, or
  just mash the keyboard for a long random string.
- `ANTHROPIC_API_KEY` — your Anthropic key from step above.

Leave `PORT` and `STORAGE_DIR` as their defaults unless you have a reason to
change them.

**Never commit your `.env` file to git** — it has real credentials in it.

## Step 3: Set up the database tables

Run:

```
npm run migrate:up
```

This creates all the tables Limona needs (users, documents, document
categories, the searchable text chunks, and the chat history log), and
turns on the pgvector extension if it isn't already on.

## Step 4: Create your own admin account

There's no "sign up" page on purpose — access is invite-only, and you're
the very first user. Run:

```
npm run bootstrap-admin -- --email you@limehousepm.com --name "Jason Sampson" --password "choose-a-real-password"
```

This creates (or updates) an admin account you can log in with immediately.
You can re-run this any time, e.g. if you forget your password — it just
updates the same account rather than creating a duplicate.

## Step 5: Start the app

For everyday use:

```
npm run start
```

While you're making changes and want it to reload automatically:

```
npm run dev
```

Then open your browser to **http://localhost:3200/login.html** and log in
with the email/password from Step 4.

## Using Limona

- **As admin**, after logging in you land on the Admin screen
  (`/admin.html`). From there you can:
  - Upload documents one at a time, or select several files at once to
    bulk-upload (all files in one upload go into the same category — pick
    the category first, then select your files).
  - Re-categorize or remove a document.
  - Download any document back in its original file — exactly as it was
    uploaded, no exceptions.
  - Invite staff by email and name. This creates a one-time link you copy
    and send to them yourself (over Teams or email) — Limona doesn't send
    the invite for you in v1. When they open the link, they set their own
    password.
  - Disable a staff member's access without deleting their account or their
    question history.
- **As a staff member (member role)**, after logging in you land on the
  Chat screen (`/chat.html`) and can only ask questions — no access to
  document or user management.

## Re-uploading a document (replacing an older version)

If a document changes (e.g. an updated SOP), upload the new file the same
way. Limona keeps the old version working until the new one has fully
processed, then switches over automatically — so staff are never left
without an answer mid-upload, and a failed re-upload never breaks the
document that was already working.

## What's blocked without API keys

The app builds and runs, and admin document upload/management works,
**without any API key set at all** — document upload and processing use a
local embedding model, so they work immediately after `npm install`.

- **Without `ANTHROPIC_API_KEY`**: the chat screen will show a clear
  "Limona isn't fully set up yet" message instead of an answer, and won't
  crash. Documents can still be uploaded and processed in the meantime.

`ANTHROPIC_API_KEY` is the only key needed, and only for the chat feature to
generate answers.

## Running the tests

Two kinds of tests exist:

- `npm test` — fast tests that don't need a database. Safe to run anytime.
- `npm run test:db` — tests that need a real, migrated Postgres database.
  **These tests delete data between runs** (they `TRUNCATE` tables), so they
  must never point at your real database.

### Setting up `npm run test:db` safely (required one-time setup)

`npm run test:db` reads its database connection from a separate file,
**`.env.test`** — never from your real `.env`. This is deliberate and
enforced in code, after an earlier incident where a missing `.env.test` let
the test suite silently fall through to the real database and delete real
data.

To set it up:

1. Copy `.env.test.example` to a new file named `.env.test` (same folder).
   `.env.test` is git-ignored, same as `.env`.
2. Point its `DATABASE_URL` at a disposable test Postgres database — never
   your production one. The database name (or connection string) **must
   contain the word "test"** (not case-sensitive) — this is checked in code
   before any test is allowed to delete data, and the test run refuses to
   start if it's missing. See `.env.test.example` for two ways to get a
   disposable database that satisfies this.
3. Migrate that test database the same way you migrated your real one:
   `DATABASE_URL=<your test database url> npm run migrate:up`

Two independent safety checks now protect against a repeat of that
incident:

- If `.env.test` doesn't exist at all, `npm run test:db` fails immediately
  with a clear error, instead of silently using whatever `DATABASE_URL`
  happens to already be set.
- Even with `.env.test` present, every destructive test operation refuses
  to run unless the connection string contains "test" — so it's not enough
  to accidentally point `.env.test` at a non-test-named database either.

**Status as of this writing:** a real disposable test database has not
been provisioned yet. `.env.test` exists with a placeholder connection
string so the safety checks above are active, but you'll need to point it
at a real test database (step 2 above) before `npm run test:db` will
actually pass.

## Project layout (for reference)

```
projects/limona/
  migrations/       -- database table definitions, run via `npm run migrate:up`
  src/
    config/         -- environment variable loading/validation
    db/              -- database connection
    auth/            -- login sessions, invite redemption, admin/member gating
    rag/             -- text extraction, chunking, embeddings, search, answer generation
    routes/          -- the web API endpoints
    scripts/         -- one-off scripts (bootstrap-admin)
    server.ts        -- the web server entry point
  public/            -- the actual web pages (plain HTML/CSS/JavaScript, no build step)
  storage/documents/ -- uploaded original files live here, one folder per document
  test/              -- automated tests
```
