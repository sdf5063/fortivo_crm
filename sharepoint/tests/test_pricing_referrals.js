// Smoke test: load the patched CRM module under a minimal DOM stub, then exercise
// the pricing helpers and the new referral rollup against representative data.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Pull the app's inline <script> out of the single-file SPA so the tests run
// against exactly what gets deployed.
const HTML = path.join(__dirname, '..', 'fortivo_crm.html');
const blocks = fs.readFileSync(HTML, 'utf8').match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];
const code = blocks
  .map(b => b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))
  .filter(b => b.includes('const App = (() => {'))[0];
if (!code) throw new Error('Could not find the App script block in ' + HTML);

// ── minimal DOM / browser stubs ──────────────────────────────────────
function fakeEl(id) {
  const o = {
    id, value: '', innerHTML: '', title: '', disabled: false,
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    querySelectorAll: () => [], querySelector: () => null,
    appendChild(){}, removeChild(){}, addEventListener(){}, click(){}, focus(){}
  };
  Object.defineProperty(o, 'textContent', { get(){ return o._t || ''; },
    set(v){ o._t = String(v == null ? '' : v); o.innerHTML = o._t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); } });
  return o;
}
const els = {};
const store = {};
const documentStub = {
  getElementById: id => (els[id] || (els[id] = fakeEl(id))),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: tag => fakeEl(tag),
  addEventListener(){},
  body: { appendChild(){}, removeChild(){}, classList: { add(){}, remove(){}, toggle(){} } }
};
const windowStub = {
  location: { hostname: 'localhost', hash: '', href: '' },
  addEventListener(){},
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL(){} },
  console
};
windowStub.window = windowStub;

const sandbox = {
  window: windowStub,
  document: documentStub,
  location: windowStub.location,
  localStorage: windowStub.localStorage,
  navigator: { onLine: true, serviceWorker: undefined },
  console,
  fetch: async () => { throw new Error('offline in test'); },
  Blob: function(){},
  URL: windowStub.URL,
  setTimeout, clearTimeout, setInterval, clearInterval,
  XLSX: undefined, Chart: function(){}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Capture the module's internals: the file ends with `return {...}})();` assigned to
// `const App`. Append an export of the pieces we want to poke at.
const probe = code + `
;globalThis.__probe = {
  App,
  parseRates, stringifyRates, pricingSummary, rateDelta, stdRateFor,
  hasCustomPricing, pricingIsUndocumented, setStandardRates, getStandardRates,
  buildReferralIndex, referralStatsFor, referralDataMissing
};
`;

// The probe must run inside the IIFE to see its closures, so re-wrap: pull the body
// out of `const App = (() => { ... })();` and run it with the probe appended.
const start = code.indexOf('const App = (() => {');
const end = code.lastIndexOf('})();');
if (start < 0 || end < 0) throw new Error('Could not locate the App IIFE');
const body = code.slice(start + 'const App = (() => {'.length, end);
const wrapped = `
const App = (() => {
${body}
})();
`;
// Inject the probe just before the module's `return {`.
const retIdx = wrapped.lastIndexOf('return {');
const probed = wrapped.slice(0, retIdx) + `
globalThis.__probe = {
  parseRates, stringifyRates, pricingSummary, rateDelta, stdRateFor,
  hasCustomPricing, pricingIsUndocumented, setStandardRates, getStandardRates,
  buildReferralIndex, referralStatsFor, referralDataMissing, DB, KEYS, fmtMoney
};
` + wrapped.slice(retIdx);

vm.runInContext(probed, sandbox, { filename: 'fortivo_crm.inline.js' });
const P = sandbox.globalThis.__probe;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + JSON.stringify(detail) : '')); }
}

console.log('\n== Pricing rate cards ==');
const card = P.parseRates(JSON.stringify([
  { label: 'Technician', unit: 'hour', rate: 85, note: 'reg hours' },
  { label: 'Supervisor', unit: 'hour', rate: 110 },
  { label: 'Air Mover', unit: 'day', rate: 22 },
  { label: '' }                                   // dropped: no label
]));
check('parseRates keeps 3 valid rows', card.length === 3, card);
check('parseRates defaults unit to hour', card[1].unit === 'hour', card[1]);
check('parseRates coerces rate to number', card[0].rate === 85);
check('parseRates survives garbage', P.parseRates('{not json').length === 0);
check('parseRates handles null', P.parseRates(null).length === 0);

P.setStandardRates([
  { label: 'Technician', unit: 'hour', rate: 100 },
  { label: 'Supervisor', unit: 'hour', rate: 110 },
  { label: 'Dehumidifier', unit: 'day', rate: 45 }
]);
check('standard card round-trips', P.getStandardRates().length === 3);
check('stdRateFor matches case/punctuation-insensitively', P.stdRateFor('technician') === 100);
check('stdRateFor returns null when absent', P.stdRateFor('Air Mover') === null);

const d0 = P.rateDelta(card[0]);           // 85 vs 100
check('rateDelta -15% for discounted tech', Math.abs(d0 + 15) < 1e-9, d0);
check('rateDelta null when no standard', P.rateDelta(card[2]) === null);

const sum = P.pricingSummary(card);
check('summary counts all lines', sum.lines === 3, sum);
check('summary counts comparable lines only', sum.comparable === 2, sum);
check('summary counts differing lines', sum.differing === 1, sum);
check('summary avg delta = -7.5%', Math.abs(sum.avgDelta + 7.5) < 1e-9, sum);

const flaggedNoRates = { pricingType: 'Modified', pricingRates: [] };
const flaggedWithRates = { pricingType: 'Modified', pricingRates: card };
const plain = { pricingType: 'Standard', pricingRates: [] };
check('hasCustomPricing true for flagged-only', P.hasCustomPricing(flaggedNoRates));
check('hasCustomPricing false for standard', !P.hasCustomPricing(plain));
check('hasCustomPricing true when rates exist w/o flag',
      P.hasCustomPricing({ pricingType: 'Standard', pricingRates: card }));
check('pricingIsUndocumented flags the label-only case', P.pricingIsUndocumented(flaggedNoRates));
check('pricingIsUndocumented false once rates exist', !P.pricingIsUndocumented(flaggedWithRates));

console.log('\n== Referral rollup (the QB "amount referred" fix) ==');
// Jobs_Master rows: one referrer matched by ID, one by name, one matched BOTH ways
// (must not double count), plus a referrer with no CRM account.
sandbox.window.CRM_JOBS = [
  { Job_Number: '26-01-00026', Client_Name: 'Carole Krooth', Referred_By_Account_Id: 42,
    Referred_By: 'Hassle Free Home Services', Amount: 3500, Total_Paid: 3172.55,
    Job_Status: 'Closed', Date_Received: '2026-01-14T00:00:00Z' },
  { Job_Number: '26-02-00048', Client_Name: 'Robin Hyer', Referred_By: 'Hassle Free Home Services',
    Amount: 8200, Total_Paid: 4100, Job_Status: 'Open', Date_Received: '2026-02-20T00:00:00Z' },
  { Job_Number: '26-02-00051', Client_Name: 'Someone Else', Referred_By_Account_Id: 42,
    Amount: 1000, Total_Paid: 900, Job_Status: 'Open', Date_Received: '2026-03-01T00:00:00Z' },
  { Job_Number: '26-03-00060', Client_Name: 'Ghost Client', Referred_By: 'Nobody Realty',
    Amount: 500, Total_Paid: 0, Job_Status: 'Open', Date_Received: '2026-03-05T00:00:00Z' }
];
sandbox.window.CRM_QB_PNL = { '26-01-00026': { Revenue: 3172.55 }, '26-02-00048': { Income: 8200 } };

const idx = P.buildReferralIndex();
const hfhs = { _spId: 42, name: 'Hassle Free Home Services' };
const stats = P.referralStatsFor(hfhs, idx);
check('3 distinct referred jobs (no double count)', stats.jobs === 3, stats);
check('invoiced sums to 12,700', stats.invoiced === 12700, stats.invoiced);
check('collected sums to 8,172.55', Math.abs(stats.collected - 8172.55) < 0.001, stats.collected);
check('lastDate is the newest job', stats.lastDate === '2026-03-01', stats.lastDate);
check('source is live job data', stats.source === 'jobs', stats.source);
check('26-02-00048 counted once', stats.jobList.filter(j => j.jobNumber === '26-02-00048').length === 1);

const unknown = { _spId: 999, name: 'Not A Referrer' };
P.DB.set(P.KEYS.jobLinks, []);
const none = P.referralStatsFor(unknown, idx);
check('unknown account returns zeroes', none.jobs === 0 && none.collected === 0, none);
check('unknown account source is none', none.source === 'none', none.source);

// Legacy fallback: no Jobs_Master rows, but stored CRM_Job_Links carry a value.
P.DB.set(P.KEYS.jobLinks, [
  { _spId: 1, jobNumber: '25-01-00099', accountName: 'Old Client', referralAccountId: 77,
    jobValue: 5000, jobStatus: 'Closed', linkDate: '2025-06-01' }
]);
const legacy = P.referralStatsFor({ _spId: 77, name: 'Legacy Referrer' }, idx);
check('falls back to job links when jobs have nothing', legacy.jobs === 1 && legacy.collected === 5000, legacy);
check('fallback is labelled as link data', legacy.source === 'links', legacy.source);

// The old code summed CRM_Job_Links.Job_Value, which the sync wrote as 0.
P.DB.set(P.KEYS.jobLinks, [
  { _spId: 2, jobNumber: '26-01-00026', accountName: 'Carole Krooth', referralAccountId: 42,
    jobValue: 0, jobStatus: 'Closed', linkDate: '2026-01-14' }
]);
const regression = P.referralStatsFor(hfhs, idx);
check('REGRESSION: stale Job_Value=0 no longer zeroes the total',
      regression.collected > 0, regression.collected);

check('referralDataMissing false when jobs loaded', P.referralDataMissing() === false);
sandbox.window.CRM_JOBS = [];
check('referralDataMissing true when Jobs_Master empty', P.referralDataMissing() === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
