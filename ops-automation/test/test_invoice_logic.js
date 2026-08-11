// Unit tests — Invoice → QuickBooks Desk pure logic
'use strict';
const assert = require('assert');
const path = require('path');
const { loadSnippet } = require('./_load_snippet');

const win = loadSnippet(path.join(__dirname, '..', 'invoicing', 'fv_invoice_qb.snippet.html'));
assert(win.FVInvoiceQB, 'FVInvoiceQB namespace must attach to window');
const L = win.FVInvoiceQB._logic;

console.log('=== Invoice Desk logic ===');

// ── money ──
assert.strictEqual(L.money(1234.5), '$1,234.50');
assert.strictEqual(L.money(0), '$0.00');
assert.strictEqual(L.money(null), '$0.00');
console.log('✓ money formats USD');

// ── firstName ──
assert.strictEqual(L.firstName('Connie Warfield'), 'Connie');
assert.strictEqual(L.firstName('Sherman, Alec'), 'Alec');
assert.strictEqual(L.firstName(''), '');
console.log('✓ firstName handles "First Last" and "Last, First"');

// ── parseLineItems ──
assert.strictEqual(L.parseLineItems('not json').length, 0);
assert.strictEqual(L.parseLineItems('{"a":1}').length, 0);
const lines = L.parseLineItems(JSON.stringify([
  { description: 'Water mitigation — emergency service', amount: 4200.505, qty: 1 },
  { desc: 'Equipment (4 dehus, 3 days)', total: 900 },
  { name: 'Admin fee', price: '150.25', quantity: 2 },
  { description: 'Note: see attached T&M backup', amount: 0 }
]));
assert.strictEqual(lines.length, 3, '$0 informational lines are dropped (QBO rejects them)');
assert.strictEqual(lines[0].amount, 4200.51, 'rounds to cents');
assert.strictEqual(lines[1].description, 'Equipment (4 dehus, 3 days)');
assert.strictEqual(lines[1].amount, 900);
assert.strictEqual(lines[2].quantity, 2);
console.log('✓ parseLineItems tolerates field-name variants, drops $0 rows, survives bad JSON');

// ── hasNegativeLines (credit/discount lines block the sync with a clear message) ──
assert.strictEqual(L.hasNegativeLines([{ amount: 100 }, { amount: -25 }]), true);
assert.strictEqual(L.hasNegativeLines([{ amount: 100 }]), false);
assert.strictEqual(L.hasNegativeLines([]), false);
console.log('✓ hasNegativeLines flags credit/discount lines');

// ── sumLines ──
assert.strictEqual(L.sumLines([{ amount: 0.1 }, { amount: 0.2 }]), 0.3);
console.log('✓ sumLines avoids float dust');

// ── buildQboPayload ──
const row = {
  Id: 12, Title: 'INV-2608-003', Job_Number: '26-01-00055', Job_Name: 'Sherman Water Loss',
  Client_Name: 'Alec Sherman', Property_Address: '123 Main St, Rockville MD',
  Invoice_Date: '2026-08-11T00:00:00Z', Due_Date: '2026-09-05T00:00:00Z',
  Total: 5100.51,
  Line_Items_JSON: JSON.stringify([{ description: 'Mitigation services', amount: 5100.51 }])
};
const p = L.buildQboPayload(row, 'alec@example.com');
assert.strictEqual(p.internalNumber, 'INV-2608-003', 'internal number is the idempotency key');
assert.strictEqual(p.txnDate, '2026-08-11');
assert.strictEqual(p.dueDate, '2026-09-05');
assert.strictEqual(p.clientEmail, 'alec@example.com');
assert.strictEqual(p.lineItems.length, 1);
assert(p.memo.indexOf('26-01-00055') !== -1);
// no line items JSON → single fallback line from Total
const p2 = L.buildQboPayload({ Title: 'INV-2608-004', Total: 750, Job_Number: '26-02-00060', Line_Items_JSON: '' }, '');
assert.strictEqual(p2.lineItems.length, 1);
assert.strictEqual(p2.lineItems[0].amount, 750);
console.log('✓ buildQboPayload maps the SP Invoices row (with Total fallback line)');

// ── stampName ──
assert.strictEqual(L.stampName('Fortivo Invoice Template.pdf', '1054'), 'Fortivo Invoice Template - INV 1054.pdf');
assert.strictEqual(L.stampName('invoice', '9'), 'invoice - INV 9.pdf');
console.log('✓ stampName produces a copy name (original never overwritten)');

// ── isInvoiceNumberField ──
assert.strictEqual(L.isInvoiceNumberField('InvoiceNumber'), true);
assert.strictEqual(L.isInvoiceNumberField('invoice_no_1'), true);
assert.strictEqual(L.isInvoiceNumberField('Invoice #'), true);
assert.strictEqual(L.isInvoiceNumberField('InvoiceDate'), false);
assert.strictEqual(L.isInvoiceNumberField('ClaimNumber'), false);
console.log('✓ isInvoiceNumberField targets only invoice-number form fields');

// ── buildEmail ──
const mail = L.buildEmail({
  docNumber: '1054', jobNumber: '26-01-00055', clientName: 'Alec Sherman',
  address: '123 Main St', total: 5100.51, dueDate: '2026-09-05'
});
assert(mail.subject.indexOf('1054') !== -1 && mail.subject.indexOf('26-01-00055') !== -1);
assert(mail.html.indexOf('Hi Alec') !== -1);
assert(mail.html.indexOf('QuickBooks') !== -1, 'must tell the client the QB copy is coming');
assert(mail.html.indexOf('pay online') !== -1 && mail.html.indexOf('by mail') !== -1, 'dual payment options');
assert(mail.html.indexOf('$5,100.51') !== -1);
assert(mail.html.indexOf('Net 25') !== -1);
assert(mail.html.indexOf('3% processing fee') !== -1);
const mail2 = L.buildEmail({ docNumber: '9', clientName: '', extraNote: 'See you Tuesday.' });
assert(mail2.html.indexOf('Hello,') !== -1);
assert(mail2.html.indexOf('See you Tuesday.') !== -1);
assert(mail2.html.indexOf('Net 25') !== -1, 'terms are stated even without a due date');
console.log('✓ buildEmail carries the standard wording (QB copy, dual payment, terms, surcharge)');

// ── buildEmail escapes SharePoint-sourced values (client-facing HTML) ──
const mail3 = L.buildEmail({
  docNumber: '10', clientName: 'Smith <Trust> & Sons', address: 'Unit <B>, 123 Main & Oak', total: 10
});
assert(mail3.html.indexOf('<Trust>') === -1 && mail3.html.indexOf('&lt;Trust&gt;') === -1,
  'firstName only takes the first word — no raw markup either way');
assert(mail3.html.indexOf('Unit <B>') === -1, 'address markup is escaped');
assert(mail3.html.indexOf('Unit &lt;B&gt;') !== -1, 'address renders as text');
console.log('✓ buildEmail escapes client/address values in the HTML body');

console.log('\nAll Invoice Desk logic tests passed.');
