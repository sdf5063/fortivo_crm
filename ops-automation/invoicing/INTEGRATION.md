# Invoice → QuickBooks Desk — Integration Guide

Automates the manual invoice ritual end to end while keeping you in control of
every client-facing action:

```
Pick invoice → Create matching QB invoice (QB assigns the number)
            → QB number auto-saved to the SP Invoices row
            → Stamp QB number into the PDF + FLATTEN (copy, original untouched)
            → Outlook DRAFT with standard wording + stamped PDF attached
            → YOU press Send in Outlook · send the QB copy from QB when ready
```

## Part A — Relay endpoint (5 minutes, one time)

1. Copy `api/qbo-invoice.js` into `~/fortivo-voice-email/api/qbo-invoice.js`.
2. Sanity-check the two integration points against your repo (they match the
   patterns recorded in decisions.md):
   - `lib/token-store.js` exports `loadNamedTokens(name)` / `saveNamedTokens(name, tokens)`
   - env vars `API_KEY`, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`
     are already set (same ones `qbo-project.js` uses)
3. Deploy: `cd ~/fortivo-voice-email && npx vercel --prod`
   - **Function count**: Hobby plan allows 12; you're at 11/12 after the
     2026-07-14 consolidation, so this fits. If a future endpoint needs the
     slot, fold this file into `api/qbo-project.js` as an `action=invoice`
     branch.
4. It reuses the existing encrypted `qbo` token blob — **no new Intuit consent
   needed** (the pending 2-click `qbo-project` connect covers both endpoints).
5. **Recommended env:** `INVOICE_API_KEY` — a dedicated key for this endpoint.
   The key you paste into the SharePoint page is readable by anyone who can
   view the page source, so don't put the master `API_KEY` there; mint a
   separate value, set it as `INVOICE_API_KEY` on Vercel, and use that as
   `RELAY_KEY`. It can then be rotated without touching the DFR/voice apps.
6. Optional env: `QBO_DEFAULT_ITEM_NAME` (defaults to `Services`) — the QBO
   product/service line items are booked under.

**Prerequisite in QuickBooks:** *Custom transaction numbers* must be **OFF**
(Settings → Account and settings → Sales) — that's what makes QB auto-assign
invoice numbers. The endpoint checks this before creating anything and fails
cleanly if it's on.

Endpoint behavior: create-only (never updates/voids/deletes in QBO).
Duplicate protection is layered: the desk re-reads the SP row's
`QB_Invoice_Number` immediately before syncing (catches other-device races),
and the relay embeds a `[FV:INV-…]` marker in PrivateNote and scans the ~100
most recent invoices for it before creating — **failing closed** (503, nothing
created) if that check can't run. Line items must be positive amounts; $0
note lines are dropped client-side and negative (credit) lines block the sync
with an explanation — net discounts into a line or use "Skip".

## Part B — Azure AD permission for Outlook drafts (2 clicks, one time)

The email step creates a **draft** via Microsoft Graph using the existing
"Fortivo Voice Email" app (`cbec554b-4222-4c5b-a1b8-e51133955bb3`):

1. portal.azure.com → App registrations → Fortivo Voice Email → API
   permissions → Add → Microsoft Graph → **Delegated** → `Mail.ReadWrite` → Add.
2. Also confirm `https://fortivopropertyservices.sharepoint.com` is listed as a
   **SPA redirect URI** (the CRM calendar sync already uses MSAL from SP pages;
   if that works, this works).

No `Mail.Send` is requested anywhere — the module is physically unable to send
email. It can only create drafts you review in Outlook.

## Part C — Paste the block

Paste the entire contents of `fv_invoice_qb.snippet.html` into
`fortivo_invoicing.html` directly **before `</body>`** (works from the
Dashboard too if you also want it there).

Then set one value in the snippet's `FVQ_CFG`:

- `RELAY_KEY` — the relay's `INVOICE_API_KEY` env value (see Part A step 5;
  falls back to accepting `API_KEY`, but prefer the dedicated key since this
  value is visible to anyone who can read the SharePoint page).

**CDN dependencies (steps 3–4 only):** the desk loads two pinned libraries on
demand from cdn.jsdelivr.net — `pdf-lib@1.17.1` and
`@azure/msal-browser@2.38.3`. The PWA service worker already cache-first's
jsdelivr URLs, so after first use they work offline. Recommended: pin
subresource-integrity hashes in `FVQ_CFG.SRI` — generate each with:

```bash
curl -sSL <cdn-url> | openssl dgst -sha384 -binary | openssl base64 -A
# → put "sha384-<output>" into FVQ_CFG.SRI.PDFLIB / .MSAL
```

Optional tuning in `FVQ_CFG`:
- `STAMP` — fallback text-stamp position for PDFs without a form field
  (`fromRight`/`fromTop` in PDF points, measured from the top-right corner).
  If the "Fortivo Invoice Template.pdf" has a fillable *Invoice Number* field,
  the module fills and flattens that field instead — no tuning needed.
- `COMPANY` — wording used in the standard email (terms, surcharge note, AR
  address).

## Part D — Deploy the app page

Canary-first, per the standing rule: test-render a scratch page, then
DELETE + `Files/Add` fresh item for `fortivo_invoicing.aspx`, publish, verify.
Keep a dated `_backups/` copy of the previous master.

## Duplicate & safety guarantees

| Risk | Guard |
|---|---|
| Same invoice created twice in QB | Fresh re-read of `QB_Invoice_Number` right before sync + double-tap button lock + relay marker probe (fails closed on error) + second probe just before create |
| Stamped with a bogus number | Relay verifies QB's *custom transaction numbers* is off before creating; desk refuses to stamp/write-back a missing number |
| Booked to the wrong QB customer | Fuzzy customer match must contain the client name and is reported back ("booked under …") so a mismatch is visible immediately |
| Original PDF damaged | Stamping always writes a **copy** (`… - INV 1234.pdf`); uploads are create-only, never overwrite |
| Email sent by accident | Only Outlook **drafts** are created (`Mail.ReadWrite`, not `Mail.Send`) |
| QB copy emailed early | This kit never triggers QB's send — you send from QB when ready |
| Wrong totals reaching QB | Billable-lines vs Total mismatch and negative-line blocks surfaced in step 2 before you sync |
| SP row corrupted | Only field written back is `QB_Invoice_Number` (MERGE, single field, after a fresh-value check) |
| No paper trail | Each QB sync, manual number entry, stamped-PDF save, and draft creation is logged to `Automation_Log` (best-effort) |

## Manual fallback still works

No relay? Use **Skip (enter QB # by hand)** in step 2 — you create the QB
invoice yourself as today, type its number in, and still get automated
stamping + flattening + the standard draft email.
