# Fortivo Ops Automation Kit

Push-button automation for the Operations Dashboard ecosystem. Read
**BLUEPRINT.md** first — it's the full proposal, architecture, and rollout
checklist.

```
ops-automation/
├── BLUEPRINT.md                     ← the upgrade proposal & roadmap (start here)
├── install/
│   ├── AGENT_RUNBOOK.md             ← END-TO-END DEPLOY, written for the Claude
│   │                                  session on Scott's Mac (Cowork/Claude Code)
│   ├── insert_snippets.js           ← installs the blocks into the app masters
│   │                                  (idempotent, backup-first, verified)
│   └── sp_deploy_console.js         ← one-paste SharePoint deployer: Automation_Log
│                                      list + canary + delete/Files-Add + verify
├── job-kickoff/
│   ├── fv_job_kickoff.snippet.html  ← the ⚡ Job Kickoff block (fortivo_app + Dashboard)
│   └── INTEGRATION.md               ← reference: behavior, probe snippets, config
├── invoicing/
│   ├── fv_invoice_qb.snippet.html   ← the 🧾 Invoice Desk block (fortivo_invoicing)
│   ├── api/qbo-invoice.js           ← relay endpoint for ~/fortivo-voice-email
│   └── INTEGRATION.md               ← reference: relay env, Azure grant, safety table
└── test/                            ← plain-node unit tests (npm test)
```

**Deploying:** hand `install/AGENT_RUNBOOK.md` to the Claude session on the
Mac — it runs the whole thing. Scott's only moments: two consent clicks and
the $1 QB test.

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
