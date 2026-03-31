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

## Notes
- Proposals download as PDF named: FacilityName_PMA_Date.pdf
- The PDF looks exactly like the on-screen preview
