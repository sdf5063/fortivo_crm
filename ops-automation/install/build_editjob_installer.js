#!/usr/bin/env node
// Regenerates fv_install_editjob_console.js from the Edit Job snippet.
// Run after any change to job-rename/fv_job_rename.snippet.html:
//   node install/build_editjob_installer.js
// The emitted file is a ONE-PASTE browser-console installer: it embeds the
// snippet JSON-encoded (backticks/${} safe) and inserts it into the Site
// Assets master before </body> with the same backup/verify/abort discipline
// as fv_patch_jobname_console.js.
'use strict';
const fs = require('fs');
const path = require('path');

const SNIPPET_PATH = path.join(__dirname, '..', 'job-rename', 'fv_job_rename.snippet.html');
const OUT_PATH = path.join(__dirname, 'fv_install_editjob_console.js');
const TOKEN = 'FORTIVO EDIT JOB';
const END = '<!-- ====== FORTIVO EDIT JOB -- END ====== -->';

const snippet = fs.readFileSync(SNIPPET_PATH, 'utf8');
if (!snippet.includes(TOKEN)) throw new Error('snippet lost its token');
if (!snippet.includes(END)) throw new Error('snippet lost its END marker');
const inner = snippet.slice(snippet.indexOf('<script>') + 8, snippet.lastIndexOf('</' + 'script>'));
if (inner.toLowerCase().includes('</' + 'script')) throw new Error('snippet JS contains a literal closing script tag');

const out = `/* ═══════════════════════════════════════════════════════════════════════════
   FORTIVO INSTALLER — ✏️ Edit Job block into the Job Manager master
   GENERATED FILE — do not edit by hand. Regenerate with:
     node install/build_editjob_installer.js
   ───────────────────────────────────────────────────────────────────────────
   Run in an authenticated browser console on:
     https://fortivopropertyservices.sharepoint.com/sites/FortivoOperations
   Then republish the page with install/sp_deploy_console.js (canary-first).

   Inserts the Edit Job block (rename/renumber jobs, numbering-convention
   checks, in-place folder rename) into the Site Assets master
   fortivo_app.html, directly before </body>. Aborts at the FIRST failure
   with nothing changed; already-installed masters are detected and skipped.
   A dated, size-verified backup lands in _backups before the master is
   replaced. The served page does NOT change until sp_deploy_console.js runs.
   ═══════════════════════════════════════════════════════════════════════ */
(async function fvInstallEditJob(){
'use strict';
const SITE = '/sites/FortivoOperations';
const MASTER = SITE + '/SiteAssets/fortivo_app.html';
const BACKUP_DIR = SITE + '/SiteAssets/_backups';
const TOKEN = ${JSON.stringify(TOKEN)};
const END = ${JSON.stringify(END)};
const SNIPPET = ${JSON.stringify(snippet.trim())};
const stamp = new Date().toISOString().slice(0,10).replace(/-/g,'');

const enc = (s) => encodeURIComponent(String(s).replace(/'/g, "''"));
async function digest(){
  const r = await fetch(SITE + '/_api/contextinfo', { method:'POST', headers:{ Accept:'application/json;odata=nometadata' } });
  if (!r.ok) throw new Error('contextinfo ' + r.status);
  return (await r.json()).FormDigestValue;
}
async function sp(url, body){
  return fetch(SITE + url, { method:'POST', headers:{
    Accept:'application/json;odata=verbose', 'X-RequestDigest': await digest()
  }, body });
}

/* 1 ── download master as bytes */
const mr = await fetch(MASTER, { headers:{ Accept:'text/html' } });
if (!mr.ok) throw new Error('master download failed: ' + mr.status);
const origBuf = await mr.arrayBuffer();
const text = new TextDecoder('utf-8').decode(origBuf);
console.log('1/4 master downloaded: ' + origBuf.byteLength + ' bytes');

/* 2 ── idempotency + insert before the LAST </body>, then verify in memory */
if (text.includes(TOKEN)){ console.log('Edit Job block already installed — nothing to do. Run sp_deploy_console.js if the served page is older.'); return; }
const bodyClose = text.toLowerCase().lastIndexOf('</body>');
if (bodyClose === -1) throw new Error('master has no </body> tag — NOTHING was changed.');
const next = text.slice(0, bodyClose) + '\\n' + SNIPPET + '\\n' + text.slice(bodyClose);
const tokenCount = next.split(TOKEN).length - 1;
const tokenExpected = SNIPPET.split(TOKEN).length - 1;
if (tokenCount !== tokenExpected) throw new Error('verify failed: token count ' + tokenCount + ' (expected ' + tokenExpected + ') — NOTHING was changed.');
const bodyCount = (s) => (s.toLowerCase().match(/<\\/body>/g) || []).length;
if (bodyCount(next) !== bodyCount(text) + bodyCount(SNIPPET)) throw new Error('verify failed: </body> count changed — NOTHING was changed.');
if (!/<\\/body>/i.test(next.slice(next.lastIndexOf(END)))) throw new Error('verify failed: closing body tag no longer follows the block — NOTHING was changed.');
console.log('2/4 block inserted + verified in memory');

/* 3 ── dated backup, create-only, size-verified */
const backupName = 'fortivo_app_' + stamp + '_preeditjob.html';
const br = await sp("/_api/web/GetFolderByServerRelativePath(DecodedUrl=@f)/Files/AddUsingPath(DecodedUrl=@n,overwrite=@o)?@f='" +
  enc(BACKUP_DIR) + "'&@n='" + enc(backupName) + "'&@o=false", origBuf);
if (!br.ok){
  const t = await br.text();
  if (/already exists|-2130575257/i.test(t)) console.log('3/4 backup ' + backupName + ' already exists from an earlier run — keeping it');
  else throw new Error('backup upload failed: ' + br.status + ' ' + t.slice(0,200) + ' — master NOT touched.');
} else {
  const vr = await fetch(BACKUP_DIR + '/' + backupName, { headers:{ Accept:'text/html' } });
  const vb = await vr.arrayBuffer();
  if (vb.byteLength !== origBuf.byteLength) throw new Error('backup size mismatch — master NOT touched.');
  console.log('3/4 backup verified: _backups/' + backupName);
}

/* 4 ── upload patched master (overwrite is safe: backup verified above) */
const outBuf = new TextEncoder().encode(next);
const ur = await sp("/_api/web/GetFolderByServerRelativePath(DecodedUrl=@f)/Files/AddUsingPath(DecodedUrl=@n,overwrite=@o)?@f='" +
  enc(SITE + '/SiteAssets') + "'&@n='fortivo_app.html'&@o=true", outBuf);
if (!ur.ok) throw new Error('master upload failed: ' + ur.status + ' ' + (await ur.text()).slice(0,200) + ' — restore from _backups/' + backupName + ' if needed.');
console.log('4/4 patched master uploaded (' + outBuf.byteLength + ' bytes).');
console.log('NEXT: run install/sp_deploy_console.js to republish the page (canary-first). The live app is unchanged until then.');
})().catch(e => console.error('INSTALL ABORTED:', e.message));
`;

fs.writeFileSync(OUT_PATH, out);
console.log('generated ' + path.basename(OUT_PATH) + ' (' + out.length + ' chars, snippet ' + snippet.length + ' chars)');
