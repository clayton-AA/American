# American Air — Proposal Builder v2 (PDF output)

## Setup (one time)

1. Install Node.js from https://nodejs.org (LTS version)
2. Unzip this folder
3. Open Terminal / Command Prompt, navigate to the folder
4. Run: npm install
   (This installs Puppeteer which downloads a browser — takes a minute)
5. Run: node server.js
6. Open: http://localhost:3000

## Render.com deployment

Build command: npm install
Start command:  node server.js

Render environment — add this environment variable:
  PUPPETEER_CACHE_DIR = /opt/render/.cache/puppeteer

## ServiceTitan customer lookup (optional)

The facility-name field searches ServiceTitan and autofills address + contact.
Add these environment variables on Render (same values as the servicetitan-mcp
service uses — see that repo's .env.example):

  ST_TENANT_ID     = <tenant id>
  ST_APP_KEY       = <app key>
  ST_CLIENT_ID     = <client id>
  ST_CLIENT_SECRET = <client secret>

If these are not set, the lookup silently disables itself and the form works
exactly as before (manual entry).

## AI tag reading — Survey tab (optional, beta)

The Survey tab lets reps photograph equipment data tags; an AI model extracts
brand, model, serial, and manufacture year. Requires one environment variable
on Render:

  ANTHROPIC_API_KEY = <key from console.anthropic.com>

Optional: TAG_MODEL to override the model (default claude-haiku-4-5-20251001).
Cost is roughly $0.01 per photo. Without the key, the Survey tab still works
for manual entry — photos just won't auto-read.

The Survey tab can also push surveyed equipment into ServiceTitan as
installed-equipment records (button at the bottom of the tab). This requires
the ST_* variables above, and the ServiceTitan app must have WRITE access to
the Equipment Systems scope (the same app used by servicetitan-mcp already
does). Records are deduplicated by serial number, so pushing twice is safe.
The customer must exist in ServiceTitan — pick them from the typeahead first.

## Notes
- Proposals download as PDF named: FacilityName_PMA_Date.pdf
- The PDF looks exactly like the on-screen preview
