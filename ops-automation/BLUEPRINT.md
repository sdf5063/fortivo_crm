# Fortivo Ops Automation — Upgrade Blueprint
**Date:** 2026-08-11 · **Status:** Kit built & unit-tested; ready for install
**Scope:** Operations Dashboard ecosystem (Dashboard, Job Manager, Invoicing, Tasks + relay)

---

## 1. What this upgrade delivers

Two push-button automations, built as self-contained drop-in blocks for the
existing single-file SharePoint apps (the exact pattern already proven by the
universal search bar), plus one relay endpoint that slots into the existing
`fortivo-voice-email` Vercel project:

| # | Automation | Replaces | Time saved |
|---|---|---|---|
| 1 | **⚡ Job Kickoff** — one tap creates the job folder (`26-01-00055 (Sherman-Mit)`), clones all 14 template subfolders, and drops the right contract draft into `01_Contract` | Manual folder copying + hunting for the right contract template | ~10–15 min/job, zero missed folders |
| 2 | **🧾 Invoice Desk** — pick invoice → matching QB invoice created (QB assigns the number) → number auto-saved to SharePoint → number stamped into the PDF + flattened → Outlook draft with your standard wording + attachment | The whole manual ritual: hand-build QB invoice, copy number, edit PDF, flatten, compose email | ~15–20 min/invoice, no transposed numbers |

**No PowerShell, no add-ons, no new logins.** Everything runs in the browser
session you already have (SharePoint REST + Microsoft Graph) plus the Vercel
relay that already holds your QuickBooks connection. Mac/iPhone friendly.

---

## 2. How it fits the existing architecture (unchanged)

```
iPhone / Mac browser
   │
   ├── SitePages SPAs (single-file HTML — unchanged architecture)
   │     Fortivo_Dashboard · fortivo_app · fortivo_invoicing · fortivo_tasks
   │     └── NEW: two pasted blocks (fvk-/fvq- prefixed, self-contained)
   │           ├── SharePoint REST, same-origin cookie auth (as today)
   │           │     ├── /sites/ActiveJobs   → job folders + template
   │           │     └── /sites/Fortivo      → contract templates (read-only)
   │           ├── Microsoft Graph via MSAL  → Outlook DRAFTS only
   │           │     (existing "Fortivo Voice Email" Azure app + Mail.ReadWrite)
   │           └── fortivo-voice-email relay → NEW api/qbo-invoice.js
   │                 (reuses the existing encrypted QBO token blob)
   └── SP lists stay the source of truth: Jobs_Master, Invoices, Ops_Tasks
         └── NEW optional list: Automation_Log (audit trail)
```

Design rules honored: single-file apps, stable PWA URLs, SP lists as source of
truth, CRM stays optional, canary-first deploys.

## 3. Automation 1 — Job Kickoff (job-kickoff/)

**Flow:** ⚡ button (Job Manager and/or Dashboard) → pick the job (or enter
manually) → the module proposes:
- **Folder name** per the convention `{num} ({client}-{type})` — editable
- **Job type** guessed from the number segment (`YY-01-…` → Mitigation,
  `YY-02-…` → Repair) — editable
- **Contract** by rule — editable:
  - Mitigation → **Fortivo Emergency Work Authorization** (.docx draft)
  - Mitigation + Healthcare property → Healthcare EWA
  - Everything else → **Fortivo Client Work Agreement**
  - DC property → DC Home Improvement (residential) / DC General Construction
- A full **plan preview** (exactly what will be created) + a **dry-run** toggle

Then one tap: the module re-reads the **live template manifest** and creates
every subfolder (top level plus one nested level, e.g. `08_Invoices/T&M`) that
is missing, copies the contract cross-site from `11_Templates/.../Final/` as
`… - {job#} - DRAFT.docx`, verifies the structure, and logs the run. Because
it is diff-based and create-only, it is fully idempotent — re-runs and even
two devices running it at once can only fill gaps, never duplicate or
overwrite.

**The template folder stays your control panel:** add `15_Warranty` to
`01_Template Job Folder` tomorrow and every future kickoff includes it — no
code change.

**If the folder already exists** (e.g. created by hand), Kickoff flips to
verify/repair: it only adds missing subfolders and only seeds the contract if
`01_Contract` doesn't already hold one. Nothing is ever overwritten.

## 4. Automation 2 — Invoice Desk (invoicing/)

Matches your exact ritual, automated, with you approving each client-facing
step:

| Step | Today (manual) | With Invoice Desk |
|---|---|---|
| QB sister invoice | Re-key everything into QB | One tap — relay creates it from the SP invoice row; **QB assigns the number** |
| Copy QB number | Read from QB, hope no typo | Returned by the API, auto-written to `QB_Invoice_Number` on the SP row |
| Put number in PDF + flatten | Open editor, type, flatten, save | One tap — fills the PDF's invoice-number form field (or stamps text), flattens, saves a **copy**; original untouched |
| Compose email | Write it from scratch each time | Outlook **draft** created: standard wording incl. *"you'll also receive this through QuickBooks — pay online or by mail"*, Net 25, CC surcharge note, stamped PDF attached |
| Send | — | **You** press Send in Outlook; **you** send the QB copy from QB when ready |

Duplicate-proof, in layers: the desk re-reads the invoice row's QB number
immediately before syncing (catches a second device), locks the button while
a sync is in flight (catches a double-tap), and the relay embeds an
idempotency marker (`[FV:INV-…]`) that it checks before creating — failing
closed if the check can't run. The relay is create-only — it cannot update,
void, or delete anything in QuickBooks.

One QuickBooks prerequisite: *custom transaction numbers* must be **off**
(that's the setting that makes QB auto-assign invoice numbers). The relay
verifies this before creating anything and explains exactly what to change if
it's on.

No relay yet? The desk still works: "Skip — enter QB # by hand" gives you
automated stamping + flattening + the standard draft email today.

## 5. "Or say something" — voice & assistant paths (proposed next)

1. **Tell Fortivo → Kickoff** (small relay addition): "Hey Siri, Tell Fortivo —
   new mitigation job for Sherman at Phelps Place" → creates the Jobs_Master
   row + an Ops_Task "Run kickoff for 26-…" (or, once trusted, runs the same
   folder scaffold via Graph). Builds on the existing `api/tasks.js` pattern.
2. **Claude-side desk:** in Claude Code/Cowork, the QuickBooks + Microsoft 365
   connectors are already live, so "invoice job 26-01-00055 for $4,200,
   mitigation line items" can drive the same pipeline conversationally. Worth
   packaging as a `fortivo-invoice-desk` skill after the button flow settles.
3. **Morning Brief tie-in:** brief already flags overdue invoices; add a line
   for "jobs In Progress with no job folder / no contract in 01_Contract"
   (read-only checks) so gaps surface automatically.

## 6. Data sanctity — by design, not by promise

- **Create-only engines.** No code path deletes, moves, or overwrites — SP
  writes use `overwrite=false`; folder copy uses `KeepBoth`; PDF stamping
  writes a new file; the QBO relay only creates.
- **Preview + dry-run** before anything touches SharePoint.
- **Idempotent & re-runnable.** Failures stop cleanly; re-running fills gaps.
- **Human on the trigger for anything client-facing.** Only Outlook *drafts*
  (`Mail.ReadWrite`; the code has no send permission), QB sends stay in QB.
- **Audit trail.** Kickoff runs, QB syncs, manual QB-number entries,
  stamped-PDF saves, and draft creations are all logged to `Automation_Log`
  (what, when, result, details JSON). Logging is best-effort — verify the
  first row appears after your first run (rollout step 4).
- **Blast-radius isolation.** Pasted blocks are namespaced (`fvk-`/`fvq-`) and
  self-contained; if one ever misbehaves, delete the block and redeploy — the
  apps are untouched.
- **Canary-first deploys** per the standing hard rule; keep dated `_backups/`.
- **This kit lives in git** (`fortivo_crm/ops-automation`) — reviewable,
  diffable, revertible.
- **Adversarially reviewed before commit.** Six independent review passes
  (SharePoint REST, QuickBooks API, Graph/MSAL, data-safety, front-end,
  docs-consistency) produced 36 findings; every confirmed one was fixed —
  including two critical bugs (an empty-job-number path that could have
  written into the template folder, and an audit-list field-name encoding
  issue that would have silently disabled logging).

## 7. Other efficiency upgrades (recommended roadmap)

**Near term (high value, low risk)**
1. **Contract auto-fill (Phase 2 of Kickoff):** merge client name, address,
   date into the DRAFT .docx on copy (docx XML find/replace, same technique as
   the T&M rate-sheet generator). You'd open a contract that's 90% done.
2. **QB payment sync-back:** relay endpoint polls QBO for paid/partial status
   on linked invoices → updates `Invoices` list → Dashboard AR tiles and the
   Morning Brief collections section get live truth without opening QB.
3. **Kickoff writes `Folder_URL` to Jobs_Master** (one optional column) so
   every app can deep-link to the job folder.

**Medium term**
4. **Job close-out assistant:** checklist-driven — verifies lien releases,
   final invoice paid, closeout docs present, then (and only then) offers the
   move to `02_Closed Jobs/{year}` with an explicit confirm. (Moves are the
   one genuinely destructive op in this domain — keep a human on it.)
5. **Sub compliance tracker:** COI/W-9 expiry dates on a `Subcontractors`
   list; Morning Brief flags expiring coverage before you mobilize a sub.
6. **Permit deadlines** into Ops_Tasks from `07_Permits` contents.
7. **Weekly WIP one-pager:** auto-generated Friday summary (jobs by phase,
   AR aging, equipment out) emailed like the Morning Brief.

**Strategic**
8. **Version-control the app masters:** commit the five Site Assets HTML
   masters to a private repo on every deploy (the 2026-07-13 outage showed
   why). This kit's repo is a natural home.
9. **SitePages exit plan** (already noted in decisions.md): Microsoft keeps
   squeezing custom script; Netlify + MSAL/Graph is the proven fallback and
   these modules are already Graph-compatible.

## 8. Rollout — agent-run, not a Scott task

Deployment is executed by the Claude session on Scott's Mac (Cowork or Claude
Code), which holds what this cloud session can't: the OneDrive-synced Site
Assets masters, the authenticated SharePoint browser session, and the
`~/fortivo-voice-email` Vercel project. Everything is scripted in
**`install/AGENT_RUNBOOK.md`** with two executable installers
(`install/insert_snippets.js` for the masters, `install/sp_deploy_console.js`
for the canary-first SharePoint deploy — both idempotent, backup-first, and
verified end-to-end).

**To start it:** open Cowork on the Mac and say —
*"Clone branch `claude/operations-dashboard-automation-fh2kgo` of
`sdf5063/fortivo_crm` and execute `ops-automation/install/AGENT_RUNBOOK.md`
end to end."*

Scott's only moments, by design: being signed in, two deep-linked consent
clicks (Azure `Mail.ReadWrite`, Intuit connect), and the $1 QuickBooks test
invoice at the end. The agent's sequence, for reference:

1. `npm test` in `ops-automation/` (already green) — sanity.
2. Create `Automation_Log` list (console snippet in job-kickoff/INTEGRATION.md —
   it uses explicit internal field names; don't create the fields by hand).
3. Paste **Job Kickoff** block into `fortivo_app.html` (+ Dashboard if wanted);
   verify Jobs_Master column names via the probe snippet; canary → deploy.
4. Dry-run a kickoff; then run one real kickoff on a test job number, inspect
   the folder, and confirm a row landed in Automation_Log; delete the test
   folder by hand afterwards (the kit won't delete it for you — by design).
5. Copy `api/qbo-invoice.js` into `~/fortivo-voice-email/api/`; set a dedicated
   `INVOICE_API_KEY` env var; `vercel --prod`. (Complete the pending 2-click
   Intuit redirect-URI + connect if not done.)
6. In QuickBooks: confirm *custom transaction numbers* is OFF
   (Settings → Account and settings → Sales).
7. Add delegated `Mail.ReadWrite` to the "Fortivo Voice Email" Azure app.
8. Paste **Invoice Desk** block into `fortivo_invoicing.html`; set `RELAY_KEY`
   to the `INVOICE_API_KEY` value; canary → deploy.
9. Run one invoice end-to-end against a $1 test invoice/customer in QB;
   confirm the draft email; delete the QB test invoice from QB by hand.

## 9. What was deliberately not touched

Production pages, SP lists, job folders, QuickBooks data, templates — all
read-only during this build. The kit ships as code + instructions; nothing
deploys or mutates until you run the checklist above.
