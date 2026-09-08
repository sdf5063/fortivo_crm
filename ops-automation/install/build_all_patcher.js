#!/usr/bin/env node
// Regenerates fv_patch_all_console.js — the consolidated one-paste patcher for
// the Job Manager master (fortivo_app.html in Site Assets). Run after editing
// any input:
//   node install/build_all_patcher.js
//
// Stages (each independently idempotent, all verified in memory BEFORE any
// upload; the FIRST failure aborts with nothing changed):
//   1. Jobs_Master Job_Name column (create if missing)
//   2. JOBNAME  — editable Job Name field (6 anchored edits, from
//                 fv_patch_jobname_console.js's PATCHES table)
//   3. MINT     — number-minting hardening (4 anchored edits, mint_patches.js)
//   4. KICKOFF  — replace the deployed Job Kickoff block with the repo version
//                 (GUARD V2: stale-number cross-checks)
//   5. EDITJOB  — insert the Edit Job block before </body> if absent
// Then a dated size-verified backup and a single master upload.
'use strict';
const fs = require('fs');
const path = require('path');
const { MINT_PATCHES, MINT_MARKER } = require('./mint_patches');

const DIR = __dirname;
const OUT = path.join(DIR, 'fv_patch_all_console.js');

// Job Name patches: single source of truth is the standalone patcher
const jobnameSrc = fs.readFileSync(path.join(DIR, 'fv_patch_jobname_console.js'), 'utf8');
const jm = jobnameSrc.match(/const ALREADY = ([^\n]+);\nconst PATCHES = (\[[\s\S]*?\n\]);/);
if (!jm) throw new Error('could not extract PATCHES from fv_patch_jobname_console.js');
const JOBNAME_ALREADY = new Function('return ' + jm[1])();
const JOBNAME_PATCHES = new Function('return ' + jm[2])();

const kickoff = fs.readFileSync(path.join(DIR, '..', 'job-kickoff', 'fv_job_kickoff.snippet.html'), 'utf8').trim();
const editjob = fs.readFileSync(path.join(DIR, '..', 'job-rename', 'fv_job_rename.snippet.html'), 'utf8').trim();
const KICKOFF_TOKEN = 'FORTIVO JOB KICKOFF';
const KICKOFF_MARKER = 'FVK GUARD V2';
const EDITJOB_TOKEN = 'FORTIVO EDIT JOB';
if (!kickoff.includes(KICKOFF_MARKER)) throw new Error('kickoff snippet lost its GUARD V2 marker');
if (kickoff.split(KICKOFF_TOKEN).length - 1 !== 2) throw new Error('kickoff snippet must contain its token exactly twice (header + END)');
if (!editjob.includes(EDITJOB_TOKEN)) throw new Error('editjob snippet lost its token');
for (const s of [kickoff, editjob]) {
  const inner = s.slice(s.indexOf('<script>') + 8, s.lastIndexOf('</' + 'script>'));
  if (inner.toLowerCase().includes('</' + 'script')) throw new Error('snippet JS contains a literal closing script tag');
}

const out = `/* ═══════════════════════════════════════════════════════════════════════════
   FORTIVO CONSOLIDATED PATCHER — Job Manager master (fortivo_app.html)
   GENERATED FILE — do not edit by hand. Regenerate with:
     node install/build_all_patcher.js
   ───────────────────────────────────────────────────────────────────────────
   Run in an authenticated browser console on:
     https://fortivopropertyservices.sharepoint.com/sites/FortivoOperations
   Then republish the page with install/sp_deploy_console.js (canary-first).

   Applies, in order (each stage skips itself if already applied):
     1. Jobs_Master "Job_Name" column (created if missing)
     2. JOBNAME  — editable Job Name in the Details editor
     3. MINT     — job-number minting hardening (the "2 numbers behind" fix:
                   suffix-tolerant max-scan, count all local jobs, verify the
                   number is free before use, never link to another client)
     4. KICKOFF  — Job Kickoff block replaced with GUARD V2 (blocks folder
                   creation when SP and the app disagree on a job's number;
                   warns on stale-twin folders for the same client+phase)
     5. EDITJOB  — ✏️ Edit Job block (rename/renumber with convention checks)
   Aborts at the FIRST failed verification with NOTHING changed. A dated,
   size-verified backup lands in _backups before the master is replaced.
   The served page does NOT change until sp_deploy_console.js runs.
   ═══════════════════════════════════════════════════════════════════════ */
(async function fvPatchAll(){
'use strict';
const SITE = '/sites/FortivoOperations';
const MASTER = SITE + '/SiteAssets/fortivo_app.html';
const BACKUP_DIR = SITE + '/SiteAssets/_backups';
const stamp = new Date().toISOString().slice(0,10).replace(/-/g,'');

const JOBNAME_ALREADY = ${JSON.stringify(JOBNAME_ALREADY)};
const JOBNAME_PATCHES = ${JSON.stringify(JOBNAME_PATCHES, null, 1)};
const MINT_MARKER = ${JSON.stringify(MINT_MARKER)};
const MINT_PATCHES = ${JSON.stringify(MINT_PATCHES, null, 1)};
const KICKOFF_TOKEN = ${JSON.stringify(KICKOFF_TOKEN)};
const KICKOFF_MARKER = ${JSON.stringify(KICKOFF_MARKER)};
const KICKOFF_SNIPPET = ${JSON.stringify(kickoff)};
const EDITJOB_TOKEN = ${JSON.stringify(EDITJOB_TOKEN)};
const EDITJOB_SNIPPET = ${JSON.stringify(editjob)};

const enc = (s) => encodeURIComponent(String(s).replace(/'/g, "''"));
async function digest(){
  const r = await fetch(SITE + '/_api/contextinfo', { method:'POST', headers:{ Accept:'application/json;odata=nometadata' } });
  if (!r.ok) throw new Error('contextinfo ' + r.status);
  return (await r.json()).FormDigestValue;
}
async function sp(url, body, contentType){
  const h = { Accept:'application/json;odata=verbose', 'X-RequestDigest': await digest() };
  if (contentType) h['Content-Type'] = contentType;
  return fetch(SITE + url, { method:'POST', headers:h, body });
}
function applyAnchored(text, patches, label){
  for (const p of patches){
    const n = text.split(p.find).length - 1;
    if (n !== 1) throw new Error(label + ' ANCHOR CHECK FAILED (found ' + n + 'x, need exactly 1): ' +
      p.find.slice(0, 80).replace(/\\n/g, ' ') + ' ... - master differs from what this patch was built against; NOTHING was changed.');
  }
  for (const p of patches) text = text.replace(p.find, p.repl);
  return text;
}

/* 1 ── Jobs_Master Job_Name column (idempotent) */
const fr = await fetch(SITE + "/_api/web/lists/getbytitle('Jobs_Master')/fields?$select=InternalName&$filter=InternalName eq 'Job_Name'",
  { headers:{ Accept:'application/json;odata=nometadata' } });
if (!fr.ok) throw new Error('Jobs_Master fields read failed: ' + fr.status);
if (((await fr.json()).value || []).length){
  console.log('1/6 Job_Name column already exists');
} else {
  const cr = await sp("/_api/web/lists/getbytitle('Jobs_Master')/fields/createfieldasxml",
    JSON.stringify({ parameters: { __metadata:{ type:'SP.XmlSchemaFieldCreationInformation' },
      SchemaXml: "<Field Type='Text' Name='Job_Name' StaticName='Job_Name' DisplayName='Job Name' MaxLength='255'/>", Options: 8 } }),
    'application/json;odata=verbose');
  if (!cr.ok) throw new Error('Job_Name column create failed: ' + cr.status + ' ' + (await cr.text()).slice(0,300));
  console.log('1/6 Job_Name column created');
}

/* 2 ── download master */
const mr = await fetch(MASTER, { headers:{ Accept:'text/html' } });
if (!mr.ok) throw new Error('master download failed: ' + mr.status);
const origBuf = await mr.arrayBuffer();
let text = new TextDecoder('utf-8').decode(origBuf);
const origBody = (text.toLowerCase().match(/<\\/body>/g) || []).length;
console.log('2/6 master downloaded: ' + origBuf.byteLength + ' bytes');

let changed = false;

/* 3 ── JOBNAME stage */
if (text.includes(JOBNAME_ALREADY)){
  console.log('3/6 JOBNAME already applied - skipped');
} else {
  text = applyAnchored(text, JOBNAME_PATCHES, 'JOBNAME');
  changed = true;
  console.log('3/6 JOBNAME applied (6 edits)');
}

/* 4 ── MINT stage */
if (text.includes(MINT_MARKER)){
  console.log('4/6 MINT already applied - skipped');
} else {
  text = applyAnchored(text, MINT_PATCHES, 'MINT');
  changed = true;
  console.log('4/6 MINT applied (4 edits)');
}

/* 5 ── KICKOFF replace (token occurrences: 1st = header comment, 2nd = END) */
if (text.includes(KICKOFF_MARKER)){
  console.log('5/6 KICKOFF GUARD V2 already installed - skipped');
} else {
  const i1 = text.indexOf(KICKOFF_TOKEN);
  if (i1 === -1) throw new Error('KICKOFF block not found in master - NOTHING uploaded.');
  const i2 = text.indexOf(KICKOFF_TOKEN, i1 + KICKOFF_TOKEN.length);
  if (i2 === -1) throw new Error('KICKOFF END marker not found - refusing to guess boundaries; NOTHING uploaded.');
  const begin = text.lastIndexOf('<!--', i1);
  const end = text.indexOf('-->', i2);
  if (begin === -1 || end === -1) throw new Error('KICKOFF comment boundaries not clean - NOTHING uploaded.');
  if (text.indexOf(KICKOFF_TOKEN, end) !== -1) throw new Error('more than 2 KICKOFF tokens in master - refusing; NOTHING uploaded.');
  text = text.slice(0, begin) + KICKOFF_SNIPPET + text.slice(end + 3);
  if (text.split(KICKOFF_TOKEN).length - 1 !== 2) throw new Error('KICKOFF replace verification failed - NOTHING uploaded.');
  if (!text.includes(KICKOFF_MARKER)) throw new Error('KICKOFF marker missing after replace - NOTHING uploaded.');
  changed = true;
  console.log('5/6 KICKOFF block replaced with GUARD V2');
}

/* 6 ── EDITJOB insert */
if (text.includes(EDITJOB_TOKEN)){
  console.log('6/6 EDITJOB already installed - skipped');
} else {
  const bodyClose = text.toLowerCase().lastIndexOf('</body>');
  if (bodyClose === -1) throw new Error('master has no closing body tag - NOTHING uploaded.');
  text = text.slice(0, bodyClose) + '\\n' + EDITJOB_SNIPPET + '\\n' + text.slice(bodyClose);
  if (text.split(EDITJOB_TOKEN).length - 1 !== EDITJOB_SNIPPET.split(EDITJOB_TOKEN).length - 1)
    throw new Error('EDITJOB insert verification failed - NOTHING uploaded.');
  changed = true;
  console.log('6/6 EDITJOB block inserted');
}

if (!changed){ console.log('Everything already applied - nothing to upload. Run sp_deploy_console.js if the served page is older than the master.'); return; }

/* final structural check: closing body tags = original + snippet-comment mentions */
const kickoffBodyMentions = (KICKOFF_SNIPPET.toLowerCase().match(/<\\/body>/g) || []).length;
const editjobBodyMentions = text.includes(EDITJOB_SNIPPET) ? (EDITJOB_SNIPPET.toLowerCase().match(/<\\/body>/g) || []).length : 0;
const finalBody = (text.toLowerCase().match(/<\\/body>/g) || []).length;
if (finalBody < origBody) throw new Error('closing body tag lost (' + finalBody + ' < ' + origBody + ') - NOTHING uploaded.');
if (!/<\\/body>\\s*<\\/html>\\s*$/i.test(text.slice(-200))) throw new Error('master no longer ends with </body></html> - NOTHING uploaded.');

/* backup: create-only, size-verified */
const backupName = 'fortivo_app_' + stamp + '_prepatchall.html';
const br = await sp("/_api/web/GetFolderByServerRelativePath(DecodedUrl=@f)/Files/AddUsingPath(DecodedUrl=@n,overwrite=@o)?@f='" +
  enc(BACKUP_DIR) + "'&@n='" + enc(backupName) + "'&@o=false", origBuf, 'application/octet-stream');
if (!br.ok){
  const t = await br.text();
  if (/already exists|-2130575257/i.test(t)) console.log('backup ' + backupName + ' already exists from an earlier run - keeping it');
  else throw new Error('backup upload failed: ' + br.status + ' ' + t.slice(0,200) + ' - master NOT touched.');
} else {
  const vr = await fetch(BACKUP_DIR + '/' + backupName, { headers:{ Accept:'text/html' } });
  const vb = await vr.arrayBuffer();
  if (vb.byteLength !== origBuf.byteLength) throw new Error('backup size mismatch - master NOT touched.');
  console.log('backup verified: _backups/' + backupName);
}

/* upload patched master */
const outBuf = new TextEncoder().encode(text);
const ur = await sp("/_api/web/GetFolderByServerRelativePath(DecodedUrl=@f)/Files/AddUsingPath(DecodedUrl=@n,overwrite=@o)?@f='" +
  enc(SITE + '/SiteAssets') + "'&@n='fortivo_app.html'&@o=true", outBuf, 'application/octet-stream');
if (!ur.ok) throw new Error('master upload failed: ' + ur.status + ' ' + (await ur.text()).slice(0,200) + ' - restore from _backups/' + backupName + ' if needed.');
console.log('DONE: patched master uploaded (' + outBuf.byteLength + ' bytes).');
console.log('NEXT: run install/sp_deploy_console.js to republish the page (canary-first). The live app is unchanged until then.');
})().catch(e => console.error('PATCH ABORTED:', e.message));
`;

fs.writeFileSync(OUT, out);
console.log('generated ' + path.basename(OUT) + ' (' + out.length + ' chars; kickoff ' + kickoff.length + ', editjob ' + editjob.length + ')');
