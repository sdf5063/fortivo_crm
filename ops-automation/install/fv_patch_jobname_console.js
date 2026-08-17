/* ═══════════════════════════════════════════════════════════════════════════
   FORTIVO PATCH — editable Job Name in the Job Manager (Option B, 2026-08-15)
   ───────────────────────────────────────────────────────────────────────────
   Run in an authenticated browser console on:
     https://fortivopropertyservices.sharepoint.com/sites/FortivoOperations
   Then republish the page with install/sp_deploy_console.js (canary-first).

   What it does, in order — aborting at the FIRST failure with nothing changed:
     1. Ensures Jobs_Master has a Job_Name text column (created with an exact
        internal name via AddFieldAsXml; skipped if it already exists)
     2. Downloads the Site Assets master fortivo_app.html as raw bytes
     3. Verifies every patch anchor occurs EXACTLY ONCE (or detects the patch
        is already applied and stops cleanly)
     4. Uploads a dated backup copy to Site Assets/_backups (create-only) and
        confirms its size matches before anything is overwritten
     5. Uploads the patched master
   The served page does NOT change until sp_deploy_console.js republishes it.

   The patch itself (6 surgical edits):
     - spToJob / jobToSP: round-trip a new j.jobName ⇄ Job_Name column
     - Details editor: "Job Name" text field, saved with the other details
     - Jobs list + job header: display Job Name when set, else client (PDFs,
       dropdowns, and reports keep using the client field — unchanged)
   Data-safety: display falls back to client when Job_Name is empty, so
   existing jobs look identical until a name is deliberately set. No column
   is renamed, no data rewritten, nothing deleted.
   ═══════════════════════════════════════════════════════════════════════ */
(async function fvPatchJobName(){
'use strict';
const SITE = '/sites/FortivoOperations';
const MASTER = SITE + '/SiteAssets/fortivo_app.html';
const BACKUP_DIR = SITE + '/SiteAssets/_backups';
const stamp = new Date().toISOString().slice(0,10).replace(/-/g,'');

// Anchors are pure ASCII and verified unique against the live master
// (2026-08-15). ALREADY marker short-circuits a second run harmlessly.
const ALREADY = "jobName: sp.Job_Name || ''";
const PATCHES = [
  { find: "clientName: sp.Client_Name || '', client: sp.Client_Name || '',",
    repl: "clientName: sp.Client_Name || '', client: sp.Client_Name || '', jobName: sp.Job_Name || ''," },
  { find: "if (j.clientName !== undefined) f.Client_Name = j.clientName;",
    repl: "if (j.clientName !== undefined) f.Client_Name = j.clientName;\n  if (j.jobName !== undefined) f.Job_Name = j.jobName;" },
  { find: "{id:'jef_clientName',field:'clientName'},{id:'jef_clientPhone',field:'clientPhone'}",
    repl: "{id:'jef_jobName',field:'jobName'},{id:'jef_clientName',field:'clientName'},{id:'jef_clientPhone',field:'clientPhone'}" },
  { find: "${_df('Client Contact',j.clientName,'clientName','text')}",
    repl: "${_df('Job Name',j.jobName,'jobName','text')}\n      ${_df('Client Contact',j.clientName,'clientName','text')}" },
  { find: '<div class="job-client">${j.client||\'\'}</div>',
    repl: '<div class="job-client">${j.jobName||j.client||\'\'}</div>' },
  { find: '<td><strong>${j.id}</strong></td><td>${j.client||\'\'}<br>',
    repl: '<td><strong>${j.id}</strong></td><td>${j.jobName||j.client||\'\'}<br>' }
];

const enc = (s) => encodeURIComponent(String(s).replace(/'/g, "''"));
async function digest(){
  const r = await fetch(SITE + '/_api/contextinfo', { method:'POST', headers:{ Accept:'application/json;odata=nometadata' } });
  if (!r.ok) throw new Error('contextinfo ' + r.status);
  return (await r.json()).FormDigestValue;
}
async function sp(method, url, body, contentType){
  const h = { Accept:'application/json;odata=verbose', 'X-RequestDigest': await digest() };
  if (contentType) h['Content-Type'] = contentType;
  return fetch(SITE + url, { method, headers: h, body });
}

/* 1 ── ensure Jobs_Master has Job_Name (exact internal name, idempotent) */
const fr = await fetch(SITE + "/_api/web/lists/getbytitle('Jobs_Master')/fields?$select=InternalName&$filter=InternalName eq 'Job_Name'",
  { headers:{ Accept:'application/json;odata=nometadata' } });
if (!fr.ok) throw new Error('Jobs_Master fields read failed: ' + fr.status);
const have = (await fr.json()).value || [];
if (have.length){
  console.log('1/5 Job_Name column already exists — good');
} else {
  const xml = "<Field Type='Text' Name='Job_Name' StaticName='Job_Name' DisplayName='Job Name' MaxLength='255'/>";
  const cr = await sp('POST', "/_api/web/lists/getbytitle('Jobs_Master')/fields/createfieldasxml",
    JSON.stringify({ parameters: { __metadata:{ type:'SP.XmlSchemaFieldCreationInformation' },
      SchemaXml: xml, Options: 8 /* AddFieldInternalNameHint */ } }),
    'application/json;odata=verbose');
  if (!cr.ok) throw new Error('Job_Name column create failed: ' + cr.status + ' ' + (await cr.text()).slice(0,300));
  console.log('1/5 Job_Name column created on Jobs_Master');
}

/* 2 ── download master as bytes */
const mr = await fetch(MASTER, { headers:{ Accept:'text/html' } });
if (!mr.ok) throw new Error('master download failed: ' + mr.status);
const origBuf = await mr.arrayBuffer();
let text = new TextDecoder('utf-8').decode(origBuf);
console.log('2/5 master downloaded: ' + origBuf.byteLength + ' bytes');

/* 3 ── verify anchors (abort — with NOTHING changed — on any mismatch) */
if (text.includes(ALREADY)){ console.log('Patch already applied — nothing to do. Run sp_deploy_console.js if the served page is older.'); return; }
for (const p of PATCHES){
  const n = text.split(p.find).length - 1;
  if (n !== 1) throw new Error('ANCHOR CHECK FAILED (found ' + n + '×, need exactly 1): ' + p.find.slice(0,80) + ' — master differs from what this patch was built against; NOTHING was changed.');
}
for (const p of PATCHES) text = text.replace(p.find, p.repl);
console.log('3/5 all 6 anchors unique — patch applied in memory');

/* 4 ── dated backup, create-only, size-verified */
const backupName = 'fortivo_app_' + stamp + '_prejobname.html';
const br = await sp('POST', "/_api/web/GetFolderByServerRelativePath(DecodedUrl=@f)/Files/AddUsingPath(DecodedUrl=@n,overwrite=@o)?@f='" +
  enc(BACKUP_DIR) + "'&@n='" + enc(backupName) + "'&@o=false", origBuf, 'application/octet-stream');
if (!br.ok){
  const t = await br.text();
  if (/already exists|-2130575257/i.test(t)) console.log('4/5 backup ' + backupName + ' already exists from an earlier run — keeping it');
  else throw new Error('backup upload failed: ' + br.status + ' ' + t.slice(0,200) + ' — master NOT touched.');
} else {
  const vr = await fetch(BACKUP_DIR + '/' + backupName, { headers:{ Accept:'text/html' } });
  const vb = await vr.arrayBuffer();
  if (vb.byteLength !== origBuf.byteLength) throw new Error('backup size mismatch (' + vb.byteLength + ' vs ' + origBuf.byteLength + ') — master NOT touched.');
  console.log('4/5 backup verified: _backups/' + backupName);
}

/* 5 ── upload patched master (overwrite is safe: backup verified above) */
const outBuf = new TextEncoder().encode(text);
const ur = await sp('POST', "/_api/web/GetFolderByServerRelativePath(DecodedUrl=@f)/Files/AddUsingPath(DecodedUrl=@n,overwrite=@o)?@f='" +
  enc(SITE + '/SiteAssets') + "'&@n='fortivo_app.html'&@o=true", outBuf, 'application/octet-stream');
if (!ur.ok) throw new Error('master upload failed: ' + ur.status + ' ' + (await ur.text()).slice(0,200) + ' — restore from _backups/' + backupName + ' if needed.');
console.log('5/5 patched master uploaded (' + outBuf.byteLength + ' bytes).');
console.log('NEXT: run install/sp_deploy_console.js to republish the page (canary-first). The live app is unchanged until then.');
})().catch(e => console.error('PATCH ABORTED:', e.message));
