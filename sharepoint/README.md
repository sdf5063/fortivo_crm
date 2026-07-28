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

### Standard rate card

Deltas are computed against a standard card held in browser local storage — set it
once via **Pricing → ⚙ Standard rate card**. Line items match case- and
punctuation-insensitively (`Technician` = `technician`), and a line with no
standard counterpart simply shows no delta rather than a wrong one.

To hydrate it automatically instead, point the `RATES_API` constant (top of the
pricing block) at the published rate feed the T&M trackers already read. It is
`''` by default, and hydration failure is non-fatal.

### First run

1. Deploy `fortivo_crm.html`.
2. **Pricing → ⚙ Setup SP fields** — adds the four columns. Run once; existing
   fields are skipped.
3. **Pricing → ⚙ Standard rate card** — enter the published T&M rates.
4. Work the "Label only, no rates" list down to zero.

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
