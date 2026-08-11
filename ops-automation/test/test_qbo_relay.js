// Unit tests — qbo-invoice relay pure helpers
'use strict';
const assert = require('assert');
const path = require('path');
const { _internal: I } = require(path.join(__dirname, '..', 'invoicing', 'api', 'qbo-invoice.js'));

console.log('=== QBO relay helpers ===');

// ── escapeQql ──
assert.strictEqual(I.escapeQql("O'Brien"), "O\\'Brien");
assert.strictEqual(I.escapeQql('back\\slash'), 'back\\\\slash');
assert.strictEqual(I.escapeQql(null), '');
console.log('✓ escapeQql escapes quotes and backslashes');

// ── marker ──
assert.strictEqual(I.marker('INV-2608-003'), '[FV:INV-2608-003]');
assert.strictEqual(I.marker(' INV-1 '), '[FV:INV-1]');
console.log('✓ marker is stable (idempotency key format)');

// ── validateInvoice ──
assert.strictEqual(I.validateInvoice(null), 'invoice object required');
assert.match(I.validateInvoice({}), /internalNumber/);
assert.match(I.validateInvoice({ internalNumber: 'x' }), /clientName/);
assert.match(I.validateInvoice({ internalNumber: 'x', clientName: 'c' }), /lineItems/);
assert.match(I.validateInvoice({ internalNumber: 'x', clientName: 'c', lineItems: [{ amount: 0 }] }), /amount/);
assert.strictEqual(I.validateInvoice({ internalNumber: 'x', clientName: 'c', lineItems: [{ amount: 10 }] }), null);
console.log('✓ validateInvoice rejects malformed payloads');

// ── sumLines ──
assert.strictEqual(I.sumLines([{ amount: 0.1 }, { amount: 0.2 }]), 0.3);
console.log('✓ sumLines rounds to cents');

// ── buildInvoicePayload ──
const inv = {
  internalNumber: 'INV-2608-003', jobNumber: '26-01-00055', clientName: 'Alec Sherman',
  clientEmail: 'alec@example.com', txnDate: '2026-08-11', dueDate: '2026-09-05',
  memo: 'Job 26-01-00055 — 123 Main St',
  lineItems: [{ description: 'Mitigation services', amount: 5100.505, quantity: 1 }]
};
const p = I.buildInvoicePayload(inv, '42', '7');
assert.strictEqual(p.CustomerRef.value, '42');
assert.strictEqual(p.Line.length, 1);
assert.strictEqual(p.Line[0].DetailType, 'SalesItemLineDetail');
assert.strictEqual(p.Line[0].Amount, 5100.51, 'amounts rounded to cents');
assert.strictEqual(p.Line[0].SalesItemLineDetail.ItemRef.value, '7');
assert(p.PrivateNote.indexOf('[FV:INV-2608-003]') === 0, 'PrivateNote starts with idempotency marker');
assert.strictEqual(p.TxnDate, '2026-08-11');
assert.strictEqual(p.DueDate, '2026-09-05');
assert.strictEqual(p.BillEmail.Address, 'alec@example.com');
assert.strictEqual(p.CustomerMemo.value, 'Job 26-01-00055 — 123 Main St');
assert.strictEqual(p.AllowOnlineCreditCardPayment, true, 'client can pay online through QB');
assert.strictEqual(p.DocNumber, undefined, 'DocNumber must be left for QuickBooks to assign');
console.log('✓ buildInvoicePayload: QB assigns the number, marker embedded, lines mapped');

// no email / no dates → fields omitted
const p2 = I.buildInvoicePayload({ internalNumber: 'a', clientName: 'c', lineItems: [{ amount: 1 }] }, '1', '1');
assert.strictEqual(p2.BillEmail, undefined);
assert.strictEqual(p2.TxnDate, undefined);
assert.strictEqual(p2.CustomerMemo, undefined);
console.log('✓ optional fields omitted cleanly');

console.log('\nAll QBO relay helper tests passed.');
