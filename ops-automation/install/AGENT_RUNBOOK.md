# AGENT RUNBOOK — deploy the Ops Automation Kit end-to-end

**Audience: the Claude session running on Scott's Mac (Cowork or Claude Code).**
You are the deploying agent. Execute every step yourself; do not hand steps
back to Scott. His only moments in this entire runbook are marked **[SCOTT]**
— being signed in, two consent clicks you deep-link for him, and the $1 test
he already agreed to run. Everything else is yours.

Read `memory/preferences.md` and `memory/decisions.md` first (standing deploy
rules live there). The kit is on branch
`claude/operations-dashboard-automation-fh2kgo` of `sdf5063/fortivo_crm`.

**OS note:** paths below are Mac (per memory). The SharePoint steps (3–5) work
from ANY machine with a signed-in browser — Windows included, if it syncs the
"Fortivo Operations - Site Assets" OneDrive folder. Only step 1 is
machine-bound: `~/fortivo-voice-email` currently exists ONLY on the Mac. If
running on Windows without it, skip step 1 and run `insert_snippets.js`
WITHOUT `--relay-key` (the desk's "Skip — enter QB # by hand" fallback keeps
everything else working); do steps 1 and 6 next time the Mac is open. Step 6
removes this limitation permanently.

**Ground rules (non-negotiable, from decisions.md):**
- Canary-first before touching any production page. `sp_deploy_console.js`
  enforces this — it aborts without touching production if the canary fails.
- Never CopyTo-overwrite a SitePages file — DELETE + Files/Add fresh item only
  (also enforced by the script).
- Timestamped backups before every modification (both installers do this).
- If anything fails, stop and report; never improvise around a failed canary.

---

## 0. Get the kit

```bash
cd ~ && rm -rf /tmp/fv-kit && git clone --branch claude/operations-dashboard-automation-fh2kgo \
  https://github.com/sdf5063/fortivo_crm.git /tmp/fv-kit
cd /tmp/fv-kit/ops-automation && npm test        # must be green before proceeding
KIT=/tmp/fv-kit/ops-automation
```

Locate the Site Assets masters (OneDrive-synced):
`SA=~/Library/CloudStorage/*/Fortivo Operations - Site Assets` — resolve the
glob, verify `fortivo_app.html` and `fortivo_invoicing.html` exist there.

## 1. Relay endpoint → fortivo-voice-email (Vercel)

```bash
cd ~/fortivo-voice-email
ls api/ | wc -l                                   # Hobby cap is 12 functions.
# If already at 12: fold qbo-invoice.js into api/qbo-project.js as an
# action branch instead of a new file (see invoicing/INTEGRATION.md).
cp "$KIT/invoicing/api/qbo-invoice.js" api/
# Verify the two integration points before deploying:
grep -n "loadNamedTokens\|saveNamedTokens" lib/token-store.js   # must exist
INVOICE_KEY=$(openssl rand -hex 24)
npx vercel env add INVOICE_API_KEY production      # paste $INVOICE_KEY
npx vercel --prod
# Prove auth + deploy (expect: 400 "invoice object required"):
curl -s -X POST -H "x-api-key: $INVOICE_KEY" -H 'Content-Type: application/json' \
  -d '{}' https://fortivo-voice-email.vercel.app/api/qbo-invoice
```

If `vercel` is logged out, run Scott's existing `FIX-AUTH.command` flow first.
Record `$INVOICE_KEY` — step 2 injects it into the page.

## 2. Install the blocks into the masters

```bash
node "$KIT/install/insert_snippets.js" --target "$SA/fortivo_app.html" \
  --snippet "$KIT/job-kickoff/fv_job_kickoff.snippet.html"
node "$KIT/install/insert_snippets.js" --target "$SA/fortivo_invoicing.html" \
  --snippet "$KIT/invoicing/fv_invoice_qb.snippet.html" --relay-key "$INVOICE_KEY"
# Optional (Dashboard gets the ⚡ button too):
node "$KIT/install/insert_snippets.js" --target "$SA/Fortivo_Dashboard.html" \
  --snippet "$KIT/job-kickoff/fv_job_kickoff.snippet.html"
```

The installer is idempotent (exit 2 = already installed; `--update` replaces),
backs up each master to `_backups/`, and verifies before and after writing.
Wait for OneDrive to sync the masters (check the synced-cloud icon or give it
a minute) before step 3.

## 3. SharePoint: list + canary + deploy + verify

Open a browser tab where **[SCOTT]** is signed in to
`https://fortivopropertyservices.sharepoint.com/sites/FortivoOperations`
(any app page). Execute `"$KIT/install/sp_deploy_console.js"` in that page's
console — via your browser automation if available, otherwise it is a single
paste. It will, in order: ensure the `Automation_Log` list (correct internal
field names), run the render canary (aborting safely if custom-script saves
are blocked — flip `DenyAddAndCustomizePages` per preferences.md and re-run),
back up and redeploy `fortivo_app.aspx` + `fortivo_invoicing.aspx` (+ Dashboard
if its master carries the block) via delete + Files/Add, verify each page
renders with the kit marker, and print a result table.

Verify by hand afterwards: open the Job Manager on iPhone-width — the
"⚡ Job Kickoff" button must not cover the app's own controls; search bar and
nav must still work.

## 4. One-time grants (deep-link, Scott clicks)

- **Azure — Mail.ReadWrite (delegated)** on app `cbec554b-4222-4c5b-a1b8-e51133955bb3`:
  open `https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnApi/appId/cbec554b-4222-4c5b-a1b8-e51133955bb3`
  → API permissions → Add → Microsoft Graph → Delegated → `Mail.ReadWrite`.
  **[SCOTT]** two clicks. Verify: the permission row appears (admin consent not
  required for this delegated scope; the first draft attempt will prompt).
- **Intuit connect** (still pending from 2026-07-14): add redirect URI
  `https://fortivo-voice-email.vercel.app/api/qbo-project` in the Intuit app
  settings, then open `/api/qbo-project?action=connect&key=API_KEY` and
  **[SCOTT]** approves. This one grant powers both qbo-project and qbo-invoice.
- **QuickBooks setting:** Settings → Account and settings → Sales →
  *Custom transaction numbers* must be **OFF**. (The relay also checks this at
  runtime and fails cleanly if on.)

## 5. End-to-end proof

1. **Kickoff dry-run:** open Job Manager → ⚡ Job Kickoff → pick any active job
   → check "Dry run" → run. Expect a full plan, zero writes.
2. **Kickoff real test:** manual entry, job number `99-01-99999`, client
   `Kit Test`, type Mitigation → create → verify the folder + 14 subfolders +
   EWA draft in `01_Contract` under `01_Active Jobs/01_Job Name/`, and a row
   in `Automation_Log`. Then delete the `99-01-99999 (Kit Test-Mit)` folder by
   hand (the kit never deletes — by design).
3. **Invoice desk:** **[SCOTT]** runs the $1 test he agreed to: create a $1
   draft invoice in the Invoicing app → 🧾 QB Invoice Desk → sync → stamp →
   draft email to himself → confirm, then delete the $1 invoice in QB.
4. Confirm `Automation_Log` now has rows for kickoff, QB sync, stamp, draft.

## 6. One-time: unchain fortivo-voice-email from the Mac (GitHub + Vercel git)

Today the relay project lives only in `~/fortivo-voice-email` on the Mac,
which is why relay changes require the Mac at all. Fix that permanently:

```bash
cd ~/fortivo-voice-email
# 6a. SECRETS SWEEP — do not push until this is clean. Env vars live in
#     Vercel, tokens live in the encrypted Blob store; NONE of that belongs
#     in git. Verify .gitignore covers at least:
#       .env .env.* .vercel node_modules *.pem
#     then scan the tree for anything that looks like a credential:
grep -rInE 'sk-ant|client_secret|refresh_token|api[_-]?key.{0,4}[:=].{8,}' \
  --exclude-dir=node_modules --exclude-dir=.git . | grep -v 'process\.env' || echo CLEAN
ls ~/.fortivo/ 2>/dev/null   # qb_credentials.json lives HERE, outside the repo — leave it there
# Anything hot found inside the project: move it to Vercel env vars first,
# purge the file, and only then continue.

# 6b. Init + push to a PRIVATE repo
git init 2>/dev/null; git add -A && git commit -m "Import fortivo-voice-email (relay: voice email, morning brief, ops rules, qbo-project, qbo-invoice)"
# Create PRIVATE repo sdf5063/fortivo-voice-email (gh CLI or github.com → New),
# then:
git remote add origin https://github.com/sdf5063/fortivo-voice-email.git
git branch -M main && git push -u origin main
```

6c. In the Vercel dashboard: project **fortivo-voice-email** → Settings → Git
→ Connect to `sdf5063/fortivo-voice-email`. From then on, a push to `main`
deploys automatically — cloud Claude sessions can maintain the relay without
the Mac. Verify with a no-op commit that a deployment triggers and the
existing env vars / blob store carry over (they're project-level, so they do).

6d. Record the new repo + git-deploy flow in `memory/decisions.md`.

**Repo stays PRIVATE** — it's infrastructure code; even clean of secrets,
there's no reason to publish it.

## 7. Close out

- Merge `claude/operations-dashboard-automation-fh2kgo` → `main` in both
  `fortivo_crm` and `fortivo-memory` (memory updates ride that branch).
- Append deploy date + any deviations to `memory/decisions.md`, push memory.
- Leave the `*_backup_<date>.aspx` pages in SitePages for a few days, then
  remove them once the apps are confirmed stable.

**Rollback (any page):** delete the bad `<name>.aspx`, `Files/Add` fresh from
`<name>_backup_<date>.aspx`, verify render. Masters roll back from
`Site Assets/_backups/`. Relay rolls back by deleting `api/qbo-invoice.js`
and re-running `npx vercel --prod`.
