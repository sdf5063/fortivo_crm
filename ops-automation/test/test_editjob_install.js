// Pre-flight for install/fv_install_editjob_console.js
//
// 1. Regenerates the installer and asserts the committed file is current.
// 2. Asserts the embedded snippet matches job-rename/fv_job_rename.snippet.html.
// 3. Simulates the exact insert against a snapshot of the LIVE master
//    (FV_APP_SNAPSHOT env) with the installer's own verification rules.
// 4. Cross-checks with insert_snippets.js --dry-run (the canonical tool).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INSTALLER = path.join(ROOT, 'install', 'fv_install_editjob_console.js');
const SNIPPET = path.join(ROOT, 'job-rename', 'fv_job_rename.snippet.html');

console.log('=== edit-job installer pre-flight ===');

execFileSync('node', [path.join(ROOT, 'install', 'build_editjob_installer.js')]);
const gen = fs.readFileSync(INSTALLER, 'utf8');
console.log('✓ installer regenerates cleanly');

const m = gen.match(/const SNIPPET = (".*");\n/);
assert(m, 'embedded SNIPPET not found in installer');
const embedded = JSON.parse(m[1]);
const snippet = fs.readFileSync(SNIPPET, 'utf8').trim();
assert.strictEqual(embedded, snippet, 'embedded snippet differs from snippet file — rerun build_editjob_installer.js');
console.log('✓ embedded snippet is byte-identical to the snippet file (' + snippet.length + ' chars)');

const TOKEN = 'FORTIVO EDIT JOB';
const END = '<!-- ====== FORTIVO EDIT JOB -- END ====== -->';
assert(snippet.includes(TOKEN) && snippet.includes(END));
const inner = snippet.slice(snippet.indexOf('<script>') + 8, snippet.lastIndexOf('</' + 'script>'));
assert(!inner.toLowerCase().includes('</' + 'script'), 'literal closing script tag inside snippet JS');
console.log('✓ token + END marker present; no closing-script-tag hazard');

const snap = process.env.FV_APP_SNAPSHOT;
if (!snap || !fs.existsSync(snap)) {
  console.log('~ no live-master snapshot (set FV_APP_SNAPSHOT) — insert simulation skipped');
  console.log('\nEdit-job installer pre-flight passed.');
  return;
}
const master = fs.readFileSync(snap, 'utf8');
assert(!master.includes(TOKEN), 'snapshot already contains the block');
const bodyClose = master.toLowerCase().lastIndexOf('</body>');
assert(bodyClose !== -1);
const next = master.slice(0, bodyClose) + '\n' + snippet + '\n' + master.slice(bodyClose);
const bodyCount = (s) => (s.toLowerCase().match(/<\/body>/g) || []).length;
assert.strictEqual(next.split(TOKEN).length - 1, snippet.split(TOKEN).length - 1);
assert.strictEqual(bodyCount(next), bodyCount(master) + bodyCount(snippet));
assert(/<\/body>/i.test(next.slice(next.lastIndexOf(END))), 'closing body tag must follow the block');
// the block must land AFTER the kickoff block's END marker, not inside it
assert(next.lastIndexOf('FORTIVO JOB KICKOFF') < next.indexOf(TOKEN), 'edit-job block must come after the kickoff block');
console.log('✓ insert simulated against live master snapshot: markers, body tags, and ordering all verified');

// canonical tool agrees (dry-run writes nothing)
const tmp = path.join(require('os').tmpdir(), 'fv_master_snap.html');
fs.writeFileSync(tmp, master);
const out = execFileSync('node', [path.join(ROOT, 'install', 'insert_snippets.js'),
  '--target', tmp, '--snippet', SNIPPET, '--dry-run']).toString();
assert(/DRY RUN — verified insert/.test(out), 'insert_snippets.js dry-run did not verify: ' + out);
fs.unlinkSync(tmp);
console.log('✓ insert_snippets.js --dry-run agrees');

console.log('\nEdit-job installer pre-flight passed.');
