// A/R panel tests. The emphasis is deliberately on what must NOT happen: no
// writes, and no confident number when the underlying data cannot support one.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'fortivo_crm.html');
const blocks = fs.readFileSync(HTML, 'utf8').match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];
const code = blocks
  .map(b => b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))
  .filter(b => b.includes('const App = (() => {'))[0];
if (!code) throw new Error('Could not find the App script block in ' + HTML);

function fakeEl(id) {
  const o = {
    id, value: '', innerHTML: '', title: '', disabled: false,
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    querySelectorAll: () => [], querySelector: () => null,
    appendChild(){}, removeChild(){}, addEventListener(){}, click(){}, focus(){}
  };
  Object.defineProperty(o, 'textContent', { get(){ return o._t || ''; },
    set(v){ o._t = String(v == null ? '' : v);
            o.innerHTML = o._t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); } });
  return o;
}
const els = {}, store = {};
// Every network call is recorded so the tests can assert the panel never writes.
const calls = [];
const sandbox = {
  window: null, document: {
    getElementById: id => (els[id] || (els[id] = fakeEl(id))),
    querySelectorAll: () => [], querySelector: () => null,
    createElement: t => fakeEl(t), addEventListener(){},
    body: { appendChild(){}, removeChild(){}, classList: { add(){}, remove(){}, toggle(){} } }
  },
  location: { hostname: 'fortivopropertyservices.sharepoint.com', hash: '', href: '' },
  localStorage: { getItem: k => (k in store ? store[k] : null),
                  setItem: (k,v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  navigator: { onLine: true }, console, addEventListener(){}, removeEventListener(){},
  Blob: function(){}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL(){} },
  setTimeout, clearTimeout, setInterval, clearInterval, Chart: function(){}, XLSX: undefined,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.fetch = async (url, opts) => {
  calls.push({ url: String(url), method: (opts && opts.method) || 'GET', cache: opts && opts.cache });
  throw new Error('no network in test');
};
vm.createContext(sandbox);

const s0 = code.indexOf('const App = (() => {');
const e0 = code.lastIndexOf('})();');
let w = `const App = (() => {\n${code.slice(s0 + 'const App = (() => {'.length, e0)}\n})();`;
const r0 = w.lastIndexOf('return {');
w = w.slice(0, r0) + `globalThis.__p = {
  DB, KEYS, strictJobNum, arBlockReason, arContestedKeys, arJobKeysFor, arRowsFor,
  arUnattributed, arAsOf, arFreshBadge, _acctARTab, loadAR, AR_TOP, fmtMoney
};\n` + w.slice(r0);
vm.runInContext(w, sandbox, { filename: 'crm.js' });
const P = sandbox.globalThis.__p;

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n))
  : (fail++, console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0,300) : ''))); };

const NOW = Date.now();
const iso = minsAgo => new Date(NOW - minsAgo * 60000).toISOString();
function arRow(o) {
  return Object.assign({
    JobNumber: '', ClientName: '', InvoiceNumber: '', InvoiceDate: '2026-05-01',
    DueDate: '2026-05-26', InvoiceAmount: 0, AmountPaid: 0, Balance: 0,
    AgingBucket: '', DaysOutstanding: 0, Modified: iso(2)
  }, o);
}
function resetWorld() {
  P.DB.set(P.KEYS.accounts, [
    { _spId: 10, name: 'FinMarc Management, LLC' },
    { _spId: 11, name: 'WC Smith' },
    { _spId: 12, name: 'Total Restoration Services LLC' },
  ]);
  P.DB.set(P.KEYS.jobLinks, []);
  sandbox.window.CRM_JOBS = [
    { Job_Number: '26-01-00021', Client_Name: 'FinMarc Management, LLC' },
    { Job_Number: '26-01-00041', Client_Name: 'WC Smith' },
  ];
  sandbox.window.CRM_AR = [];
}

console.log('\n== Strict job-number extraction ==');
check('plain job number', P.strictJobNum('26-01-00021') === '26-01-00021');
check('parenthesised suffix', P.strictJobNum('26-01-00021 (Foundation School)') === '26-01-00021');
// normJobNum would happily return 26-01-00021 from this; strict must not.
check('REJECTS a longer digit run (2026-01-000210)', P.strictJobNum('2026-01-000210') === '', P.strictJobNum('2026-01-000210'));
check('rejects a plain client name', P.strictJobNum('Extra Clean, Inc.') === '');
check('tolerates null', P.strictJobNum(null) === '');

console.log('\n== Blocking states: never show a number the data cannot support ==');
resetWorld();
sandbox.window.CRM_AR = undefined;
check('never fetched -> unfetched', P.arBlockReason() === 'unfetched');
sandbox.window.CRM_AR = null;
check('fetch failed -> unavailable (NOT $0)', P.arBlockReason() === 'unavailable');
sandbox.window.CRM_AR = [];
check('empty list -> empty (NOT $0)', P.arBlockReason() === 'empty');
sandbox.window.CRM_AR = new Array(P.AR_TOP).fill(0).map(() => arRow({ Balance: 1 }));
check('at $top -> truncated', P.arBlockReason() === 'truncated');
sandbox.window.CRM_AR = [arRow({ Modified: iso(1) }), arRow({ Modified: iso(400) })];
check('wide Modified spread -> rewriting (partial sync)', P.arBlockReason() === 'rewriting');
sandbox.window.CRM_AR = [arRow({ Modified: iso(1) }), arRow({ Modified: iso(3) })];
sandbox.window.CRM_JOBS = [];
check('Jobs_Master empty -> nojobs (ownership unknowable)', P.arBlockReason() === 'nojobs');
sandbox.window.CRM_JOBS = [{ Job_Number: '26-01-00021', Client_Name: 'FinMarc Management, LLC' }];
check('all good -> no block', P.arBlockReason() === '');

console.log('\n== Attribution ==');
resetWorld();
sandbox.window.CRM_AR = [
  arRow({ JobNumber: '26-01-00021', ClientName: 'FinMarc Management, LLC', Balance: 262135.23,
          InvoiceAmount: 262135.23, DaysOutstanding: 79, AgingBucket: '61-90', InvoiceNumber: 'INV-2605-011' }),
  arRow({ JobNumber: '26-01-00041', ClientName: 'WC Smith', Balance: 8000, InvoiceAmount: 8000, DaysOutstanding: 0, AgingBucket: 'Current' }),
  arRow({ JobNumber: '26-01-00021', ClientName: 'FinMarc', Balance: 0, AgingBucket: 'Paid' }),   // paid row
  arRow({ JobNumber: '26-09-99999', ClientName: 'Nobody At All', Balance: 4321 }),               // unattributed
];
let fin = P.arRowsFor({ _spId: 10, name: 'FinMarc Management, LLC' });
check('FinMarc gets exactly its one open invoice', fin.rows.length === 1, fin.rows.length);
check('balance is 262,135.23', Math.abs(fin.rows[0].balance - 262135.23) < 0.001, fin.rows[0].balance);
check('zero-balance "Paid" row excluded', !fin.rows.some(r => r.balance === 0));
check("WC Smith's invoice not credited to FinMarc", !fin.rows.some(r => r.jobNumber === '26-01-00041'));
let wc = P.arRowsFor({ _spId: 11, name: 'WC Smith' });
check('WC Smith gets its own $8,000', wc.rows.length === 1 && wc.rows[0].balance === 8000);
const un = P.arUnattributed();
check('unattributed row is surfaced, not silently dropped', un.count === 1 && un.total === 4321, un);

console.log('\n== A customer literally named "Total ..." is not filtered away ==');
sandbox.window.CRM_AR = [arRow({ ClientName: 'Total Restoration Services LLC', Balance: 9500 })];
const tot = P.arRowsFor({ _spId: 12, name: 'Total Restoration Services LLC' });
check('matched by client name despite leading "Total"', tot.rows.length === 1 && tot.rows[0].balance === 9500, tot.rows);
check('and it is not counted as unattributed', P.arUnattributed().count === 0);

console.log('\n== Contested job numbers are excluded, not double counted ==');
resetWorld();
P.DB.set(P.KEYS.jobLinks, [
  { _spId: 1, jobNumber: '26-01-00021', accountId: 10 },
  { _spId: 2, jobNumber: '26-01-00021 (Foundation School)', accountId: 11 },   // same job, other account
]);
sandbox.window.CRM_AR = [arRow({ JobNumber: '26-01-00021', ClientName: 'FinMarc Management, LLC', Balance: 262135.23, DaysOutstanding: 79 })];
const ctx = P.arContestedKeys();
check('conflict detected across raw/decorated labels', ctx.contested['26-01-00021'] === true, ctx);
const a10 = P.arRowsFor({ _spId: 10, name: 'FinMarc Management, LLC' });
const a11 = P.arRowsFor({ _spId: 11, name: 'WC Smith' });
check('contested money excluded from account A total', a10.rows.length === 0, a10.rows);
check('contested money excluded from account B total', a11.rows.length === 0, a11.rows);
check('and reported as contested on the claiming account', a10.contested.length === 1, a10.contested);
const sumBoth = a10.rows.concat(a11.rows).reduce((s, r) => s + r.balance, 0);
check('so the same dollar is never counted twice', sumBoth === 0, sumBoth);

console.log('\n== Freshness thresholds suit a short sync cadence ==');
check('30 min -> green', /badge-green/.test(P.arFreshBadge({ at: new Date(), hours: 0.5 })));
check('3 hr -> amber', /badge-amber/.test(P.arFreshBadge({ at: new Date(), hours: 3 })));
check('23 hr -> red (NOT green)', /badge-red/.test(P.arFreshBadge({ at: new Date(), hours: 23 })));

console.log('\n== Rendering never emits a dollar figure while blocked ==');
resetWorld();
const acct = { _spId: 10, name: 'FinMarc Management, LLC' };
for (const [label, setup] of [
  ['fetch failed', () => { sandbox.window.CRM_AR = null; }],
  ['empty list',   () => { sandbox.window.CRM_AR = []; }],
  ['mid-rewrite',  () => { sandbox.window.CRM_AR = [arRow({ Balance: 5, Modified: iso(1) }), arRow({ Balance: 5, Modified: iso(900) })]; }],
  ['no Jobs_Master', () => { sandbox.window.CRM_AR = [arRow({ Balance: 5, Modified: iso(1) })]; sandbox.window.CRM_JOBS = []; }],
]) {
  resetWorld(); setup();
  const el = fakeEl('acctTabContent');
  P._acctARTab(el, acct);
  check(`${label}: renders no "$"`, !el.innerHTML.includes('$'), el.innerHTML.slice(0, 200));
  check(`${label}: states a reason`, el.innerHTML.length > 120);
}

console.log('\n== The panel performs no writes ==');
resetWorld();
sandbox.window.CRM_AR = [arRow({ JobNumber: '26-01-00021', ClientName: 'FinMarc Management, LLC', Balance: 262135.23, DaysOutstanding: 79, AgingBucket: '61-90' })];
calls.length = 0;
const el2 = fakeEl('acctTabContent');
P._acctARTab(el2, acct);
check('rendering issues zero network calls', calls.length === 0, calls);
check('renders the balance once loaded', el2.innerHTML.includes('262,135'), el2.innerHTML.slice(0, 200));
check('shows the aging bucket', el2.innerHTML.includes('61-90'));
check('discloses the credit-memo caveat', /credit memos/i.test(el2.innerHTML));
check('states it never writes', /never writes/i.test(el2.innerHTML));

calls.length = 0;
(async () => {
await P.loadAR(true).catch(() => {});
check('loadAR issues exactly one request', calls.length === 1, calls);
check('and it is a GET', calls[0] && calls[0].method === 'GET', calls[0]);
check('with cache:no-store (service worker cannot serve it)', calls[0] && calls[0].cache === 'no-store', calls[0]);
check('against QB_AR_Aging', calls[0] && calls[0].url.includes("getbytitle('QB_AR_Aging')"), calls[0] && calls[0].url);
check('at $top=5000, matching the rest of the app', calls[0] && calls[0].url.includes('$top=5000'), calls[0] && calls[0].url);
check('a failed load leaves the cache null, not stale', sandbox.window.CRM_AR === null, sandbox.window.CRM_AR);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
