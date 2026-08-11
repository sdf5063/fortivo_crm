// Unit tests — Job Kickoff pure logic (naming, contract rules, planning)
'use strict';
const assert = require('assert');
const path = require('path');
const { loadSnippet } = require('./_load_snippet');

const win = loadSnippet(path.join(__dirname, '..', 'job-kickoff', 'fv_job_kickoff.snippet.html'));
assert(win.FVKickoff, 'FVKickoff namespace must attach to window');
const L = win.FVKickoff._logic;
const CFG = win.FVKickoff._cfg;

console.log('=== Job Kickoff logic ===');

// ── sanitizeName ──
assert.strictEqual(L.sanitizeName('Smith/Jones: "Vault"*?'), 'Smith Jones Vault');
assert.strictEqual(L.sanitizeName('  Steinhardt Vehicle.  '), 'Steinhardt Vehicle');
assert.strictEqual(L.sanitizeName('A#B%C|D\\E'), 'A B C D E');
console.log('✓ sanitizeName strips SP-illegal characters');

// ── buildFolderName (matches observed convention: 26-02-00051 (Sherman-Recon)) ──
assert.strictEqual(
  L.buildFolderName({ jobNumber: '26-01-00055', clientName: 'Alec Sherman', jobType: 'Mitigation' }),
  '26-01-00055 (Alec Sherman-Mit)');
assert.strictEqual(
  L.buildFolderName({ jobNumber: '26-02-00060', clientName: 'Stopak', jobType: 'Repair' }),
  '26-02-00060 (Stopak-Repair)');
assert.strictEqual(
  L.buildFolderName({ jobNumber: '26-02-00061', clientName: 'Jensen', jobType: 'Reconstruction' }),
  '26-02-00061 (Jensen-Recon)');
// blank type short ("Other") → no dangling dash
assert.strictEqual(
  L.buildFolderName({ jobNumber: '26-03-00001', clientName: 'Acme', jobType: 'Other' }),
  '26-03-00001 (Acme)');
// blank client → no leading dash
assert.strictEqual(
  L.buildFolderName({ jobNumber: '26-01-00002', clientName: '', jobType: 'Mitigation' }),
  '26-01-00002 (Mit)');
console.log('✓ buildFolderName follows the naming convention with clean edge cases');

// ── inferTypeFromNumber (YY-PP-NNNNN) ──
assert.strictEqual(L.inferTypeFromNumber('26-01-00055'), 'Mitigation');
assert.strictEqual(L.inferTypeFromNumber('26-02-00051'), 'Repair');
assert.strictEqual(L.inferTypeFromNumber('25-06-00126'), '');
assert.strictEqual(L.inferTypeFromNumber('garbage'), '');
console.log('✓ inferTypeFromNumber maps the PP segment');

// ── pickContract decision matrix ──
assert.strictEqual(L.pickContract({ jobType: 'Mitigation' }), 'ewa');
assert.strictEqual(L.pickContract({ jobType: 'Mitigation', propertyType: 'Healthcare' }), 'ewa-healthcare');
assert.strictEqual(L.pickContract({ jobType: 'Mitigation', propertyType: 'Healthcare', state: 'DC' }), 'ewa-healthcare',
  'mitigation wins over DC');
assert.strictEqual(L.pickContract({ jobType: 'Repair', state: 'MD' }), 'cwa');
assert.strictEqual(L.pickContract({ jobType: 'Repair', state: 'DC', propertyType: 'Residential' }), 'cwa-dc-hi');
assert.strictEqual(L.pickContract({ jobType: 'Reconstruction', state: 'District of Columbia', propertyType: 'Commercial' }), 'cwa-dc-gc');
assert.strictEqual(L.pickContract({ jobType: 'Contents' }), 'cwa');
console.log('✓ pickContract: EWA for mitigation (healthcare variant), CWA otherwise (DC variants)');

// every contract id used by the rules exists in CFG.CONTRACTS with a source
['ewa', 'ewa-healthcare', 'cwa', 'cwa-dc-hi', 'cwa-dc-gc'].forEach(function (id) {
  const c = CFG.CONTRACTS.find((x) => x.id === id);
  assert(c && c.src && c.src.indexOf('/sites/Fortivo/') === 0, 'contract ' + id + ' must map to a Fortivo-site template');
  assert(/\.docx$/.test(c.src), 'contract ' + id + ' must be an editable .docx');
});
console.log('✓ all rule outputs resolve to editable .docx templates on the Fortivo site');

// ── planMissing (verify/repair diff) ──
assert.deepStrictEqual(
  L.planMissing(['01_Contract', '08_Invoices', '13_Daily Field Reports'], ['01_contract']),
  ['08_Invoices', '13_Daily Field Reports']);
assert.deepStrictEqual(L.planMissing(['A'], ['A', 'B']), []);
assert.deepStrictEqual(L.planMissing([], []), []);
console.log('✓ planMissing diffs case-insensitively');

// ── draftContractName ──
assert.strictEqual(
  L.draftContractName('/sites/Fortivo/x/Fortivo Emergency Work Authorization.docx', '26-01-00055'),
  'Fortivo Emergency Work Authorization - 26-01-00055 - DRAFT.docx');
console.log('✓ draftContractName keeps extension and appends job number + DRAFT');

// ── mapJob candidate columns ──
const j1 = L.mapJob({ Id: 7, Job_Number: '26-01-00055', Client_Name: 'Sherman', Status: 'Open', Property_Type: 'Residential', State: 'MD' });
assert.strictEqual(j1.jobNumber, '26-01-00055');
assert.strictEqual(j1.clientName, 'Sherman');
const j2 = L.mapJob({ Id: 8, Title: '26-02-00060', Client: 'Stopak' });
assert.strictEqual(j2.jobNumber, '26-02-00060', 'falls back to Title');
assert.strictEqual(j2.clientName, 'Stopak', 'falls back to Client');
console.log('✓ mapJob candidate-column strategy tolerates schema drift');

// ── isActiveStatus ──
assert.strictEqual(L.isActiveStatus('Open'), true);
assert.strictEqual(L.isActiveStatus('in progress'), true);
assert.strictEqual(L.isActiveStatus('Closed'), false);
assert.strictEqual(L.isActiveStatus(''), true, 'unknown status column must not hide jobs');
console.log('✓ isActiveStatus filters closed/cancelled only when status is known');

// ── config sanity (paths recon-verified 2026-08-11) ──
assert.strictEqual(CFG.TEMPLATE_FOLDER, '/sites/ActiveJobs/Shared Documents/01_Active Jobs/01_Job Name/01_Template Job Folder');
assert.strictEqual(CFG.ACTIVE_ROOT, '/sites/ActiveJobs/Shared Documents/01_Active Jobs/01_Job Name');
assert.strictEqual(CFG.CONTRACT_SUBFOLDER, '01_Contract');
console.log('✓ config paths match the live SharePoint structure');

console.log('\nAll Job Kickoff logic tests passed.');
