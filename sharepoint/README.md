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

`python3 patch_crm.py fortivo_crm.baseline.html fortivo_crm.html` reproduces the
deployable exactly, so the diff is auditable rather than a 294 KB blob. The script
refuses to write back over a file named `*baseline*`, because that file is the only
record of pre-patch production.

```bash
node tests/test_pricing_referrals.js   # 56 assertions — helpers, rates, rollup math
node tests/test_views.js               # 15 assertions — rendered view output
node tests/test_ar_panel.js            # 47 assertions — A/R states, attribution, no-writes
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

## 3. A/R on the account view

**The problem.** $262,135.23 — 79% of all receivables — is one FinMarc invoice at
61–90 days, and the CRM showed no trace of it. The A/R lived in QuickBooks, the
chase history in Outlook, and the account record knew about neither.

**The panel.** A new **AR** tab on every account: open balance, past due, oldest
invoice age, invoice count, and the invoice table with aging buckets.

It reads `QB_AR_Aging` (11 columns, written from QuickBooks by `fv_qb.py`) and
attributes rows to accounts by job number first, client name second. **It writes
nothing.**

### Why it so often refuses to show a number

An adversarial review of the design turned up more ways to display a confident
wrong balance than to display a right one. A wrong number shown authoritatively is
worse than a blank, so the panel states a reason instead of a figure whenever the
data cannot support one:

| State | Why no number |
| --- | --- |
| `unavailable` | The read failed. Not a zero balance. |
| `empty` | `QB_AR_Aging` has no rows — the sync never populated it. **Not** a zero balance. |
| `truncated` | Hit the 5000-row cap; `spGet` ignores `odata.nextLink`, so any total would understate. |
| `rewriting` | `fv_qb.py` clear-then-reinserts every row. A `Modified` spread over 5 minutes means a partial list. |
| `nojobs` | `Jobs_Master` did not load, so ownership is unknowable and the balance would be understated. |

The cache is genuinely three-state — `undefined` / `null` / array — and is never
defaulted to `[]`, because `[]` is indistinguishable from "nothing owed".

### Other correctness decisions

- **Lazy fetch, not in `loadData`.** Four of the seven reads in that `Promise.all`
  have no `.catch`, so widening it makes a whole-batch abort likelier — which in
  turn feeds the `Job_Value` backfill a partial picture.
- **`cache: 'no-store'` via a dedicated `spGetNoStore`.** A service worker is
  registered with a scope covering `/_api/`; money must not come from Cache
  Storage. `spGet` is left alone — it has other callers.
- **Contested jobs are excluded, not credited.** `CRM_Job_Links` has no uniqueness
  constraint and `_syncQBRevenue` dedupes on the raw label, so one job can be
  claimed by two accounts. Those rows are withheld from both totals and named.
- **Unattributed rows are surfaced** with a count and total, so a join miss looks
  like a miss instead of an absence.
- **Anchored job-number matching.** `normJobNum` finds a job number anywhere, so
  `2026-01-000210` would yield `26-01-00021`; `strictJobNum` requires a standalone
  match before money is attributed.
- **Freshness thresholds suit the sync cadence** — green ≤1h, amber ≤6h, red after.
  The contact-recency thresholds used elsewhere would call a day-dead sync fresh.
- **Gross, not net.** The source is `SELECT * FROM Invoice WHERE Balance > '0'`, so
  unapplied credit memos and payments are invisible and a balance here can exceed
  QuickBooks' net figure. The panel says so on screen.

Excluded from v1: the Residential Client roll-up, and any chase-email drafting —
the latter is where a wrong figure would reach a customer.

---

## Deploying

Single-file SPA, so deployment is a file copy into Site Assets — same as every
other app here. Keep the `.aspx` page name stable so the iPhone PWA shortcuts
survive. Take a timestamped backup into `_backups/` first, per the existing
convention:

```
_backups/fortivo_crm_2026-07-28_pricing_qb.html
```
