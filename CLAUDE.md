# CLAUDE.md

Guidance for Claude (and developers) working in this repository.

## What this app is

The **American Air LLC Proposal Tool** — a web app that generates branded
**Preventative Maintenance Agreement (PMA)** proposals for commercial HVAC
customers as downloadable PDFs, and sends them for e-signature via DocuSign.

It is used by American Air's sales reps and GM. A rep selects the customer's
equipment, enters pricing, and the tool produces a polished multi-page PDF that
matches an on-screen live preview.

## Run & deploy

- **Node version:** 20.x (see `.nvmrc` / `.node-version`).
- **Install:** `npm install` (pulls `puppeteer-core` + `@sparticuz/chromium`).
- **Start:** `node server.js` (or `npm start`) → http://localhost:3000
- **No build step.** The front end is plain static HTML/CSS/JS served from
  `public/`. Editing `public/index.html` only requires a **browser refresh**
  (hard refresh / Ctrl+F5 to bust cache) — **not** a server restart.
- **Server changes** (`server.js`) **do** require restarting the Node process.
- **Hosting:** Render.com. Build = `npm install`, Start = `node server.js`.
  Render deploys from the Git repo, so changes only go live after commit + push.

## Architecture

Single-server, single-page app. There is no framework and no bundler.

- **`server.js`** — the entire backend in one Express file (~1570 lines):
  routing, ServiceTitan/DocuSign/Anthropic integrations, the PMA HTML template,
  the equipment catalog, and Puppeteer PDF rendering.
- **`public/index.html`** — the entire front end in one file (~2100 lines):
  markup, styles, and all client JS inline. Four tabs: New Proposal, Survey,
  My Proposals, Dashboard.
- **`public/dashboard.html`** — standalone proposal dashboard view.
- **PDF generation** — Puppeteer renders the server-built HTML template to PDF.
  DocuSign signature/initial/date fields are placed using text **anchors**
  embedded in the PDF (e.g. `__custsign__`, `__custdate__`, `__repsign__`).

### Data storage (no database)

- `DATA_DIR` = `/data` if it exists (Render persistent disk), else the repo dir.
- `proposal_counter.json` — incrementing proposal number.
- `proposal_log.json` — record of every generated proposal + status.
- `pdfs/<proposalNumber>.pdf` — generated PDFs (used for DocuSign + re-download).

## Key server routes (`server.js`)

- `POST /auth`, `POST /admin-auth` — site/admin password gate.
- `GET /st-customers`, `/st-customer/:id`, `/st-equipment/:id` — ServiceTitan lookup.
- `POST /st-push-equipment` — push surveyed units into ServiceTitan.
- `POST /survey-read-tag` — AI reading of an equipment data-tag photo.
- `POST /generate` — build + render the proposal PDF (password-protected).
- `GET /download/:proposalNumber` — re-download a stored PDF.
- `POST /shield-report` — S.H.I.E.L.D. equipment age / replacement-forecast report.
- `POST /send-docusign`, `/resend-docusign`, `POST /docusign-webhook` — e-sign flow.
- `GET /my-proposals`, `/admin-data`, `POST /update-proposal-status`, `/delete-proposal`.

## Environment variables

Auth: `SITE_PASSWORD` (default `americanair`), `ADMIN_PASSWORD`, `PORT`.

ServiceTitan (optional — lookup self-disables if unset):
`ST_TENANT_ID`, `ST_APP_KEY`, `ST_CLIENT_ID`, `ST_CLIENT_SECRET`,
`ST_AUTH_URL`, `ST_API_BASE`.

DocuSign: `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_INTEGRATION_KEY`,
`DOCUSIGN_USER_ID`, `DOCUSIGN_PRIVATE_KEY`.

AI tag reading (optional): `ANTHROPIC_API_KEY`, `TAG_MODEL`
(default `claude-haiku-4-5-20251001`).

## ⚠️ Critical gotcha: equipment catalog must stay in sync

Equipment types are defined in **two** places that **must** match:

- Front end: `EQ_DATA` in `public/index.html` (drives the selectable cards).
- Backend: `EQ_CATALOG` in `server.js` (drives the PDF scope/schedule tables).

Every `id` offered in `EQ_DATA` **must** have a matching key in `EQ_CATALOG`.
If a customer selects an equipment type that exists only in `EQ_DATA`, the
server crashes with `Cannot read properties of undefined (reading 'name')`
during `/generate` (the error surfaces to the user as
"Error generating document: ...").

When adding a new equipment type, update **both** lists. `server.js` also
guards the lookups with `if (!eq) return '';` so an unknown id is skipped
rather than crashing — keep that guard in place.

Current ids (12, in sync): `rtu, split, mini, vrf, vav, reznor, mau, exhaust,
boiler, erv, backflow, waterheater`.

## Front-end conventions (`public/index.html`)

- **`refresh()` is the central hub.** Nearly every input change calls it; it
  rebuilds the live preview and is the right place to hook "on any change"
  behavior (auto-save is wired here).
- **`toast(msg, type, opts)`** — user notifications (`type`: info/error/success).
- **Auth** is held in `sessionStorage.sitePassword` and sent as the
  `x-site-password` header on API calls.
- **`localStorage` persistence keys** (all `aa_*`):
  - `aa_draft_v1` — auto-saved in-progress New Proposal (customer fields,
    1-year pricing, additions/exclusions, equipment selection). Restored on
    load; cleared by "Clear all fields"; never saved when the form is empty.
  - `aa_calc_v1` — cost-calculator assumptions.
  - `aa_survey_v1` — Survey tab unit list.
  - `aa_inp-sales-name` / `aa_inp-sales-phone` / `aa_inp-sales-email` —
    per-rep details, persisted across proposals.
- Equipment selection lives in the `state` object keyed by equipment id:
  `{ active, qty, visits }`.
- Pricing: only the **1-year** column has inputs (`p-1-q/s/a`); the 3- and
  5-year columns are **computed** display cells (`p-3-*`, `p-5-*`) via
  `calcPriceTable()` (3yr = 97%, 5yr = 95% of 1yr).

## Conventions & cautions

- **Single-file front end and back end** — keep additions inline and consistent
  with the existing plain-JS style; do not introduce a build step or framework
  without discussion.
- **File integrity:** these two files are large and edited in place. A prior
  incident left `server.js` **truncated mid-file** (and a corrupt git index /
  stale `.git/index.lock`). After any large edit, verify with
  `node --check server.js` and confirm the file ends with the
  `app.listen(PORT, ...)` startup line.
- **PDF rendering depends on Chromium** via `@sparticuz/chromium`; the
  `/generate` and `/shield-report` routes won't work without it installed.
- **Secrets:** never commit real ServiceTitan/DocuSign/Anthropic credentials;
  they belong in environment variables (Render dashboard).

## Verifying changes

- `node --check server.js` after server edits.
- For front-end logic, the script blocks can be syntax-checked by extracting
  `<script>` contents and running them through Node's `vm`.
- There is no automated test suite; verify the `/generate` path manually with a
  proposal that includes at least one of every equipment type.
