# Job Kickoff — Integration Guide

Adds a one-tap "⚡ Job Kickoff" flow to the Job Manager (and optionally the
Dashboard): creates the job folder, clones the full `01_Template Job Folder`
structure, and seeds the correct contract draft into `01_Contract`.

## 1. Paste the block

Open the master `fortivo_app.html` in **Fortivo Operations - Site Assets** and
paste the entire contents of `fv_job_kickoff.snippet.html` directly **before
`</body>`** — same pattern as the universal search bar block. It is fully
self-contained (styles + markup + script, `fvk-` prefixed, no dependencies).

Optional: paste the same block into `Fortivo_Dashboard.html` so kickoff is
available from the Dashboard too. It works identically on any page under
`/sites/FortivoOperations` (it talks to `/sites/ActiveJobs` and `/sites/Fortivo`
cross-site with the user's existing session — no new auth).

## 2. Create the Automation_Log list (once, optional but recommended)

Run in an authenticated browser console on the SP site (same pattern as prior
list setups). If you skip this, kickoff still works — audit logging is
best-effort and silently disabled.

Fields are created with `CreateFieldAsXml` so their **internal names stay
literally `Job_Number` / `Result` / `Details`** — creating them by Title would
encode the underscore (`Job_x005f_Number`) and every audit write would fail
silently.

```javascript
const d = await fetch('/sites/FortivoOperations/_api/contextinfo',{method:'POST',headers:{'Accept':'application/json;odata=nometadata'}}).then(r=>r.json());
const H = {'Accept':'application/json;odata=verbose','Content-Type':'application/json;odata=verbose','X-RequestDigest':d.FormDigestValue};
await fetch("/sites/FortivoOperations/_api/web/lists", {method:'POST',headers:H,body:JSON.stringify({'__metadata':{'type':'SP.List'},'Title':'Automation_Log','BaseTemplate':100,'Description':'Audit trail for Fortivo Ops Automation (create-only actions)'})});
for (const xml of [
  "<Field Type='Text' Name='Job_Number' StaticName='Job_Number' DisplayName='Job_Number'/>",
  "<Field Type='Text' Name='Result' StaticName='Result' DisplayName='Result'/>",
  "<Field Type='Note' Name='Details' StaticName='Details' DisplayName='Details' NumLines='6'/>"
]) await fetch("/sites/FortivoOperations/_api/web/lists/getbytitle('Automation_Log')/fields/CreateFieldAsXml",{method:'POST',headers:H,body:JSON.stringify({'parameters':{'__metadata':{'type':'SP.XmlSchemaFieldCreationInformation'},'SchemaXml':xml}})});
console.log('Automation_Log ready');
```

**Verify it works** (the modules log best-effort and never surface logging
errors): after your first kickoff, open the Automation_Log list and confirm a
row exists with Job_Number, Result, and Details populated.

## 3. Verify the Jobs_Master column names (2 minutes)

The module reads jobs with a candidate-column strategy (first match wins), so
it tolerates naming drift. To confirm what your list actually exposes, run:

```javascript
(await fetch("/sites/FortivoOperations/_api/web/lists/getbytitle('Jobs_Master')/items?$top=1",{headers:{Accept:'application/json;odata=nometadata'}}).then(r=>r.json())).value[0]
```

Check that the field names for job number / client / status / property type /
state appear in `FVK_CFG.FIELDS` inside the snippet. If a column is missing
from the candidates, add it there (one line). If nothing matches, the module
still works — Scott can use "enter details manually."

## 4. Optional one-line hook after new-job save

To auto-offer kickoff right after a job is created in the Job Manager, add
this at the end of the new-job save success path:

```javascript
if (window.FVKickoff) FVKickoff.open({ jobNumber: job.jobNumber, clientName: job.client, propertyType: job.propertyType, state: job.state, spId: job.spId });
```

(Field names on the right side = the app's own job model.) Without this hook,
the floating "⚡ Job Kickoff" button provides the same flow with a job picker.

## 5. Deploy — CANARY FIRST (hard rule)

Follow the proven recipe from decisions.md ("Files/Add fresh item"):

1. Canary: CopyTo any small .html → `SitePages/fv_test_render.aspx`; confirm it
   renders (twice, if DenyAddAndCustomizePages was just flipped).
2. Save master to Site Assets, wait for OneDrive sync.
3. DELETE target `SitePages/fortivo_app.aspx`, then `Files/Add` the new HTML,
   publish, verify the app renders and the search bar + nav still work.
4. Keep a dated backup of the previous master in `_backups/`.

## Behavior reference

| Situation | What happens |
|---|---|
| New job | Folder created, then the **live template manifest** is read and every subfolder created (top level + one nested level, e.g. `08_Invoices/T&M`), structure verified, contract draft copied in, run logged |
| Folder already exists for the job number | Same flow becomes **verify/repair**: only missing subfolders (incl. nested) are added; contract seeded only if `01_Contract` has no copy of that contract already |
| Job number edited mid-flow / two devices at once | State is re-detected at the moment you press the button; if it changed since the plan was shown, the run aborts and the plan refreshes. The engine is create-only and diff-based, so concurrent runs can't produce duplicates or overwrites |
| Contract file already there | Skipped and reported — never overwritten |
| Dry run checked | Full plan displayed; zero writes |
| Any failure | Stops, reports; nothing deleted/overwritten; safe to re-run (gap-filling only) |

Template source of truth: `01_Active Jobs/01_Job Name/01_Template Job Folder`
on the ActiveJobs site. Add folders there and every future kickoff includes
them — no code change.

Contract sources (Fortivo site → `11_Templates/01_Client-Facing/02_Project
Specific/Final/`, healthcare variant under `11_Templates/07_Healthcare/01_Contracts/`)
are configured in `FVK_CFG.CONTRACTS` in the snippet.
