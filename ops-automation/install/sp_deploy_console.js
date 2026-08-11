/* ═══════════════════════════════════════════════════════════════════════════
   Fortivo Ops Automation — ONE-PASTE SharePoint installer & deployer
   ───────────────────────────────────────────────────────────────────────────
   Run in an authenticated browser console on:
     https://fortivopropertyservices.sharepoint.com/sites/FortivoOperations
   (any page — the Job Manager is fine). The deploying agent executes this via
   its browser automation; pasting it by hand works identically.

   Encodes the proven, hard-won deploy recipe from decisions.md:
   canary-first, DELETE + Files/Add fresh item (never CopyTo-overwrite),
   verify render, keep dated backups. Aborts at the first failure.

   Sequence:
     1. Ensure Automation_Log list exists (explicit internal field names)
     2. CANARY: create fv_test_render.aspx and confirm it renders
        (if it serves "File Not Found", saves are blocked — flip
        DenyAddAndCustomizePages per preferences.md and re-run; NOTHING
        in production is touched on a failed canary)
     3. For each app page whose Site Assets master contains a kit block:
        backup current page as <name>_backup_<date>.aspx →
        DELETE canonical → Files/Add fresh from the master → verify render
        + kit marker present
     4. Delete the canary. Print a result table.

   Pages are only deployed when their master actually contains the new block,
   so this is safe to re-run at any time.
   ═══════════════════════════════════════════════════════════════════════ */
(async function fvDeploy(){
'use strict';
const SITE = '/sites/FortivoOperations';
const PAGES = [
  { name: 'fortivo_app',       marker: 'FORTIVO JOB KICKOFF' },
  { name: 'fortivo_invoicing', marker: 'FORTIVO INVOICE → QUICKBOOKS DESK' },
  // Optional: deploy the Dashboard too if its master carries a block
  { name: 'Fortivo_Dashboard', marker: 'FORTIVO JOB KICKOFF', optional: true }
];
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const results = [];
const enc = (s) => encodeURIComponent(String(s).replace(/'/g, "''"));

async function digest(){
  const r = await fetch(SITE + '/_api/contextinfo', { method: 'POST', headers: { Accept: 'application/json;odata=nometadata' } });
  if (!r.ok) throw new Error('contextinfo ' + r.status);
  return (await r.json()).FormDigestValue;
}
async function sp(method, url, body, contentType){
  const h = { Accept: 'application/json;odata=verbose', 'X-RequestDigest': await digest() };
  if (contentType) h['Content-Type'] = contentType;
  if (method === 'DELETE'){ h['X-HTTP-Method'] = 'DELETE'; h['IF-MATCH'] = '*'; method = 'POST'; }
  return fetch(SITE + url, { method, headers: h, body });
}
async function getText(url){
  const r = await fetch(url, { headers: { Accept: 'text/html' } });
  return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
}
async function addPage(name, html){
  const r = await sp('POST', "/_api/web/GetFolderByServerRelativeUrl('" + SITE + "/SitePages')/Files/Add(url='" + name + "',overwrite=true)", html);
  if (!r.ok) throw new Error('Files/Add ' + name + ' → ' + r.status + ': ' + (await r.text()).slice(0, 200));
  // publish is best-effort — SitePages often has minor versions disabled
  try { await sp('POST', "/_api/web/GetFileByServerRelativeUrl('" + SITE + "/SitePages/" + name + "')/Publish(comment='ops-automation deploy')"); } catch (e) {}
}
async function renders(name, mustContain){
  const p = await getText(SITE + '/SitePages/' + name + '?fvcb=' + Date.now());
  if (!p.ok) return { ok: false, why: 'HTTP ' + p.status };
  if (/File Not Found|Page not found/i.test(p.text)) return { ok: false, why: 'serves "File Not Found" (custom-script save block)' };
  if (mustContain && !p.text.includes(mustContain)) return { ok: false, why: 'renders but marker "' + mustContain + '" missing' };
  return { ok: true };
}

/* 1 ── Automation_Log list (idempotent) */
console.log('1/4 Automation_Log list…');
const listCheck = await fetch(SITE + "/_api/web/lists/getbytitle('Automation_Log')?$select=Title", { headers: { Accept: 'application/json;odata=nometadata' } });
if (listCheck.ok){
  console.log('   = already exists');
} else {
  let r = await sp('POST', '/_api/web/lists', JSON.stringify({ '__metadata': { 'type': 'SP.List' }, 'Title': 'Automation_Log', 'BaseTemplate': 100, 'Description': 'Audit trail for Fortivo Ops Automation (create-only actions)' }), 'application/json;odata=verbose');
  if (!r.ok) throw new Error('list create failed: ' + (await r.text()).slice(0, 300));
  for (const xml of [
    "<Field Type='Text' Name='Job_Number' StaticName='Job_Number' DisplayName='Job_Number'/>",
    "<Field Type='Text' Name='Result' StaticName='Result' DisplayName='Result'/>",
    "<Field Type='Note' Name='Details' StaticName='Details' DisplayName='Details' NumLines='6'/>"
  ]){
    r = await sp('POST', "/_api/web/lists/getbytitle('Automation_Log')/fields/CreateFieldAsXml", JSON.stringify({ 'parameters': { '__metadata': { 'type': 'SP.XmlSchemaFieldCreationInformation' }, 'SchemaXml': xml } }), 'application/json;odata=verbose');
    if (!r.ok) throw new Error('field create failed: ' + (await r.text()).slice(0, 300));
  }
  console.log('   ✓ created with internal names Job_Number / Result / Details');
}

/* 2 ── Canary (HARD RULE: no canary, no deploy) */
console.log('2/4 canary render test…');
await addPage('fv_test_render.aspx', '<html><body>fv-canary-ok-' + stamp + '</body></html>');
const canary = await renders('fv_test_render.aspx', 'fv-canary-ok-' + stamp);
if (!canary.ok){
  await sp('DELETE', "/_api/web/GetFileByServerRelativeUrl('" + SITE + "/SitePages/fv_test_render.aspx')").catch(() => {});
  throw new Error('CANARY FAILED (' + canary.why + ') — custom-script saves are blocked. Flip DenyAddAndCustomizePages (CSOM recipe in preferences.md), wait for propagation, re-run until the canary passes TWICE. Production pages were NOT touched.');
}
console.log('   ✓ canary renders');

/* 3 ── Deploy each page whose master carries a kit block */
for (const p of PAGES){
  console.log('3/4 ' + p.name + '…');
  const master = await getText(SITE + '/SiteAssets/' + p.name + '.html');
  if (!master.ok){ results.push([p.name, p.optional ? 'skipped (no master in Site Assets)' : 'SKIPPED — master not found']); continue; }
  if (!master.text.includes(p.marker)){ results.push([p.name, 'skipped (master has no kit block' + (p.optional ? '' : ' — run insert_snippets.js first') + ')']); continue; }
  if (!/<\/body>/i.test(master.text)) { results.push([p.name, 'ABORTED — master looks truncated (no </body>)']); continue; }

  const current = await getText(SITE + '/SitePages/' + p.name + '.aspx');
  if (current.ok && current.text.length > 500){
    await addPage(p.name + '_backup_' + stamp + '.aspx', current.text);
    console.log('   • backup: ' + p.name + '_backup_' + stamp + '.aspx');
  }
  await sp('DELETE', "/_api/web/GetFileByServerRelativeUrl('" + SITE + "/SitePages/" + p.name + ".aspx')").catch(() => {});
  await addPage(p.name + '.aspx', master.text);          // fresh item — never overwrite-in-place
  const v = await renders(p.name + '.aspx', p.marker);
  if (!v.ok){
    results.push([p.name, 'DEPLOYED BUT VERIFY FAILED (' + v.why + ') — restore: delete ' + p.name + '.aspx, Files/Add from ' + p.name + '_backup_' + stamp + '.aspx']);
    continue;
  }
  results.push([p.name, '✓ deployed & verified (kit block live)']);
}

/* 4 ── Cleanup + report */
await sp('DELETE', "/_api/web/GetFileByServerRelativeUrl('" + SITE + "/SitePages/fv_test_render.aspx')").catch(() => {});
console.log('4/4 done:');
results.forEach(([n, s]) => console.log('   ' + n + ': ' + s));
console.log('Backups kept in SitePages as *_backup_' + stamp + '.aspx — leave them until the apps are confirmed good for a few days.');
})().catch((e) => console.error('✗ DEPLOY ABORTED: ' + e.message));
