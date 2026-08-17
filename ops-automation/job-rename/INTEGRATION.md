# ✏️ Edit Job (Rename / Renumber) — Integration Guide

Adds the one thing the SharePoint Job Manager couldn't do: **change a job's
name, client, or number after creation** — with the Fortivo numbering
convention enforced and the Active Jobs folder renamed to match.

```
Pick job → edit number / client / job name → checks + plan shown live
        → Apply: Jobs_Master row MERGE-updated (changed fields only)
                 Active Jobs folder renamed IN PLACE (FileLeafRef)
                 audit row → Automation_Log
        → QB project rename listed as a manual follow-up (never auto-written)
```

## Install (one paste)

Paste the entire contents of `fv_job_rename.snippet.html` into
`fortivo_app.html` directly **before `</body>`**, next to the ⚡ Job Kickoff
block (the two coexist; the ✏️ button sits above the ⚡ one). Deploy the page
canary-first per the standing rule (test-render a scratch page, then
DELETE + `Files/Add` fresh, publish, keep a dated `_backups/` copy).

No new permissions, endpoints, or libraries: same-origin SharePoint REST with
the user's own cookies, exactly like Job Kickoff.

## The numbering convention (enforced, not just documented)

Job numbers are `YY-PP-NNNNN`:

- **NNNNN — permanent identity.** A mitigation job that phases to a rebuild
  KEEPS its last 5; only `PP` flips (01 → 02) and `YY` may advance to the new
  phase's start year. Confirmed in live QBO data: 25-01-00129→25-02-00129,
  25-01-00139→25-02-00139, 26-01-00029→26-02-00029, 26-01-00043→26-02-00043.
- **PP — classification.** 01 = Mitigation, 02 = Repair/Reconstruction.
  Codes 05 and 99 exist in live data; their meanings are pending Scott's
  confirmation and are deliberately unmapped in tooling.

What the checks do:

| You try to… | Result |
|---|---|
| Change PP with the same last-5 (phase change) | ✅ allowed, shown as "sequence kept — correct" |
| Advance YY with the same last-5 | ✅ allowed (phase start year) |
| Use a full number another job already holds | 🚫 blocked (this catches the live 26-01-00043 Ansaldo/Peters collision class) |
| Change the last-5 | ⚠️ loud warning — permanent identity; do it only to FIX a wrong assignment |
| Adopt a last-5 that belongs to a different client | ⚠️ second warning naming the owner |
| Clear a populated field | 🚫 blocked — existing job data is never blanked |

## Data safety guarantees (the standing rule: never degrade existing job data)

- **Never deletes anything, anywhere.** No file, folder, row, or field removal.
- **MERGE writes only the fields you changed** — everything else on the row is
  untouched; blanking a populated field is refused outright.
- **Folder rename is in place** via `FileLeafRef` (`ValidateUpdateListItem`):
  contents, sharing links, and version history are preserved. It is not a
  move or copy, and it **aborts if a folder with the target name exists** —
  no merge, no overwrite, no "KeepBoth" duplicates.
- **Two-device race guard:** the row is re-read immediately before applying;
  if it changed since the form was opened, the run aborts and refreshes.
- **Dry-run toggle** shows the exact plan with zero writes.
- **Audit trail:** every apply logs before + after values to `Automation_Log`,
  so any rename can be reversed by hand from the log entry.
- **QuickBooks is never written.** When the number or client changes, the plan
  reminds you to rename the matching QBO project manually (QB → Sales →
  Customers → project → Edit). The hourly `qbo-financials` sync keys P&L rows
  by QBProjectId, so a QBO display-name change flows to the Dashboard safely.

## Knock-on effects handled

- **DFR uploads** search job folders by number prefix — after a renumber the
  folder is renamed to the new number, so new DFRs land correctly.
- **Invoices** reference the job by number in Jobs_Master; the row update and
  folder rename keep them consistent. Already-issued PDFs are historical
  documents and are deliberately left untouched.
- **Job Kickoff** detects folders by number prefix too — a renamed job folder
  is found in verify/repair mode as before.

## Deeper integration

```js
window.FVJobRename.open({ jobNumber: '26-01-00043' })   // open preselected
```

## Tests

`node test/test_rename_logic.js` (also wired into `npm test`) — 15 checks
covering the convention rules, the live collision fix path, folder naming,
plan building, blanking protection, and column resolution.
