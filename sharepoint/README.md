# Fortivo CRM (SharePoint SPA) — pricing + QB referral fixes

This folder holds the **production** CRM, the single-file SPA that lives at
`FortivoOperations → Site Assets → fortivo_crm.html` (served as
`SitePages/fortivo_crm.aspx`). It is a different application from the Python demo
in the repo root.

| File | What it is |
| --- | --- |
| `fortivo_crm.baseline.html` | Byte-for-byte copy of production as of 2026-07-28 |
| `fortivo_crm.html` | **Deploy this.** Baseline + the changes below |
| `patch_crm.py` | The transformation, as reproducible source |
| `gen_standard_rates.py` | The published rate card, transcribed from `rates.json` |
| `tests/` | Node tests that run against `fortivo_crm.html` directly |

`python3 patch_crm.py fortivo_crm.baseline.html` reproduces `fortivo_crm.html`
exactly, so the diff is auditable rather than a 293 KB blob.

```bash
node tests/test_pricing_referrals.js   # 32 assertions — helpers and rollup math
node tests/test_views.js               # 15 assertions — rendered view output
```

---

## 1. Modified pricing now has something behind the label

**Before:** `Pricing_Type` on `CRM_Accounts` was a three-value choice
(`Standard` / `Preferred` / `Modified`) plus a one-line `Pricing_Notes` text
field. The account header rendered a purple "Modified Pricing" badge off that
choice. The negotiated rates themselves were stored **nowhere in the CRM** — they
lived only in the T&M rate sheets and signed MSA exhibits. The badge was a label
pointing at nothing.

**After:** each account carries a real rate card.

- **New `CRM_Accounts` columns** — `Pricing_Rates_JSON` (Note),
  `Pricing_Doc_Url` (Text), `Pricing_Effective_Date` (DateTime),
  `Pricing_Review_Date` (DateTime).
- **Pricing tab** on every account: line item, this account's rate, the standard
  rate, and the delta, plus effective/review dates and a link to the signed sheet.
- **Pricing view** (new sidebar entry) — every account off standard in one list,
  searchable, with its full rate card inline and a CSV export.
- **"Label only, no rates" counter** — accounts flagged non-standard that still
  have no numbers stored. That count is the size of the original problem; it drops
  to zero as the cards get filled in.
- The purple badge is now clickable and jumps straight to the rate card.

A rate card is `[{ label, unit, rate, note }]` stored as JSON. Units are
hour / day / week / month / each / sq ft / lin ft / flat / %.

### Standard rate card — already loaded

The app ships with the **published Fortivo rates, 2026-V1.5 (effective June
2026)**: 136 lines covering 14 labor categories, 28 equipment items at their
day/week/month terms, 42 consumables, and the six admin charges clients actually
negotiate. These are transcribed from `03_Rate Sheets/T&M HTML/rates.json` — the
same source the T&M trackers and client rate sheets are generated from — by
`gen_standard_rates.py`, which `patch_crm.py` calls at build time so the numbers
are never typed into two places.

Matching is unit-aware, because equipment is published per term: `Air Mover` is
$31/day, $150/week and $435/month, and a negotiated week rate compares against
the week standard, not the day rate. Labels match case- and
punctuation-insensitively; a line with no published counterpart shows no delta
rather than a wrong one.

**Pricing → ⚙ Standard rate card** shows what is loaded. Editing it creates a
local override for that browser only, with a **Revert to published** button. To
hydrate from a live feed instead, point the `RATES_API` constant at it.

When rates change: re-read `rates.json`, update the tables in
`gen_standard_rates.py`, re-run `patch_crm.py`, redeploy.

### First run

1. Deploy `fortivo_crm.html`. That is the only manual step.
2. The four `Pricing_*` columns are created automatically the first time the
   Pricing view is opened on SharePoint (`ensurePricingFields`). It probes the
   list first and only adds what is missing, so it is safe on every load. If your
   account cannot create columns it says so and points at **⚙ Setup SP fields**
   for someone who can.
3. `Job_Value` on existing job links is backfilled from QuickBooks automatically
   on first load after the upgrade (`autoBackfillJobValues`), guarded by a
   localStorage flag so it runs once. A partial run retries next load rather than
   marking itself done.
4. Work the "Label only, no rates" list down to zero — the one genuinely human
   task, since only you know what was negotiated.

Nothing here is destructive: `Pricing_Type` and `Pricing_Notes` keep their current
meaning and values, and an account with no rate card behaves exactly as before.

---

## 2. The QB link now shows the amount referred

**Root cause.** Three different places computed referral revenue three different
ways, and the Referral Pipeline used the broken one.

The pipeline summed `CRM_Job_Links.Job_Value`. That field is a *snapshot*, written
once when a link is created and never refreshed — and `_syncQBRevenue`, the
function whose whole job is pulling QuickBooks numbers in, created its links with
`Job_Value: 0` hardcoded (`fortivo_crm.html:3729` in the baseline). It set the
value from QB only for links it created in that same pass, and never updated a
link that already existed. So the pipeline's "Total Value" column read `$0` while
`window.CRM_QB_PNL` sat in memory with the real figures.

The account Overview, meanwhile, matched jobs by `Referred_By_Account_Id` **or**
`Referred_By` name and summed `Total_Paid` — different numbers from the same data.

**Fix.**

- `buildReferralIndex()` is now the single source of truth: one pass over
  `Jobs_Master`, keyed by both referral account ID and lowercased name, joined to
  `QB_JobPnL` by job number. The dashboard, account list, account overview and
  Referral Pipeline all read from it, so they agree.
- `referralStatsFor()` merges the ID-keyed and name-keyed buckets **de-duped by
  job number**, so a source matched both ways is counted once.
- Invoiced and collected are reported separately instead of one ambiguous
  "Total Value".
- `_syncQBRevenue` now **backfills `Job_Value` on links that already exist**, so
  the stored data stops drifting from QuickBooks.
- Referrers named on jobs with no CRM account are shown greyed with a "no account"
  badge instead of being silently dropped.
- If `Jobs_Master` fails to load, the view says so and falls back to the stored
  link values, rather than displaying `$0` as though it were a fact.

### Related hardening: the QB job-number join

QuickBooks labels its job sub-customers inconsistently — `26-01-00026` bare,
`26-02-00048 (Robin Hyer--HFHS)` parenthesised, `26-05-00039 650 Mass Ave Report`
with no parentheses at all. `QB_JobPnL` was joined to `Jobs_Master` by exact match
on that label, so a decorated name found nothing, and a missed join looks exactly
like "no revenue" on screen. Both sides are now normalized to the bare
`NN-NN-NNNNN` first, in the referral index, the `Job_Value` backfill and
`_autoLinkJobs`.

Worth knowing: referral credit comes from `Referred_By` / `Referred_By_Account_Id`
on `Jobs_Master`, which is maintained independently of QuickBooks' customer tree.
The CRM and QB can drift apart without either complaining. Keep `Referred_By`
populated at job creation — it is what the rollup reads. See
`docs/qb-crm-streamlining.md`.

---

## Deploying

Single-file SPA, so deployment is a file copy into Site Assets — same as every
other app here. Keep the `.aspx` page name stable so the iPhone PWA shortcuts
survive. Take a timestamped backup into `_backups/` first, per the existing
convention:

```
_backups/fortivo_crm_2026-07-28_pricing_qb.html
```
