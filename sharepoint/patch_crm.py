#!/usr/bin/env python3
"""Patch fortivo_crm.html:
   1. Real per-account rate cards (modified pricing) + a dedicated Pricing view.
   2. Live QB referral rollup replacing the stale CRM_Job_Links.Job_Value snapshot.
Idempotent-ish: refuses to run twice (checks for a marker)."""
import sys, io, re, os

path = sys.argv[1]
# Writing back over the input destroys the pristine baseline, which is the only
# record of pre-patch production. Refuse, and require an explicit output path.
out = sys.argv[2] if len(sys.argv) > 2 else path
if out == path and 'baseline' in os.path.basename(path).lower():
    sys.exit('Refusing to overwrite %s in place — it is the pristine baseline.\n'
             'Usage: python3 patch_crm.py <baseline.html> <output.html>' % path)
src = io.open(path, encoding='utf-8').read()

# The standard rate card is generated from the canonical rates.json data so the
# numbers are never hand-typed into two places.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_standard_rates


if 'FV_PRICING_PATCH' in src:
    sys.exit('Already patched.')

def sub1(old, new, label):
    """Replace exactly one occurrence; fail loudly otherwise."""
    global src
    n = src.count(old)
    if n != 1:
        sys.exit('PATCH FAIL [%s]: found %d occurrences, expected 1' % (label, n))
    src = src.replace(old, new, 1)
    print('  ok: ' + label)


# ─────────────────────────────────────────────────────────────────────
# 1. Constants + helpers (pricing rate cards, referral index)
# ─────────────────────────────────────────────────────────────────────
HELPERS = r"""
// ══════════════════════════════════════════════
//  FV_PRICING_PATCH — rate cards + live QB referral rollup
// ══════════════════════════════════════════════

// ── Pricing: rate cards ──
// Optional feed for the published STANDARD rate card (the same numbers the T&M
// trackers hydrate at runtime). Leave '' to manage the standard card by hand in
// CRM → Pricing → "Standard rate card". A per-account card never depends on this.
const RATES_API = '';
const PRICING_TYPES = ['Standard', 'Preferred', 'Modified'];
const RATE_UNITS = ['hour', 'day', 'week', 'month', 'each', 'gal', 'box', 'roll', 'pack', 'sq ft', 'lin ft', 'flat', '%'];
const STD_RATES_KEY = 'fv_crm_standard_rates';
""" + gen_standard_rates.emit_js() + r"""

// A rate card is an array of { label, unit, rate, note }. It is stored on the
// account as JSON in CRM_Accounts/Pricing_Rates_JSON.
function parseRates(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  try {
    var v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.map(function(r) {
      return {
        label: String(r.label || r.name || '').trim(),
        unit: String(r.unit || 'hour').trim(),
        rate: parseFloat(r.rate) || 0,
        note: String(r.note || '').trim()
      };
    }).filter(function(r) { return r.label; });
  } catch (e) { console.warn('Bad Pricing_Rates_JSON:', e); return []; }
}
function stringifyRates(rows) {
  return JSON.stringify((rows || []).filter(function(r) { return r && r.label; }).map(function(r) {
    return { label: r.label, unit: r.unit || 'hour', rate: parseFloat(r.rate) || 0, note: r.note || '' };
  }));
}
// The published card ships with the app, so deltas work on first load with no
// setup. A locally edited card overrides it; clearing that reverts to published.
function getStandardRates() {
  try {
    var custom = parseRates(localStorage.getItem(STD_RATES_KEY));
    if (custom.length) return custom;
  } catch (e) { /* fall through to published */ }
  return STANDARD_RATE_CARD.map(function(r) { return { label: r.label, unit: r.unit, rate: r.rate, note: '' }; });
}
function usingPublishedRates() {
  try { return !parseRates(localStorage.getItem(STD_RATES_KEY)).length; } catch (e) { return true; }
}
function setStandardRates(rows) {
  try { localStorage.setItem(STD_RATES_KEY, stringifyRates(rows)); } catch (e) { console.warn(e); }
}
function rateKey(label) { return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
// Equipment is published at day/week/month, so the unit is part of the identity —
// "Air Mover" at $31/day and $150/week are different lines. Prefer an exact
// label+unit match, fall back to label alone so a unit typo still compares.
function stdRateFor(label, unit, stdRows) {
  var k = rateKey(label);
  var rows = (stdRows || getStandardRates()).filter(function(r) { return rateKey(r.label) === k; });
  if (!rows.length) return null;
  if (unit) {
    var exact = rows.filter(function(r) { return (r.unit || '') === unit; })[0];
    if (exact) return parseFloat(exact.rate) || 0;
  }
  return parseFloat(rows[0].rate) || 0;
}
// % difference of an account rate vs the standard rate. null when not comparable.
function rateDelta(row, stdRows) {
  var std = stdRateFor(row.label, row.unit, stdRows);
  if (std === null || !std) return null;
  return ((parseFloat(row.rate) || 0) - std) / std * 100;
}
// Rolls a whole card up: how many lines differ from standard, and the average delta.
function pricingSummary(rows, stdRows) {
  rows = rows || []; stdRows = stdRows || getStandardRates();
  var deltas = [], off = 0;
  rows.forEach(function(r) {
    var d = rateDelta(r, stdRows);
    if (d === null) return;
    deltas.push(d);
    if (Math.abs(d) >= 0.005) off++;
  });
  return {
    lines: rows.length,
    comparable: deltas.length,
    differing: off,
    avgDelta: deltas.length ? deltas.reduce(function(s, d) { return s + d; }, 0) / deltas.length : null
  };
}
function fmtDelta(d) {
  if (d === null || d === undefined) return '<span style="color:var(--text-muted)">&mdash;</span>';
  if (Math.abs(d) < 0.005) return '<span style="color:var(--text-muted)">at standard</span>';
  var c = d < 0 ? 'var(--success-600)' : 'var(--danger-500)';
  return '<span style="color:' + c + ';font-weight:600">' + (d > 0 ? '+' : '') + d.toFixed(1) + '%</span>';
}
function fmtRate(r) {
  return fmtMoney(parseFloat(r.rate) || 0) + '<span style="color:var(--text-muted);font-size:11px">/' + escHtml(r.unit || 'hour') + '</span>';
}
// An account "has custom pricing" if it is flagged non-Standard OR carries a card.
function hasCustomPricing(a) {
  return (a.pricingType && a.pricingType !== 'Standard') || (a.pricingRates && a.pricingRates.length > 0);
}
// Flagged non-Standard but nobody ever entered the numbers — the exact gap that
// made "Modified Pricing" a label with nothing behind it.
function pricingIsUndocumented(a) {
  return a.pricingType && a.pricingType !== 'Standard' && (!a.pricingRates || !a.pricingRates.length);
}
async function hydrateStandardRates() {
  if (!RATES_API) return;
  try {
    var r = await fetch(RATES_API, { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var data = await r.json();
    var rows = parseRates(Array.isArray(data) ? data : (data.rates || data.items || []));
    if (rows.length) setStandardRates(rows);
  } catch (e) { console.warn('Standard rate hydration skipped:', e.message); }
}

// QB customer and job labels carry descriptive suffixes — "26-02-00048 (Robin
// Hyer--HFHS)", "26-05-00039 650 Mass Ave Report". An exact-match join on job number
// misses those, and the miss looks exactly like "no revenue". Normalize both sides.
const JOB_NUM_RE = /\d{2}-\d{2}-\d{5}/;
function normJobNum(v) {
  var s = String(v == null ? '' : v);
  var m = s.match(JOB_NUM_RE);
  return m ? m[0] : s.trim();
}
// QB_JobPnL re-keyed by bare job number.
function qbByJobNumber() {
  var out = {};
  var raw = window.CRM_QB_PNL_RAW || [];
  if (raw.length) {
    raw.forEach(function(r) {
      var k = normJobNum(r.Title || r.Job_Number || r.JobNumber || '');
      if (k) out[k] = r;
    });
    return out;
  }
  var m = window.CRM_QB_PNL || {};
  Object.keys(m).forEach(function(k) { out[normJobNum(k)] = m[k]; });
  return out;
}

// ── Referrals: one live index, built from Jobs_Master + QB_JobPnL ──
// Replaces the stale CRM_Job_Links.Job_Value snapshot, which was written once at
// link-creation time (and hardcoded to 0 by the revenue sync), so referral totals
// read $0 no matter what QuickBooks said.
function buildReferralIndex() {
  var idx = { byId: {}, byName: {}, jobCount: 0 };
  var qbIndex = qbByJobNumber();
  function bucket(map, key, displayName) {
    if (!map[key]) map[key] = { displayName: displayName || key, jobs: 0, invoiced: 0, collected: 0, qbRevenue: 0, lastDate: '', jobList: [] };
    return map[key];
  }
  (window.CRM_JOBS || []).forEach(function(j) {
    var accId = parseInt(j.Referred_By_Account_Id) || 0;
    var name = (j.Referred_By || '').trim();
    if (!accId && !name) return;
    idx.jobCount++;
    var jobNum = normJobNum(j.Job_Number || j.Title || '');
    var qb = qbIndex[jobNum] || {};
    var qbRevenue = parseFloat(qb.Revenue != null ? qb.Revenue : qb.Income) || 0;
    var invoiced = parseFloat(j.Amount) || 0;
    var collected = parseFloat(j.Total_Paid) || 0;
    var when = fmtDate(j.Date_Received || j.Created || j.Modified) || '';
    var rec = {
      jobNumber: jobNum, client: j.Client_Name || '', status: j.Job_Status || '',
      invoiced: invoiced, collected: collected, qbRevenue: qbRevenue, date: when
    };
    var targets = [];
    if (accId) targets.push(bucket(idx.byId, accId, name));
    if (name) targets.push(bucket(idx.byName, name.toLowerCase(), name));
    targets.forEach(function(b) {
      b.jobs++; b.invoiced += invoiced; b.collected += collected; b.qbRevenue += qbRevenue;
      if (when > b.lastDate) b.lastDate = when;
      b.jobList.push(rec);
    });
  });
  return idx;
}
function _emptyRefStats() {
  return { jobs: 0, invoiced: 0, collected: 0, qbRevenue: 0, lastDate: '', jobList: [], source: 'none' };
}
// Merge the id-keyed and name-keyed buckets for one account, de-duped by job number,
// so a source matched both ways is not counted twice.
function referralStatsFor(account, idx) {
  idx = idx || buildReferralIndex();
  var parts = [idx.byId[account._spId], idx.byName[(account.name || '').toLowerCase()]].filter(Boolean);
  if (!parts.length) return _referralFallback(account);
  var seen = {}, out = _emptyRefStats();
  out.source = 'jobs';
  parts.forEach(function(p) {
    p.jobList.forEach(function(rec) {
      var k = rec.jobNumber || (rec.client + '|' + rec.date);
      if (seen[k]) return;
      seen[k] = true;
      out.jobs++; out.invoiced += rec.invoiced; out.collected += rec.collected; out.qbRevenue += rec.qbRevenue;
      if (rec.date > out.lastDate) out.lastDate = rec.date;
      out.jobList.push(rec);
    });
  });
  return out;
}
// Jobs_Master carries no referral rows for this account (or failed to load) — fall
// back to whatever the legacy CRM_Job_Links snapshot holds so nothing disappears.
function _referralFallback(account) {
  var out = _emptyRefStats();
  var links = DB.get(KEYS.jobLinks).filter(function(jl) { return jl.referralAccountId === account._spId; });
  if (!links.length) return out;
  out.source = 'links';
  links.forEach(function(jl) {
    out.jobs++;
    out.invoiced += jl.jobValue || 0;
    out.collected += jl.jobValue || 0;
    if (jl.linkDate > out.lastDate) out.lastDate = jl.linkDate;
    out.jobList.push({ jobNumber: jl.jobNumber, client: jl.accountName || '', status: jl.jobStatus || '',
                       invoiced: jl.jobValue || 0, collected: jl.jobValue || 0, qbRevenue: 0, date: jl.linkDate });
  });
  return out;
}
// True when Jobs_Master never loaded — every referral number would read $0 and the
// user deserves to know it is a data problem, not a business one.
function referralDataMissing() { return !(window.CRM_JOBS && window.CRM_JOBS.length); }
"""

sub1(
    "const JOBLINK_ENTITY = 'SP.Data.CRM_x005f_Job_x005f_LinksListItem';",
    "const JOBLINK_ENTITY = 'SP.Data.CRM_x005f_Job_x005f_LinksListItem';\n" + HELPERS,
    'helpers block'
)

# ─────────────────────────────────────────────────────────────────────
# 2. Model: read/write the new pricing fields
# ─────────────────────────────────────────────────────────────────────
sub1(
    "    pricingType: sp.Pricing_Type || 'Standard', pricingNotes: sp.Pricing_Notes || '',",
    "    pricingType: sp.Pricing_Type || 'Standard', pricingNotes: sp.Pricing_Notes || '',\n"
    "    pricingRates: parseRates(sp.Pricing_Rates_JSON), pricingDocUrl: sp.Pricing_Doc_Url || '',\n"
    "    pricingEffectiveDate: fmtDate(sp.Pricing_Effective_Date) || '', pricingReviewDate: fmtDate(sp.Pricing_Review_Date) || '',",
    'accountFromSP pricing fields'
)

sub1(
    "  if (a.pricingNotes !== undefined) f.Pricing_Notes = a.pricingNotes;",
    "  if (a.pricingNotes !== undefined) f.Pricing_Notes = a.pricingNotes;\n"
    "  if (a.pricingRates !== undefined) f.Pricing_Rates_JSON = stringifyRates(a.pricingRates);\n"
    "  if (a.pricingDocUrl !== undefined) f.Pricing_Doc_Url = a.pricingDocUrl;\n"
    "  if (a.pricingEffectiveDate !== undefined) { if (a.pricingEffectiveDate) { const d = new Date(a.pricingEffectiveDate); if (!isNaN(d)) f.Pricing_Effective_Date = d.toISOString(); } else f.Pricing_Effective_Date = null; }\n"
    "  if (a.pricingReviewDate !== undefined) { if (a.pricingReviewDate) { const d = new Date(a.pricingReviewDate); if (!isNaN(d)) f.Pricing_Review_Date = d.toISOString(); } else f.Pricing_Review_Date = null; }",
    'accountToSP pricing fields'
)

# ─────────────────────────────────────────────────────────────────────
# 3. Nav + route for the Pricing view
# ─────────────────────────────────────────────────────────────────────
sub1(
    """      <a class="nav-item" data-route="referrals" onclick="App.nav('referrals')">
        <span class="nav-icon">&#128279;</span> Referrals
      </a>""",
    """      <a class="nav-item" data-route="referrals" onclick="App.nav('referrals')">
        <span class="nav-icon">&#128279;</span> Referrals
      </a>
      <a class="nav-item" data-route="pricing" onclick="App.nav('pricing')">
        <span class="nav-icon">&#128181;</span> Pricing <span class="nav-badge" id="navPricingCount" style="background:var(--purple-500)">0</span>
      </a>""",
    'sidebar nav item'
)

sub1(
    "  if ($('navDealsCount')) $('navDealsCount').textContent = openDeals;",
    "  if ($('navDealsCount')) $('navDealsCount').textContent = openDeals;\n"
    "  if ($('navPricingCount')) $('navPricingCount').textContent = accts.filter(hasCustomPricing).length;",
    'nav pricing count'
)

sub1(
    "  else if (route === 'referrals') { $('headerTitle').textContent = 'Referral Pipeline'; Views.referralPipeline(page); }",
    "  else if (route === 'referrals') { $('headerTitle').textContent = 'Referral Pipeline'; Views.referralPipeline(page); }\n"
    "  else if (route === 'pricing') { $('headerTitle').textContent = 'Pricing & Rate Cards'; Views.pricing(page); }",
    'pricing route'
)

# ─────────────────────────────────────────────────────────────────────
# 4. Account detail: clickable pricing badge + Pricing tab
# ─────────────────────────────────────────────────────────────────────
sub1(
    """      ${a.pricingType && a.pricingType !== 'Standard' ? '<span class="badge badge-purple">'+a.pricingType+' Pricing</span>' : ''}""",
    """      ${hasCustomPricing(a) ? '<span class="badge badge-purple" style="cursor:pointer" title="View this account\\'s rate card" onclick="event.stopPropagation();App._acctTab(\\'pricing\\','+a._spId+')">'+escHtml(a.pricingType)+' Pricing'+(pricingIsUndocumented(a) ? ' &#9888;' : '')+'</span>' : ''}""",
    'clickable pricing badge'
)

sub1(
    """      <button class="tab-btn" onclick="App._acctTab('jobs',${a._spId})">Jobs (${jobTabCount})</button>""",
    """      <button class="tab-btn" onclick="App._acctTab('jobs',${a._spId})">Jobs (${jobTabCount})</button>
      <button class="tab-btn" onclick="App._acctTab('pricing',${a._spId})">Pricing${a.pricingRates && a.pricingRates.length ? ' ('+a.pricingRates.length+')' : ''}</button>""",
    'pricing tab button'
)

# The tab switcher matches on button text; 'pricing' would also prefix-match nothing
# else, but 'jobs'/'pricing' both start distinctly so the existing logic is fine.

# ─────────────────────────────────────────────────────────────────────
# 5. Overview: surface the rate card inline instead of a bare word
# ─────────────────────────────────────────────────────────────────────
sub1(
    """      ['Pricing', a.pricingType + (a.pricingNotes ? ' &mdash; ' + a.pricingNotes : '')],""",
    """      ['Pricing', (function() {
        var s = escHtml(a.pricingType || 'Standard');
        if (a.pricingRates && a.pricingRates.length) {
          var sum = pricingSummary(a.pricingRates);
          s += ' &mdash; <a href="javascript:void(0)" onclick="App._acctTab(\\'pricing\\',' + a._spId + ')">' + a.pricingRates.length + ' rate line' + (a.pricingRates.length === 1 ? '' : 's') + '</a>';
          if (sum.avgDelta !== null) s += ' (avg ' + (sum.avgDelta > 0 ? '+' : '') + sum.avgDelta.toFixed(1) + '% vs standard)';
          if (a.pricingEffectiveDate) s += ', effective ' + escHtml(a.pricingEffectiveDate);
        } else if (a.pricingType && a.pricingType !== 'Standard') {
          s += ' &mdash; <span class="badge badge-amber">no rates on file</span> <a href="javascript:void(0)" onclick="App._acctTab(\\'pricing\\',' + a._spId + ')">add them</a>';
        }
        if (a.pricingNotes) s += '<div style="font-size:12px;color:var(--text-secondary);margin-top:2px">' + escHtml(a.pricingNotes) + '</div>';
        return s;
      })()],""",
    'overview pricing row'
)

# ─────────────────────────────────────────────────────────────────────
# 6. Overview: referral numbers from the live index
# ─────────────────────────────────────────────────────────────────────
sub1(
    """    var referredJobs = (window.CRM_JOBS || []).filter(function(j) {
      var idMatch = parseInt(j.Referred_By_Account_Id) === a._spId;
      var nameMatch = (j.Referred_By || '').toLowerCase() === (a.name || '').toLowerCase();
      return idMatch || nameMatch;
    });
    var refRevenue = referredJobs.reduce(function(s, j) { return s + (parseFloat(j.Total_Paid) || 0); }, 0);""",
    """    var refStats = referralStatsFor(a);
    var referredJobs = refStats.jobList;
    var refRevenue = refStats.collected;
    var refInvoiced = refStats.invoiced;""",
    'overview referral stats'
)

sub1(
    """            '<div class="stat-card" style="flex:1;background:#f0fdf4;border-color:#22c55e"><div class="stat-value" style="color:#15803d">' + fmtMoney(refRevenue) + '</div><div class="stat-label">Referred Revenue (Collected)</div></div>'""",
    """            '<div class="stat-card" style="flex:1;background:#f0fdf4;border-color:#22c55e"><div class="stat-value" style="color:#15803d">' + fmtMoney(refInvoiced) + '</div><div class="stat-label">Referred Revenue (Invoiced)</div></div>' +
            '<div class="stat-card" style="flex:1;background:#f0fdf4;border-color:#22c55e"><div class="stat-value" style="color:#15803d">' + fmtMoney(refRevenue) + '</div><div class="stat-label">Referred Revenue (Collected)</div></div>'""",
    'overview referral stat cards'
)

sub1(
    """        referredJobs.map(function(j) {
          var paid = parseFloat(j.Total_Paid) || 0;
          var amt = parseFloat(j.Amount) || 0;
          return '<tr><td style="padding:6px">' + escHtml(j.Job_Number || j.Title) + '</td><td style="padding:6px">' + escHtml(j.Client_Name || '') + '</td><td style="padding:6px;text-align:right;color:var(--text-muted)">' + fmtMoney(amt) + '</td><td style="padding:6px;text-align:right;color:var(--success-600);font-weight:600">' + fmtMoney(paid) + '</td><td style="padding:6px">' + escHtml(j.Job_Status || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';""",
    """        referredJobs.map(function(j) {
          return '<tr><td style="padding:6px">' + escHtml(j.jobNumber) + '</td><td style="padding:6px">' + escHtml(j.client) + '</td><td style="padding:6px;text-align:right;color:var(--text-muted)">' + fmtMoney(j.invoiced) + '</td><td style="padding:6px;text-align:right;color:var(--success-600);font-weight:600">' + fmtMoney(j.collected) + '</td><td style="padding:6px">' + escHtml(j.status) + '</td></tr>';
        }).join('') + '</tbody></table></div>';""",
    'overview referred jobs table'
)

# ─────────────────────────────────────────────────────────────────────
# 7. Account list: pricing column + referral columns off the shared index
# ─────────────────────────────────────────────────────────────────────
sub1(
    "      <thead><tr><th>Name</th><th>Roles</th><th>Category</th><th>City/State</th><th>Jobs</th><th>QB Revenue</th><th>Referred</th><th>Ref Collected</th><th>Health</th></tr></thead>",
    "      <thead><tr><th>Name</th><th>Roles</th><th>Category</th><th>City/State</th><th>Pricing</th><th>Jobs</th><th>QB Revenue</th><th>Referred</th><th>Ref Collected</th><th>Health</th></tr></thead>",
    'account table header'
)

sub1(
    """  var refByName = {};
  (window.CRM_JOBS || []).forEach(function(j) {
    var k = (j.Referred_By || '').toLowerCase();
    if (!k) return;
    if (!refByName[k]) refByName[k] = { count: 0, revenue: 0 };
    refByName[k].count++;
    refByName[k].revenue += (parseFloat(j.Total_Paid) || 0);
  });""",
    """  var _refIdx = buildReferralIndex();
  var _stdRates = getStandardRates();""",
    'account list referral index'
)

sub1(
    """    var refStats = refByName[(a.name || '').toLowerCase()] || { count: 0, revenue: 0 };
    var refCell = refStats.count > 0 ? '<strong style="color:var(--purple-500)">' + refStats.count + '</strong>' : '<span style="color:var(--text-muted)">\\u2014</span>';
    var refRevCell = refStats.revenue > 0 ? '<span style="color:var(--purple-500);font-weight:600">' + fmtMoney(refStats.revenue) + '</span>' : '<span style="color:var(--text-muted)">\\u2014</span>';""",
    """    var refStats = referralStatsFor(a, _refIdx);
    var refCell = refStats.jobs > 0 ? '<strong style="color:var(--purple-500)">' + refStats.jobs + '</strong>' : '<span style="color:var(--text-muted)">\\u2014</span>';
    var refRevCell = refStats.collected > 0 ? '<span style="color:var(--purple-500);font-weight:600">' + fmtMoney(refStats.collected) + '</span>' : '<span style="color:var(--text-muted)">\\u2014</span>';
    var priceCell = (function() {
      if (!hasCustomPricing(a)) return '<span style="color:var(--text-muted);font-size:11px">Standard</span>';
      if (pricingIsUndocumented(a)) return '<span class="badge badge-amber" title="Flagged ' + escHtml(a.pricingType) + ' but no rates on file">' + escHtml(a.pricingType) + ' &#9888;</span>';
      var sum = pricingSummary(a.pricingRates, _stdRates);
      return '<span class="badge badge-purple">' + escHtml(a.pricingType) + '</span>' +
        '<div style="font-size:11px;color:var(--text-muted)">' + sum.lines + ' line' + (sum.lines === 1 ? '' : 's') +
        (sum.avgDelta !== null ? ' &middot; ' + (sum.avgDelta > 0 ? '+' : '') + sum.avgDelta.toFixed(1) + '%' : '') + '</div>';
    })();""",
    'account list cells'
)

sub1(
    """      <td>${cityStateHtml}</td>
      <td>${a.totalJobs || 0}</td>""",
    """      <td>${cityStateHtml}</td>
      <td>${priceCell}</td>
      <td>${a.totalJobs || 0}</td>""",
    'account list pricing cell placement'
)

# ─────────────────────────────────────────────────────────────────────
# 8. Dashboard: referral rollup off the shared index
# ─────────────────────────────────────────────────────────────────────
sub1(
    """  var referralsByOrg = {};
  (window.CRM_JOBS || []).forEach(function(j) {
    var ref = (j.Referred_By || '').toLowerCase();
    if (!ref) return;
    if (!referralsByOrg[ref]) referralsByOrg[ref] = { count: 0, revenue: 0 };
    referralsByOrg[ref].count++;
    referralsByOrg[ref].revenue += (parseFloat(j.Total_Paid) || 0);
  });""",
    """  var _dashRefIdx = buildReferralIndex();
  var referralsByOrg = {};
  Object.keys(_dashRefIdx.byName).forEach(function(k) {
    referralsByOrg[k] = { count: _dashRefIdx.byName[k].jobs, revenue: _dashRefIdx.byName[k].collected };
  });
  accounts.forEach(function(a) {
    var b = _dashRefIdx.byId[a._spId];
    if (!b) return;
    var k = (a.name || '').toLowerCase();
    if (!referralsByOrg[k]) referralsByOrg[k] = { count: b.jobs, revenue: b.collected };
  });""",
    'dashboard referral index'
)

# ─────────────────────────────────────────────────────────────────────
# 9. Referral Pipeline: live QB amounts, invoiced + collected
# ─────────────────────────────────────────────────────────────────────
OLD_REF_VIEW_START = """Views.referralPipeline = (el) => {
  const accounts = DB.get(KEYS.accounts);
  const jobLinks = DB.get(KEYS.jobLinks);
  // Build referral stats
  const refStats = {};
  jobLinks.filter(jl => jl.referralAccountId).forEach(jl => {
    if (!refStats[jl.referralAccountId]) refStats[jl.referralAccountId] = { id: jl.referralAccountId, name: jl.referralAccountName, jobs: 0, revenue: 0, lastDate: '' };
    refStats[jl.referralAccountId].jobs++;
    refStats[jl.referralAccountId].revenue += jl.jobValue || 0;
    if (jl.linkDate > refStats[jl.referralAccountId].lastDate) refStats[jl.referralAccountId].lastDate = jl.linkDate;
  });
  // Also show referral source accounts with no links yet
  accounts.filter(a => a.accountType === 'Referral Source').forEach(a => {
    if (!refStats[a._spId]) refStats[a._spId] = { id: a._spId, name: a.name, jobs: a.totalJobs || 0, revenue: a.totalRevenue || 0, lastDate: a.lastActivityDate || '' };
  });
  const sorted = Object.values(refStats).sort((a,b) => b.revenue - a.revenue);
"""

NEW_REF_VIEW_START = """Views.referralPipeline = (el) => {
  const accounts = DB.get(KEYS.accounts);
  const jobLinks = DB.get(KEYS.jobLinks);
  const idx = buildReferralIndex();
  // One row per referring account, valued live off Jobs_Master + QB_JobPnL rather
  // than the CRM_Job_Links.Job_Value snapshot (which the revenue sync wrote as 0).
  const refStats = {};
  accounts.forEach(function(a) {
    var s = referralStatsFor(a, idx);
    if (s.jobs === 0 && a.accountType !== 'Referral Source') return;
    refStats[a._spId] = {
      id: a._spId, name: a.name, jobs: s.jobs, invoiced: s.invoiced, collected: s.collected,
      lastDate: s.lastDate, source: s.source, jobList: s.jobList
    };
  });
  // Referrers named on jobs but with no CRM account yet — worth surfacing, not hiding.
  var knownNames = {};
  accounts.forEach(function(a) { knownNames[(a.name || '').toLowerCase()] = true; });
  Object.keys(idx.byName).forEach(function(k) {
    if (knownNames[k]) return;
    var b = idx.byName[k];
    refStats['unlinked:' + k] = {
      id: null, name: b.displayName || k, jobs: b.jobs, invoiced: b.invoiced,
      collected: b.collected, lastDate: b.lastDate, source: 'unlinked', jobList: b.jobList
    };
  });
  const sorted = Object.values(refStats).sort((a,b) => (b.collected || b.invoiced) - (a.collected || a.invoiced));
  const totalInvoiced = sorted.reduce((s,r) => s + r.invoiced, 0);
  const totalCollected = sorted.reduce((s,r) => s + r.collected, 0);
  const unlinkedCount = sorted.filter(r => r.source === 'unlinked').length;
  const banner = referralDataMissing()
    ? '<div class="card" style="padding:12px 16px;margin-bottom:12px;background:var(--warning-50);border-color:var(--warning-500)">' +
      '<strong>Jobs_Master did not load.</strong> Referral amounts below fall back to the stored CRM_Job_Links values and may read $0. ' +
      'Hit &#8635; Sync, or check list permissions.</div>'
    : (unlinkedCount ? '<div class="card" style="padding:12px 16px;margin-bottom:12px;background:var(--surface-subtle)">' +
      '<strong>' + unlinkedCount + '</strong> referrer' + (unlinkedCount === 1 ? '' : 's') + ' named on jobs have no CRM account yet (shown in grey below).</div>' : '');
"""

sub1(OLD_REF_VIEW_START, NEW_REF_VIEW_START, 'referral pipeline computation')

OLD_REF_VIEW_HTML = """  el.innerHTML = `
    <div class="stats-row">
      <div class="stat-card"><div class="stat-value">${sorted.length}</div><div class="stat-label">Referral Sources</div></div>
      <div class="stat-card"><div class="stat-value">${sorted.reduce((s,r)=>s+r.jobs,0)}</div><div class="stat-label">Total Referrals</div></div>
      <div class="stat-card"><div class="stat-value">${fmtMoney(sorted.reduce((s,r)=>s+r.revenue,0))}</div><div class="stat-label">Total Referred Revenue</div></div>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Source</th><th>Jobs Referred</th><th>Total Value</th><th>Clients Referred</th><th>Last Referral</th></tr></thead>
      <tbody>${sorted.map(r => {
        // Find distinct client accounts referred by this source
        var referredClients = {};
        jobLinks.filter(function(jl) { return jl.referralAccountId === r.id && jl.accountId; }).forEach(function(jl) {
          referredClients[jl.accountId] = jl.accountName || '';
        });
        var clientNames = Object.values(referredClients).filter(Boolean);
        var clientsDisplay = clientNames.length > 0 ? clientNames.slice(0,3).join(', ') + (clientNames.length > 3 ? ' +' + (clientNames.length - 3) + ' more' : '') : '&mdash;';
        return `<tr class="clickable-row" onclick="App.nav('accounts',{id:'${r.id}'})">
        <td><strong>${escHtml(r.name)}</strong></td><td>${r.jobs}</td><td>${fmtMoney(r.revenue)}</td>
        <td><span title="${escHtml(clientNames.join(', '))}">${clientNames.length > 0 ? clientNames.length + ' &mdash; ' + escHtml(clientsDisplay) : '&mdash;'}</span></td>
        <td>${r.lastDate || '&mdash;'}</td>
      </tr>`;
      }).join('')}</tbody>
    </table></div></div>`;
};"""

NEW_REF_VIEW_HTML = """  el.innerHTML = `
    ${banner}
    <div class="stats-row">
      <div class="stat-card"><div class="stat-value">${sorted.length}</div><div class="stat-label">Referral Sources</div></div>
      <div class="stat-card"><div class="stat-value">${sorted.reduce((s,r)=>s+r.jobs,0)}</div><div class="stat-label">Total Referrals</div></div>
      <div class="stat-card"><div class="stat-value">${fmtMoney(totalInvoiced)}</div><div class="stat-label">Referred Revenue (Invoiced)</div></div>
      <div class="stat-card"><div class="stat-value">${fmtMoney(totalCollected)}</div><div class="stat-label">Referred Revenue (Collected)</div></div>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Source</th><th>Jobs Referred</th><th style="text-align:right">Invoiced</th><th style="text-align:right">Collected (QB)</th><th>Clients Referred</th><th>Last Referral</th></tr></thead>
      <tbody>${sorted.map(r => {
        // Clients this source sent us — from the jobs themselves, with the legacy
        // job-link names as a fallback.
        var referredClients = {};
        r.jobList.forEach(function(rec) { if (rec.client) referredClients[rec.client] = true; });
        if (!Object.keys(referredClients).length && r.id) {
          jobLinks.filter(function(jl) { return jl.referralAccountId === r.id && jl.accountId; }).forEach(function(jl) {
            if (jl.accountName) referredClients[jl.accountName] = true;
          });
        }
        var clientNames = Object.keys(referredClients);
        var clientsDisplay = clientNames.length > 0 ? clientNames.slice(0,3).join(', ') + (clientNames.length > 3 ? ' +' + (clientNames.length - 3) + ' more' : '') : '&mdash;';
        var unlinked = r.source === 'unlinked';
        var click = r.id ? `onclick="App.nav('accounts',{id:'${r.id}'})"` : '';
        return `<tr class="${r.id ? 'clickable-row' : ''}" ${click} ${unlinked ? 'style="opacity:0.75"' : ''}>
        <td><strong>${escHtml(r.name)}</strong>${unlinked ? ' <span class="badge badge-amber" title="Named on jobs but not in the CRM">no account</span>' : ''}${r.source === 'links' ? ' <span class="badge" title="From stored job links — no Jobs_Master match">link data</span>' : ''}</td>
        <td>${r.jobs}</td>
        <td style="text-align:right;color:var(--text-muted)">${fmtMoney(r.invoiced)}</td>
        <td style="text-align:right;color:var(--success-600);font-weight:600">${fmtMoney(r.collected)}</td>
        <td><span title="${escHtml(clientNames.join(', '))}">${clientNames.length > 0 ? clientNames.length + ' &mdash; ' + escHtml(clientsDisplay) : '&mdash;'}</span></td>
        <td>${r.lastDate || '&mdash;'}</td>
      </tr>`;
      }).join('')}</tbody>
    </table></div></div>`;
};"""

sub1(OLD_REF_VIEW_HTML, NEW_REF_VIEW_HTML, 'referral pipeline markup')

# ─────────────────────────────────────────────────────────────────────
# 10. _syncQBRevenue: backfill Job_Value on links that already exist
# ─────────────────────────────────────────────────────────────────────
sub1(
    """    toast(updated + ' accounts updated with revenue data', 'success');
    render();
  } catch(e) { toast('Revenue sync error: ' + e.message, 'error'); }
}""",
    """    // Backfill Job_Value on links that already existed. Previously these were
    // written once (often as 0) and never refreshed, so referral totals read $0.
    var qbByJob = {};
    qbRows.forEach(function(q) {
      var jn = normJobNum(q.Title || q.Job_Number || q.JobNumber || '');
      if (jn) qbByJob[jn] = Math.round(parseFloat(q.Revenue != null ? q.Revenue : q.Income) || 0);
    });
    var jmByJob = {};
    jobRows.forEach(function(jr) {
      var jn = normJobNum(jr.Job_Number || jr.Title || '');
      if (jn) jmByJob[jn] = Math.round(parseFloat(jr.Total_Paid) || 0);
    });
    var backfilled = 0;
    var allLinks = DB.get(KEYS.jobLinks);
    for (var L = 0; L < allLinks.length; L++) {
      var link = allLinks[L];
      var jn2 = normJobNum(link.jobNumber || '');
      if (!jn2) continue;
      var want = qbByJob[jn2];
      if (want === undefined) want = jmByJob[jn2];
      if (want === undefined || want === (link.jobValue || 0)) continue;
      try {
        await spUpdate('CRM_Job_Links', link._spId, JOBLINK_ENTITY, { Job_Value: want });
        DB.update(KEYS.jobLinks, link._spId, { jobValue: want });
        backfilled++;
      } catch(e) { console.warn('Job_Value backfill failed for', jn2, e); }
    }
    toast(updated + ' accounts updated' + (backfilled ? ', ' + backfilled + ' job values backfilled' : ''), 'success');
    render();
  } catch(e) { toast('Revenue sync error: ' + e.message, 'error'); }
}""",
    'syncQBRevenue backfill'
)

# _autoLinkJobs joined QB by raw job label too.
sub1(
    """      Job_Value: Math.round(parseFloat(((window.CRM_QB_PNL || {})[j.Job_Number || j.Title] || {}).Revenue || ((window.CRM_QB_PNL || {})[j.Job_Number || j.Title] || {}).Income || 0)), Job_Status: j.Job_Status || 'Open',""",
    """      Job_Value: (function() { var q = qbByJobNumber()[normJobNum(j.Job_Number || j.Title)] || {}; return Math.round(parseFloat(q.Revenue != null ? q.Revenue : q.Income) || 0); })(), Job_Status: j.Job_Status || 'Open',""",
    'autoLinkJobs job-number normalization'
)

# ─────────────────────────────────────────────────────────────────────
# 11. Pricing tab, Pricing view, rate editor, SP field setup
# ─────────────────────────────────────────────────────────────────────
PRICING_CODE = r"""
// ══════════════════════════════════════════════
//  FV_PRICING_PATCH — Pricing tab, Pricing view, rate-card editor
// ══════════════════════════════════════════════

function _rateTableHtml(rows, stdRows, opts) {
  opts = opts || {};
  if (!rows || !rows.length) return '';
  return '<div class="table-wrap"><table style="width:100%;font-size:13px">' +
    '<thead><tr>' +
      '<th style="text-align:left">Line item</th>' +
      '<th style="text-align:right">This account</th>' +
      '<th style="text-align:right">Standard</th>' +
      '<th style="text-align:right">Delta</th>' +
      (opts.notes === false ? '' : '<th style="text-align:left">Note</th>') +
    '</tr></thead><tbody>' +
    rows.map(function(r) {
      var std = stdRateFor(r.label, r.unit, stdRows);
      var d = rateDelta(r, stdRows);
      return '<tr>' +
        '<td><strong>' + escHtml(r.label) + '</strong></td>' +
        '<td style="text-align:right">' + fmtRate(r) + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + (std === null ? '&mdash;' : fmtMoney(std)) + '</td>' +
        '<td style="text-align:right">' + fmtDelta(d) + '</td>' +
        (opts.notes === false ? '' : '<td style="color:var(--text-secondary)">' + escHtml(r.note || '') + '</td>') +
        '</tr>';
    }).join('') +
    '</tbody></table></div>';
}

function _acctPricingTab(el, a) {
  var stdRows = getStandardRates();
  var rows = a.pricingRates || [];
  var sum = pricingSummary(rows, stdRows);
  var head = '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
    '<span class="badge ' + (a.pricingType === 'Standard' ? '' : 'badge-purple') + '">' + escHtml(a.pricingType || 'Standard') + ' pricing</span>' +
    (a.pricingEffectiveDate ? '<span style="font-size:13px;color:var(--text-secondary)">Effective ' + escHtml(a.pricingEffectiveDate) + '</span>' : '') +
    (a.pricingReviewDate ? '<span class="badge ' + (a.pricingReviewDate < today() ? 'badge-red' : 'badge-blue') + '">Review ' + escHtml(a.pricingReviewDate) + '</span>' : '') +
    (a.pricingDocUrl ? '<a class="btn btn-sm" href="' + escHtml(a.pricingDocUrl) + '" target="_blank" rel="noopener">&#128196; Signed rate sheet</a>' : '') +
    '<div style="flex:1"></div>' +
    '<button class="btn btn-sm btn-primary" onclick="App._editPricing(' + a._spId + ')">Edit rate card</button>' +
    '</div>';

  if (!rows.length) {
    el.innerHTML = head +
      '<div class="empty-state"><div class="empty-icon">&#128181;</div>' +
      '<h3>No rates on file</h3>' +
      '<p style="color:var(--text-secondary);max-width:520px;margin:0 auto">' +
      (a.pricingType && a.pricingType !== 'Standard'
        ? 'This account is flagged <strong>' + escHtml(a.pricingType) + '</strong>, but the actual negotiated rates were never stored anywhere in the CRM &mdash; only the label was. Add them here and they travel with the account.'
        : 'This account bills at standard rates. Add lines here only if it negotiates something different.') +
      '</p>' +
      '<button class="btn btn-primary" style="margin-top:16px" onclick="App._editPricing(' + a._spId + ')">Add rates</button>' +
      '</div>';
    return;
  }

  var summaryBar = '<div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">' +
    '<div class="stat-card" style="flex:1;min-width:140px"><div class="stat-value">' + sum.lines + '</div><div class="stat-label">Rate lines</div></div>' +
    '<div class="stat-card" style="flex:1;min-width:140px"><div class="stat-value">' + sum.differing + '</div><div class="stat-label">Differ from standard</div></div>' +
    '<div class="stat-card" style="flex:1;min-width:140px"><div class="stat-value">' +
      (sum.avgDelta === null ? '&mdash;' : (sum.avgDelta > 0 ? '+' : '') + sum.avgDelta.toFixed(1) + '%') +
      '</div><div class="stat-label">Avg vs standard</div></div>' +
    '</div>';

  var stdHint = stdRows.length ? '' :
    '<div class="card" style="padding:12px 16px;margin-bottom:12px;background:var(--surface-subtle);font-size:13px">' +
    'No standard rate card is set, so the Standard and Delta columns are blank. ' +
    '<a href="javascript:void(0)" onclick="App.nav(\'pricing\')">Set it once in Pricing</a> and every account compares against it.</div>';

  el.innerHTML = head + summaryBar + stdHint +
    '<div class="card" style="padding:16px">' + _rateTableHtml(rows, stdRows) + '</div>' +
    (a.pricingNotes ? '<div class="card" style="padding:16px;margin-top:12px"><h4 style="font-size:14px;margin-bottom:6px">Notes</h4><div style="color:var(--text-secondary)">' + escHtml(a.pricingNotes) + '</div></div>' : '');
}

// ── Rate-card editor ──
var _rateDraft = null;
function _editPricing(spId) {
  var a = DB.find(KEYS.accounts, spId);
  if (!a) return;
  _rateDraft = { spId: spId, rows: (a.pricingRates || []).map(function(r) { return { label: r.label, unit: r.unit, rate: r.rate, note: r.note }; }) };
  openModal('Rate card &mdash; ' + escHtml(a.name),
    '<div class="form-row">' +
      '<div class="form-group"><label class="form-label">Pricing type</label><select class="form-control" id="pf_type">' +
        PRICING_TYPES.map(function(p) { return '<option ' + (a.pricingType === p ? 'selected' : '') + '>' + p + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="form-group"><label class="form-label">Effective date</label><input type="date" class="form-control" id="pf_eff" value="' + escHtml(a.pricingEffectiveDate || '') + '"></div>' +
      '<div class="form-group"><label class="form-label">Next review</label><input type="date" class="form-control" id="pf_review" value="' + escHtml(a.pricingReviewDate || '') + '"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">Signed rate sheet / MSA exhibit (URL)</label><input class="form-control" id="pf_doc" value="' + escHtml(a.pricingDocUrl || '') + '" placeholder="https://fortivopropertyservices.sharepoint.com/..."></div>' +
    '<div class="form-group"><label class="form-label">Notes</label><input class="form-control" id="pf_notes" value="' + escHtml(a.pricingNotes || '') + '"></div>' +
    '<label class="form-label" style="margin-top:8px">Rate lines</label>' +
    '<div id="pf_rows"></div>' +
    '<button class="btn btn-sm" style="margin-top:8px" onclick="App._addRateRow()">+ Add line</button> ' +
    '<span style="margin-left:8px;font-size:12px;color:var(--text-secondary)">Copy from published:</span> ' +
    ['Labor', 'Equipment', 'Consumable', 'Admin'].map(function(c) {
      return '<button class="btn btn-sm" style="margin-top:8px" onclick="App._seedFromStandard(\'' + c + '\')">' + c + '</button>';
    }).join(' '),
    '<button class="btn btn-primary" onclick="App._savePricing()">Save</button>' +
    '<button class="btn" onclick="App.closeModal()">Cancel</button>');
  _renderRateRows();
}
function _renderRateRows() {
  var host = document.getElementById('pf_rows');
  if (!host || !_rateDraft) return;
  if (!_rateDraft.rows.length) {
    host.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No lines yet.</div>';
    return;
  }
  var std = getStandardRates();
  host.innerHTML = _rateDraft.rows.map(function(r, i) {
    var d = rateDelta(r, std);
    return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">' +
      '<input class="form-control" style="flex:2;min-width:150px" placeholder="Line item (e.g. Technician)" value="' + escHtml(r.label || '') + '" oninput="App._rateEdit(' + i + ',\'label\',this.value)">' +
      '<input class="form-control" style="width:100px" type="number" step="0.01" placeholder="Rate" value="' + (r.rate != null ? r.rate : '') + '" oninput="App._rateEdit(' + i + ',\'rate\',this.value)">' +
      '<select class="form-control" style="width:100px" onchange="App._rateEdit(' + i + ',\'unit\',this.value)">' +
        RATE_UNITS.map(function(u) { return '<option ' + ((r.unit || 'hour') === u ? 'selected' : '') + '>' + u + '</option>'; }).join('') +
      '</select>' +
      '<input class="form-control" style="flex:1;min-width:120px" placeholder="Note" value="' + escHtml(r.note || '') + '" oninput="App._rateEdit(' + i + ',\'note\',this.value)">' +
      '<span style="width:70px;text-align:right;font-size:12px">' + fmtDelta(d) + '</span>' +
      '<button class="btn btn-sm btn-danger" onclick="App._removeRateRow(' + i + ')">&times;</button>' +
      '</div>';
  }).join('');
}
function _rateEdit(i, field, val) {
  if (!_rateDraft || !_rateDraft.rows[i]) return;
  _rateDraft.rows[i][field] = field === 'rate' ? (parseFloat(val) || 0) : val;
  if (field === 'rate' || field === 'label') {
    // Only the delta readout needs refreshing; re-rendering would steal focus, so
    // repaint on the next tick only when the row count is small enough to be cheap.
    var host = document.getElementById('pf_rows');
    if (host) {
      var spans = host.querySelectorAll('div > span');
      if (spans[i]) spans[i].innerHTML = fmtDelta(rateDelta(_rateDraft.rows[i], getStandardRates()));
    }
  }
}
function _addRateRow() {
  if (!_rateDraft) return;
  _rateDraft.rows.push({ label: '', unit: 'hour', rate: 0, note: '' });
  _renderRateRows();
}
function _removeRateRow(i) {
  if (!_rateDraft) return;
  _rateDraft.rows.splice(i, 1);
  _renderRateRows();
}
// Pull in one published category at a time — the full card is 136 lines and
// nobody negotiates all of them. De-dupes on label+unit.
function _seedFromStandard(cat) {
  if (!_rateDraft) return;
  var std = usingPublishedRates()
    ? STANDARD_RATE_CARD.filter(function(r) { return !cat || r.cat === cat; })
    : getStandardRates();
  if (!std.length) { toast('Nothing to copy for ' + (cat || 'standard'), 'warning'); return; }
  var have = {};
  _rateDraft.rows.forEach(function(r) { have[rateKey(r.label) + '|' + (r.unit || '')] = true; });
  var added = 0;
  std.forEach(function(r) {
    var k = rateKey(r.label) + '|' + (r.unit || '');
    if (have[k]) return;
    have[k] = true;
    _rateDraft.rows.push({ label: r.label, unit: r.unit, rate: r.rate, note: '' });
    added++;
  });
  _renderRateRows();
  toast(added ? 'Added ' + added + ' ' + (cat || 'standard') + ' line' + (added === 1 ? '' : 's') : 'Already present', added ? 'success' : 'info');
}
async function _savePricing() {
  if (!_rateDraft) return;
  var spId = _rateDraft.spId;
  var a = DB.find(KEYS.accounts, spId);
  if (!a) return;
  var rows = _rateDraft.rows.filter(function(r) { return (r.label || '').trim(); });
  var patch = {
    pricingType: document.getElementById('pf_type').value,
    pricingNotes: document.getElementById('pf_notes').value,
    pricingDocUrl: document.getElementById('pf_doc').value,
    pricingEffectiveDate: document.getElementById('pf_eff').value,
    pricingReviewDate: document.getElementById('pf_review').value,
    pricingRates: rows
  };
  try {
    if (onSP()) await spUpdate('CRM_Accounts', spId, ACCT_ENTITY, accountToSP(patch));
    DB.update(KEYS.accounts, spId, patch);
    closeModal();
    _rateDraft = null;
    toast('Rate card saved', 'success');
    render();
  } catch (e) {
    toast('Save failed: ' + e.message + ' (run Pricing → Setup fields if the columns are missing)', 'error');
  }
}

// ── Standard rate card editor (browser-local, shared shape with account cards) ──
var _stdDraft = null;
function _editStandardRates() {
  _stdDraft = getStandardRates().map(function(r) { return { label: r.label, unit: r.unit, rate: r.rate, note: r.note }; });
  var published = usingPublishedRates();
  openModal('Standard rate card',
    '<p style="margin-bottom:12px;color:var(--text-secondary);font-size:13px">' +
    (published
      ? 'Showing the <strong>published Fortivo rates, ' + escHtml(STANDARD_RATE_VERSION) + '</strong> (effective ' + escHtml(STANDARD_RATE_EFFECTIVE) + ') &mdash; ' +
        'mirrored from <code>rates.json</code>, the source the T&amp;M trackers and client rate sheets are built from. ' +
        'Editing here creates a local override for this browser only; the published card stays the default everywhere else.'
      : '<strong>Local override in effect</strong> for this browser. Revert to ship with the published card again.') +
    '</p>' +
    '<div id="sf_rows" style="max-height:50vh;overflow-y:auto"></div>' +
    '<button class="btn btn-sm" style="margin-top:8px" onclick="App._addStdRow()">+ Add line</button>',
    '<button class="btn btn-primary" onclick="App._saveStandardRates()">Save override</button>' +
    (published ? '' : '<button class="btn" onclick="App._resetStandardRates()">Revert to published</button>') +
    '<button class="btn" onclick="App.closeModal()">Cancel</button>');
  _renderStdRows();
}
function _resetStandardRates() {
  try { localStorage.removeItem(STD_RATES_KEY); } catch (e) { /* nothing to clear */ }
  _stdDraft = null;
  closeModal();
  toast('Reverted to published rates ' + STANDARD_RATE_VERSION, 'success');
  render();
}
function _renderStdRows() {
  var host = document.getElementById('sf_rows');
  if (!host || !_stdDraft) return;
  if (!_stdDraft.length) { host.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No lines yet.</div>'; return; }
  host.innerHTML = _stdDraft.map(function(r, i) {
    return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">' +
      '<input class="form-control" style="flex:2;min-width:150px" placeholder="Line item" value="' + escHtml(r.label || '') + '" oninput="App._stdEdit(' + i + ',\'label\',this.value)">' +
      '<input class="form-control" style="width:100px" type="number" step="0.01" placeholder="Rate" value="' + (r.rate != null ? r.rate : '') + '" oninput="App._stdEdit(' + i + ',\'rate\',this.value)">' +
      '<select class="form-control" style="width:100px" onchange="App._stdEdit(' + i + ',\'unit\',this.value)">' +
        RATE_UNITS.map(function(u) { return '<option ' + ((r.unit || 'hour') === u ? 'selected' : '') + '>' + u + '</option>'; }).join('') +
      '</select>' +
      '<button class="btn btn-sm btn-danger" onclick="App._removeStdRow(' + i + ')">&times;</button>' +
      '</div>';
  }).join('');
}
function _stdEdit(i, field, val) {
  if (!_stdDraft || !_stdDraft[i]) return;
  _stdDraft[i][field] = field === 'rate' ? (parseFloat(val) || 0) : val;
}
function _addStdRow() { if (_stdDraft) { _stdDraft.push({ label: '', unit: 'hour', rate: 0, note: '' }); _renderStdRows(); } }
function _removeStdRow(i) { if (_stdDraft) { _stdDraft.splice(i, 1); _renderStdRows(); } }
function _saveStandardRates() {
  if (!_stdDraft) return;
  setStandardRates(_stdDraft.filter(function(r) { return (r.label || '').trim(); }));
  _stdDraft = null;
  closeModal();
  toast('Standard rate card saved', 'success');
  render();
}

// ── Pricing view: every non-standard account in one place ──
var _pricingSearch = '';
Views.pricing = (el) => {
  // Create the Pricing_* columns on first visit rather than making it a chore.
  ensurePricingFields();
  const pricingSetupNote = _pricingFieldState === 'creating'
    ? '<div class="card" style="padding:12px 16px;margin-bottom:12px;background:var(--surface-subtle);font-size:13px">Adding the Pricing_* columns to CRM_Accounts&hellip;</div>'
    : (_pricingFieldState === 'failed'
      ? '<div class="card" style="padding:12px 16px;margin-bottom:12px;background:var(--warning-50);border-color:var(--warning-500);font-size:13px"><strong>Could not add the Pricing_* columns automatically.</strong> Rate cards will not save until they exist &mdash; use &#9881; Setup SP fields, or ask a site owner to run it.</div>'
      : '');
  const stdRows = getStandardRates();
  const all = DB.get(KEYS.accounts);
  const custom = all.filter(hasCustomPricing);
  const undocumented = custom.filter(pricingIsUndocumented);
  const dueReview = custom.filter(function(a) { return a.pricingReviewDate && a.pricingReviewDate <= today(); });

  el.innerHTML = `
    <div class="stats-row">
      <div class="stat-card"><div class="stat-value">${custom.length}</div><div class="stat-label">Accounts off standard</div></div>
      <div class="stat-card"><div class="stat-value">${custom.length - undocumented.length}</div><div class="stat-label">With rates on file</div></div>
      <div class="stat-card" ${undocumented.length ? 'style="background:var(--warning-50);border-color:var(--warning-500)"' : ''}><div class="stat-value">${undocumented.length}</div><div class="stat-label">Label only, no rates</div></div>
      <div class="stat-card" ${dueReview.length ? 'style="background:var(--danger-50);border-color:var(--danger-500)"' : ''}><div class="stat-value">${dueReview.length}</div><div class="stat-label">Due for review</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
      <input class="form-control" style="flex:1;min-width:200px" id="pricingSearch" placeholder="Search accounts..." value="${escHtml(_pricingSearch)}" oninput="App._pricingFilter(this.value)">
      <button class="btn" onclick="App._editStandardRates()">&#9881; Standard rate card (${stdRows.length}${usingPublishedRates() ? ' &middot; ' + STANDARD_RATE_VERSION : ' &middot; local'})</button>
      <button class="btn" onclick="App._exportPricingCsv()">&#11015; Export CSV</button>
      <button class="btn btn-outline btn-sm" onclick="App._setupPricingFields()" title="Add the Pricing_* columns to CRM_Accounts">&#9881; Setup SP fields</button>
    </div>
    ${stdRows.length ? '' : '<div class="card" style="padding:12px 16px;margin-bottom:12px;background:var(--surface-subtle);font-size:13px"><strong>No standard rate card set.</strong> Set it once and every account card shows its delta against it.</div>'}
    ${pricingSetupNote}
    ${undocumented.length ? '<div class="card" style="padding:12px 16px;margin-bottom:12px;background:var(--warning-50);border-color:var(--warning-500);font-size:13px"><strong>' + undocumented.length + ' account' + (undocumented.length === 1 ? ' is' : 's are') + ' flagged non-standard with no rates stored.</strong> That flag is just a label until the numbers are entered.</div>' : ''}
    <div id="pricingList"></div>`;
  _pricingFilter(_pricingSearch);
};

function _pricingFilter(val) {
  _pricingSearch = val || '';
  var host = document.getElementById('pricingList');
  if (!host) return;
  var stdRows = getStandardRates();
  var q = _pricingSearch.toLowerCase().trim();
  var rows = DB.get(KEYS.accounts).filter(hasCustomPricing).filter(function(a) {
    return !q || (a.name || '').toLowerCase().indexOf(q) > -1 || (a.pricingNotes || '').toLowerCase().indexOf(q) > -1 ||
      (a.pricingRates || []).some(function(r) { return (r.label || '').toLowerCase().indexOf(q) > -1; });
  }).sort(function(x, y) { return (x.name || '').localeCompare(y.name || ''); });

  if (!rows.length) {
    host.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128181;</div><h3>' +
      (q ? 'No matches' : 'Every account is on standard pricing') + '</h3></div>';
    return;
  }
  host.innerHTML = rows.map(function(a) {
    var sum = pricingSummary(a.pricingRates, stdRows);
    var undoc = pricingIsUndocumented(a);
    var reviewDue = a.pricingReviewDate && a.pricingReviewDate <= today();
    return '<div class="card" style="padding:16px;margin-bottom:12px">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:' + (undoc ? '0' : '12px') + '">' +
        '<a href="javascript:void(0)" onclick="App.nav(\'accounts\',{id:\'' + a._spId + '\'})"><strong style="font-size:15px">' + escHtml(a.name) + '</strong></a>' +
        '<span class="badge badge-purple">' + escHtml(a.pricingType) + '</span>' +
        (undoc ? '<span class="badge badge-amber">no rates on file</span>' : '<span style="font-size:12px;color:var(--text-secondary)">' + sum.lines + ' line' + (sum.lines === 1 ? '' : 's') + (sum.avgDelta !== null ? ' &middot; avg ' + (sum.avgDelta > 0 ? '+' : '') + sum.avgDelta.toFixed(1) + '% vs standard' : '') + '</span>') +
        (a.pricingEffectiveDate ? '<span style="font-size:12px;color:var(--text-muted)">eff. ' + escHtml(a.pricingEffectiveDate) + '</span>' : '') +
        (a.pricingReviewDate ? '<span class="badge ' + (reviewDue ? 'badge-red' : 'badge-blue') + '">review ' + escHtml(a.pricingReviewDate) + '</span>' : '') +
        '<div style="flex:1"></div>' +
        (a.pricingDocUrl ? '<a class="btn btn-sm" href="' + escHtml(a.pricingDocUrl) + '" target="_blank" rel="noopener">&#128196;</a> ' : '') +
        '<button class="btn btn-sm btn-primary" onclick="App._editPricing(' + a._spId + ')">' + (undoc ? 'Add rates' : 'Edit') + '</button>' +
      '</div>' +
      (undoc ? '' : _rateTableHtml(a.pricingRates, stdRows, { notes: false })) +
      (a.pricingNotes ? '<div style="font-size:12px;color:var(--text-secondary);margin-top:8px">' + escHtml(a.pricingNotes) + '</div>' : '') +
      '</div>';
  }).join('');
}

function _exportPricingCsv() {
  var stdRows = getStandardRates();
  var out = [['Account', 'Pricing Type', 'Line Item', 'Rate', 'Unit', 'Standard', 'Delta %', 'Effective', 'Review', 'Note', 'Account Notes']];
  DB.get(KEYS.accounts).filter(hasCustomPricing).sort(function(x, y) { return (x.name || '').localeCompare(y.name || ''); }).forEach(function(a) {
    if (!a.pricingRates || !a.pricingRates.length) {
      out.push([a.name, a.pricingType, '(no rates on file)', '', '', '', '', a.pricingEffectiveDate || '', a.pricingReviewDate || '', '', a.pricingNotes || '']);
      return;
    }
    a.pricingRates.forEach(function(r) {
      var std = stdRateFor(r.label, r.unit, stdRows);
      var d = rateDelta(r, stdRows);
      out.push([a.name, a.pricingType, r.label, r.rate, r.unit || 'hour', std === null ? '' : std,
                d === null ? '' : d.toFixed(1), a.pricingEffectiveDate || '', a.pricingReviewDate || '', r.note || '', a.pricingNotes || '']);
    });
  });
  var csv = out.map(function(row) {
    return row.map(function(c) { return '"' + String(c === null || c === undefined ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = 'Fortivo_Modified_Pricing_' + today() + '.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  toast('Pricing exported', 'success');
}

// ── One-time: add the Pricing_* columns to CRM_Accounts ──
async function _setupPricingFields() {
  if (!onSP()) { toast('Requires SharePoint connection', 'warning'); return; }
  openModal('Add pricing fields to CRM_Accounts',
    '<p style="margin-bottom:12px">Adds <strong>Pricing_Rates_JSON</strong>, <strong>Pricing_Doc_Url</strong>, ' +
    '<strong>Pricing_Effective_Date</strong> and <strong>Pricing_Review_Date</strong> to the CRM_Accounts list.</p>' +
    '<p style="color:var(--text-secondary);font-size:13px">Run once. Fields that already exist are skipped.</p>' +
    '<div id="pricingSetupProgress" style="margin-top:12px"></div>',
    '<button class="btn btn-primary" id="pricingSetupBtn" onclick="App._runPricingSetup()">Add fields</button>' +
    '<button class="btn" onclick="App.closeModal()">Cancel</button>');
}
async function _runPricingSetup() {
  const prog = document.getElementById('pricingSetupProgress');
  const btn = document.getElementById('pricingSetupBtn');
  if (btn) btn.disabled = true;
  const log = msg => { if (prog) prog.innerHTML += '<div style="font-size:13px;padding:2px 0">' + escHtml(msg) + '</div>'; };
  try {
    const digest = await spDigest();
    const hdrs = { 'Accept': 'application/json;odata=verbose', 'Content-Type': 'application/json;odata=verbose', 'X-RequestDigest': digest };
    const fields = [
      ['Pricing_Rates_JSON', 3], ['Pricing_Doc_Url', 2],
      ['Pricing_Effective_Date', 4], ['Pricing_Review_Date', 4]
    ];
    for (const [name, kind] of fields) {
      log('Adding field: ' + name + '...');
      const body = { '__metadata': { 'type': 'SP.Field' }, 'FieldTypeKind': kind, 'Title': name, 'StaticName': name, 'InternalName': name };
      const fr = await fetch(SP_SITE + "/_api/web/lists/getbytitle('CRM_Accounts')/fields", { method: 'POST', credentials: 'same-origin', headers: hdrs, body: JSON.stringify(body) });
      if (!fr.ok && fr.status !== 409) log('  Warning: ' + name + ' — ' + fr.status);
    }
    log('Done. Hit ↻ Sync to reload.');
    toast('Pricing fields ready', 'success');
  } catch (e) { log('Error: ' + e.message); toast('Setup error: ' + e.message, 'error'); }
}

// ── Auto-provisioning: do the setup instead of asking for it ──
// Idempotent and safe to call repeatedly; the state flag keeps it to one probe
// per page load, and SharePoint answers 409 for a column that already exists.
var _pricingFieldState = 'unknown';   // unknown | ok | creating | failed
const PRICING_FIELDS = [
  ['Pricing_Rates_JSON', 3], ['Pricing_Doc_Url', 2],
  ['Pricing_Effective_Date', 4], ['Pricing_Review_Date', 4]
];
async function ensurePricingFields() {
  if (!onSP() || _pricingFieldState === 'ok' || _pricingFieldState === 'creating') return;
  _pricingFieldState = 'creating';
  try {
    const r = await fetch(SP_SITE + "/_api/web/lists/getbytitle('CRM_Accounts')/fields?$select=InternalName&$top=500",
      { credentials: 'same-origin', headers: { 'Accept': 'application/json;odata=nometadata' } });
    if (!r.ok) throw new Error('field list: HTTP ' + r.status);
    const data = await r.json();
    const have = {};
    (data.value || []).forEach(function(f) { have[f.InternalName] = true; });
    const missing = PRICING_FIELDS.filter(function(f) { return !have[f[0]]; });
    if (!missing.length) { _pricingFieldState = 'ok'; return; }
    const digest = await spDigest();
    const hdrs = { 'Accept': 'application/json;odata=verbose', 'Content-Type': 'application/json;odata=verbose', 'X-RequestDigest': digest };
    for (const [name, kind] of missing) {
      const body = { '__metadata': { 'type': 'SP.Field' }, 'FieldTypeKind': kind, 'Title': name, 'StaticName': name, 'InternalName': name };
      const fr = await fetch(SP_SITE + "/_api/web/lists/getbytitle('CRM_Accounts')/fields",
        { method: 'POST', credentials: 'same-origin', headers: hdrs, body: JSON.stringify(body) });
      if (!fr.ok && fr.status !== 409) throw new Error(name + ': HTTP ' + fr.status);
    }
    _pricingFieldState = 'ok';
    toast('Added ' + missing.length + ' pricing field' + (missing.length === 1 ? '' : 's') + ' to CRM_Accounts', 'success');
    render();
  } catch (e) {
    console.warn('Pricing field provisioning failed:', e);
    _pricingFieldState = 'failed';
  }
}

// One-time migration: refresh Job_Value on links written before the fix, when it
// was set once at creation (often as 0) and never updated again.
const JOBVALUE_BACKFILL_KEY = 'fv_crm_jobvalue_backfill_v1';
async function autoBackfillJobValues() {
  if (!onSP()) return;
  try { if (localStorage.getItem(JOBVALUE_BACKFILL_KEY)) return; } catch (e) { return; }
  var qbRows = window.CRM_QB_PNL_RAW || [];
  var jobRows = window.CRM_JOBS_RAW || [];
  // Both sources must have loaded. Either one silently degrading to [] (they use
  // .catch(() => [])) would make `want` a partial picture, and writing that back
  // over Job_Value would overwrite good data with a worse guess.
  if (!qbRows.length || !jobRows.length) return;
  var want = {};
  jobRows.forEach(function(jr) {
    var jn = normJobNum(jr.Job_Number || jr.Title || '');
    if (jn) want[jn] = Math.round(parseFloat(jr.Total_Paid) || 0);
  });
  qbRows.forEach(function(q) {
    var jn = normJobNum(q.Title || q.Job_Number || q.JobNumber || '');
    if (jn) want[jn] = Math.round(parseFloat(q.Revenue != null ? q.Revenue : q.Income) || 0);
  });
  var links = DB.get(KEYS.jobLinks);
  var stale = links.filter(function(l) {
    var jn = normJobNum(l.jobNumber || '');
    return jn && want[jn] !== undefined && want[jn] !== (l.jobValue || 0);
  });
  if (!stale.length) {
    try { localStorage.setItem(JOBVALUE_BACKFILL_KEY, 'nothing-to-do'); } catch (e) {}
    return;
  }
  var done = 0;
  for (var i = 0; i < stale.length; i++) {
    var l = stale[i];
    var v = want[normJobNum(l.jobNumber)];
    try {
      await spUpdate('CRM_Job_Links', l._spId, JOBLINK_ENTITY, { Job_Value: v });
      DB.update(KEYS.jobLinks, l._spId, { jobValue: v });
      done++;
    } catch (e) { console.warn('Backfill failed for', l.jobNumber, e); }
  }
  // Only mark complete on a clean sweep, so a partial run retries next load.
  if (done === stale.length) {
    try { localStorage.setItem(JOBVALUE_BACKFILL_KEY, String(done)); } catch (e) {}
  }
  if (done) { toast('Refreshed ' + done + ' job value' + (done === 1 ? '' : 's') + ' from QuickBooks', 'success'); render(); }
}

// ══════════════════════════════════════════════
//  FV_AR_PANEL — read-only A/R on the account view
// ══════════════════════════════════════════════
// Reads QB_AR_Aging (written from QuickBooks by fv_qb.py) and attributes rows to
// accounts. WRITES NOTHING. Every failure mode renders a stated reason instead of
// a number, because a confident wrong balance is worse than a blank.

const AR_LIST = 'QB_AR_Aging';
const AR_TOP = 5000;                 // match every other read in the app
const AR_REWRITE_SPREAD_MIN = 5;     // fv_qb.py clear-then-reinserts every row; a
                                     // wide Modified spread means a partial write
// Three-state, deliberately never defaulted to []:
//   undefined = never fetched | null = fetch failed | array = loaded
window.CRM_AR = undefined;
var _arLoading = false;

// Dedicated fetch. A service worker is registered with a scope covering /_api/,
// so the shared spGet could be served from Cache Storage — money must not come
// from a cache. Not folded into spGet, which has other callers.
async function spGetNoStore(list, query) {
  const url = SP_SITE + "/_api/web/lists/getbytitle('" + list + "')/items?" + (query || '');
  const r = await fetch(url, {
    credentials: 'same-origin', cache: 'no-store',
    headers: { 'Accept': 'application/json;odata=nometadata', 'Cache-Control': 'no-cache' }
  });
  if (!r.ok) throw new Error(list + ': HTTP ' + r.status);
  const d = await r.json();
  return d.value || [];
}

// Lazy: deliberately NOT added to loadData's Promise.all. Four of those reads have
// no .catch, so widening that batch raises the odds of aborting the whole load —
// which in turn feeds the Job_Value backfill a partial picture.
async function loadAR(force) {
  if (_arLoading) return;
  if (!force && window.CRM_AR !== undefined) return;
  if (!onSP()) { window.CRM_AR = null; return; }
  _arLoading = true;
  try {
    window.CRM_AR = await spGetNoStore(AR_LIST, '$top=' + AR_TOP);
  } catch (e) {
    console.warn('A/R load failed:', e);
    window.CRM_AR = null;      // never leave a previous run's array in place
  } finally {
    _arLoading = false;
  }
}

// Anchored. normJobNum finds a job number anywhere, so "2026-01-000210" would
// yield "26-01-00021". Money attribution needs a real standalone match.
const STRICT_JOB_RE = /(^|[^\d])(\d{2}-\d{2}-\d{5})([^\d]|$)/;
function strictJobNum(v) {
  var m = String(v == null ? '' : v).match(STRICT_JOB_RE);
  return m ? m[2] : '';
}

// Why the panel cannot show a number, in priority order. '' means it can.
function arBlockReason() {
  if (_arLoading) return 'loading';
  if (window.CRM_AR === undefined) return 'unfetched';
  if (window.CRM_AR === null) return 'unavailable';
  var rows = window.CRM_AR;
  if (rows.length >= AR_TOP) return 'truncated';   // spGet ignores odata.nextLink
  if (!rows.length) return 'empty';
  var ts = rows.map(function(r) { return Date.parse(r.Modified); }).filter(function(n) { return !isNaN(n); });
  if (ts.length > 1) {
    var spread = (Math.max.apply(null, ts) - Math.min.apply(null, ts)) / 60000;
    if (spread > AR_REWRITE_SPREAD_MIN) return 'rewriting';
  }
  // Ownership depends on Jobs_Master. Without it we cannot say whose invoice this
  // is, and a smaller balance would read as a real paydown.
  if (!(window.CRM_JOBS && window.CRM_JOBS.length)) return 'nojobs';
  return '';
}

// Job numbers claimed by more than one account. CRM_Job_Links has no uniqueness
// constraint, and _syncQBRevenue dedupes on the raw label rather than the
// normalized one, so duplicates under different accounts genuinely occur.
function arContestedKeys() {
  var owner = {}, contested = {};
  DB.get(KEYS.jobLinks).forEach(function(l) {
    if (!l.accountId) return;
    var k = strictJobNum(l.jobNumber);
    if (!k) return;
    if (owner[k] === undefined) owner[k] = l.accountId;
    else if (owner[k] !== l.accountId) contested[k] = true;
  });
  return { owner: owner, contested: contested };
}

// The job numbers belonging to this account, with provenance.
function arJobKeysFor(a) {
  var keys = {};
  DB.get(KEYS.jobLinks).forEach(function(l) {
    if (l.accountId !== a._spId) return;
    var k = strictJobNum(l.jobNumber);
    if (k) keys[k] = 'link';
  });
  var nm = (a.name || '').toLowerCase().trim();
  if (nm) {
    (window.CRM_JOBS || []).forEach(function(j) {
      if ((j.Client_Name || '').toLowerCase().trim() !== nm) return;
      var k = strictJobNum(j.Job_Number);          // not || Title — Title is free text
      if (k && !keys[k]) keys[k] = 'name';
    });
  }
  return keys;
}

// Open A/R rows for one account. Balance > 0 only — fv_qb.py writes paid rows too,
// stamped AgingBucket 'Paid'. Contested keys are excluded from the total and
// reported separately rather than silently credited to one side.
function arRowsFor(a) {
  var ctx = arContestedKeys();
  var keys = arJobKeysFor(a);
  var nm = (a.name || '').toLowerCase().trim();
  var mine = [], contested = [];
  (window.CRM_AR || []).forEach(function(r) {
    var bal = parseFloat(r.Balance) || 0;
    if (bal <= 0) return;
    var k = strictJobNum(r.JobNumber);
    var hit = k ? !!keys[k] : (!!nm && (r.ClientName || '').toLowerCase().trim() === nm);
    if (!hit) return;
    var rec = {
      jobNumber: k || (r.JobNumber || ''), client: r.ClientName || '',
      invoiceNumber: r.InvoiceNumber || '', invoiceDate: fmtDate(r.InvoiceDate) || '',
      dueDate: fmtDate(r.DueDate) || '', amount: parseFloat(r.InvoiceAmount) || 0,
      paid: parseFloat(r.AmountPaid) || 0, balance: bal,
      bucket: r.AgingBucket || '', days: parseInt(r.DaysOutstanding, 10) || 0,
      via: k ? (keys[k] || 'name') : 'client-name'
    };
    if (k && ctx.contested[k]) contested.push(rec); else mine.push(rec);
  });
  mine.sort(function(x, y) { return y.days - x.days; });
  return { rows: mine, contested: contested };
}

// Rows matching no account at all — visible proof that a join miss is a miss
// rather than a zero.
function arUnattributed() {
  var claimed = {}, names = {};
  DB.get(KEYS.accounts).forEach(function(a) {
    var nm = (a.name || '').toLowerCase().trim();
    if (nm) names[nm] = true;
    Object.keys(arJobKeysFor(a)).forEach(function(k) { claimed[k] = true; });
  });
  var n = 0, total = 0;
  (window.CRM_AR || []).forEach(function(r) {
    var bal = parseFloat(r.Balance) || 0;
    if (bal <= 0) return;
    var k = strictJobNum(r.JobNumber);
    if (k ? claimed[k] : names[(r.ClientName || '').toLowerCase().trim()]) return;
    n++; total += bal;
  });
  return { count: n, total: total };
}

// Freshness from the sync's own stamps, not from wall time.
function arAsOf() {
  var ts = (window.CRM_AR || []).map(function(r) { return Date.parse(r.Modified); })
    .filter(function(n) { return !isNaN(n); });
  if (!ts.length) return null;
  var newest = Math.max.apply(null, ts);
  return { at: new Date(newest), hours: (Date.now() - newest) / 3600000 };
}
// fv_qb.py runs on a short cadence, so a day of staleness is hundreds of missed
// runs — the contact-recency thresholds used elsewhere would be far too lax here.
function arFreshBadge(asOf) {
  if (!asOf) return '';
  var h = asOf.hours, cls = h <= 1 ? 'badge-green' : (h <= 6 ? 'badge-amber' : 'badge-red');
  var txt = h < 1 ? Math.max(1, Math.round(h * 60)) + ' min'
                  : (h < 48 ? Math.round(h) + ' hr' : Math.round(h / 24) + ' days');
  return '<span class="badge ' + cls + '" title="Newest QB_AR_Aging row written ' +
    escHtml(asOf.at.toISOString()) + '">synced ' + txt + ' ago</span>';
}

const AR_BLOCK_COPY = {
  loading:     ['Loading A/R&hellip;', ''],
  unfetched:   ['A/R not loaded yet', 'Press Refresh to read QB_AR_Aging.'],
  unavailable: ['Could not read QB_AR_Aging', 'The list did not load, so no balance can be shown. This is a data problem, not a zero balance.'],
  truncated:   ['A/R list too large to total safely', 'QB_AR_Aging returned the maximum ' + AR_TOP + ' rows, so the list is truncated and any total would understate. Not shown.'],
  empty:       ['QB_AR_Aging is empty', 'The QuickBooks A/R sync has not populated this list, so the CRM cannot see any invoices. This is NOT a zero balance &mdash; check whether fv_qb.py last completed.'],
  rewriting:   ['A/R sync is mid-write', 'QB_AR_Aging rewrites every row on each run, and these rows were written more than ' + AR_REWRITE_SPREAD_MIN + ' minutes apart, so the list is partial right now. No total shown.'],
  nojobs:      ['Jobs_Master did not load', 'Without it the CRM cannot tell which invoices belong to this account, so any balance would be understated. Not shown.']
};

function _acctARTab(el, a) {
  var reason = arBlockReason();
  var head = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
    '<strong style="font-size:15px">Accounts receivable</strong>' +
    (reason ? '' : arFreshBadge(arAsOf())) +
    '<div style="flex:1"></div>' +
    '<button class="btn btn-sm" onclick="App._arRefresh(' + a._spId + ')"' + (_arLoading ? ' disabled' : '') + '>&#8635; Refresh</button>' +
    '</div>';

  if (reason) {
    var copy = AR_BLOCK_COPY[reason] || AR_BLOCK_COPY.unavailable;
    var warn = reason !== 'loading';
    el.innerHTML = head +
      '<div class="card" style="padding:20px;background:' + (warn ? 'var(--warning-50)' : 'var(--surface-subtle)') +
      ';border-color:' + (warn ? 'var(--warning-500)' : 'var(--border)') + '">' +
      '<h4 style="font-size:14px;margin-bottom:6px">' + copy[0] + '</h4>' +
      (copy[1] ? '<div style="font-size:13px;color:var(--text-secondary)">' + copy[1] + '</div>' : '') +
      '</div>';
    if (reason === 'unfetched') {
      loadAR().then(function() {
        var e2 = document.getElementById('acctTabContent');
        if (e2) _acctARTab(e2, a);
      });
    }
    return;
  }

  var res = arRowsFor(a);
  var rows = res.rows;
  var open = rows.reduce(function(s, r) { return s + r.balance; }, 0);
  var currentRows = rows.filter(function(r) { return r.days <= 0 || /current/i.test(r.bucket); });
  var pastDueTotal = rows.reduce(function(s, r) {
    return s + (currentRows.indexOf(r) === -1 ? r.balance : 0);
  }, 0);
  var oldest = rows.length ? rows[0] : null;
  var un = arUnattributed();

  if (!rows.length && !res.contested.length) {
    el.innerHTML = head +
      '<div class="empty-state"><div class="empty-icon">&#128179;</div><h3>No open A/R</h3>' +
      '<p style="color:var(--text-secondary)">QuickBooks shows no unpaid invoices attributed to ' +
      escHtml(a.name) + '.</p></div>' + _arFooter(un, res.contested);
    return;
  }

  var cards = '<div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">' +
    '<div class="stat-card" style="flex:1;min-width:150px' + (open > 0 ? ';background:var(--danger-50);border-color:var(--danger-500)' : '') + '">' +
      '<div class="stat-value"' + (open > 0 ? ' style="color:var(--danger-500)"' : '') + '>' + fmtMoney(open) + '</div>' +
      '<div class="stat-label">Open balance</div></div>' +
    '<div class="stat-card" style="flex:1;min-width:150px"><div class="stat-value">' + fmtMoney(pastDueTotal) + '</div><div class="stat-label">Past due</div></div>' +
    '<div class="stat-card" style="flex:1;min-width:150px"><div class="stat-value">' + (oldest ? oldest.days + 'd' : '&mdash;') + '</div><div class="stat-label">Oldest invoice</div></div>' +
    '<div class="stat-card" style="flex:1;min-width:150px"><div class="stat-value">' + rows.length + '</div><div class="stat-label">Open invoices</div></div>' +
    '</div>';

  var table = '<div class="card" style="padding:16px"><div class="table-wrap"><table style="width:100%;font-size:13px">' +
    '<thead><tr><th style="text-align:left">Invoice</th><th style="text-align:left">Job</th><th style="text-align:left">Due</th>' +
    '<th style="text-align:right">Amount</th><th style="text-align:right">Paid</th><th style="text-align:right">Balance</th>' +
    '<th style="text-align:left">Aging</th></tr></thead><tbody>' +
    rows.map(function(r) {
      var overdue = r.days > 0;
      return '<tr>' +
        '<td>' + (r.invoiceNumber ? escHtml(r.invoiceNumber) : '<span style="color:var(--text-muted)">&mdash;</span>') + '</td>' +
        '<td>' + escHtml(r.jobNumber || '') + (r.via === 'client-name' ? ' <span class="badge" title="Matched on client name — the invoice carries no job number">name</span>' : '') + '</td>' +
        '<td>' + escHtml(r.dueDate || '') + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + fmtMoney(r.amount) + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + fmtMoney(r.paid) + '</td>' +
        '<td style="text-align:right;font-weight:600' + (overdue ? ';color:var(--danger-500)' : '') + '">' + fmtMoney(r.balance) + '</td>' +
        '<td>' + (r.bucket ? '<span class="badge ' + (overdue ? 'badge-red' : 'badge-green') + '">' + escHtml(r.bucket) + '</span>' : '&mdash;') + '</td>' +
        '</tr>';
    }).join('') + '</tbody></table></div></div>';

  el.innerHTML = head + cards + table + _arFooter(un, res.contested);
}

function _arFooter(un, contested) {
  var out = '';
  if (contested && contested.length) {
    out += '<div class="card" style="padding:12px 16px;margin-top:12px;background:var(--warning-50);border-color:var(--warning-500);font-size:13px">' +
      '<strong>' + contested.length + ' invoice' + (contested.length === 1 ? '' : 's') + ' excluded &mdash; job claimed by more than one account.</strong> ' +
      'CRM_Job_Links holds conflicting owners for ' + escHtml(contested.map(function(r) { return r.jobNumber; }).join(', ')) +
      '. Excluded from the total rather than credited to the wrong account.</div>';
  }
  if (un && un.count) {
    out += '<div class="card" style="padding:12px 16px;margin-top:12px;background:var(--surface-subtle);font-size:13px">' +
      un.count + ' open invoice' + (un.count === 1 ? '' : 's') + ' totalling <strong>' + fmtMoney(un.total) +
      '</strong> match no CRM account at all &mdash; shown so a join miss is visible rather than silently absent.</div>';
  }
  out += '<div style="font-size:11px;color:var(--text-muted);margin-top:10px;line-height:1.5">' +
    'Source: QB_AR_Aging, written from QuickBooks by fv_qb.py. Figures are <strong>gross open invoice balances</strong> &mdash; ' +
    'unapplied credit memos and unapplied customer payments are not visible to this source, so a balance here can exceed what ' +
    'QuickBooks&rsquo; own A/R Aging shows net. Read-only: this panel never writes. ' +
    'The Residential Client roll-up is not included in v1.</div>';
  return out;
}

async function _arRefresh(spId) {
  await loadAR(true);
  var el = document.getElementById('acctTabContent');
  var a = DB.find(KEYS.accounts, spId);
  if (el && a) _acctARTab(el, a);
}

"""

sub1(
    "// ── Public API ──\nasync function refreshData() { await loadData(false); render(); }",
    PRICING_CODE + "\n// ── Public API ──\nasync function refreshData() { await loadData(false); render(); }",
    'pricing code block'
)

# Wire the Pricing tab into the tab switcher.
sub1(
    """  if (tab === 'overview') {""",
    """  if (tab === 'pricing') { _acctPricingTab(el, a); return; }

  if (tab === 'overview') {""",
    'pricing tab dispatch'
)

# Hydrate standard rates on boot.
sub1(
    "parseHash();\nloadData(true).then(() => render());",
    "parseHash();\nhydrateStandardRates();\nloadData(true).then(() => { render(); autoBackfillJobValues(); });",
    'hydrate standard rates on boot'
)

# Export the new functions.
sub1(
    "  _setupCRMDealsList, _runCRMDealsSetup,",
    "  _setupCRMDealsList, _runCRMDealsSetup,\n"
    "  // FV_PRICING_PATCH: rate cards\n"
    "  _editPricing, _savePricing, _addRateRow, _removeRateRow, _rateEdit, _seedFromStandard,\n"
    "  _editStandardRates, _saveStandardRates, _resetStandardRates, _addStdRow, _removeStdRow, _stdEdit,\n"
    "  _pricingFilter, _exportPricingCsv, _setupPricingFields, _runPricingSetup,\n"
    "  // FV_AR_PANEL\n"
    "  _arRefresh,",
    'export new functions'
)

io.open(out, 'w', encoding='utf-8').write(src)
print('\nPatched OK -> ' + out)
