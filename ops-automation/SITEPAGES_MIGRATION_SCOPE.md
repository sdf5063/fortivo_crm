# SitePages → Vercel Migration — Scope & Estimate
**Status:** proposal for Scott's approval — nothing gets built until he signs off.
**Date:** 2026-08-14 · Approved direction: "scope it first"

## 1. Why (the recurring pain, all hosting-caused)

Every production incident this system has had traces to hosting single-file
apps inside SharePoint SitePages, not to the apps themselves:

| Incident | Root cause |
|---|---|
| July 2026 full outage (all 4 apps "File Not Found") | custom-script save-flag poisoning on SitePages file items |
| Canary-first deploy ritual + delete/re-add recipe | same save-flag behavior |
| `DenyAddAndCustomizePages` reverts every ~24h | Microsoft tenant policy, outside our control |
| Em-dash/emoji mojibake (twice) | SitePages serving without honest charset; BOM workaround |
| Untraceable deploys / no version history | SitePages has no usable versioning for these files |

Microsoft is actively squeezing custom-script hosting; these get worse, not
better. **What does NOT move: the data.** SP lists (Jobs_Master, Invoices,
Ops_Tasks, QB_* mirrors) and all job folders stay exactly where they are —
this migration moves only the 5 HTML shells.

## 2. Target architecture

```
Vercel (Pro, already paid)                 Microsoft 365 (unchanged)
┌─────────────────────────────┐            ┌──────────────────────────┐
│ ops.fortivo.com (static)    │  MSAL SSO  │ Azure AD "Fortivo Voice  │
│  /            → Dashboard   │──────────▶│  Email" app (existing)    │
│  /jobs        → Job Manager │            ├──────────────────────────┤
│  /invoicing   → Invoicing   │  Graph API │ SP lists  (source of     │
│  /tasks       → Tasks       │──────────▶│  truth — unchanged)       │
│  /crm         → CRM (dormant)│           │ Job folders (unchanged)  │
│ fortivo-voice-email relay   │            │ SitePages: tiny redirect │
│  (already on Vercel + git)  │            │  stubs keep old URLs     │
└─────────────────────────────┘            └──────────────────────────┘
```

- **Apps stay single-file HTML** — same files, same iPhone-first design.
- **Auth:** MSAL Browser (already proven in this codebase — CRM calendar sync
  and the Invoice Desk drafts use it). Login is the same Microsoft account;
  first visit shows a Microsoft sign-in, then silent forever.
- **Data access:** the apps' `spGet/spPost` helpers get a thin adapter that
  speaks Microsoft Graph (`/sites/{id}/lists/.../items`) with a bearer token
  instead of `/_api/` with cookies. The relay already proves every operation
  we need (list read/write, file upload, folder create) works via Graph.
- **Old URLs keep working:** each SitePages page becomes a 5-line redirect
  stub (`location.replace('https://ops.fortivo.com/jobs')`). iPhone
  home-screen shortcuts never notice. Stubs are immune to the save-flag
  problem because they're trivial to re-create.
- **Deploys become:** `git push` → Vercel builds → live, with preview URLs
  for testing before production and one-click rollback. No canary, no BOM,
  no DenyAddAndCustomizePages, ever.

## 3. The real work (what the adapter has to cover)

From the codebases, the apps use SP REST for: list CRUD (all apps), digest
tokens (goes away entirely under Graph), file upload to job folders (DFR PDFs,
invoices), folder enumeration (kickoff, invoice desk), cross-site calls to
ActiveJobs/Fortivo sites, and `_spPageContextInfo` (replaced by MSAL account
info). Estimated adapter surface: ~15 helper functions, written once, shared
by all apps. The kickoff/desk blocks added this month already run on
plain fetch and port trivially.

Per-app complexity: Dashboard (read-mostly, ~10 list reads) LOW ·
Tasks (1 list CRUD) LOW · Invoicing (list CRUD + PDF upload + the new desk)
MEDIUM · Job Manager (largest: lists, DFR upload, folder scan, QB button)
MEDIUM-HIGH · CRM (dormant) LAST.

## 4. Phased plan — SharePoint stays live the whole time

| Phase | What | Exit test | Effort |
|---|---|---|---|
| 0 | Azure app: add SPA redirect for ops domain; Graph delegated scopes (Sites.ReadWrite.All already effectively in use via relay); buy/attach `ops.fortivo.com` (optional — *.vercel.app works day 1) | sign-in round-trip on a hello-world page | 1 short session |
| 1 | Graph adapter lib + **Dashboard pilot** on Vercel, reading production lists (read-only app = zero write risk) | Scott uses the Vercel Dashboard for a week alongside the old one; numbers identical | 1–2 sessions |
| 2 | **Tasks** app (small CRUD proves writes) | add/complete/snooze a task from the Vercel URL | 1 session |
| 3 | **Invoicing** (incl. desk + wizard) | $1 end-to-end on Vercel | 1–2 sessions |
| 4 | **Job Manager** (kickoff, DFR upload, QB button) | new job + DFR filed from Vercel | 2–3 sessions |
| 5 | Redirect stubs on SitePages; retire canary ritual; CRM whenever it wakes | old URLs land on new apps | 1 short session |

**Total: roughly 7–10 working sessions**, spread as convenient; each phase
independently shippable and reversible (worst case: keep using the .aspx
pages, which remain untouched until phase 5).

## 5. Risks & mitigations

- **MSAL popup friction on iPhone** → use redirect flow (lesson already
  learned in the Invoice Desk build).
- **Graph throttling on dashboard load** → batch requests (`$batch`), cache
  in localStorage; the apps already cache.
- **Conditional-access / consent surprises** → phase 0 proves the auth
  round-trip before any app work.
- **Two versions drifting during migration** → per phase, the Vercel copy is
  canonical the day its exit test passes; the .aspx page gets its redirect
  stub then, not at the end.
- **Cost** → $0 marginal (Pro already paid; static pages + existing relay).

## 6. Decision needed from Scott

1. Approve phases 0–1 (pilot only, read-only risk) — recommended starting point.
2. Custom domain now (`ops.fortivo.com`) or later (start on vercel.app URLs)?
3. Anything sacred about the current URLs beyond the iPhone shortcuts?
