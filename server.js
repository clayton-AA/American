
const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const crypto    = require('crypto');
const app = express();

app.use(express.json({ limit: '5mb' }));

// ── DocuSign config ───────────────────────────────────────────────────────────
const DS_INT_KEY    = process.env.DOCUSIGN_INTEGRATION_KEY || '';
const DS_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID     || '';
const DS_USER_ID    = process.env.DOCUSIGN_USER_ID         || '';
const DS_PRIVATE_KEY= (process.env.DOCUSIGN_PRIVATE_KEY   || '').replace(/\\n/g,'\n');

function httpsReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getDSToken() {
  const header  = { alg:'RS256', typ:'JWT' };
  const now     = Math.floor(Date.now()/1000);
  const payload = { iss: DS_INT_KEY, sub: DS_USER_ID, aud:'account-d.docusign.com', iat: now, exp: now+3600, scope:'signature impersonation' };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(DS_PRIVATE_KEY,'base64url')}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const resp = await httpsReq({ hostname:'account-d.docusign.com', path:'/oauth/token', method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)} }, body);
  if (!resp.body.access_token) throw new Error('DocuSign auth failed: ' + JSON.stringify(resp.body));
  return resp.body.access_token;
}

async function createDSEnvelope({ pdfBuffer, filename, customerName, customerEmail, repName, repEmail }) {
  const token = await getDSToken();
  const envelope = {
    emailSubject: `Preventative Maintenance Agreement — Please Sign`,
    emailBlurb:   `Please review and sign your Preventative Maintenance Agreement with American Air, Inc.`,
    documents: [{ documentBase64: pdfBuffer.toString('base64'), name: filename, fileExtension: 'pdf', documentId: '1' }],
    recipients: {
      signers: [
        { email: customerEmail, name: customerName, recipientId: '1', routingOrder: '1',
          tabs: {
            signHereTabs:   [{ documentId:'1', pageNumber:'2', xPosition:'60',  yPosition:'620' }],
            dateSignedTabs: [{ documentId:'1', pageNumber:'2', xPosition:'330', yPosition:'620' }],
            initialHereTabs:[{ documentId:'1', pageNumber:'2', xPosition:'60',  yPosition:'540', scaleValue:'0.6' }],
            checkboxTabs: [
              { documentId:'1', pageNumber:'2', xPosition:'243', yPosition:'175', tabLabel:'Q1yr'  },
              { documentId:'1', pageNumber:'2', xPosition:'360', yPosition:'175', tabLabel:'SA1yr' },
              { documentId:'1', pageNumber:'2', xPosition:'480', yPosition:'175', tabLabel:'A1yr'  },
              { documentId:'1', pageNumber:'2', xPosition:'243', yPosition:'210', tabLabel:'Q3yr'  },
              { documentId:'1', pageNumber:'2', xPosition:'360', yPosition:'210', tabLabel:'SA3yr' },
              { documentId:'1', pageNumber:'2', xPosition:'480', yPosition:'210', tabLabel:'A3yr'  },
              { documentId:'1', pageNumber:'2', xPosition:'243', yPosition:'245', tabLabel:'Q5yr'  },
              { documentId:'1', pageNumber:'2', xPosition:'360', yPosition:'245', tabLabel:'SA5yr' },
              { documentId:'1', pageNumber:'2', xPosition:'480', yPosition:'245', tabLabel:'A5yr'  },
              { documentId:'1', pageNumber:'2', xPosition:'188', yPosition:'330', tabLabel:'PayMonthly' },
              { documentId:'1', pageNumber:'2', xPosition:'295', yPosition:'330', tabLabel:'PayService' },
              { documentId:'1', pageNumber:'2', xPosition:'420', yPosition:'330', tabLabel:'PayUpfront' },
            ],
          }
        },
        { email: repEmail, name: repName, recipientId: '2', routingOrder: '2',
          tabs: {
            signHereTabs:   [{ documentId:'1', pageNumber:'2', xPosition:'330', yPosition:'700' }],
            dateSignedTabs: [{ documentId:'1', pageNumber:'2', xPosition:'550', yPosition:'700' }],
          }
        }
      ]
    },
    status: 'sent',
  };
  const body = JSON.stringify(envelope);
  const resp = await httpsReq({ hostname:'demo.docusign.net', path:`/restapi/v2.1/accounts/${DS_ACCOUNT_ID}/envelopes`, method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, body);
  if (resp.status !== 201) throw new Error('DocuSign envelope failed: ' + JSON.stringify(resp.body));
  return resp.body.envelopeId;
}

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

const LOGO_B64 = fs.readFileSync(path.join(__dirname, 'public', 'logo.png')).toString('base64');

// ── Proposal number tracker ───────────────────────────────────────────────
const COUNTER_FILE = path.join(__dirname, 'proposal_counter.json');

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
        <td class="price-cell">${fmtP(pt.y1q)}<div class="sel-box"></div></td>
        <td class="price-cell">${fmtP(pt.y1s)}<div class="sel-box"></div></td>
        <td class="price-cell">${fmtP(pt.y1a)}<div class="sel-box"></div></td>
      </tr>
      <tr class="disc-row">
        <td class="term-label">3 Year <span class="disc-badge">3% off</span></td>
        <td class="price-cell">${fmtP(pt.y3q)}<div class="sel-box"></div></td>
        <td class="price-cell">${fmtP(pt.y3s)}<div class="sel-box"></div></td>
        <td class="price-cell">${fmtP(pt.y3a)}<div class="sel-box"></div></td>
      </tr>
      <tr class="disc-row">
        <td class="term-label">5 Year <span class="disc-badge">5% off</span></td>
        <td class="price-cell">${fmtP(pt.y5q)}<div class="sel-box"></div></td>
        <td class="price-cell">${fmtP(pt.y5s)}<div class="sel-box"></div></td>
        <td class="price-cell">${fmtP(pt.y5a)}<div class="sel-box"></div></td>
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
      <span class="payment-opt ${pt.paymentTerm === 'monthly' ? 'selected' : ''}">&#9633; Monthly</span>
      <span class="payment-opt ${pt.paymentTerm === 'service' ? 'selected' : ''}">&#9633; At time of service</span>
      <span class="payment-opt ${pt.paymentTerm === 'upfront' ? 'selected' : ''}">&#9633; Upfront / annual</span>
    </div>
    <div class="initial-row">
      <span>Customer initial: ____________</span>
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

  const eqScheduleRows = equipment.map((e, i) => {
    const eq = EQ_CATALOG[e.id];
    return `<tr class="${i%2===1?'alt':''}">
      <td>${eq.name}</td><td>${e.qty}</td><td></td>
    </tr>`;
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

${addExclHTML}

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
    ${sigLine('Printed Name')}
    ${sigLine('Date')}
    ${sigLine('Purchase Order')}
    ${sigLine('Agreement Start Date')}
  </div>
  <div class="sig-box">
    <div class="sig-box-title">American Air LLC</div>
    <div class="sig-box-addr">80 Brick Kiln Road<br>Chelmsford, MA 01824<br>Ph: 978-640-8880</div>
    ${sigLine('Submitted By: ' + salesName)}
    ${sigLine('Title')}
    ${sigLine('Signature')}
    ${sigLine('Date')}
    ${sigLine('Approved By')}
    ${sigLine('Title')}
    ${sigLine('Printed Name')}
    ${sigLine('Date')}
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
    const PDF_DIR = path.join(__dirname, 'pdfs');
    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);
    fs.writeFileSync(path.join(PDF_DIR, `${data.proposalNumber}.pdf`), pdf);

    // ── Log proposal to history ───────────────────────────────────────────
    const LOG_FILE = path.join(__dirname, 'proposal_log.json');
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
  const filePath = path.join(__dirname, 'pdfs', `${num}.pdf`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${num}_PMA.pdf"`);
  res.setHeader('Content-Type', 'application/pdf');
  res.send(fs.readFileSync(filePath));
});

// ── Admin dashboard routes ────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'aaadmin';

app.post('/admin-auth', (req, res) => {
  const { password } = req.body;
  res.json({ ok: password === ADMIN_PASSWORD });
});

app.get('/admin-data', (req, res) => {
  const pw = req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const LOG_FILE = path.join(__dirname, 'proposal_log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
  res.json(log);
});

// ── DocuSign routes ───────────────────────────────────────────────────────────
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
    const PDF_DIR  = path.join(__dirname, 'pdfs');
    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);
    fs.writeFileSync(path.join(PDF_DIR, `${data.proposalNumber}.pdf`), pdf);
    const LOG_FILE = path.join(__dirname, 'proposal_log.json');
    try {
      let log = []; try { log = JSON.parse(fs.readFileSync(LOG_FILE,'utf8')); } catch(e) {}
      const eq = data.equipment.map(e => { const eq = EQ_CATALOG[e.id]; return eq ? `${e.qty}x ${eq.name}` : e.id; }).join(', ');
      log.unshift({ proposalNumber:data.proposalNumber, facility:data.facility, contact:data.contact, salesName:data.salesName, salesPhone:data.salesPhone, salesEmail:data.salesEmail, date:data.date, equipment:eq, sentViaDocuSign:true, customerEmail:data.customerEmail, generatedAt:new Date().toISOString() });
      fs.writeFileSync(LOG_FILE, JSON.stringify(log,null,2));
    } catch(e) { console.error('Log error:',e.message); }
    const envelopeId = await createDSEnvelope({ pdfBuffer:Buffer.from(pdf), filename, customerName:data.customerName||data.contact, customerEmail:data.customerEmail, repName:data.salesName, repEmail:data.salesEmail });
    res.json({ ok:true, envelopeId, proposalNumber:data.proposalNumber });
  } catch(err) { console.error('DocuSign error:',err); if (!res.headersSent) res.status(500).json({ error: err.message||String(err) }); }
});

app.post('/resend-docusign', async (req, res) => {
  try {
    const pw = req.headers['x-site-password'];
    if (pw !== (process.env.SITE_PASSWORD || 'americanair')) return res.status(401).json({ error:'Unauthorized' });
    const { proposalNumber, customerName, customerEmail, repName, repEmail } = req.body;
    const filePath = path.join(__dirname, 'pdfs', `${proposalNumber}.pdf`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error:'PDF not found — proposal may have been cleared on server restart. Please regenerate it first.' });
    const pdfBuffer = fs.readFileSync(filePath);
    const envelopeId = await createDSEnvelope({ pdfBuffer, filename:`${proposalNumber}_PMA.pdf`, customerName, customerEmail, repName, repEmail });
    res.json({ ok:true, envelopeId, proposalNumber });
  } catch(err) { console.error('Resend error:',err); if (!res.headersSent) res.status(500).json({ error: err.message||String(err) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n  American Air Proposal Tool\n  Open: http://localhost:${PORT}\n  Dashboard: http://localhost:${PORT}/dashboard.html\n`));
