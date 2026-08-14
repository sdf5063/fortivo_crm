// Unit tests — Wizard Safety Net pure logic
'use strict';
const assert = require('assert');
const path = require('path');
const { loadSnippet } = require('./_load_snippet');

const win = loadSnippet(path.join(__dirname, '..', 'invoicing', 'fv_wizard_safety.snippet.html'));
assert(win.FVWizardGuard, 'FVWizardGuard namespace must attach to window');
const L = win.FVWizardGuard._logic;

console.log('=== Wizard Safety Net logic ===');

// ── labelFor priority: label > placeholder > name > id ──
assert.strictEqual(L.labelFor({ label: 'Client Name', placeholder: 'x', name: 'n', id: 'i' }), 'Client Name');
assert.strictEqual(L.labelFor({ placeholder: 'Invoice total', name: 'n' }), 'Invoice total');
assert.strictEqual(L.labelFor({ name: 'jobNumber' }), 'jobNumber');
assert.strictEqual(L.labelFor({}), 'field');
console.log('✓ labelFor priority chain');

// ── classifyRequest: only Invoices-list POSTs, create vs update ──
const CREATE = "/sites/FortivoOperations/_api/web/lists/getbytitle('Invoices')/items";
assert.strictEqual(L.classifyRequest(CREATE, 'POST', {}), 'create');
assert.strictEqual(L.classifyRequest(CREATE + '(12)', 'POST', { 'X-HTTP-Method': 'MERGE' }), 'update');
assert.strictEqual(L.classifyRequest(CREATE + '(12)', 'POST', { 'X-HTTP-Method': 'DELETE' }), null, 'deletes ignored');
assert.strictEqual(L.classifyRequest(CREATE, 'GET', {}), null, 'reads ignored');
assert.strictEqual(L.classifyRequest("/x/getbytitle('Jobs_Master')/items", 'POST', {}), null, 'other lists ignored');
console.log('✓ classifyRequest watches only Invoices writes');

// ── merge: accumulates, overwrites, drops empties ──
let d = L.merge(null, 'Client Name', 'Alec');
d = L.merge(d, 'Total', '5100.51');
d = L.merge(d, 'Client Name', 'Alec Sherman');
assert.strictEqual(L.count(d), 2);
assert.strictEqual(d.fields['Client Name'], 'Alec Sherman');
d = L.merge(d, 'Total', '');
assert.strictEqual(L.count(d), 1, 'cleared fields drop out');
assert(d.updatedAt >= d.startedAt);
console.log('✓ merge accumulates and prunes');

assert.strictEqual(L.count(null), 0);
console.log('✓ count tolerates empty state');

console.log('\nAll Wizard Safety Net logic tests passed.');
