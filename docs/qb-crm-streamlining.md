# Streamlining the CRM around QuickBooks and Outlook

Written 2026-07-28. Every figure below was pulled live from the Fortivo
QuickBooks realm and the `sfutrovsky@fortivo.com` mailbox on that date. Where a
number is a QuickBooks report artifact rather than a real balance, it says so.

The goal Scott set: **reduce the time spent hand-updating the CRM.** It should
learn from the emails he already sends, and it should tell him which accounts to
create rather than waiting to be told.

---

## Part 1 — What QuickBooks actually looks like right now

### 1.1 Receivables are one customer

Distinct top-level balances, A/R aging as of 2026-07-28:

| Customer | Total | Current | 1–30 | 61–90 |
| --- | ---: | ---: | ---: | ---: |
| FinMarc Management, LLC | $276,145.44 | $6,198.40 | $7,811.81 | **$262,135.23** |
| Talak Shah | $21,773.31 | — | $21,773.31 | — |
| WC Smith | $8,000.00 | $8,000.00 | — | — |
| Four Star Real Estate Services | $7,500.00 | — | $7,500.00 | — |
| Clay Gregory | $6,873.02 | — | $6,873.02 | — |
| Robert Eisinger | $4,551.47 | $4,551.47 | — | — |
| Nelson Peters | $3,133.00 | $3,133.00 | — | — |
| Hassle Free Home Services (Northeast) | $2,643.02 | $2,643.02 | — | — |
| **Total** | **$330,619.26** | | | |

> The report's own `Total Receivables` says $989,214.76. Ignore it — it sums
> parent rows, sub-customer rows *and* "Total for …" rows, so every dollar is
> counted two or three times. $330,619.26 is the distinct figure.

**One line is 79% of all receivables**: job `26-01-00021 (Foundation School)`,
$262,135.23, sitting in the 61–90 bucket under FinMarc. It is also the single
thing Scott spends the most email on — five separate chase messages to
Philadelphia Insurance, Marsh MMA and LBM Adjusters in the sampled week alone,
one noting *"3 months since the invoice and 2 months since an agreement was
reached"* and another warning that subcontractors are preparing to lien.

Nothing in the CRM knows any of that. The AR sits in QuickBooks, the chase
history sits in Outlook, and the account record shows neither.

### 1.2 There is no rate data in QuickBooks

The entire Product/Service list is eight rows:

`Services - MD` · `Services - VA` · `Services - DC` · `Hours` ·
`Property Services` · `Custom Amount` · `Discount` · `Bad Debt`

Only `Property Services` has a sales price, and it is `0`. There is no
technician rate, no equipment day rate, nothing per-line.

This matters for the "where is the modified pricing" question: **QuickBooks was
never going to be the answer.** Billing is driven by Xactimate and the T&M rate
sheets; QuickBooks receives a total, not a rate card. That is why the negotiated
rates now live on the CRM account (see `sharepoint/README.md`), and why the
Pricing view is the single place to look.

### 1.3 Job-customer naming is inconsistent

Jobs are modelled as sub-customers, which is right. The naming is not:

- `26-01-00026` — bare
- `26-02-00048 (Robin Hyer--HFHS)` — parenthesised suffix
- `26-99-00027 (CBG)` — parenthesised abbreviation
- `26-05-00039 650 Mass Ave Report` — **no parentheses at all**

The CRM joins `QB_JobPnL` to `Jobs_Master` on job number. An exact-match join
against `26-05-00039 650 Mass Ave Report` finds nothing, and a missed join is
indistinguishable from "no revenue" on screen. The code now normalizes both
sides to the bare `NN-NN-NNNNN` before joining, so this can no longer cause a
silent zero — but standardising on `YY-MM-NNNNN (Short Name)` in QuickBooks is
still worth an hour.

### 1.4 Smaller items

- **Metro Management: −$5,240.62** in this year's sales (job `25-02-00124`). A
  credit memo or misapplied payment that should be cleaned up or written off.
- **Concentration:** the top five customers are 47% of $3.5M in sales. Extra
  Clean alone is 11.9%. Worth a named risk line in the CRM dashboard.
- **Hassle Free Home Services** parents correctly in A/R — `Hassle Free Home
  Services (Northeast)` → `Carole Krooth` → `26-01-00026`, and → `Hyer, Robin`
  → `26-02-00048`. Referral *credit*, though, comes from `Referred_By` on
  `Jobs_Master`, which is maintained independently of QuickBooks' customer tree.
  The two can drift apart without anything complaining. Keep `Referred_By`
  populated at job creation; it is what the referral rollup reads.

---

## Part 2 — Teaching the CRM to read Scott's sent mail

### 2.1 The conventions already exist

A week of Sent Items shows Scott already writes machine-readable subjects. No
new discipline is required — the CRM just has to read what is there.

| Pattern seen | Real example | What it should trigger |
| --- | --- | --- |
| Job number in subject | `26-01-00046; Fortivo Odor Elimination Scope/Contract/Follow-up questions` | Log activity against that job's account; add unknown recipients as contacts |
| Claim number in subject | `Claim Number: PHNP26051780146; …`, `090G6W384`, `LAPP26808387` | Attach thread to the job carrying that claim; create the carrier account if missing |
| Scope/contract sent, with attachment | same 26-01-00046 message | Move the deal to **Proposal**; set a 5-business-day follow-up |
| Revised pricing sent | `Re: 8000 Park Overlook Mitigation + Repair` — *"See attached for the revised amount"* | Log a pricing revision on the deal |
| AR chase | `… Fortivo Property Services Final Bill`, importance **high** | Log a collection touch on the invoice; re-arm follow-up; stamp last-contacted |
| Sub payment forwarded | `Fw: Funds Transfer Request #624129724 Has Been Scheduled` → `jjuarez@jmacompleterestoration.com` | Log a vendor payment against the sub |
| Billing-contact change | *"Can you please update our account so that invoices are sent to AR@Fortivo.com?"* | Flag the vendor record for an AP detail update |

**Must be ignored**, or the CRM fills with noise: internal-only threads
(`@fortivo.com` on both ends), calendar responses (`Accepted:` / `Declined:` /
`Canceled:`), and personal mail — the sampled week includes a tax-return thread
with Richey May and a `Declined:` reply to a cold-outreach sender. A simple
sender/recipient-domain and subject-prefix filter removes all of it.

### 2.2 How to build it

The infrastructure is already standing. This is wiring, not new architecture.

1. **Trigger** — Microsoft Graph subscription on `/me/mailFolders('sentitems')/messages`,
   with a delta-query catch-up on renewal so nothing is lost when a webhook
   drops. Weekly renewal; Graph subscriptions expire.
2. **Classifier** — extend the existing Vercel relay
   (`fortivo-voice-email.vercel.app`), which already holds the Graph token store
   and the QBO OAuth grant. Cheap regex first: if the subject has no job number,
   no claim number and no known counterparty domain, drop it before it costs
   anything. Only survivors go to Claude for structuring.
3. **Structuring** — reuse the DFR relay pattern verbatim: a JSON schema in the
   system prompt, few-shot examples, and a `_confidence` object per field. That
   pattern is already in production for daily field reports and is the reason
   this can be trusted.
4. **Write** — append to `CRM_Activities` with `Auto_Generated = true` (the field
   already exists and the CRM already reads it), plus targeted updates to
   `CRM_Deals.Deal_Stage`, `CRM_Contacts.Next_Follow_Up`, and
   `Invoices.Last_Chased_Date` (new).
5. **Review, not auto-apply** — high-confidence activity logs write straight
   through. Anything that changes a deal stage, creates an account, or moves
   money lands in a **Suggested Updates** queue for one-tap approve/reject.

That review queue is the whole safety story. Scott's time drops because he is
confirming rather than typing, and a wrong guess costs one tap instead of a
corrupted record.

### 2.3 Expected effect

Roughly 2,100 messages sit in Sent Items. The sampled week is ~19 business
messages, of which 12 carry a CRM-relevant signal and 7 are noise. If the
classifier handles the 12 and Scott confirms the ambiguous third of them, that
is most of the manual CRM upkeep gone.

---

## Part 3 — Accounts the CRM should be suggesting

Every address below appeared in Scott's sent mail in the sampled week. This is
what the suggestion engine should have surfaced, and it is worth creating by
hand now regardless of when the automation ships.

**Insurance carriers and adjusters** — recurring counterparties, none of them
one-offs:

| Contact | Organization | Suggested role |
| --- | --- | --- |
| Christopher Graham, Joanne Wyrzykowski, Jennifer Worthington | Philadelphia Insurance (`phly.com`) | Insurance |
| Kimberly G. Evans, Laura Pechin | Marsh McLennan Agency (`MarshMMA.com`) | Insurance / broker |
| G. Ponne | LBM Adjusters | Insurance / adjuster |
| — | State Farm (claim `090G6W384`) | Insurance |

**Clients and client contacts** on active jobs:

| Contact | Context | Suggested role |
| --- | --- | --- |
| Y. Colvin | Foundation Schools — the $262K job | Client |
| Steve Halle | FinMarc Management — largest A/R | Client (check if already present) |
| Jess Lasko, E. Benovitz | job `26-01-00046`, odor elimination | Client |
| Alex Ansaldo, A.B. Watson | 8000 Park Overlook | Client |
| Christine Watkins | State Farm claim `090G6W384` | Client |
| Angela | **Extra Clean, Inc.** — 11.9% of annual sales | Client |

**Referral partners and vendors:**

| Contact | Organization | Suggested role |
| --- | --- | --- |
| Alex Lomonosov | 1-800-Packouts | Referral Source |
| Vern McDade | Great Dwellings | Referral Source / Client |
| J. Juarez | JMA Complete Restoration | Vendor / subcontractor |
| Maxi | ESI | Vendor |
| Ijaz Qureshi | Makom | Insurance broker |

**Not clients** — and the suggester must not propose them as such: Nathan
Bortnick and E. Bernardi at Lincoln Property Company are Fortivo's prospective
*landlord* on the Taft Street lease, and Richey May is Scott's accountant.

### 3.1 Scoring rule

Suggest an account when a non-Fortivo domain appears in **2+ threads** or **1
thread carrying a job or claim number**, and no CRM account matches the domain
or the organization name. Rank by dollars in play — a domain attached to an open
A/R balance outranks a domain attached to nothing. Free-mail domains
(`gmail.com` and similar) become **contact** suggestions rather than
organization suggestions, since Alex Ansaldo is a person, not a company.

---

## Part 4 — What to do, in order

| # | Action | Effort | Why now |
| --- | --- | ---: | --- |
| 1 | Deploy the patched `fortivo_crm.html`; run **Pricing → ⚙ Setup SP fields**; enter the standard rate card | 30 min | Unblocks both original questions |
| 2 | Fill in rate cards for the accounts the Pricing view flags as "label only, no rates" | 1–2 h | The flag is meaningless until the numbers exist |
| 3 | Run **Import Data → Sync QB Revenue** once to backfill `Job_Value` on existing job links | 5 min | Stops the stored data drifting from QuickBooks |
| 4 | Standardise QB job-customer names to `YY-MM-NNNNN (Short Name)`; clear the Metro Management −$5,240.62 | 1 h | Removes the last ambiguity from the QB join |
| 5 | Create the Part 3 accounts by hand | 1 h | Immediate value; also the training set for step 7 |
| 6 | Add an **A/R panel** to the CRM account view — balance, oldest bucket, last chase date — reading `Invoices` + `QB_AR_Aging` | half day | Puts the Foundation School situation where Scott looks |
| 7 | Build the Sent Items classifier and the Suggested Updates queue | 2–3 days | The actual time saver; steps 1–6 make it trustworthy |
| 8 | Nightly digest: new counterparties, deals with no activity in 14 days, A/R crossing 30/60/90 | half day | Replaces remembering with being told |

Steps 1–5 are configuration and data entry and can happen today. Steps 6–8 are
build work, and each one is independently useful — none of them needs the next
one to land first.
