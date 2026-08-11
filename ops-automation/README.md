# Fortivo Ops Automation Kit

Push-button automation for the Operations Dashboard ecosystem. Read
**BLUEPRINT.md** first — it's the full proposal, architecture, and rollout
checklist.

```
ops-automation/
├── BLUEPRINT.md                     ← the upgrade proposal & roadmap (start here)
├── job-kickoff/
│   ├── fv_job_kickoff.snippet.html  ← paste into fortivo_app.html (and/or Dashboard)
│   └── INTEGRATION.md               ← paste point, Automation_Log setup, deploy steps
├── invoicing/
│   ├── fv_invoice_qb.snippet.html   ← paste into fortivo_invoicing.html
│   ├── api/qbo-invoice.js           ← copy into ~/fortivo-voice-email/api/, deploy
│   └── INTEGRATION.md               ← relay install, Azure Mail.ReadWrite, config
└── test/                            ← plain-node unit tests (npm test)
```

**⚡ Job Kickoff** — one tap: job folder named `{num} ({client}-{type})`,
all `01_Template Job Folder` subfolders cloned, correct contract draft
(EWA for mitigation, CWA otherwise, DC/Healthcare variants) seeded into
`01_Contract`. Dry-run preview, verify/repair mode, audit-logged.

**🧾 Invoice Desk** — pick invoice → matching QuickBooks invoice created (QB
assigns the number) → number written back to the SP row → stamped into the
PDF + flattened (copy; original untouched) → Outlook **draft** with the
standard dual-payment wording and the PDF attached. You press Send.

**Safety model:** create-only (no deletes, no overwrites, no auto-sends),
idempotent, previewed, audit-logged. See BLUEPRINT.md §6.

Run tests: `cd ops-automation && npm test`
