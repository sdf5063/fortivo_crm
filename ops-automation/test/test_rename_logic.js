// Unit tests — Edit Job (rename/renumber) pure logic
'use strict';
const assert = require('assert');
const { loadSnippet } = require('./_load_snippet');

const w = loadSnippet(__dirname + '/../job-rename/fv_job_rename.snippet.html');
const L = w.FVJobRename._logic;

console.log('=== job rename logic ===');

// ── parseJobNumber ──
// (VM-sandbox objects have a foreign prototype — compare fields, not deepStrictEqual)
const pj = L.parseJobNumber('26-02-00043');
assert.strictEqual(pj.yy, '26'); assert.strictEqual(pj.pp, '02'); assert.strictEqual(pj.seq, '00043');
assert.strictEqual(L.parseJobNumber('26-2-00043'), null);
assert.strictEqual(L.parseJobNumber('26-02-0043'), null);
assert.strictEqual(L.parseJobNumber(' 26-01-00129 ').seq, '00129');
assert.strictEqual(L.parseJobNumber(''), null);
console.log('✓ parseJobNumber enforces YY-PP-NNNNN');

// Real jobs from QBO (2026-08-15) — including the live 00043 collision:
// 26-01-00043 is held by BOTH Anna Ansaldo and Nelson Peters (mit);
// Peters also correctly holds 26-02-00043 (repair phase, same sequence).
const jobs = [
  { spId: 1, jobNumber: '26-01-00043', clientName: 'Anna Ansaldo',  jobName: 'Ansaldo Water Loss' },
  { spId: 2, jobNumber: '26-01-00043', clientName: 'Nelson Peters', jobName: 'Peters Mitigation' },
  { spId: 3, jobNumber: '26-02-00043', clientName: 'Nelson Peters', jobName: 'Peters Repair' },
  { spId: 4, jobNumber: '26-01-00029', clientName: 'CBRE',          jobName: '1250 Connecticut Ave' },
  { spId: 5, jobNumber: '26-02-00029', clientName: 'CBRE',          jobName: '1250 Connecticut Ave Repair' },
  { spId: 6, jobNumber: '26-01-00046', clientName: 'Jessica Lasko', jobName: '' }
];

// ── validateChange: bad format blocks ──
let checks = L.validateChange(jobs[0], { spId:1, jobNumber:'26-1-43', clientName:'Anna Ansaldo' }, jobs);
assert.strictEqual(checks[0].level, 'block');
console.log('✓ malformed number blocks');

// ── full-number collision blocks (the Ansaldo/Peters class of error) ──
checks = L.validateChange(jobs[5], { spId:6, jobNumber:'26-01-00043', clientName:'Jessica Lasko' }, jobs);
assert(checks.some(c => c.level === 'block' && /already used/.test(c.msg)));
console.log('✓ duplicate full number blocks');

// ── phase change keeping the sequence is recognized as correct ──
checks = L.validateChange(jobs[3], { spId:4, jobNumber:'26-02-00029', clientName:'CBRE' }, [jobs[3], jobs[5]]);
assert(checks.some(c => c.level === 'info' && /Phase change/.test(c.msg) && /kept/.test(c.msg)));
assert(!checks.some(c => c.level === 'block' || c.level === 'warn'));
console.log('✓ phase change (same last-5) passes with info note');

// ── year advance with same sequence is an info, not a warning ──
checks = L.validateChange(
  { spId: 7, jobNumber: '25-01-00140', clientName: 'Talak Shah' },
  { spId: 7, jobNumber: '26-02-00140', clientName: 'Talak Shah' }, jobs);
assert(checks.some(c => c.level === 'info' && /Year 2025 → 2026/.test(c.msg)));
assert(!checks.some(c => c.level === 'block'));
console.log('✓ phase-driven year change allowed');

// ── changing the last-5 warns loudly (identity rule) ──
checks = L.validateChange(jobs[0], { spId:1, jobNumber:'26-01-00050', clientName:'Anna Ansaldo' }, jobs);
assert(checks.some(c => c.level === 'warn' && /permanent identity/.test(c.msg)));
console.log('✓ sequence change warns (fix-only action)');

// ── adopting a sequence owned by a different client adds a second warning ──
checks = L.validateChange(jobs[5], { spId:6, jobNumber:'26-02-00046', clientName:'Someone Else' }, jobs);
// same seq, but client differs from the row's own client → no ownership warning (self)
checks = L.validateChange(jobs[0], { spId:1, jobNumber:'26-01-00029', clientName:'Anna Ansaldo' }, jobs);
assert(checks.some(c => c.level === 'block')); // exact number taken by CBRE
checks = L.validateChange(jobs[0], { spId:1, jobNumber:'25-01-00029', clientName:'Anna Ansaldo' }, jobs);
assert(checks.some(c => c.level === 'warn' && /already belongs to CBRE/.test(c.msg)));
console.log('✓ cross-client sequence adoption warns');

// ── the actual fix for the live collision passes cleanly ──
// (give Anna a fresh unused number: warned as identity change, nothing blocks)
checks = L.validateChange(jobs[0], { spId:1, jobNumber:'26-01-00052', clientName:'Anna Ansaldo' }, jobs);
assert(!checks.some(c => c.level === 'block'));
assert(checks.some(c => c.level === 'warn' && /permanent identity/.test(c.msg)));
console.log('✓ collision fix path (fresh number) is allowed with warning');

// ── blanking an existing value is never allowed (data-degradation rule) ──
checks = L.validateChange(jobs[0], { spId:1, jobNumber:'26-01-00043', clientName:'', jobName:'Ansaldo Water Loss' }, jobs);
assert(checks.some(c => c.level === 'block' && /never blanked/.test(c.msg)));
checks = L.validateChange(jobs[5], { spId:6, jobNumber:'26-01-00046', clientName:'Jessica Lasko', jobName:'' }, jobs);
assert(!checks.some(c => c.level === 'block')); // jobName was already empty — no-op, not a blanking
console.log('✓ populated fields can be corrected but never cleared');

// ── buildFolderName mirrors the kickoff convention ──
assert.strictEqual(
  L.buildFolderName({ jobNumber:'26-02-00043', clientName:'Nelson Peters', jobType:'Repair' }),
  '26-02-00043 (Nelson Peters-Repair)');
assert.strictEqual(
  L.buildFolderName({ jobNumber:'26-01-00046', clientName:'Jessica Lasko', jobType:'' }),
  '26-01-00046 (Jessica Lasko)');
console.log('✓ folder name matches Fortivo convention');

// ── buildPlan ──
let plan = L.buildPlan(
  jobs[0], { jobNumber:'26-01-00052', clientName:'Anna Ansaldo', jobType:'Mitigation' },
  ['jobNumber'], { Name:'26-01-00043 (Anna Ansaldo-Mit)' }, false);
assert(plan.some(s => s.kind === 'list'));
assert(plan.some(s => s.kind === 'folder' && /26-01-00052 \(Anna Ansaldo-Mit\)/.test(s.label)));
assert(plan.some(s => s.kind === 'manual' && /QuickBooks/.test(s.label)));
assert(plan.some(s => s.kind === 'manual' && /keep the OLD number/.test(s.label)));
console.log('✓ plan: row update + folder rename + linked-record heads-up + QB reminder');

plan = L.buildPlan(jobs[0], { jobNumber:'26-01-00052', clientName:'Anna Ansaldo', jobType:'' },
  ['jobNumber'], { Name:'x' }, true);
assert(plan.some(s => s.kind === 'block' && /already exists/.test(s.label)));
console.log('✓ plan blocks when target folder name exists');

plan = L.buildPlan(jobs[0], { jobNumber:'26-01-00043', clientName:'Anna Ansaldo', jobType:'' },
  ['jobName'], null, false);
assert(plan.some(s => /Job Kickoff/.test(s.label)));
assert(!plan.some(s => s.kind === 'manual')); // name-only edit → no QB reminder
console.log('✓ plan: missing folder handled; job-name-only edit skips QB reminder');

// ── diffFields / resolveColumns / mapJob ──
assert.strictEqual(
  L.diffFields(jobs[0], { jobNumber:'26-01-00043', clientName:'Anna B. Ansaldo', jobName:'Ansaldo Water Loss' }).join(','),
  'clientName');
const cols = L.resolveColumns(['Title','Client_Name','Job_Name','Status','Editor']);
assert.strictEqual(cols.jobNumber, 'Title');
assert.strictEqual(cols.clientName, 'Client_Name');
assert.strictEqual(cols.jobName, 'Job_Name');
const j = L.mapJob({ Id: 9, Title:'26-01-00046', Client_Name:'Jessica Lasko', Job_Name:'Lasko Kitchen', Status:'Open' });
assert.strictEqual(j.jobNumber, '26-01-00046');
assert.strictEqual(j.jobName, 'Lasko Kitchen');
console.log('✓ field mapping and column resolution');

console.log('\nAll job-rename logic tests passed.');
