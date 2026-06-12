
const express = require('express');
const puppeteer = require('puppeteer-core');
const https  = require('https');
const crypto = require('crypto');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json({ limit: '5mb' }));

// ── DocuSign ──────────────────────────────────────────────────────────────────
const DS_INT_KEY     = process.env.DOCUSIGN_INTEGRATION_KEY || '';
const DS_ACCOUNT_ID  = process.env.DOCUSIGN_ACCOUNT_ID      || '';
const DS_USER_ID     = process.env.DOCUSIGN_USER_ID         || '';
const DS_PRIVATE_KEY = (process.env.DOCUSIGN_PRIVATE_KEY    || '').replace(/\\n/g, '\n');

function httpsReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getDSToken() {
  if (!DS_INT_KEY || !DS_USER_ID || !DS_PRIVATE_KEY) {
    throw new Error('DocuSign environment variables not configured. Need DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_ACCOUNT_ID, DOCUSIGN_USER_ID, DOCUSIGN_PRIVATE_KEY');
  }

  const header  = { alg: 'RS256', typ: 'JWT' };
  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   DS_INT_KEY,
    sub:   DS_USER_ID,
    aud:   'account.docusign.com',
    iat:   now,
    exp:   now + 3600,
    scope: 'signature impersonation',
  };

  const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  // Log JWT details for debugging
  console.log('DS JWT - INT_KEY:', DS_INT_KEY.substring(0,8) + '...');
  console.log('DS JWT - USER_ID:', DS_USER_ID.substring(0,8) + '...');
  console.log('DS JWT - KEY starts with:', DS_PRIVATE_KEY.substring(0,40));

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(DS_PRIVATE_KEY, 'base64url');
  const jwt = `${unsigned}.${sig}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const opts = {
    hostname: 'account.docusign.com',
    path:     '/oauth/token',
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  };

  const resp = await httpsReq(opts, body);
  console.log('DS token response status:', resp.status);
  console.log('DS token response body:', JSON.stringify(resp.body));

  if (!resp.body.access_token) {
    throw new Error('DocuSign auth failed: ' + JSON.stringify(resp.body));
  }
  return resp.body.access_token;
}

async function createDSEnvelope({ pdfBuffer, filename, customerName, customerEmail, repName, repEmail, date }) {
  const token = await getDSToken();

  // Dynamically detect which page the execution/pricing section is on
  // Structure: Cover(1) + Agreement(1-2 pages) + Execution(1 page) + Scope(1) + TC(2-3)
  // Count total pages then subtract known tail pages (scope=1, TC=2) = execution is totalPages-3
  let execPage = 3;
  try {
    const pdfStr = pdfBuffer.toString('latin1');
    const matches = pdfStr.match(/\/Type\s*\/Page/g) || [];
    const totalPages = matches.length;
    console.log('PDF total pages:', totalPages);
    // Execution page is always (totalPages - 3): last 3 pages are execution+scope+TC
    // But execution IS one of those — it's totalPages - 2 (scope=last, TC=second last, exec=third from last)
    // Actually: cover, agreement, [exec+pricing], scope, TC(2 pages) = 6 pages normally
    // execPage = totalPages - 2 (scope + TC last 2, exec is 3rd from end... no)
    // Let's just be direct: without extras = 5-6 pages total, exec is page 3
    // With extras (long exclusions) = could push to page 4
    // Best heuristic: exec page = totalPages - 3 (there are always 3 pages after exec: scope + 2 TC pages)
    if (totalPages > 0) {
      execPage = Math.max(2, totalPages - 3);
    }
    console.log('Execution page:', execPage);
  } catch(e) {
    console.log('Page count error:', e.message);
    execPage = 3;
  }

  const p = '3'; // Execution always on page 3
  const envelope = {
    emailSubject: `Preventative Maintenance Agreement — Please Sign`,
    emailBlurb:   `Please review and sign your Preventative Maintenance Agreement with American Air, Inc. Once signed it will be routed to your account manager for countersignature.`,
    documents: [{ documentBase64: pdfBuffer.toString('base64'), name: filename, fileExtension: 'pdf', documentId: '1' }],
    recipients: {
      signers: [
        {
          email: customerEmail, name: customerName, recipientId: '1', routingOrder: '1',
          tabs: {
            signHereTabs:    [{ documentId:'1', pageNumber:p, xPosition:'49',  yPosition:'460' }],
            initialHereTabs: [{ documentId:'1', pageNumber:p, xPosition:'164', yPosition:'222', scaleValue:'0.6' }],
            textTabs: [
              { documentId:'1', pageNumber:p, xPosition:'49', yPosition:'361', tabLabel:'ApprovedBy',       width:'200', height:'24', locked:'false' },
              { documentId:'1', pageNumber:p, xPosition:'49', yPosition:'396', tabLabel:'Title',            width:'200', height:'24', locked:'false' },
              { documentId:'1', pageNumber:p, xPosition:'49', yPosition:'503', tabLabel:'PurchaseOrder',    width:'200', height:'24', locked:'false', required:'false' },
              { documentId:'1', pageNumber:p, xPosition:'49', yPosition:'540', tabLabel:'AgreementStart',   width:'200', height:'24', locked:'true', value: date },
              { documentId:'1', pageNumber:p, xPosition:'230', yPosition:'316', tabLabel:'InitialDate',     width:'130', height:'18', locked:'true', value: date },
            ],
            dateSignedTabs: [{ documentId:'1', pageNumber:p, xPosition:'49', yPosition:'444' }],
            checkboxTabs: [
              { documentId:'1', pageNumber:p, xPosition:'224', yPosition:'108', tabLabel:'Q1yr'       },
              { documentId:'1', pageNumber:p, xPosition:'372', yPosition:'108', tabLabel:'SA1yr'      },
              { documentId:'1', pageNumber:p, xPosition:'515', yPosition:'108', tabLabel:'A1yr'       },
              { documentId:'1', pageNumber:p, xPosition:'224', yPosition:'137', tabLabel:'Q3yr'       },
              { documentId:'1', pageNumber:p, xPosition:'372', yPosition:'137', tabLabel:'SA3yr'      },
              { documentId:'1', pageNumber:p, xPosition:'515', yPosition:'137', tabLabel:'A3yr'       },
              { documentId:'1', pageNumber:p, xPosition:'224', yPosition:'164', tabLabel:'Q5yr'       },
              { documentId:'1', pageNumber:p, xPosition:'372', yPosition:'164', tabLabel:'SA5yr'      },
              { documentId:'1', pageNumber:p, xPosition:'515', yPosition:'164', tabLabel:'A5yr'       },
              { documentId:'1', pageNumber:p, xPosition:'216', yPosition:'227', tabLabel:'PayMonthly' },
              { documentId:'1', pageNumber:p, xPosition:'328', yPosition:'227', tabLabel:'PayService' },
              { documentId:'1', pageNumber:p, xPosition:'477', yPosition:'227', tabLabel:'PayUpfront' },
            ],
          }
        },
        {
          email: repEmail, name: repName, recipientId: '2', routingOrder: '2',
          tabs: {
            signHereTabs:   [{ documentId:'1', pageNumber:p, xPosition:'327', yPosition:'416' }],
            dateSignedTabs: [{ documentId:'1', pageNumber:p, xPosition:'327', yPosition:'480' }],
            textTabs: [
            ],
          }
        }
      ]
    },
    status: 'sent',
  };

  const body = JSON.stringify(envelope);
  const resp = await httpsReq({
    hostname: 'na4.docusign.net',
    path:     `/restapi/v2.1/accounts/${DS_ACCOUNT_ID}/envelopes`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);

  if (resp.status !== 201) throw new Error('DocuSign envelope failed: ' + JSON.stringify(resp.body));
  return resp.body.envelopeId;
}

// ── ServiceTitan customer lookup ──────────────────────────────────────────
// OAuth2 client-credentials; token cached in memory (~15 min lifetime).
// Same pattern as the servicetitan-mcp repo. Requires env vars:
//   ST_TENANT_ID, ST_APP_KEY, ST_CLIENT_ID, ST_CLIENT_SECRET
const ST_AUTH_URL = process.env.ST_AUTH_URL || 'https://auth.servicetitan.io/connect/token';
const ST_API_BASE = process.env.ST_API_BASE || 'https://api.servicetitan.io';

const stConfigured = () =>
  !!(process.env.ST_TENANT_ID && process.env.ST_APP_KEY && process.env.ST_CLIENT_ID && process.env.ST_CLIENT_SECRET);

let stToken = null, stTokenExpiresAt = 0;
async function getSTToken() {
  const now = Date.now();
  if (stToken && now < stTokenExpiresAt - 30000) return stToken;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.ST_CLIENT_ID,
    client_secret: process.env.ST_CLIENT_SECRET,
  });
  const resp = await fetch(ST_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error('ServiceTitan OAuth failed (' + resp.status + ')');
  stToken = data.access_token;
  stTokenExpiresAt = now + (Number(data.expires_in || 900) * 1000);
  return stToken;
}

async function stFetch(pathAfterV2, query) {
  // pathAfterV2 e.g. '/crm/v2/customers' — tenant id is spliced in after /v2
  const p = pathAfterV2.replace(/^(\/[^/]+\/v\d+)/, '$1/tenant/' + process.env.ST_TENANT_ID);
  const url = new URL(ST_API_BASE + p);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let token = await getSTToken();
  let resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token, 'ST-App-Key': process.env.ST_APP_KEY, Accept: 'application/json' } });
  if (resp.status === 401) { // one-shot retry on stale token
    stToken = null;
    token = await getSTToken();
    resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token, 'ST-App-Key': process.env.ST_APP_KEY, Accept: 'application/json' } });
  }
  if (!resp.ok) throw new Error('ST GET ' + pathAfterV2 + ' → ' + resp.status);
  return resp.json();
}

const fmtSTAddress = (a) => a ? [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') : '';

// Search customers by name (typeahead). Commercial sorted first.
app.get('/st-customers', async (req, res) => {
  if (req.headers['x-site-password'] !== (process.env.SITE_PASSWORD || 'americanair'))
    return res.status(401).json({ error: 'Unauthorized' });
  if (!stConfigured()) return res.status(503).json({ error: 'ServiceTitan not configured' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const data = await stFetch('/crm/v2/customers', { name: q, active: 'True', pageSize: 15 });
    const rows = (data.data || [])
      .sort((a, b) => (a.type === 'Commercial' ? -1 : 1) - (b.type === 'Commercial' ? -1 : 1))
      .map(c => ({ id: c.id, name: c.name, type: c.type, address: fmtSTAddress(c.address) }));
    res.json(rows);
  } catch (e) {
    console.error('ST search error:', e.message);
    res.status(502).json({ error: 'ServiceTitan search failed' });
  }
});

// Details for one customer: primary location address + contacts.
app.get('/st-customer/:id', async (req, res) => {
  if (req.headers['x-site-password'] !== (process.env.SITE_PASSWORD || 'americanair'))
    return res.status(401).json({ error: 'Unauthorized' });
  if (!stConfigured()) return res.status(503).json({ error: 'ServiceTitan not configured' });
  const id = String(req.params.id).replace(/\D/g, '');
  if (!id) return res.status(400).json({ error: 'Bad id' });
  try {
    const [locData, contactData] = await Promise.all([
      stFetch('/crm/v2/locations', { customerId: id, active: 'True', pageSize: 50 }),
      stFetch('/crm/v2/customers/' + id + '/contacts', { pageSize: 50 }).catch(() => ({ data: [] })),
    ]);
    const locations = (locData.data || []).map(l => ({ id: l.id, name: l.name || '', address: fmtSTAddress(l.address) }));
    const contacts = (contactData.data || []).map(c => ({
      name: c.name || '', type: c.type || '', value: c.value || '', memo: c.memo || '',
    }));
    res.json({ locations, contacts });
  } catch (e) {
    console.error('ST detail error:', e.message);
    res.status(502).json({ error: 'ServiceTitan lookup failed' });
  }
});

// Paginate through ServiceTitan's {data, hasMore} shape (max 10 pages × 200).
async function stFetchAllPages(pathAfterV2, query) {
  let page = 1;
  const all = [];
  while (page <= 10) {
    const data = await stFetch(pathAfterV2, { ...(query || {}), page, pageSize: 200 });
    const rows = (data && data.data) || [];
    all.push(...rows);
    if (!data || data.hasMore === false || rows.length < 200) break;
    page += 1;
  }
  return all;
}

// Map ServiceTitan equipment type/name/model text onto the app's equipment card ids.
// Order matters: specific patterns before generic ones ("mini split" before "split").
const EQ_MATCHERS = [
  ['mini',    /mini[\s-]?split|ductless/i],
  ['vrf',     /\bvrf\b|\bvrv\b/i],
  ['vav',     /\bvav\b/i],
  ['erv',     /\berv\b|\bhrv\b|energy recovery|heat recovery/i],
  ['mau',     /make[\s-]?up\s?air|\bmau\b/i],
  ['boiler',  /boiler/i],
  ['reznor',  /unit heater|reznor|infrared|radiant/i],
  ['exhaust', /exhaust|supply fan|ventilat/i],
  ['rtu',     /\brtu\b|roof[\s-]?top|packaged?\s?unit/i],
  ['split',   /split|condens|air handler|\bahu\b|heat pump|furnace/i],
];

// Installed equipment for one customer, grouped by app equipment card.
app.get('/st-equipment/:id', async (req, res) => {
  if (req.headers['x-site-password'] !== (process.env.SITE_PASSWORD || 'americanair'))
    return res.status(401).json({ error: 'Unauthorized' });
  if (!stConfigured()) return res.status(503).json({ error: 'ServiceTitan not configured' });
  const id = String(req.params.id).replace(/\D/g, '');
  if (!id) return res.status(400).json({ error: 'Bad id' });
  try {
    const locations = await stFetchAllPages('/crm/v2/locations', { customerId: id, active: 'True' });
    if (locations.length === 0) return res.json({ counts: {}, unmatched: [], totalUnits: 0 });
    const locationIdsCsv = locations.map(l => l.id).join(',');
    const equipment = await stFetchAllPages('/equipmentsystems/v2/installed-equipment', {
      locationIds: locationIdsCsv, active: 'True',
    });
    const locName = new Map(locations.map(l => [l.id, l.name || (l.address && l.address.street) || ('Location ' + l.id)]));
    const counts = {};
    const unmatched = [];
    const units = [];
    for (const r of equipment) {
      const label = [(r.type && r.type.name) || '', r.name || '', r.model || ''].join(' ');
      const hit = EQ_MATCHERS.find(([, re]) => re.test(label));
      if (hit) counts[hit[0]] = (counts[hit[0]] || 0) + 1;
      else unmatched.push((r.type && r.type.name) || r.name || r.model || 'Unknown unit');
      let year = null;
      const dateStr = r.installedOn || r.manufacturedOn || null;
      if (dateStr) { const y = new Date(dateStr).getFullYear(); if (y > 1950) year = y; }
      units.push({
        typeId: hit ? hit[0] : null,
        label: r.name || (r.type && r.type.name) || 'Unit',
        brand: r.manufacturer || r.brand || '',
        model: r.model || '',
        serial: r.serialNumber || r.serial || '',
        year,
        location: locName.get(r.locationId) || '',
      });
    }
    res.json({ counts, unmatched, totalUnits: equipment.length, units });
  } catch (e) {
    console.error('ST equipment error:', e.message);
    res.status(502).json({ error: 'ServiceTitan equipment lookup failed' });
  }
});

// POST to ServiceTitan (same auth/retry pattern as stFetch)
async function stPost(pathAfterV2, body) {
  const p = pathAfterV2.replace(/^(\/[^/]+\/v\d+)/, '$1/tenant/' + process.env.ST_TENANT_ID);
  const url = ST_API_BASE + p;
  const doIt = async () => {
    const token = await getSTToken();
    return fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'ST-App-Key': process.env.ST_APP_KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  let resp = await doIt();
  if (resp.status === 401) { stToken = null; resp = await doIt(); }
  const text = await resp.text();
  if (!resp.ok) throw new Error('ST POST ' + pathAfterV2 + ' → ' + resp.status + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

// Push surveyed equipment into ServiceTitan as installed-equipment records.
// Dedupes by serial number against the location's existing equipment.
app.post('/st-push-equipment', async (req, res) => {
  if (req.headers['x-site-password'] !== (process.env.SITE_PASSWORD || 'americanair'))
    return res.status(401).json({ error: 'Unauthorized' });
  if (!stConfigured()) return res.status(503).json({ error: 'ServiceTitan not configured' });
  const { customerId, locationId, units } = req.body || {};
  if (!customerId || !locationId || !Array.isArray(units) || units.length === 0)
    return res.status(400).json({ error: 'Missing customerId, locationId, or units' });
  try {
    // Confirm the location belongs to this customer
    const locData = await stFetch('/crm/v2/locations', { customerId: String(customerId), active: 'True', pageSize: 100 });
    const locs = (locData.data || []);
    if (!locs.some(l => String(l.id) === String(locationId)))
      return res.status(400).json({ error: 'Location does not belong to this customer' });

    // Existing serials at this location → dedupe set
    const existing = await stFetchAllPages('/equipmentsystems/v2/installed-equipment', {
      locationIds: String(locationId), active: 'Any',
    });
    const have = new Set(existing.map(r => String(r.serialNumber || r.serial || '').trim().toUpperCase()).filter(Boolean));

    const created = [], skipped = [], failed = [];
    for (const u of units) {
      const serial = String(u.serial || '').trim();
      if (serial && have.has(serial.toUpperCase())) { skipped.push(serial); continue; }
      const payload = {
        locationId: Number(locationId),
        name: String(u.name || 'Surveyed unit').slice(0, 120),
        ...(u.brand  ? { manufacturer: String(u.brand).slice(0, 60) } : {}),
        ...(u.model  ? { model: String(u.model).slice(0, 60) } : {}),
        ...(serial   ? { serialNumber: serial.slice(0, 60) } : {}),
        ...(u.year && Number(u.year) > 1970 ? { installedOn: u.year + '-06-15T00:00:00Z' } : {}),
        ...(u.memo   ? { memo: String(u.memo).slice(0, 300) } : {}),
      };
      try {
        await stPost('/equipmentsystems/v2/installed-equipment', payload);
        created.push(payload.name);
        if (serial) have.add(serial.toUpperCase());
      } catch (e) {
        console.error('ST equipment create failed:', e.message);
        failed.push(payload.name);
      }
    }
    res.json({ created: created.length, skipped, failed });
  } catch (e) {
    console.error('ST push error:', e.message);
    res.status(502).json({ error: 'ServiceTitan push failed' });
  }
});

// ── Site survey: AI nameplate reader ──────────────────────────────────────
// Sends a photo of an equipment data tag to the Claude API and returns
// structured fields. Requires ANTHROPIC_API_KEY env var; the survey tab
// falls back to manual entry when it's not set.
const TAG_PROMPT = `You are reading a photo of an HVAC equipment nameplate / data tag.
Extract the following and respond with ONLY a JSON object, no other text:
{
  "brand": string|null,           // manufacturer, e.g. "Carrier", "Trane"
  "model": string|null,           // model number exactly as printed
  "serial": string|null,          // serial number exactly as printed
  "equipment_type": string|null,  // best guess, one of: rtu, split, mini, vrf, vav, reznor, mau, exhaust, boiler, erv
  "component": string,            // "complete" if this is a self-contained system (RTU, boiler, unit heater, MAU, ERV, mini-split outdoor unit);
                                  // otherwise the part of a split system this tag belongs to: "condenser", "coil", "furnace", "air_handler"
  "tonnage": number|null,         // cooling capacity in tons if determinable (12000 BTU = 1 ton)
  "mfg_year": number|null,        // 4-digit manufacture year
  "confidence": "high"|"medium"|"low"
}
Component hints: outdoor condensing units (e.g. Carrier 24/38-series, Trane 4TTR) = "condenser";
evaporator/cased coils (ADP, Aspen, Carrier CNP) = "coil"; gas furnaces (59-series, S9X, TUD) = "furnace";
fan coils / air handlers (FB4C, TEM6) = "air_handler". A condenser + coil + furnace together form ONE split system.
For mfg_year: use a printed date if present; otherwise attempt to decode the serial number using
manufacturer conventions (Carrier/Bryant/Payne: digits 3-4 are year; Trane: leading digit/letter year codes;
Lennox: digits 3-4 of serial are year; York: letter year codes; Rheem/Ruud: positions 5-8 are week+year;
Goodman/Amana: first 2 digits year; Daikin/Mitsubishi: varies). If you cannot decode it confidently, return null.
If the image is not an equipment tag or is unreadable, return all nulls with confidence "low".`;

app.post('/survey-read-tag', async (req, res) => {
  if (req.headers['x-site-password'] !== (process.env.SITE_PASSWORD || 'americanair'))
    return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'Tag reading not configured' });
  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64 || imageBase64.length > 4_000_000)
    return res.status(400).json({ error: 'Bad or oversized image' });
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.TAG_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: TAG_PROMPT },
          ],
        }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error('AI API ' + resp.status + ': ' + JSON.stringify(data).slice(0, 200));
    let text = (data.content && data.content[0] && data.content[0].text) || '';
    text = text.replace(/```json|```/g, '').trim();
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in AI response');
    const parsed = JSON.parse(text.slice(start, end + 1));
    res.json(parsed);
  } catch (e) {
    console.error('Tag read error:', e.message);
    res.status(502).json({ error: 'Could not read the tag — enter details manually' });
  }
});

// ── Password protection ───────────────────────────────────────────────────
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'americanair';

app.post('/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

// Protect /generate — check password header
app.use('/generate', (req, res, next) => {
  const pw = req.headers['x-site-password'];
  if (pw !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const LOGO_B64 = require('fs').readFileSync(require('path').join(__dirname, 'logo_b64.txt'), 'utf8').trim();

// ── Proposal number tracker ───────────────────────────────────────────────
// Use persistent disk at /data if available, fallback to app directory
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const COUNTER_FILE = path.join(DATA_DIR, 'proposal_counter.json');
console.log('Storage directory:', DATA_DIR);

function getNextProposalNumber() {
  let data = { counter: 0 };
  try { data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')); } catch(e) {}
  data.counter = (data.counter || 0) + 1;
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(data));
  const year = new Date().getFullYear();
  return `AA-${year}-${String(data.counter).padStart(4, '0')}`;
}

const EQ_CATALOG = {
  rtu:    { name:'Rooftop Unit (RTU)',         cats:{ 'Electrical':['Volts/amps — compressor, condenser & evap fan motors','Tighten all electrical connections','Starters & contactors for wear','Test all safety controls','Test all controls & sequences'], 'Refrigeration':['Refrigerant pressures','Check for refrigerant / oil leaks','Clean condenser coil','Check evaporator coil','Inspect condensate drain pan & lines'], 'Mechanical':['Filters — inspect / replace per contract','Belts — inspect / replace per contract','Sheaves — wear & alignment','Blower wheels — inspect','Lubricate motor & blower bearings'], 'Heating':['Heat exchanger — cracks / corrosion','Burner assembly & ignition sequence','Inducer fan wheel if applicable','Overall condition of unit'] } },
  split:  { name:'Split System (DX)',           cats:{ 'Electrical':['Volts/amps — compressor & fan motors','Tighten all electrical connections','Starters & contactors for wear','Test all safety controls','Test all controls & sequences'], 'Refrigeration':['Refrigerant pressures','Check for refrigerant / oil leaks','Condenser coil — clean per contract','Inspect condensate drain pan & lines'], 'Mechanical':['Filters — inspect / replace per contract','Belts — inspect / replace per contract','Blower wheels — inspect','Lubricate motor & blower bearings'], 'Heating':['Heat exchanger — cracks / corrosion','Burner assembly if applicable','Ignition & burner sequence','Overall condition of unit'] } },
  mini:   { name:'Ductless Mini Split',         cats:{ 'Air & Filtration':['Filters — clean or replace per contract','Fan blades & housing — fouling check','Damper — adjust / lubricate if applicable','Check for moisture carryover from drain pan'], 'Refrigeration':['Refrigerant pressures & levels','Check for visible refrigerant / oil leaks','Evaporator coils — clean per contract','Condenser coils — clean per contract'], 'Electrical & Controls':['All electrical connections','Control system devices','Control box — dirt & debris','Test all safety controls','Test all controls & sequences','Field serviceable bearings — lubricate'], 'Drainage':['Drain pan, line & coil — check for biological growth','Condensate pump if applicable','General condition of unit'] } },
  vrf:    { name:'VRF / VRV System',            cats:{ 'Electrical':['Volts/amps — all motors','Tighten all electrical connections','All safety controls & safeties','Communication wiring integrity'], 'Refrigeration':['Refrigerant pressures — all circuits','Check for leaks — all connections','Condenser coil — clean per contract','Oil levels if applicable'], 'Controls':['Zone controller operation','Setpoints & schedules verified','Test all safety controls','Test all controls & sequences','Fault code review','Overall controls condition'], 'Mechanical':['Fan blades & housing','Filters — indoor units per contract','Lubricate all serviceable bearings','Overall condition — all heads & ODU'] } },
  vav:    { name:'VAV Box',                     cats:{ 'Controls':['Actuator operation & calibration','Thermostat / zone sensor accuracy','Test all safety controls','Test all controls & sequences','Setpoints & schedules verified','Occupied / unoccupied schedules'], 'Mechanical':['Damper blade condition & seating','Linkage — tighten & lubricate','Box casing & insulation integrity','Flow measurement if applicable'], 'Heating':['Hot water coil operation if applicable','Control valve — stroke & seating','Reheat sequence of operation','Overall condition of box'], 'Electrical':['All electrical connections','Control board & wiring','24V transformer output','Overall condition'] } },
  reznor: { name:'Reznor / Unit Heater',        cats:{ 'Combustion':['Burner assembly & orifices','Ignition sequence of operation','Burner sequence of operation','Gas valve operation & pressure'], 'Heat Exchanger':['Cracks, corrosion & deterioration','Flue & venting — blockage & condition','Combustion air — adequate supply','CO test if applicable'], 'Electrical':['All electrical connections','Test all safety controls','Test all controls & sequences','Thermostat calibration','Blower motor amps if applicable'], 'General':['Fan blade & housing condition','Filters if applicable','Overall unit condition','Recommend service if needed'] } },
  mau:    { name:'Make-Up Air Unit (MAU)',       cats:{ 'Air':['Filters — inspect / replace per contract','Fan wheel — clean & balance check','Belts — inspect / replace per contract','Sheaves — wear & alignment'], 'Heating / Cooling':['Heat exchanger if applicable','Gas valve & burner sequence','Cooling coil & refrigerant check','Economizer operation','Pressure controller — check & adjust if applicable'], 'Electrical':['All electrical connections','Contactors & starters for wear','Test all safety controls','Test all controls & sequences','Overall electrical condition'], 'General':['Louvers & dampers — operation','Lubricate dampers','Drain pan & condensate line','Lubricate all serviceable bearings','Overall condition of unit'] } },
  exhaust: { name:'Exhaust / Supply Fan', cats:{ 'Mechanical':['Belt condition & tension — inspect / replace per contract','Sheaves — wear & alignment','Lubricate motor & fan bearings','Fan blade & housing — inspect & clean'], 'Electrical':['All electrical connections','Volts/amps — motor','Test all safety controls','Test all controls & sequences'], 'General':['Damper operation if applicable','Overall condition of unit','Recommend service if needed','Verify airflow & operation'] } },
  boiler: { name:'Boiler', cats:{ 'Combustion':['Burner assembly — inspect & clean','Combustion analysis — check & adjust','Heat exchanger — inspect for cracks & leaks','Flue & venting — inspect & clear','Gas valve & pilot assembly — inspect & test'], 'Mechanical':['Circulator pump(s) — inspect & lubricate','Expansion tank — inspect','Pressure relief valve — inspect & test','System pressure & water level — check & adjust','Strainer — inspect & clean'], 'Controls':['Aquastat / operating controls — calibrate & verify','High limit controls — test','Test all safety controls','Test all controls & sequences','Thermostat / BAS interface — verify'], 'General':['All electrical connections','Flue gas temperature — verify','Overall condition of unit','Recommend service if needed'] } },
  erv:    { name:'ERV / HRV',                   cats:{ 'Core & Filters':['Heat / energy recovery core — inspect & clean','Filters — clean or replace per contract','Core bypass damper operation','Defrost cycle operation if applicable'], 'Mechanical':['Fan wheels — clean & condition','Energy recovery wheel & belt — inspect & condition','Belts if applicable','Lubricate all serviceable bearings','Condensate drain if applicable'], 'Controls':['Controls & setpoints verified','Test all safety controls','Test all controls & sequences','Enthalpy sensors if applicable','Occupied / unoccupied schedules','Airflow verification'], 'General':['All electrical connections','Housing integrity & seals','Overall condition of unit','Recommend service if needed'] } },
};

const SERVICES = [
  ['Filter Inspection & Replacement',            'All return air filters inspected and replaced as needed. Correct filter size and MERV rating confirmed per unit specifications.'],
  ['Electrical & Safety Inspection',             'All electrical connections inspected and tightened. Contactors, capacitors, fuses, and disconnects checked for wear or failure risk.'],
  ['Refrigerant Level & System Pressure Check',  'Operating pressures measured and logged against manufacturer specs. Low refrigerant or leak indicators flagged and documented.'],
  ['Condensate Drain Line Inspection & Cleaning','Drain pans and lines inspected and flushed. Checked for biological growth, blockages, and proper drainage to prevent overflow and water damage.'],
  ['Thermostat Calibration & Controls Verification','Thermostat accuracy and staging verified. Schedules and setpoints confirmed per facility needs.'],
  ['Blower Motor & Belt Inspection',             'Belt condition, tension, and alignment inspected. Blower wheel cleaned. Motor and blower bearings lubricated.'],
  ['Condenser Coil Cleaning',                    'Outdoor condenser coils cleaned using low-pressure rinse and coil-safe detergent to maintain airflow and heat transfer efficiency.'],
  ['Digital Service Report & Unit Labeling',      'Digital report provided after every visit documenting all findings, readings, and recommended repairs. All units tagged and labeled for easy identification. Kept on file for your records.'],
];

const TC_SECTIONS = [
  { h:'Acceptance', b:'These terms and conditions are an integral part of American Air LLC\'s offer and form the basis of any agreement resulting from American Air LLC\'s proposal for the services and equipment listed in the Proposal. This Agreement is subject to periodic change or amendment. The Agreement is accepted in writing by the party to whom this offer is made or an authorized agent ("Client") delivered to Client within 30 days from the date of the Proposal. If Client accepts the Proposal by placing an order, without the addition of any other terms and conditions of sale or any other modification, Client\'s order shall be deemed acceptance of the Proposal subject to American Air LLC\'s terms and conditions. This Agreement is subject to credit approval by American Air LLC. Upon disapproval of credit, American Air LLC may delay or suspend performance or, at its option, renegotiate prices and/or terms and conditions with Client. If American Air LLC and Client are unable to agree on such revisions, this Agreement shall be cancelled without any liability, other than Client\'s obligations to pay for Services provided by American Air LLC to the date of cancellation.' },
  { h:'Payment Terms', b:'Client understands and agrees that payment of the net is due upon receipt of the invoice; that after thirty (30) days a service charge of 1-1/2% of the balance due shall be added for every month the balance remains unpaid; that after ninety (90) days all costs of collection, including attorney fees, shall be payable and shall be recovered in addition to sums then due. The validity and interpretation of the contract between the parties shall be governed by the laws of the State of Massachusetts, and the parties agree that jurisdiction and venue over any dispute or proceedings arising out of the contract shall be exclusively in the Courts of the County of Middlesex, State of Massachusetts.' },
  { h:'Force Majeure', b:'This agreement shall NOT include maintenance, repairs, service or replacements necessitated by any loss or damage resulting from any cause beyond the control of American Air LLC, including but not limited to damage or loss due to lack of water, freezing, loss or insufficient electric power or fuel source, hail, flood, windstorms, excessive rain, or snow, freezing weather, lightning, earthquake, theft, fire, riots of any kind, strikes, wars, misuse and negligence by person(s) other than those representing American Air LLC, vandalism, acts of government, building code requirements, insurance requirements, unauthorized adjustments or repair, or any other peril or act of God. The cost of all repairs, modifications or alterations necessitated by the above shall be the responsibility of the Client and payable to American Air LLC at the then current service rate.' },
  { h:'Warranty', b:'American Air LLC warrants that its products and services shall be free from defects in workmanship and materials for thirty (30) days from the date of completion. American Air LLC\'s sole obligation shall be repair or replace defective parts or its property performing defective service. Except as expressly provided by this Agreement, American Air LLC hereby expressly disclaims and negates any other representation or warranty, express or implied, related to the Services provided under this Agreement. American Air LLC does warrant that all material and labor furnished pursuant to this Agreement shall be free from defects in materials and workmanship. THIS WARRANTY AND LIABILITY SET FORTH IN THIS AGREEMENT ARE IN LIEU OF ALL OTHER WARRANTIES AND LIABILITIES, WHETHER IN CONTRACT OR IN NEGLIGENCE, EXPRESS OR IMPLIED, IN LAW OR IN FACT, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.' },
  { h:'Limitations of Liability', b:'This Agreement does not include responsibility for the design of the system, obsolescence, safety test, removal and reinstallation of valve bodies and dampers, repair or replacement necessitated by freezing weather, electrical power failure, low voltage, burned-out main or branch fuses, low water pressure, vandalism, misuse or abuse of the system(s), negligence of others (including Client), failure of Client to properly operate the system, requirements of governmental, regulatory or insurance agencies, or other causes beyond control of American Air LLC. Service Provider shall not be liable for any delay, loss, damage or detention caused by unavailability of machinery, equipment or materials, delay of carriers, strikes, lockouts, civil or military authority, or by any cause beyond its control.' },
  { h:'Additional Services', b:'Where American Air LLC renders service for Client, other than those services specified in the maintenance plan schedule, Client agrees to pay for such services at American Air LLC\'s then current service rates. Loss of time or productivity due to unexpected events that may restrict or limit access to the equipment, associated equipment or components shall be invoiced at the then current service rates. Labor rates are subject to change without notice except when requested.' },
  { h:'Exclusivity of Service', b:'Client agrees to employ American Air LLC exclusively for the service and repair work of the listed equipment and promptly notify American Air LLC of any condition of the equipment that is unusual or that may adversely affect its operation and reliability. Any alterations, additions, adjustments, or repairs made by others, unless authorized or agreed upon by American Air LLC, will be cause to terminate or renegotiate our obligations under this agreement.' },
  { h:'Transfer of Contract', b:'This Agreement cannot be transferred or assigned without written approval of both parties.' },
  { h:'Indemnity', b:'To the fullest extent permitted by law, each party agrees to indemnify, hold harmless, protect and defend the other, including officers, agents, directors and employees, from any and all liabilities, damages, injury (including bodily injuries and/or death), cost, claims, demands, settlements or suits of any kind, including but not limited to reasonable attorney\'s fees, arising out of or resulting from (1) indemnifying party\'s breach of this agreement, and/or (2) the gross negligence and/or willful misconduct by indemnifying party or its employees, contractors, sub-contractors of any tier, directors, officers or agents, or from the presence or exposure to mold, mildew or micro-organisms, and any byproducts of such materials.' },
  { h:'Legal Action', b:'In the event either party must commence legal action to enforce or interpret any rights or obligations under this agreement, the prevailing party shall be entitled to recover its reasonable court costs and attorney\'s fees incurred from the non-prevailing party.' },
  { h:'Insurance', b:'American Air LLC agrees to maintain the following insurance during the term of this agreement with limits not less than shown below and will, upon request from the Client, provide a Certificate of Insurance.\n\nCommercial General Liability: $1,000,000 per occurrence\nAutomobile Liability: $1,000,000 combined single limit\nUmbrella Liability: $3,000,000 per occurrence\nWorker\'s Compensation: Statutory Limits' },
  { h:'Hiring of American Air LLC Employees', b:'Client agrees that it will not hire as an employee or contract with as an independent contractor any of the employees of American Air LLC during the term of this Agreement and for a period of twelve (12) months following the termination of the service agreement.' },
  { h:'Hazardous Substances', b:'American Air LLC\'s obligation under this proposal and any subsequent contract does not include the identification, abatement or removal of asbestos or any other toxic or hazardous substances, hazardous wastes or hazardous materials. In the event such substances, wastes and materials are discovered, American Air LLC\'s obligation will be to notify the client of their existence. American Air LLC shall have the right thereafter to suspend its work until such substances, wastes or materials and the resultant hazards are removed.' },
  { h:'Subcontract Rights', b:'American Air LLC reserves the right to subcontract certain repairs, if deemed necessary or in the best interest of and following approval by Client. Costs of this work will be handled as a parts sale and standard labor item in accordance with the applicable plan. Supplies, parts or equipment placed on Client\'s property shall remain the property of American Air LLC until such supplies, parts, or equipment are installed. American Air LLC reserves the right to remove such property within a reasonable period of time, if this agreement is terminated for any reason.' },
];

function buildHTML(data) {
  const { facility, address, contact, salesName, salesPhone, salesEmail, date, priceTable, additions, exclusions, equipment, proposalNumber } = data;
  const pt = priceTable || {};
  const fmtP = (v) => v && v > 0 ? '$' + Number(v).toLocaleString() : '—';
  const hasPrices = pt.y1q > 0 || pt.y1s > 0 || pt.y1a > 0;

  const totalUnits  = equipment.reduce((s,e) => s + e.qty, 0);
  const totalVisits = equipment.length > 0 ? Math.max(...equipment.map(e => e.visits)) : 0;

  const servicesHTML = SERVICES.map(([title, desc]) => `
    <div class="service-row">
      <div class="check">&#10003;</div>
      <div><div class="service-title">${title}</div><div class="service-desc">${desc}</div></div>
    </div>`).join('');

  const benefitsHTML = `
    <div class="benefits-grid">
      <div class="benefit">&#10003;&nbsp; Priority scheduling</div>
      <div class="benefit">&#10003;&nbsp; Discounted repair labor</div>
      <div class="benefit">&#10003;&nbsp; Capital Expenditure Planning</div>
      <div class="benefit">&#10003;&nbsp; Extended equipment life</div>
      <div class="benefit">&#10003;&nbsp; Manufacturer warranty support</div>
      <div class="benefit">&#10003;&nbsp; Dedicated Account Manager</div>
    </div>`;

  // ── Pricing selection table ─────────────────────────────────────────────
  const pricingTableHTML = hasPrices ? `
  <div class="section-label">Service agreement options</div>
  <table class="pricing-sel-table">
    <thead>
      <tr>
        <th style="width:18%">Term</th>
        <th style="width:26%">Quarterly<br><span style="font-size:9px;font-weight:400;opacity:0.8">(4 visits/yr)</span></th>
        <th style="width:26%">Semi-Annual<br><span style="font-size:9px;font-weight:400;opacity:0.8">(2 visits/yr)</span></th>
        <th style="width:26%">Annual<br><span style="font-size:9px;font-weight:400;opacity:0.8">(1 visit/yr)</span></th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="term-label">1 Year</td>
        <td class="price-cell">${fmtP(pt.y1q)}<span class="ds-anchor" id="anc-q1y">__q1y__</span></td>
        <td class="price-cell">${fmtP(pt.y1s)}<span class="ds-anchor" id="anc-sa1y">__sa1y__</span></td>
        <td class="price-cell">${fmtP(pt.y1a)}<span class="ds-anchor" id="anc-a1y">__a1y__</span></td>
      </tr>
      <tr class="disc-row">
        <td class="term-label">3 Year <span class="disc-badge">3% off</span></td>
        <td class="price-cell">${fmtP(pt.y3q)}<span class="ds-anchor" id="anc-q3y">__q3y__</span></td>
        <td class="price-cell">${fmtP(pt.y3s)}<span class="ds-anchor" id="anc-sa3y">__sa3y__</span></td>
        <td class="price-cell">${fmtP(pt.y3a)}<span class="ds-anchor" id="anc-a3y">__a3y__</span></td>
      </tr>
      <tr class="disc-row">
        <td class="term-label">5 Year <span class="disc-badge">5% off</span></td>
        <td class="price-cell">${fmtP(pt.y5q)}<span class="ds-anchor" id="anc-q5y">__q5y__</span></td>
        <td class="price-cell">${fmtP(pt.y5s)}<span class="ds-anchor" id="anc-sa5y">__sa5y__</span></td>
        <td class="price-cell">${fmtP(pt.y5a)}<span class="ds-anchor" id="anc-a5y">__a5y__</span></td>
      </tr>
    </tbody>
  </table>

  <div class="pricing-footer">
    <div class="pricing-lock">
      <span class="lock-icon">&#9650;</span>
      <span><strong>Lock in your rate today.</strong> Prices are subject to change. Multi-year agreements guarantee your rate for the full term — protecting you from future increases in labor and material costs.</span>
    </div>
    <div class="payment-terms-row">
      <span class="payment-label">Preferred payment terms:</span>
      <span class="payment-opt ${pt.paymentTerm === 'monthly' ? 'selected' : ''}"><span class="ds-anchor">__paymonthly__</span>&#9633; Monthly</span>
      <span class="payment-opt ${pt.paymentTerm === 'service' ? 'selected' : ''}"><span class="ds-anchor">__payservice__</span>&#9633; At time of service</span>
      <span class="payment-opt ${pt.paymentTerm === 'upfront' ? 'selected' : ''}"><span class="ds-anchor">__payupfront__</span>&#9633; Upfront / annual</span>
    </div>
    <div class="initial-row">
      <span><span class="ds-anchor">__custinit__</span>Customer initial: ____________</span>
      <span style="margin-left:40px;">Date: ____________</span>
    </div>
  </div>
  <div class="gap"></div>
  ` : '';

  // Build additions / exclusions sections
  const addExclHTML = (() => {
    let html = '';
    if (additions && additions.trim()) {
      const lines = additions.split('\n').filter(l => l.trim());
      html += `
      <div class="section-label">Additional services included</div>
      <div class="addexcl-box incl">
        ${lines.map(l => `<div class="addexcl-row"><span class="addexcl-bullet incl-bullet">+</span><span>${l.trim()}</span></div>`).join('')}
      </div>`;
    }
    if (exclusions && exclusions.trim()) {
      const lines = exclusions.split('\n').filter(l => l.trim());
      html += `
      <div class="section-label">Exclusions</div>
      <div class="addexcl-box excl">
        ${lines.map(l => `<div class="addexcl-row"><span class="addexcl-bullet excl-bullet">&minus;</span><span>${l.trim()}</span></div>`).join('')}
      </div>`;
    }
    return html;
  })();

  const surveyUnits = Array.isArray(data.surveyUnits) ? data.surveyUnits : [];
  const eqScheduleRows = equipment.map((e, i) => {
    const eq = EQ_CATALOG[e.id];
    const units = surveyUnits.filter(u => u.typeId === e.id);
    let rows = `<tr class="${i%2===1?'alt':''}">
      <td>${eq.name}</td><td>${e.qty}</td><td></td>
    </tr>`;
    units.forEach((u, j) => {
      const detail = u.detail || [
        [u.brand, u.model].filter(Boolean).join(' '),
        u.serial ? 'S/N ' + u.serial : '',
        u.year ? 'Mfg ' + u.year : '',
        u.filter ? 'Filter ' + u.filter : '',
      ].filter(Boolean).join(' &middot; ');
      if (detail) rows += `<tr class="${i%2===1?'alt':''}">
        <td style="padding-left:24px;font-size:9.5px;color:#777;">&ndash; Unit ${j+1}</td><td></td><td style="font-size:9.5px;color:#777;">${detail}</td>
      </tr>`;
    });
    return rows;
  }).join('');

  const eqScopeHTML = equipment.map(e => {
    const eq = EQ_CATALOG[e.id];
    const cats = Object.entries(eq.cats);
    const maxItems = Math.max(...cats.map(([,items]) => items.length));
    const totalPoints = cats.reduce((s,[,items]) => s + items.length, 0);
    const colW = Math.floor(100 / cats.length);

    const headerCells = cats.map(([cat]) =>
      `<th style="width:${colW}%">${cat}</th>`).join('');

    const itemRows = [];
    for (let i = 0; i < maxItems; i++) {
      const cells = cats.map(([,items]) =>
        `<td class="${i%2===1?'alt-row':''}">${items[i] ? '&middot;&nbsp; ' + items[i] : ''}</td>`
      ).join('');
      itemRows.push(`<tr>${cells}</tr>`);
    }

    return `
    <div class="eq-block">
      <div class="eq-header">
        <span class="eq-name">${eq.name}</span>
        <span class="eq-badge">${e.qty} unit${e.qty>1?'s':''} on site &middot; ${e.visits} visit${e.visits>1?'s':''} per year</span>
      </div>
      <table class="eq-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${itemRows.join('')}</tbody>
      </table>
      <div class="eq-footer">${totalPoints}+ inspection points per visit</div>
    </div>`;
  }).join('');

  const tcHTML = TC_SECTIONS.map(s => `
    <div class="tc-section">
      <div class="tc-heading">${s.h}</div>
      ${s.b.split('\n\n').map(p => `<p class="tc-body">${p.replace(/\n/g,'<br>')}</p>`).join('')}
    </div>`).join('');

  const sigLine = (label) => `
    <div class="sig-line-wrap">
      <div class="sig-line"></div>
      <div class="sig-label">${label}</div>
    </div>`;

  const sigLineSpaced = (label, extra) => `
    <div class="sig-line-wrap" style="margin-top:${extra}px;">
      <div class="sig-line"></div>
      <div class="sig-label">${label}</div>
    </div>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&family=Playfair+Display:wght@500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', Arial, sans-serif; font-size: 11px; color: #333; background: white; }

  /* ── Cover sheet ── */
  .cover { width: 100%; height: 100vh; display: flex; flex-direction: column; position: relative; page-break-after: always; }
  .cover-top { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 80px 40px; }
  .cover-logo { height: 80px; margin-bottom: 60px; }
  .cover-divider { width: 60px; height: 3px; background: #1B3A6B; margin: 0 auto 40px; }
  .cover-title { font-family: 'Playfair Display', serif; font-size: 32px; color: #1B3A6B; text-align: center; margin-bottom: 8px; letter-spacing: -0.3px; }
  .cover-subtitle { font-size: 13px; color: #888; text-align: center; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 70px; }
  .cover-customer-block { text-align: center; }
  .cover-customer-label { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #aaa; margin-bottom: 8px; }
  .cover-customer-name { font-family: 'Playfair Display', serif; font-size: 24px; color: #222; margin-bottom: 6px; }
  .cover-customer-address { font-size: 12px; color: #666; line-height: 1.7; }
  .cover-meta { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; margin-top: 60px; width: 100%; border-top: 1px solid #eee; }
  .cover-meta-item { padding: 20px 24px; border-right: 1px solid #eee; }
  .cover-meta-item:last-child { border-right: none; }
  .cover-meta-label { font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase; color: #aaa; margin-bottom: 5px; }
  .cover-meta-value { font-size: 12px; color: #333; font-weight: 500; }
  .cover-meta-value.proposal-num { color: #1B3A6B; font-family: 'DM Sans', sans-serif; }
  .cover-bottom { background: #1B3A6B; padding: 20px 40px; display: flex; align-items: center; justify-content: space-between; }
  .cover-bottom-co { font-family: 'Playfair Display', serif; font-size: 14px; color: white; }
  .cover-bottom-info { font-size: 10px; color: #AABCDD; text-align: right; line-height: 1.8; }

  /* ── Header ── */
  .doc-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 14px 0 10px; border-bottom: 3px solid #1B3A6B; }
  .doc-header img { height: 44px; }
  .header-right { text-align: right; font-size: 10px; color: #666; line-height: 1.9; }
  .header-right strong { color: #222; }

  /* ── Hero ── */
  .hero { background: #E8EEF7; padding: 12px 0; margin-bottom: 18px; }
  .hero h1 { font-family: 'Playfair Display', serif; font-size: 20px; color: #1B3A6B; margin-bottom: 5px; }
  .hero p { font-size: 10.5px; color: #444; line-height: 1.5; }

  /* ── Section labels ── */
  .section-label { font-size: 9px; font-weight: 500; letter-spacing: 1.8px; text-transform: uppercase;
    color: #1B3A6B; border-bottom: 2px solid #1B3A6B; padding-bottom: 5px; margin: 14px 0 8px; }

  /* ── Services ── */
  .services { padding: 0; }
  .service-row { display: flex; gap: 10px; margin-bottom: 8px; align-items: flex-start; }
  .check { color: #1B3A6B; font-size: 13px; font-weight: bold; flex-shrink: 0; margin-top: 1px; }
  .service-title { font-weight: 500; font-size: 11px; color: #333; margin-bottom: 1px; }
  .service-desc { font-size: 10px; color: #666; line-height: 1.45; }

  /* ── Benefits ── */
  .benefits-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; padding: 0; }
  .benefit { background: #F5F5F5; padding: 8px 12px; font-size: 10.5px; color: #444; border-radius: 4px; }

  /* ── Equipment schedule ── */
  .eq-schedule { margin: 0; width: 100%; border-collapse: collapse; font-size: 10.5px; }
  .eq-schedule thead th { background: #E8EEF7; color: #1B3A6B; font-weight: 500; padding: 7px 10px;
    text-align: left; border-bottom: 2px solid #1B3A6B; }
  .eq-schedule tbody td { padding: 7px 10px; border-bottom: 1px solid #E0E0E0; }
  .eq-schedule tbody tr.alt td { background: #FAFBFD; }
  .eq-schedule tfoot td { background: #E8EEF7; color: #1B3A6B; font-weight: 500; padding: 7px 10px; border-top: 2px solid #1B3A6B; }

  /* ── Additions / Exclusions ── */
  .addexcl-box { padding: 8px 0; margin-bottom: 4px; }
  .addexcl-row { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 5px; font-size: 10.5px; }
  .addexcl-bullet { font-weight: 700; font-size: 13px; flex-shrink: 0; line-height: 1.2; }
  .incl-bullet { color: #1B6B3A; }
  .excl-bullet { color: #8B1A1A; }
  .addexcl-box.incl { border-left: 3px solid #1B6B3A; padding-left: 12px; }
  .addexcl-box.excl { border-left: 3px solid #8B1A1A; padding-left: 12px; }

  /* ── Summary ── */
  .summary-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; padding: 0; }
  .summary-box { border: 1px solid #ddd; border-radius: 6px; padding: 12px 14px; }
  .summary-box.dark { background: #1B3A6B; border-color: #1B3A6B; }
  .summary-box-title { font-weight: 500; font-size: 11px; color: #1B3A6B; margin-bottom: 8px; }
  .summary-box.dark .summary-box-title { color: white; }
  .summary-row { display: flex; justify-content: space-between; font-size: 10px; color: #666;
    border-bottom: 1px solid #eee; padding: 4px 0; }
  .summary-row:last-child { border-bottom: none; }
  .summary-row strong { color: #222; font-weight: 500; }
  .summary-row.highlight strong { color: #1B3A6B; }
  .summary-desc { font-size: 10px; color: #555; line-height: 1.55; }
  .cta-line { font-size: 10.5px; color: white; margin-bottom: 3px; }
  .cta-line.muted { color: #AABCDD; font-size: 10px; }
  .cta-line.name { margin-top: 10px; }

  /* ── Signature ── */
  .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 0; }
  .sig-box { border: 1px solid #ddd; border-radius: 6px; padding: 14px 16px; }
  .sig-box-title { font-weight: 500; font-size: 11px; color: #1B3A6B; margin-bottom: 4px; }
  .sig-box-addr { font-size: 10px; color: #666; margin-bottom: 10px; line-height: 1.6; }
  .sig-line-wrap { margin-top: 14px; }
  .sig-line { border-bottom: 1px solid #888; height: 18px; margin-bottom: 3px; }
  .sig-label { font-size: 9px; color: #888; }

  /* ── Page breaks ── */
  .page-break { page-break-before: always; }
  .summary-grid { page-break-inside: avoid; }
  .summary-box  { page-break-inside: avoid; }
  .sig-grid     { page-break-inside: avoid; }
  .sig-box      { page-break-inside: avoid; }
  .section-label { page-break-after: avoid; }
  .services     { page-break-inside: avoid; }
  .benefits-grid{ page-break-inside: avoid; }
  .pricing-sel-table { page-break-inside: avoid; }
  .pricing-footer { page-break-inside: avoid; }

  /* ── DocuSign anchor text — invisible in PDF but found by DocuSign ── */
  .ds-anchor { font-size: 8pt; color: #f8f8f8; line-height: 1; }

  /* ── Pricing selection table ── */
  .pricing-sel-table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
  .pricing-sel-table thead th { background: #1B3A6B; color: white; padding: 8px 10px; text-align: center;
    font-weight: 500; font-size: 11px; line-height: 1.4; }
  .pricing-sel-table thead th:first-child { text-align: left; }
  .pricing-sel-table tbody td { padding: 9px 10px; border-bottom: 1px solid #eee; vertical-align: middle; }
  .pricing-sel-table tbody tr:last-child td { border-bottom: none; }
  .pricing-sel-table tbody tr:hover { background: #fafbfd; }
  .term-label { font-weight: 500; color: #1B3A6B; font-size: 11px; }
  .price-cell { text-align: center; font-size: 13px; font-weight: 500; color: #333; }
  .price-cell .sel-box { width: 14px; height: 14px; border: 1.5px solid #999; border-radius: 2px;
    display: inline-block; margin-left: 10px; vertical-align: middle; }
  .disc-row td { background: #F7F9FC; }
  .disc-badge { font-size: 9px; font-weight: 500; background: #E8EEF7; color: #1B3A6B;
    padding: 1px 5px; border-radius: 3px; margin-left: 4px; }
  .pricing-footer { margin-top: 10px; padding: 10px 14px; background: #F7F9FC; border-radius: 6px;
    border: 1px solid #E8EEF7; }
  .pricing-lock { display: flex; gap: 8px; align-items: flex-start; font-size: 10px; color: #444;
    line-height: 1.55; margin-bottom: 10px; }
  .lock-icon { color: #1B3A6B; font-size: 12px; flex-shrink: 0; margin-top: 1px; }
  .payment-terms-row { display: flex; align-items: center; gap: 16px; font-size: 11px; margin-bottom: 8px; flex-wrap: wrap; }
  .payment-label { font-weight: 500; color: #1B3A6B; }
  .payment-opt { color: #555; }
  .payment-opt.selected { font-weight: 500; color: #1B3A6B; }
  .initial-row { font-size: 11px; color: #555; margin-top: 6px; }

  /* ── Scope of work ── */
  .scope-hero { background: #E8EEF7; padding: 12px 0; margin-bottom: 16px; }
  .scope-hero h2 { font-family: 'Playfair Display', serif; font-size: 18px; color: #1B3A6B; margin-bottom: 4px; }
  .scope-hero p { font-size: 10px; color: #555; }

  .eq-block { margin: 0 0 16px; }
  .eq-header { background: #1B3A6B; color: white; padding: 10px 14px; border-radius: 5px 5px 0 0;
    display: flex; justify-content: space-between; align-items: center; }
  .eq-name { font-weight: 500; font-size: 12px; }
  .eq-badge { font-size: 9.5px; color: #AABCDD; background: rgba(255,255,255,0.12); padding: 2px 9px; border-radius: 10px; }
  .eq-table { width: 100%; border-collapse: collapse; }
  .eq-table thead th { background: #E8EEF7; color: #1B3A6B; font-weight: 500; font-size: 9.5px;
    letter-spacing: 0.8px; text-transform: uppercase; padding: 7px 10px;
    border-bottom: 2px solid #B5D4F4; text-align: left; }
  .eq-table td { font-size: 10px; color: #444; padding: 6px 10px; border-bottom: 1px solid #EEF3FA;
    border-right: 1px solid #EEF3FA; vertical-align: top; }
  .eq-table td.alt-row { background: #FAFBFD; }
  .eq-footer { background: #F5F5F5; padding: 6px 14px; font-size: 9.5px; color: #888;
    border-top: 1px solid #ddd; border-radius: 0 0 5px 5px; }

  /* ── T&C ── */
  .tc-hero { background: #E8EEF7; padding: 12px 0; margin-bottom: 16px; }
  .tc-hero h2 { font-family: 'Playfair Display', serif; font-size: 18px; color: #1B3A6B; margin-bottom: 4px; }
  .tc-hero p { font-size: 10px; color: #555; }
  .tc-section { padding: 0; margin-bottom: 10px; }
  .tc-heading { font-weight: 500; font-size: 11px; color: #1B3A6B; margin-bottom: 4px; margin-top: 12px; }
  .tc-body { font-size: 10px; color: #444; line-height: 1.6; margin-bottom: 4px; text-align: justify; }

  /* ── Spacers ── */
  .gap { height: 16px; }
  .gap-sm { height: 10px; }
</style>
</head>
<body>

<!-- ══ COVER SHEET ════════════════════════════════════════════════════════ -->
<div class="cover">
  <div class="cover-top">
    <img src="data:image/png;base64,${LOGO_B64}" class="cover-logo" alt="American Air">
    <div class="cover-divider"></div>
    <div class="cover-title">Preventative Maintenance</div>
    <div class="cover-title" style="margin-top:-8px;">Agreement</div>
    <div class="cover-subtitle" style="margin-top:12px;">Prepared for</div>

    <div class="cover-customer-block">
      <div class="cover-customer-name">${facility}</div>
      ${address ? `<div class="cover-customer-address">${address}</div>` : ''}
      ${contact ? `<div class="cover-customer-address" style="margin-top:4px;">Attn: ${contact}</div>` : ''}
    </div>

    <div class="cover-meta">
      <div class="cover-meta-item">
        <div class="cover-meta-label">Proposal number</div>
        <div class="cover-meta-value proposal-num">${proposalNumber}</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Date</div>
        <div class="cover-meta-value">${date}</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Prepared by</div>
        <div class="cover-meta-value">${salesName}</div>
        <div style="font-size:10px;color:#888;margin-top:2px;">${salesPhone}</div>
      </div>
    </div>
  </div>

  <div class="cover-bottom">
    <div class="cover-bottom-co">American Air, Inc.</div>
    <div class="cover-bottom-info">
      80 Brick Kiln Road, Chelmsford MA 01824<br>
      978-640-8880 &nbsp;&middot;&nbsp; americanairinc.com
    </div>
  </div>
</div>

<!-- ══ PAGE 1 ══════════════════════════════════════════════════════════════ -->

<div class="doc-header">
  <img src="data:image/png;base64,${LOGO_B64}" alt="American Air">
  <div class="header-right">
    Facility: <strong>${facility}</strong><br>
    Contact: <strong>${contact}</strong><br>
    Proposal: <strong>${proposalNumber}</strong> &nbsp;|&nbsp; Date: <strong>${date}</strong><br>
    Prepared by: <strong>${salesName}</strong> &nbsp;|&nbsp; ${salesPhone} &nbsp;|&nbsp; ${salesEmail}
  </div>
</div>

<div class="hero">
  <h1>Preventative Maintenance Agreement</h1>
  <p>Scheduled, documented service by licensed technicians — designed to protect your equipment investment,<br>maintain tenant comfort, and keep your facilities code-compliant all year long.</p>
</div>

<div class="section-label">Services performed at every scheduled visit</div>
<div class="services">${servicesHTML}</div>

<div class="gap"></div>
<div class="section-label">Agreement benefits</div>
${benefitsHTML}

<div class="gap"></div>
<div class="section-label">Covered equipment schedule</div>
<table class="eq-schedule">
  <thead><tr><th style="width:45%">Equipment Type</th><th style="width:10%">Qty</th><th>Model / Serial / Notes</th></tr></thead>
  <tbody>${eqScheduleRows}</tbody>
  <tfoot><tr><td><strong>Total Units Covered</strong></td><td><strong>${totalUnits}</strong></td><td></td></tr></tfoot>
</table>


<div class="page-break"></div>
<div style="page-break-inside: avoid;">
${pricingTableHTML}
<div class="gap-sm"></div>
<div class="section-label">Agreement execution</div>
<div class="sig-grid">
  <div class="sig-box">
    <div class="sig-box-title">Client</div>
    <div class="sig-box-addr">${facility}${address ? '<br>' + address : ''}</div>
    ${sigLine('Approved By')}
    ${sigLine('Title')}
    ${sigLine('Date')}
    ${sigLine('Signature')}
    ${sigLine('Purchase Order (Optional)')}
    ${sigLine('Agreement Start Date')}
  </div>
  <div class="sig-box" style="margin-top:18px;">
    <div class="sig-box-title">American Air LLC</div>
    <div class="sig-box-addr">80 Brick Kiln Road<br>Chelmsford, MA 01824<br>Ph: 978-640-8880</div>
    ${sigLine('Submitted By: ' + salesName)}
    ${sigLineSpaced('Signature', 22)}
    ${sigLineSpaced('Date', 15)}
  </div>
</div>
</div><!-- end keep-together -->

<!-- ══ PAGE 2 — SCOPE ══════════════════════════════════════════════════════ -->
<div class="page-break"></div>

<div class="doc-header">
  <img src="data:image/png;base64,${LOGO_B64}" alt="American Air">
  <div class="header-right">Facility: <strong>${facility}</strong> &nbsp;|&nbsp; Date: <strong>${date}</strong></div>
</div>

<div class="scope-hero">
  <h2>Exhibit A — Scope of Work</h2>
  <p>Full inspection checklist for all covered equipment at ${facility}. Performed by a licensed technician at every scheduled visit.</p>
</div>

${eqScopeHTML}

${addExclHTML}

<p style="font-size:9.5px;color:#888;font-style:italic;padding:8px 0;border-top:1px solid #ddd;margin:0;">
  This scope of work applies to all units of each type listed above. Additional findings or repairs outside this scope will be presented in writing for customer approval prior to any work being performed.
</p>

<!-- ══ PAGE 3 — T&C ════════════════════════════════════════════════════════ -->
<div class="page-break"></div>

<div class="doc-header">
  <img src="data:image/png;base64,${LOGO_B64}" alt="American Air">
  <div class="header-right">Facility: <strong>${facility}</strong> &nbsp;|&nbsp; Date: <strong>${date}</strong></div>
</div>

<div class="tc-hero">
  <h2>Planned Maintenance Terms and Conditions</h2>
  <p>American Air LLC &middot; 80 Brick Kiln Road, Chelmsford MA 01824 &middot; 978-640-8880</p>
</div>

${tcHTML}

</body>
</html>`;
}

// ── S.H.I.E.L.D. Report (System Health Inspection & Equipment Lifecycle Diagnostic) ──
// Lifespans per the equipment-health-report methodology (light-commercial HVAC)
const SHIELD_LIFESPANS = { rtu: 15, split: 15, mini: 15, vrf: 15, vav: 15, reznor: 18, mau: 18, exhaust: 15, boiler: 25, erv: 15 };
const SHIELD_STATUS = {
  good:    { label: 'Good',                   color: '#2e7d32', bg: '#e8f5e9' },
  monitor: { label: 'Monitor',                color: '#e65100', bg: '#fff8e1' },
  plan:    { label: 'Plan Replacement',       color: '#ef6c00', bg: '#ffe0b2' },
  eol:     { label: 'End of Life',            color: '#c62828', bg: '#fce4ec' },
  assess:  { label: 'Site Assessment Needed', color: '#5E35B1', bg: '#ede7f6' },
};

function shieldClassify(u, nowYear) {
  const lifespan = SHIELD_LIFESPANS[u.typeId] || 15;
  if (!u.year || u.year < 1950) return { status: 'assess', lifespan, age: null, pct: null, replaceYear: null };
  const age = nowYear - u.year;
  const pct = age / lifespan;
  const status = pct >= 1 ? 'eol' : pct >= 0.75 ? 'plan' : pct >= 0.5 ? 'monitor' : 'good';
  return { status, lifespan, age, pct, replaceYear: u.year + lifespan };
}

function buildShieldHTML(d) {
  const nowYear = new Date().getFullYear();
  const units = (d.units || []).map(u => ({ ...u, ...shieldClassify(u, nowYear) }));
  const dated  = units.filter(u => u.age !== null);
  const counts = { good: 0, monitor: 0, plan: 0, eol: 0, assess: 0 };
  units.forEach(u => counts[u.status]++);
  const oldest = dated.length ? Math.max(...dated.map(u => u.age)) : null;

  // Donut chart (SVG stroke segments)
  const order = ['eol', 'plan', 'monitor', 'good', 'assess'];
  const total = units.length || 1;
  const C = 2 * Math.PI * 54;
  let offset = 0;
  const donutSegs = order.filter(s => counts[s] > 0).map(s => {
    const frac = counts[s] / total;
    const seg = `<circle cx="70" cy="70" r="54" fill="none" stroke="${SHIELD_STATUS[s].color}" stroke-width="22"
      stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset * C).toFixed(2)}"
      transform="rotate(-90 70 70)"/>`;
    offset += frac;
    return seg;
  }).join('');
  const legend = order.filter(s => counts[s] > 0).map(s =>
    `<div style="display:flex;align-items:center;gap:6px;font-size:10px;color:#444;margin-bottom:4px;">
      <span style="width:10px;height:10px;border-radius:2px;background:${SHIELD_STATUS[s].color};display:inline-block;"></span>
      ${SHIELD_STATUS[s].label} — <strong>${counts[s]}</strong></div>`).join('');

  // Headline
  const headline = counts.eol > 0
    ? `${counts.eol} of ${units.length} systems ${counts.eol === 1 ? 'is' : 'are'} at or past end of design life — replacement planning should begin now.`
    : counts.plan > 0
    ? `${counts.plan} of ${units.length} systems ${counts.plan === 1 ? 'is' : 'are'} in the final quarter of design life — budget planning is recommended.`
    : `The equipment fleet is in serviceable condition — preventative maintenance will protect the remaining life.`;

  // Equipment rows with lifespan bars
  const rows = units
    .sort((a, b) => (b.pct || 0) - (a.pct || 0))
    .map((u, i) => {
      const st = SHIELD_STATUS[u.status];
      const pctTxt = u.pct !== null ? Math.round(u.pct * 100) + '%' : '—';
      const barW = u.pct !== null ? Math.min(100, Math.round(u.pct * 100)) : 0;
      const bar = u.pct !== null
        ? `<div style="background:#eee;border-radius:4px;height:10px;width:100%;overflow:hidden;">
             <div style="background:${st.color};height:10px;width:${barW}%;"></div></div>
           <div style="font-size:8.5px;color:${st.color};font-weight:500;margin-top:1px;">${pctTxt} of design life</div>`
        : `<div style="font-size:9px;color:${st.color};">Serial/date unverified</div>`;
      return `<tr style="${i % 2 ? 'background:#fafbfd;' : ''}">
        <td>${u.label || 'Unit'}${u.location ? `<div style="font-size:8.5px;color:#999;">${u.location}</div>` : ''}</td>
        <td>${[u.brand, u.model].filter(Boolean).join(' ') || '—'}<div style="font-size:8.5px;color:#999;">${u.serial ? 'S/N ' + u.serial : ''}</div></td>
        <td style="text-align:center;">${u.year || '—'}</td>
        <td style="text-align:center;">${u.age !== null ? u.age + ' yrs' : '—'}</td>
        <td style="width:24%;">${bar}</td>
        <td><span style="background:${st.bg};color:${st.color};padding:2px 8px;border-radius:8px;font-size:9px;font-weight:500;white-space:nowrap;">${st.label}</span></td>
      </tr>`;
    }).join('');

  // 5-year replacement forecast
  const horizon = [];
  for (let y = nowYear; y <= nowYear + 5; y++) {
    const list = y === nowYear ? dated.filter(u => u.replaceYear <= nowYear) : dated.filter(u => u.replaceYear === y);
    if (list.length) horizon.push({ year: y === nowYear ? nowYear + ' (now)' : String(y), list });
  }
  const forecastRows = horizon.map(h => `<tr>
      <td style="font-weight:500;color:#1B3A6B;white-space:nowrap;">${h.year}</td>
      <td style="text-align:center;font-weight:500;">${h.list.length}</td>
      <td>${h.list.map(u => (u.label || 'Unit') + (u.location ? ' (' + u.location + ')' : '')).join(' · ')}</td>
    </tr>`).join('');

  const assessList = units.filter(u => u.status === 'assess');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Playfair+Display:wght@500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', Arial, sans-serif; font-size: 11px; color: #333; }
  .page-break { page-break-before: always; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 7px 9px; font-size: 10px; border-bottom: 1px solid #eee; vertical-align: middle; text-align: left; }
  thead th { background: #1B3A6B; color: white; font-weight: 500; font-size: 9.5px; letter-spacing: 0.5px; }
  .section-label { font-size: 9px; font-weight: 500; letter-spacing: 1.8px; text-transform: uppercase;
    color: #1B3A6B; border-bottom: 2px solid #1B3A6B; padding-bottom: 5px; margin: 18px 0 10px; }
  </style></head><body>

  <!-- Cover -->
  <div style="text-align:center;padding-top:30px;">
    <img src="data:image/png;base64,${LOGO_B64}" style="height:64px;">
    <div style="font-family:'Playfair Display',serif;font-size:34px;color:#1B3A6B;margin-top:24px;letter-spacing:2px;">S.H.I.E.L.D. Report</div>
    <div style="font-size:11px;color:#888;letter-spacing:2px;text-transform:uppercase;margin-top:4px;">System Health Inspection &amp; Equipment Lifecycle Diagnostic</div>
    <div style="width:60px;height:3px;background:#1B3A6B;margin:18px auto;"></div>
    <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#aaa;">Prepared for</div>
    <div style="font-family:'Playfair Display',serif;font-size:22px;color:#222;margin-top:4px;">${d.facility || ''}</div>
    ${d.address ? `<div style="font-size:11px;color:#666;margin-top:3px;">${d.address}</div>` : ''}
    <div style="font-size:12px;color:#444;max-width:520px;margin:20px auto 0;line-height:1.6;font-weight:500;">${headline}</div>
  </div>

  <div style="display:flex;justify-content:center;gap:14px;margin-top:26px;">
    ${[['Systems audited', units.length], ['Past end of life', counts.eol], ['Plan replacement', counts.plan], ['Oldest asset', oldest !== null ? oldest + ' yrs' : '—']]
      .map(([l, v]) => `<div style="border:1px solid #ddd;border-radius:8px;padding:14px 18px;text-align:center;min-width:110px;">
        <div style="font-size:24px;font-weight:700;color:#1B3A6B;">${v}</div>
        <div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#888;margin-top:4px;">${l}</div></div>`).join('')}
  </div>

  <div style="display:flex;justify-content:center;align-items:center;gap:30px;margin-top:26px;">
    <svg width="140" height="140" viewBox="0 0 140 140">${donutSegs}
      <text x="70" y="66" text-anchor="middle" font-size="22" font-weight="700" fill="#1B3A6B" font-family="DM Sans, Arial">${units.length}</text>
      <text x="70" y="82" text-anchor="middle" font-size="8" fill="#888" font-family="DM Sans, Arial">SYSTEMS</text></svg>
    <div>${legend}</div>
  </div>

  <div style="position:fixed;bottom:0;left:0;right:0;background:#1B3A6B;padding:14px 30px;display:flex;justify-content:space-between;font-size:9.5px;color:#AABCDD;">
    <span>Prepared for: <strong style="color:white;">${d.facility || ''}</strong></span>
    <span>Prepared by: <strong style="color:white;">American Air, Inc.${d.salesName ? ' — ' + d.salesName : ''}</strong></span>
    <span>${d.date || ''}</span>
  </div>

  <!-- Equipment detail -->
  <div class="page-break"></div>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:14px 0 10px;border-bottom:3px solid #1B3A6B;">
    <img src="data:image/png;base64,${LOGO_B64}" style="height:40px;">
    <div style="text-align:right;font-size:10px;color:#666;line-height:1.8;">
      ${d.facility || ''}<br>S.H.I.E.L.D. Report &middot; ${d.date || ''}</div>
  </div>

  <div class="section-label">Equipment Lifecycle Status</div>
  <table>
    <thead><tr><th>Equipment</th><th>Make / Model</th><th style="text-align:center;">Year</th><th style="text-align:center;">Age</th><th>Design Life Consumed</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  ${forecastRows ? `<div class="section-label">5-Year Replacement Forecast</div>
  <table>
    <thead><tr><th style="width:14%;">Budget Year</th><th style="width:10%;text-align:center;">Systems</th><th>Equipment Due</th></tr></thead>
    <tbody>${forecastRows}</tbody>
  </table>
  <p style="font-size:9px;color:#888;margin-top:6px;font-style:italic;">Replacement year = manufacture/install year + industry-standard design life. Well-maintained equipment routinely exceeds design life; this forecast is a budgeting guide, not a guarantee of failure.</p>` : ''}

  ${assessList.length ? `<div class="section-label" style="border-color:#5E35B1;color:#5E35B1;">Site Assessment Needed</div>
  <p style="font-size:10px;color:#555;margin-bottom:6px;">${assessList.length} unit${assessList.length !== 1 ? 's' : ''} could not be dated from records or serial numbers. We recommend a walkthrough to verify:</p>
  ${assessList.map(u => `<div style="font-size:10px;color:#555;padding:5px 10px;background:#ede7f6;border-radius:4px;margin-bottom:4px;">${u.label}${u.location ? ' — ' + u.location : ''} ${[u.brand, u.model].filter(Boolean).join(' ')}</div>`).join('')}` : ''}

  <div style="margin-top:20px;background:#E8EEF7;border-radius:8px;padding:14px 18px;">
    <div style="font-weight:500;color:#1B3A6B;font-size:11px;margin-bottom:5px;">Protecting the remaining life of this fleet</div>
    <div style="font-size:10px;color:#444;line-height:1.6;">Scheduled preventative maintenance is the single largest factor in whether equipment reaches — or exceeds — its design life.
    American Air's Preventative Maintenance Agreement includes the inspections, cleaning, and adjustments that protect these systems, plus capital-expenditure planning support so replacements land on your budget, not as emergencies.
    ${d.salesName ? `Contact ${d.salesName}${d.salesPhone ? ' at ' + d.salesPhone : ''}${d.salesEmail ? ' or ' + d.salesEmail : ''} to discuss.` : ''}</div>
  </div>

  </body></html>`;
}

app.post('/shield-report', async (req, res) => {
  try {
    const pw = req.headers['x-site-password'];
    if (pw !== (process.env.SITE_PASSWORD || 'americanair')) return res.status(401).json({ error: 'Unauthorized' });
    const data = req.body || {};
    if (!Array.isArray(data.units) || data.units.length === 0)
      return res.status(400).json({ error: 'No equipment to report on' });
    const html = buildShieldHTML(data);
    const browser = await puppeteer.launch({ args: chromium.args, defaultViewport: chromium.defaultViewport, executablePath: await chromium.executablePath(), headless: chromium.headless });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' } });
    await browser.close();
    const filename = `${(data.facility || 'Customer').replace(/[^a-z0-9]/gi, '_')}_SHIELD_Report.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdf);
  } catch (err) {
    console.error('SHIELD report error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/generate', async (req, res) => {
  try {
    const data = req.body;
    data.proposalNumber = getNextProposalNumber();
    const html = buildHTML(data);

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });
    await browser.close();

    const filename = `${data.proposalNumber}_${data.facility.replace(/[^a-z0-9]/gi,'_')}_PMA.pdf`;

    // ── Save PDF to disk ──────────────────────────────────────────────────
    const PDF_DIR = path.join(DATA_DIR, 'pdfs');
    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);
    fs.writeFileSync(path.join(PDF_DIR, `${data.proposalNumber}.pdf`), pdf);

    // ── Log proposal to history ───────────────────────────────────────────
    const LOG_FILE = path.join(DATA_DIR, 'proposal_log.json');
    try {
      let log = [];
      try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
      const eqSummary = data.equipment.map(e => {
        const eq = EQ_CATALOG[e.id];
        return eq ? `${e.qty}x ${eq.name}` : e.id;
      }).join(', ');
      log.unshift({
        proposalNumber: data.proposalNumber,
        facility:       data.facility,
        contact:        data.contact,
        salesName:      data.salesName,
        salesPhone:     data.salesPhone,
        salesEmail:     data.salesEmail,
        date:           data.date,
        price:          data.price,
        duration:       data.duration,
        equipment:      eqSummary,
        annualValue:    data.annualValue || 0,
        status:         'open',
        generatedAt:    new Date().toISOString(),
      });
      fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
    } catch(e) { console.error('Log error:', e.message); }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdf);

  } catch(err) {
    console.error('PDF generation error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || String(err) });
    }
  }
});

// ── Re-download saved PDF ────────────────────────────────────────────────
app.get('/download/:proposalNumber', (req, res) => {
  const pw = req.headers['x-admin-password'] || req.query.pw || '';
  const SITE_PW = process.env.SITE_PASSWORD || 'americanair';
  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'aaadmin';
  if (pw !== SITE_PW && pw !== ADMIN_PW) return res.status(401).json({ error: 'Unauthorized' });
  const num = req.params.proposalNumber.replace(/[^a-zA-Z0-9\-]/g, '');
  const filePath = path.join(DATA_DIR, 'pdfs', `${num}.pdf`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${num}_PMA.pdf"`);
  res.setHeader('Content-Type', 'application/pdf');
  res.send(fs.readFileSync(filePath));
});


// ── Update proposal status ────────────────────────────────────────────────
app.post('/update-proposal-status', (req, res) => {
  const pw = req.headers['x-site-password'] || req.headers['x-admin-password'];
  const SITE_PW  = process.env.SITE_PASSWORD  || 'americanair';
  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'aaadmin';
  if (pw !== SITE_PW && pw !== ADMIN_PW) return res.status(401).json({ error: 'Unauthorized' });
  const { proposalNumber, status } = req.body;
  if (!proposalNumber || !['won','lost','sent','open'].includes(status)) return res.status(400).json({ error: 'Invalid' });
  const LOG_FILE = path.join(DATA_DIR, 'proposal_log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
  log = log.map(p => p.proposalNumber === proposalNumber ? { ...p, status } : p);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  res.json({ ok: true });
});


// ── Delete proposal ───────────────────────────────────────────────────────
app.post('/delete-proposal', (req, res) => {
  const pw = req.headers['x-site-password'];
  if (pw !== (process.env.SITE_PASSWORD || 'americanair')) return res.status(401).json({ error: 'Unauthorized' });
  const { proposalNumber } = req.body;
  if (!proposalNumber) return res.status(400).json({ error: 'Missing proposalNumber' });
  const LOG_FILE = path.join(DATA_DIR, 'proposal_log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
  const before = log.length;
  log = log.filter(p => p.proposalNumber !== proposalNumber);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  // Also delete the PDF if it exists
  const pdfPath = path.join(DATA_DIR, 'pdfs', `${proposalNumber}.pdf`);
  try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch(e) {}
  res.json({ ok: true, removed: before - log.length });
});


// ── DocuSign Connect Webhook ──────────────────────────────────────────────
// Receives envelope completion events from DocuSign Connect
app.post('/docusign-webhook', express.raw({ type: 'application/json', limit: '5mb' }), (req, res) => {
  try {
    // DocuSign sends JSON — parse raw body
    const body = JSON.parse(req.body.toString());

    const event    = body.event;
    const envelope = body.data && body.data.envelopeSummary ? body.data.envelopeSummary : body.envelopeSummary;

    if (!envelope) { return res.status(200).send('ok'); }

    const envelopeId = envelope.envelopeId;
    const status     = (envelope.status || '').toLowerCase();

    console.log(`DocuSign webhook: envelopeId=${envelopeId} status=${status}`);

    // Only act on 'completed' (both parties signed)
    if (status === 'completed' && envelopeId) {
      const LOG_FILE = path.join(DATA_DIR, 'proposal_log.json');
      let log = [];
      try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}

      const match = log.find(p => p.envelopeId === envelopeId);
      if (match) {
        // Parse which pricing checkbox was selected
        let contractLength = null;
        let frequency = null;
        try {
          const recipients = envelope.recipients || {};
          const signers = recipients.signers || [];
          // Customer is signer 1
          const customer = signers.find(s => s.routingOrder === '1' || s.routingOrder === 1);
          if (customer && customer.tabs && customer.tabs.checkboxTabs) {
            const checked = customer.tabs.checkboxTabs.filter(t => t.selected === 'true' || t.selected === true);
            console.log('Checked tabs:', checked.map(t => t.tabLabel));
            // Determine contract length and frequency from tab label
            // Labels: Q1yr, SA1yr, A1yr, Q3yr, SA3yr, A3yr, Q5yr, SA5yr, A5yr
            const freqMap = { Q: 'Quarterly', SA: 'Semi-Annual', A: 'Annual' };
            const lenMap  = { '1yr': 1, '3yr': 3, '5yr': 5 };
            for (const tab of checked) {
              const label = tab.tabLabel || '';
              for (const [key, len] of Object.entries(lenMap)) {
                if (label.endsWith(key)) {
                  contractLength = len;
                  const freqKey = label.replace(key, '');
                  frequency = freqMap[freqKey] || freqKey;
                }
              }
            }
          }
        } catch(e) { console.log('Tab parse error:', e.message); }

        // Calculate expiration date
        let expiresAt = null;
        const signedAt = new Date().toISOString();
        if (contractLength) {
          const exp = new Date();
          exp.setFullYear(exp.getFullYear() + contractLength);
          expiresAt = exp.toISOString();
        }

        console.log(`Contract: ${contractLength}yr ${frequency}, expires: ${expiresAt}`);

        log = log.map(p => p.envelopeId === envelopeId ? {
          ...p,
          status: 'won',
          signedAt,
          contractLength,
          frequency,
          expiresAt,
        } : p);
        fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
        console.log(`Marked ${match.proposalNumber} as WON via DocuSign webhook`);
      } else {
        console.log(`Webhook: no proposal found for envelopeId=${envelopeId}`);
      }
    }

    res.status(200).send('ok');
  } catch(e) {
    console.error('Webhook error:', e.message);
    res.status(200).send('ok'); // Always return 200 to DocuSign
  }
});

// ── Admin dashboard routes ────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'aaadmin';

app.post('/admin-auth', (req, res) => {
  const { password } = req.body;
  res.json({ ok: password === ADMIN_PASSWORD });
});


// ── My Proposals (rep-facing, site password protected) ───────────────────────
app.get('/my-proposals', (req, res) => {
  const pw = req.headers['x-site-password'];
  if (pw !== (process.env.SITE_PASSWORD || 'americanair')) return res.status(401).json({ error: 'Unauthorized' });
  const LOG_FILE = path.join(DATA_DIR, 'proposal_log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
  res.json(log);
});

app.get('/admin-data', (req, res) => {
  const pw = req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const LOG_FILE = path.join(DATA_DIR, 'proposal_log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
  res.json(log);
});

// ── DocuSign send route ───────────────────────────────────────────────────────
app.post('/send-docusign', async (req, res) => {
  try {
    const pw = req.headers['x-site-password'];
    if (pw !== (process.env.SITE_PASSWORD || 'americanair')) return res.status(401).json({ error:'Unauthorized' });
    const data = req.body;
    data.proposalNumber = getNextProposalNumber();
    const html    = buildHTML(data);
    const browser = await puppeteer.launch({ args: chromium.args, defaultViewport: chromium.defaultViewport, executablePath: await chromium.executablePath(), headless: chromium.headless });
    const page    = await browser.newPage();
    await page.setContent(html, { waitUntil:'networkidle0' });
    const pdf = await page.pdf({ format:'Letter', printBackground:true, margin:{top:'0.5in',right:'0.5in',bottom:'0.5in',left:'0.5in'} });
    await browser.close();
    const filename = `${data.proposalNumber}_${data.facility.replace(/[^a-z0-9]/gi,'_')}_PMA.pdf`;
    const PDF_DIR  = path.join(DATA_DIR, 'pdfs');
    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);
    fs.writeFileSync(path.join(PDF_DIR, `${data.proposalNumber}.pdf`), pdf);
    const LOG_FILE = path.join(DATA_DIR, 'proposal_log.json');
    try {
      let log = []; try { log = JSON.parse(fs.readFileSync(LOG_FILE,'utf8')); } catch(e) {}
      const eq = data.equipment.map(e => { const eq = EQ_CATALOG[e.id]; return eq ? `${e.qty}x ${eq.name}` : e.id; }).join(', ');
      log.unshift({ proposalNumber:data.proposalNumber, facility:data.facility, contact:data.contact, salesName:data.salesName, salesPhone:data.salesPhone, salesEmail:data.salesEmail, date:data.date, equipment:eq, sentViaDocuSign:true, customerEmail:data.customerEmail, generatedAt:new Date().toISOString() });
      fs.writeFileSync(LOG_FILE, JSON.stringify(log,null,2));
    } catch(e) { console.error('Log error:',e.message); }
    const envelopeId = await createDSEnvelope({ pdfBuffer:Buffer.from(pdf), filename, customerName:data.customerName||data.contact, customerEmail:data.customerEmail, repName:data.salesName, repEmail:'Clayton@americanairinc.com', date:data.date });
    res.json({ ok:true, envelopeId, proposalNumber:data.proposalNumber });
  } catch(err) { console.error('DocuSign send error:', err); if (!res.headersSent) res.status(500).json({ error: err.message||String(err) }); }
});

app.post('/resend-docusign', async (req, res) => {
  try {
    const pw = req.headers['x-site-password'];
    if (pw !== (process.env.SITE_PASSWORD || 'americanair')) return res.status(401).json({ error:'Unauthorized' });
    const { proposalNumber, customerName, customerEmail, repName, repEmail } = req.body;
    const filePath = path.join(DATA_DIR, 'pdfs', `${proposalNumber}.pdf`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error:'PDF not found — please regenerate the proposal first.' });
    const pdfBuffer  = fs.readFileSync(filePath);
    const envelopeId = await createDSEnvelope({ pdfBuffer, filename:`${proposalNumber}_PMA.pdf`, customerName, customerEmail, repName, repEmail:'Clayton@americanairinc.com', date:'' });
    res.json({ ok:true, envelopeId, proposalNumber });
  } catch(err) { console.error('Resend error:', err); if (!res.headersSent) res.status(500).json({ error: err.message||String(err) }); }
});

// Debug route — check if anchor text is in PDF
app.post('/debug-pdf-text', async (req, res) => {
  try {
    const pw = req.headers['x-site-password'];
    if (pw !== (process.env.SITE_PASSWORD || 'americanair')) return res.status(401).json({ error:'Unauthorized' });
    const data = req.body;
    data.proposalNumber = 'DEBUG-001';
    const html = buildHTML(data);
    const browser = await puppeteer.launch({ args: chromium.args, defaultViewport: chromium.defaultViewport, executablePath: await chromium.executablePath(), headless: chromium.headless });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil:'networkidle0' });
    const pdf = await page.pdf({ format:'Letter', printBackground:true, margin:{top:'0.5in',right:'0.5in',bottom:'0.5in',left:'0.5in'} });
    await browser.close();
    // Check if anchor strings appear in raw PDF bytes
    const pdfStr = pdf.toString('utf8');
    const anchors = ['__custsign__','__custdate__','__custinit__','__repsign__','__repdate__','__q1y__','__sa1y__','__a1y__'];
    const found = anchors.filter(a => pdfStr.includes(a));
    const missing = anchors.filter(a => !pdfStr.includes(a));
    res.json({ found, missing, pdfSize: pdf.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n  American Air Proposal Tool\n  Open: http://localhost:${PORT}\n  Dashboard: http://localhost:${PORT}/dashboard.html\n`));
