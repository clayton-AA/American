
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const LOGO_B64 = fs.readFileSync(path.join(__dirname, 'public', 'logo.png')).toString('base64');

const EQ_CATALOG = {
  rtu:    { name:'Rooftop Unit (RTU)',         cats:{ 'Electrical':['Volts/amps — compressor, condenser & evap fan motors','Tighten all electrical connections','Starters & contactors for wear','All operating and safety controls'], 'Refrigeration':['Refrigerant pressures','Check for refrigerant / oil leaks','Clean condenser coil','Check evaporator coil','Inspect condensate drain pan & lines'], 'Mechanical':['Filters — inspect / replace per contract','Belts — inspect / replace per contract','Sheaves — wear & alignment','Blower wheels — clean','Lubricate motor & blower bearings'], 'Heating':['Heat exchanger — cracks / corrosion','Burner assembly & ignition sequence','Inducer fan wheel if applicable','Overall condition of unit'] } },
  split:  { name:'Split System (DX)',           cats:{ 'Electrical':['Volts/amps — compressor & fan motors','Tighten all electrical connections','Starters & contactors for wear','Operating and safety controls'], 'Refrigeration':['Refrigerant pressures','Check for refrigerant / oil leaks','Condenser coil — clean per contract','Inspect condensate drain pan & lines'], 'Mechanical':['Filters — inspect / replace per contract','Belts — inspect / replace per contract','Blower wheels — clean surface','Lubricate motor & blower bearings'], 'Heating':['Heat exchanger — cracks / corrosion','Burner assembly if applicable','Ignition & burner sequence','Overall condition of unit'] } },
  mini:   { name:'Ductless Mini Split',         cats:{ 'Air & Filtration':['Filters — clean or replace per contract','Fan blades & housing — fouling check','Damper — adjust / lubricate if applicable','Check for moisture carryover from drain pan'], 'Refrigeration':['Refrigerant pressures & levels','Check for visible refrigerant / oil leaks','Evaporator coils — clean per contract','Condenser coils — clean per contract'], 'Electrical & Controls':['All electrical connections','Control system devices','Control box — dirt & debris','Field serviceable bearings — lubricate'], 'Drainage':['P-trap drain — clean as needed','Drain pan, line & coil — check for biological growth','Condensate pump if applicable','General condition of unit'] } },
  vrf:    { name:'VRF / VRV System',            cats:{ 'Electrical':['Volts/amps — all motors','Tighten all electrical connections','All safety controls & safeties','Communication wiring integrity'], 'Refrigeration':['Refrigerant pressures — all circuits','Check for leaks — all connections','Condenser coil — clean per contract','Oil levels if applicable'], 'Controls':['Zone controller operation','Setpoints & schedules verified','Fault code review','Overall controls condition'], 'Mechanical':['Fan blades & housing','Filters — indoor units per contract','Lubricate all serviceable bearings','Overall condition — all heads & ODU'] } },
  vav:    { name:'VAV Box',                     cats:{ 'Controls':['Actuator operation & calibration','Thermostat / zone sensor accuracy','Setpoints & schedules verified','Occupied / unoccupied schedules'], 'Mechanical':['Damper blade condition & seating','Linkage — tighten & lubricate','Box casing & insulation integrity','Flow measurement if applicable'], 'Heating':['Hot water coil operation if applicable','Control valve — stroke & seating','Reheat sequence of operation','Overall condition of box'], 'Electrical':['All electrical connections','Control board & wiring','24V transformer output','Overall condition'] } },
  reznor: { name:'Reznor / Unit Heater',        cats:{ 'Combustion':['Burner assembly & orifices','Ignition sequence of operation','Burner sequence of operation','Gas valve operation & pressure'], 'Heat Exchanger':['Cracks, corrosion & deterioration','Flue & venting — blockage & condition','Combustion air — adequate supply','CO test if applicable'], 'Electrical':['All electrical connections','Safety controls & limits','Thermostat calibration','Blower motor amps if applicable'], 'General':['Fan blade & housing condition','Filters if applicable','Overall unit condition','Recommend service if needed'] } },
  mau:    { name:'Make-Up Air Unit (MAU)',       cats:{ 'Air':['Filters — inspect / replace per contract','Fan wheel — clean & balance check','Belts — inspect / replace per contract','Sheaves — wear & alignment'], 'Heating / Cooling':['Heat exchanger if applicable','Gas valve & burner sequence','Cooling coil & refrigerant check','Economizer operation'], 'Electrical':['All electrical connections','Contactors & starters for wear','Safety controls & limits','Overall electrical condition'], 'General':['Louvers & dampers — operation','Drain pan & condensate line','Lubricate all serviceable bearings','Overall condition of unit'] } },
  erv:    { name:'ERV / HRV',                   cats:{ 'Core & Filters':['Heat / energy recovery core — inspect & clean','Filters — clean or replace per contract','Core bypass damper operation','Defrost cycle operation if applicable'], 'Mechanical':['Fan wheels — clean & condition','Belts if applicable','Lubricate all serviceable bearings','Condensate drain if applicable'], 'Controls':['Controls & setpoints verified','Enthalpy sensors if applicable','Occupied / unoccupied schedules','Airflow verification'], 'General':['All electrical connections','Housing integrity & seals','Overall condition of unit','Recommend service if needed'] } },
};

const SERVICES = [
  ['Filter Inspection & Replacement',            'All return air filters inspected and replaced as needed. Correct filter size and MERV rating confirmed per unit specifications.'],
  ['Electrical & Safety Inspection',             'All electrical connections inspected and tightened. Contactors, capacitors, fuses, and disconnects checked for wear or failure risk.'],
  ['Refrigerant Level & System Pressure Check',  'Operating pressures measured and logged against manufacturer specs. Low refrigerant or leak indicators flagged and documented.'],
  ['Condensate Drain Line Inspection & Cleaning','Drain pans and lines inspected and flushed. Checked for biological growth, blockages, and proper drainage to prevent overflow and water damage.'],
  ['Thermostat Calibration & Controls Verification','Thermostat accuracy and staging verified. Schedules and setpoints confirmed per facility needs.'],
  ['Blower Motor & Belt Inspection',             'Belt condition, tension, and alignment inspected. Blower wheel cleaned. Motor and blower bearings lubricated.'],
  ['Condenser Coil Cleaning',                    'Outdoor condenser coils cleaned using low-pressure rinse and coil-safe detergent to maintain airflow and heat transfer efficiency.'],
  ['Digital Service Report',                     'Digital report provided after every visit documenting all findings, readings, and recommended repairs. Kept on file for your records.'],
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
  const { facility, address, contact, salesName, salesPhone, salesEmail, date, price, equipment } = data;
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

  const eqScheduleRows = equipment.map((e, i) => {
    const eq = EQ_CATALOG[e.id];
    return `<tr class="${i%2===1?'alt':''}">
      <td>${eq.name}</td><td>${e.qty}</td><td>${e.visits}</td><td></td>
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

  /* ── Header ── */
  .doc-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 18px 36px 14px; border-bottom: 3px solid #1B3A6B; }
  .doc-header img { height: 44px; }
  .header-right { text-align: right; font-size: 10px; color: #666; line-height: 1.9; }
  .header-right strong { color: #222; }

  /* ── Hero ── */
  .hero { background: #E8EEF7; padding: 16px 36px; margin-bottom: 18px; }
  .hero h1 { font-family: 'Playfair Display', serif; font-size: 20px; color: #1B3A6B; margin-bottom: 5px; }
  .hero p { font-size: 10.5px; color: #444; line-height: 1.5; }

  /* ── Section labels ── */
  .section-label { font-size: 9px; font-weight: 500; letter-spacing: 1.8px; text-transform: uppercase;
    color: #1B3A6B; border-bottom: 2px solid #1B3A6B; padding-bottom: 5px; margin: 18px 36px 10px; }

  /* ── Services ── */
  .services { padding: 0 36px; }
  .service-row { display: flex; gap: 10px; margin-bottom: 8px; align-items: flex-start; }
  .check { color: #1B3A6B; font-size: 13px; font-weight: bold; flex-shrink: 0; margin-top: 1px; }
  .service-title { font-weight: 500; font-size: 11px; color: #333; margin-bottom: 1px; }
  .service-desc { font-size: 10px; color: #666; line-height: 1.45; }

  /* ── Benefits ── */
  .benefits-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; padding: 0 36px; }
  .benefit { background: #F5F5F5; padding: 8px 12px; font-size: 10.5px; color: #444; border-radius: 4px; }

  /* ── Equipment schedule ── */
  .eq-schedule { margin: 0 36px; width: calc(100% - 72px); border-collapse: collapse; font-size: 10.5px; }
  .eq-schedule thead th { background: #E8EEF7; color: #1B3A6B; font-weight: 500; padding: 7px 10px;
    text-align: left; border-bottom: 2px solid #1B3A6B; }
  .eq-schedule tbody td { padding: 7px 10px; border-bottom: 1px solid #E0E0E0; }
  .eq-schedule tbody tr.alt td { background: #FAFBFD; }
  .eq-schedule tfoot td { background: #E8EEF7; color: #1B3A6B; font-weight: 500; padding: 7px 10px; border-top: 2px solid #1B3A6B; }

  /* ── Summary ── */
  .summary-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; padding: 0 36px; }
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
  .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 0 36px; }
  .sig-box { border: 1px solid #ddd; border-radius: 6px; padding: 14px 16px; }
  .sig-box-title { font-weight: 500; font-size: 11px; color: #1B3A6B; margin-bottom: 4px; }
  .sig-box-addr { font-size: 10px; color: #666; margin-bottom: 10px; line-height: 1.6; }
  .sig-line-wrap { margin-top: 14px; }
  .sig-line { border-bottom: 1px solid #888; height: 18px; margin-bottom: 3px; }
  .sig-label { font-size: 9px; color: #888; }

  /* ── Page breaks ── */
  .page-break { page-break-before: always; }

  /* ── Scope of work ── */
  .scope-hero { background: #E8EEF7; padding: 14px 36px; margin-bottom: 16px; }
  .scope-hero h2 { font-family: 'Playfair Display', serif; font-size: 18px; color: #1B3A6B; margin-bottom: 4px; }
  .scope-hero p { font-size: 10px; color: #555; }

  .eq-block { margin: 0 36px 18px; }
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
  .tc-hero { background: #E8EEF7; padding: 14px 36px; margin-bottom: 16px; }
  .tc-hero h2 { font-family: 'Playfair Display', serif; font-size: 18px; color: #1B3A6B; margin-bottom: 4px; }
  .tc-hero p { font-size: 10px; color: #555; }
  .tc-section { padding: 0 36px; margin-bottom: 10px; }
  .tc-heading { font-weight: 500; font-size: 11px; color: #1B3A6B; margin-bottom: 4px; margin-top: 12px; }
  .tc-body { font-size: 10px; color: #444; line-height: 1.6; margin-bottom: 4px; text-align: justify; }

  /* ── Spacers ── */
  .gap { height: 16px; }
  .gap-sm { height: 10px; }
</style>
</head>
<body>

<!-- ══ PAGE 1 ══════════════════════════════════════════════════════════════ -->

<div class="doc-header">
  <img src="data:image/png;base64,${LOGO_B64}" alt="American Air">
  <div class="header-right">
    Facility: <strong>${facility}</strong><br>
    Contact: <strong>${contact}</strong><br>
    Date: <strong>${date}</strong><br>
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
  <thead><tr><th style="width:45%">Equipment Type</th><th style="width:10%">Qty</th><th style="width:15%">Visits / Yr</th><th>Model / Serial / Notes</th></tr></thead>
  <tbody>${eqScheduleRows}</tbody>
  <tfoot><tr><td><strong>Total Units Covered</strong></td><td><strong>${totalUnits}</strong></td><td></td><td></td></tr></tfoot>
</table>

<div class="gap"></div>
<div class="section-label">Agreement summary</div>
<div class="summary-grid">
  <div class="summary-box">
    <div class="summary-box-title">Pricing &amp; Terms</div>
    <div class="summary-row"><span>Agreement term</span><strong>12 months</strong></div>
    <div class="summary-row"><span>Total units</span><strong>${totalUnits}</strong></div>
    <div class="summary-row"><span>Visits per year</span><strong>${totalVisits}</strong></div>
    <div class="summary-row highlight"><span>Annual investment</span><strong>${price}</strong></div>
  </div>
  <div class="summary-box">
    <div class="summary-box-title">Our Commitment to You</div>
    <p class="summary-desc">Every visit is performed by a trained, licensed HVAC technician familiar with your facility. We document all findings digitally and communicate clearly — no surprises, no upsells you didn't ask for.</p>
  </div>
  <div class="summary-box dark">
    <div class="summary-box-title">Ready to Get Started?</div>
    <p class="cta-line muted">Contact us to confirm your first visit date and finalize this agreement.</p>
    <p class="cta-line" style="margin-top:8px"><strong>americanairinc.com</strong></p>
    <p class="cta-line">978-640-8880</p>
    <p class="cta-line name">${salesName}</p>
    <p class="cta-line muted">${salesPhone} &nbsp;|&nbsp; ${salesEmail}</p>
  </div>
</div>

<div class="gap"></div>
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

<p style="font-size:9.5px;color:#888;font-style:italic;padding:10px 36px;border-top:1px solid #ddd;margin:0 36px;">
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
    const html = buildHTML(data);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0.5in', left: '0' }
    });
    await browser.close();

    const filename = `${data.facility.replace(/[^a-z0-9]/gi,'_')}_PMA_${data.date.replace(/[^a-z0-9]/gi,'_')}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdf);

  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n  American Air Proposal Tool\n  Open: http://localhost:${PORT}\n`));
