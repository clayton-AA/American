# American Air — Proposal Builder

## Setup (one time)

1. Install Node.js from https://nodejs.org (choose LTS version)
2. Unzip this folder somewhere on your computer
3. Open Terminal (Mac) or Command Prompt (Windows)
4. Navigate to the folder:  cd path/to/aa-proposal-tool
5. Run:  npm install
6. Done.

## Starting the tool

    node server.js

Then open your browser to:  http://localhost:3000

## Sharing with your team

If you want your sales reps to use it from their own computers without installing anything,
deploy it to Render.com (free tier):

1. Create a free account at https://render.com
2. Push this folder to a GitHub repo
3. On Render: New > Web Service > connect your repo
4. Build command: npm install
5. Start command: node server.js
6. Share the URL Render gives you with your team

That's it — they open the URL in any browser, fill out the form, download the doc.

## Notes
- The logo (logo.png) must stay in the same folder as server.js
- All proposals download as Word docs named: FacilityName_PMA_Date.docx
- ⚠ Review the T&C section — "ISS" appears in Indemnity and Warranty clauses, 
  likely from a previous template. Replace with "American Air LLC" if needed.
