// Fortivo Ops Automation — QuickBooks Invoice Relay
// POST /api/qbo-invoice
//
// INSTALL: copy this file into ~/fortivo-voice-email/api/qbo-invoice.js and
// deploy (vercel --prod). It reuses the existing encrypted 'qbo' token blob
// created by api/qbo-project.js — NO new Intuit consent or redirect URI needed.
//
// Depends only on lib/token-store.js (loadNamedTokens / saveNamedTokens) and
// these env vars (all already set for qbo-project): API_KEY, QBO_CLIENT_ID,
// QBO_CLIENT_SECRET, QBO_REALM_ID. Optional: QBO_ENV=sandbox,
// QBO_DEFAULT_ITEM_NAME (default 'Services'), INVOICE_API_KEY (recommended —
// a dedicated key for this endpoint so the one pasted into the SharePoint
// page is NOT the master relay key and can be rotated independently).
//
// Requires the QBO company setting "Custom transaction numbers" to be OFF —
// that is what makes QuickBooks auto-assign invoice numbers. The handler
// checks this preference before creating anything and fails cleanly if ON.
// Written against QBO API minorversion 75.
//
// Request:  { invoice: { internalNumber, jobNumber, clientName, clientEmail?,
//                        txnDate?, dueDate?, memo?, total, lineItems:[{description,amount,quantity}] },
//             send?: false }
// Response: { ok:true, existing:bool, qboInvoiceId, docNumber, customerId }
//
// GUARANTEES: create-only (never updates, voids, or deletes anything in QBO).
// Idempotent: every created invoice carries the marker [FV:<internalNumber>]
// in PrivateNote; a same-day retry finds it and returns the existing invoice
// instead of creating a duplicate. QuickBooks assigns the DocNumber.

'use strict';

/* ── pure helpers (exported for tests as module.exports._internal) ────────── */

function escapeQql(s) {
  // QBO query language: single quotes escaped by backslash
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function marker(internalNumber) {
  return '[FV:' + String(internalNumber || '').trim() + ']';
}

function sumLines(lines) {
  return Math.round((lines || []).reduce(function (a, li) { return a + Number(li.amount || 0); }, 0) * 100) / 100;
}

function validateInvoice(inv) {
  if (!inv || typeof inv !== 'object') return 'invoice object required';
  if (!inv.internalNumber) return 'invoice.internalNumber required (idempotency key)';
  if (!inv.clientName) return 'invoice.clientName required';
  if (!Array.isArray(inv.lineItems) || !inv.lineItems.length) return 'invoice.lineItems required (at least one)';
  for (var i = 0; i < inv.lineItems.length; i++) {
    var li = inv.lineItems[i];
    if (!(Number(li.amount) > 0)) return 'lineItems[' + i + '].amount must be > 0';
  }
  return null;
}

function buildInvoicePayload(inv, customerId, itemId) {
  var payload = {
    CustomerRef: { value: String(customerId) },
    Line: inv.lineItems.map(function (li) {
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: Math.round(Number(li.amount) * 100) / 100,
        Description: String(li.description || 'Services').slice(0, 4000),
        SalesItemLineDetail: {
          ItemRef: { value: String(itemId) },
          Qty: Number(li.quantity || 1) || 1
        }
      };
    }),
    PrivateNote: (marker(inv.internalNumber) + ' Job ' + (inv.jobNumber || '') + ' — created by Fortivo Ops Automation').slice(0, 4000),
    AllowOnlineACHPayment: true,
    AllowOnlineCreditCardPayment: true
  };
  if (inv.txnDate) payload.TxnDate = inv.txnDate;
  if (inv.dueDate) payload.DueDate = inv.dueDate;
  if (inv.memo) payload.CustomerMemo = { value: String(inv.memo).slice(0, 1000) };
  if (inv.clientEmail) payload.BillEmail = { Address: inv.clientEmail };
  return payload;
}

/* ── QBO plumbing ─────────────────────────────────────────────────────────── */

var QBO_BASE = (process.env.QBO_ENV === 'sandbox')
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

function loadTokenStore() {
  try { return require('../lib/token-store'); }
  catch (e) {
    throw new Error('lib/token-store.js not found — this endpoint must live in the fortivo-voice-email project (' + e.message + ')');
  }
}

async function refreshTokens(store, tokens) {
  var basic = Buffer.from(process.env.QBO_CLIENT_ID + ':' + process.env.QBO_CLIENT_SECRET).toString('base64');
  var r = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(tokens.refresh_token)
  });
  if (!r.ok) {
    var t = await r.text();
    throw new Error('QBO token refresh failed (' + r.status + '): ' + t.slice(0, 200) + ' — re-connect via /api/qbo-project?action=connect');
  }
  var fresh = await r.json();
  var merged = Object.assign({}, tokens, fresh, { obtained_at: Date.now() });
  await store.saveNamedTokens('qbo', merged); // Intuit rotates refresh tokens — persist immediately
  return merged;
}

function makeQbo(store, tokens, realmId) {
  var current = tokens;
  async function call(method, path, body, isRetry) {
    var r = await fetch(QBO_BASE + '/v3/company/' + realmId + path, {
      method: method,
      headers: {
        Authorization: 'Bearer ' + current.access_token,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401 && !isRetry) {
      current = await refreshTokens(store, current);
      return call(method, path, body, true);
    }
    var text = await r.text();
    var json; try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!r.ok) {
      var detail = json && json.Fault && json.Fault.Error && json.Fault.Error[0]
        ? (json.Fault.Error[0].Message + ' — ' + (json.Fault.Error[0].Detail || ''))
        : text.slice(0, 300);
      throw new Error('QBO ' + method + ' ' + path.split('?')[0] + ' failed (' + r.status + '): ' + detail);
    }
    return json;
  }
  return {
    query: function (q) { return call('GET', '/query?query=' + encodeURIComponent(q) + '&minorversion=75'); },
    post: function (entity, body) { return call('POST', '/' + entity + '?minorversion=75', body); }
  };
}

async function findOrCreateCustomer(qbo, inv) {
  var rawName = inv.clientName.trim();
  var name = escapeQql(rawName);
  var res = await qbo.query("SELECT Id, DisplayName FROM Customer WHERE DisplayName = '" + name + "'");
  var found = res.QueryResponse && res.QueryResponse.Customer && res.QueryResponse.Customer[0];
  // Fuzzy fallback: skipped when the name itself contains LIKE wildcards, and
  // a lone candidate is only accepted after a plain-JS containment check —
  // never book an invoice onto a customer the name doesn't actually match.
  if (!found && !/[%_]/.test(rawName)) {
    res = await qbo.query("SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '%" + name + "%' MAXRESULTS 5");
    var cands = (res.QueryResponse && res.QueryResponse.Customer) || [];
    if (cands.length === 1 &&
        String(cands[0].DisplayName || '').toLowerCase().indexOf(rawName.toLowerCase()) !== -1) {
      found = cands[0];
    }
  }
  if (found) return { id: found.Id, name: found.DisplayName, created: false };
  var body = { DisplayName: rawName };
  if (inv.clientEmail) body.PrimaryEmailAddr = { Address: inv.clientEmail };
  var created = await qbo.post('customer', body);
  return { id: created.Customer.Id, name: created.Customer.DisplayName, created: true };
}

async function findDefaultItem(qbo) {
  var wanted = escapeQql(process.env.QBO_DEFAULT_ITEM_NAME || 'Services');
  var res = await qbo.query("SELECT Id, Name FROM Item WHERE Name = '" + wanted + "'");
  var item = res.QueryResponse && res.QueryResponse.Item && res.QueryResponse.Item[0];
  if (item) return item.Id;
  res = await qbo.query('SELECT Id, Name FROM Item WHERE Type IN (\'Service\', \'NonInventory\') MAXRESULTS 1');
  item = res.QueryResponse && res.QueryResponse.Item && res.QueryResponse.Item[0];
  if (item) return item.Id;
  throw new Error("No usable Item found in QBO — create a 'Services' product/service item once, or set QBO_DEFAULT_ITEM_NAME");
}

async function findExistingByMarker(qbo, inv) {
  // PrivateNote isn't filterable in QBO queries → scan the most recent
  // invoices (date-narrowed when possible) and match the marker locally.
  // FAIL CLOSED: a probe error must abort the request (503), never fall
  // through to a create — that is exactly the retry scenario the marker
  // exists for. Window: 100 most-recent invoices; the SP row's
  // QB_Invoice_Number (checked fresh client-side) is the long-term guard.
  var mk = marker(inv.internalNumber);
  var q = 'SELECT Id, DocNumber, PrivateNote FROM Invoice';
  if (inv.txnDate) q += " WHERE TxnDate = '" + escapeQql(inv.txnDate) + "'";
  q += ' ORDERBY MetaData.CreateTime DESC MAXRESULTS 100';
  var res = await qbo.query(q);
  var list = (res.QueryResponse && res.QueryResponse.Invoice) || [];
  return list.find(function (x) { return x.PrivateNote && x.PrivateNote.indexOf(mk) !== -1; }) || null;
}

async function customTxnNumbersOn(qbo) {
  // When Preferences.SalesFormsPrefs.CustomTxnNumbers is true, QBO does NOT
  // auto-assign DocNumber — the whole "QB assigns the number" flow breaks.
  // Check up-front so we fail cleanly BEFORE creating anything.
  var res = await qbo.query('SELECT * FROM Preferences');
  var prefs = res.QueryResponse && res.QueryResponse.Preferences && res.QueryResponse.Preferences[0];
  return !!(prefs && prefs.SalesFormsPrefs && prefs.SalesFormsPrefs.CustomTxnNumbers === true);
}

/* ── handler ──────────────────────────────────────────────────────────────── */

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://fortivopropertyservices.sharepoint.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Prefer INVOICE_API_KEY (a dedicated, independently-rotatable key for the
  // key that gets pasted into the SharePoint page); API_KEY also accepted.
  var key = req.headers['x-api-key'] || (req.query && req.query.key);
  var validKeys = [process.env.INVOICE_API_KEY, process.env.API_KEY].filter(Boolean);
  if (!validKeys.length || validKeys.indexOf(key) === -1) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    var inv = req.body && req.body.invoice;
    var bad = validateInvoice(inv);
    if (bad) return res.status(400).json({ ok: false, error: bad });

    var lineSum = sumLines(inv.lineItems);
    if (inv.total && Math.abs(lineSum - Number(inv.total)) > 0.5) {
      // surfaced as a warning, not a block — Scott sees totals in the UI before emailing
      inv._totalMismatch = { lineSum: lineSum, total: Number(inv.total) };
    }

    var store = loadTokenStore();
    var tokens = await store.loadNamedTokens('qbo');
    if (!tokens || !tokens.access_token) {
      return res.status(409).json({ ok: false, error: 'QuickBooks not connected — visit /api/qbo-project?action=connect&key=API_KEY first' });
    }
    var realmId = tokens.realmId || process.env.QBO_REALM_ID;
    if (!realmId) return res.status(500).json({ ok: false, error: 'QBO_REALM_ID not configured' });

    var qbo = makeQbo(store, tokens, realmId);

    // 1. Idempotency: same internal number already synced? Return it.
    //    Probe errors FAIL CLOSED (503) — never create when we can't verify.
    var existing;
    try {
      existing = await findExistingByMarker(qbo, inv);
    } catch (probeErr) {
      return res.status(503).json({ ok: false, error: 'Could not verify whether this invoice already exists in QuickBooks (' + probeErr.message + ') — nothing was created; retry shortly.' });
    }
    if (existing) {
      return res.status(200).json({ ok: true, existing: true, qboInvoiceId: existing.Id, docNumber: existing.DocNumber });
    }

    // 2. Pre-flight: QB must be the number authority for this flow
    if (await customTxnNumbersOn(qbo)) {
      return res.status(409).json({ ok: false, error: 'QuickBooks setting "Custom transaction numbers" is ON, so QB will not auto-assign invoice numbers. Turn it off (Settings → Account and settings → Sales) or create this invoice in QB by hand and use "Skip". Nothing was created.' });
    }

    // 3. Customer (exact → verified single fuzzy → create) and service item
    var customer = await findOrCreateCustomer(qbo, inv);
    var itemId = await findDefaultItem(qbo);

    // 4. Narrow the double-submit window: re-probe right before creating
    try {
      existing = await findExistingByMarker(qbo, inv);
      if (existing) {
        return res.status(200).json({ ok: true, existing: true, qboInvoiceId: existing.Id, docNumber: existing.DocNumber, customerId: customer.id, customerName: customer.name });
      }
    } catch (probeErr2) {
      return res.status(503).json({ ok: false, error: 'Could not re-verify idempotency before create (' + probeErr2.message + ') — nothing was created; retry shortly.' });
    }

    // 5. Create the invoice — QuickBooks assigns DocNumber
    var created = await qbo.post('invoice', buildInvoicePayload(inv, customer.id, itemId));
    var out = created.Invoice;

    return res.status(200).json({
      ok: true,
      existing: false,
      qboInvoiceId: out.Id,
      docNumber: out.DocNumber || null,   // null would mean QB didn't assign — client refuses to stamp it
      customerId: customer.id,
      customerName: customer.name,
      customerCreated: customer.created,
      totalMismatch: inv._totalMismatch || null
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
module.exports._internal = { escapeQql: escapeQql, marker: marker, sumLines: sumLines, validateInvoice: validateInvoice, buildInvoicePayload: buildInvoicePayload };
