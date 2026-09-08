// Pre-flight for install/fv_patch_all_console.js (consolidated patcher).
//
// Regenerates the patcher, extracts its embedded tables/snippets, and applies
// every stage to a snapshot of the LIVE master (FV_APP_SNAPSHOT env) using the
// same logic as the console script. Then:
//   - verifies markers, token counts, and document structure
//   - node-parses EVERY <script> block of the patched master (a syntax error
//     in a replacement would brick the whole Job Manager)
//   - verifies idempotency (all stages skip on a second pass)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
console.log('=== consolidated patcher pre-flight ===');

execFileSync('node', [path.join(ROOT, 'install', 'build_all_patcher.js')]);
const gen = fs.readFileSync(path.join(ROOT, 'install', 'fv_patch_all_console.js'), 'utf8');
console.log('✓ patcher regenerates cleanly');

function grab(name){
  const m = gen.match(new RegExp('const ' + name + ' = ([\\s\\S]*?);\\n(?=const |\\n)'));
  assert(m, name + ' not found in generated patcher');
  return new Function('return ' + m[1])();
}
const JOBNAME_ALREADY = grab('JOBNAME_ALREADY');
const JOBNAME_PATCHES = grab('JOBNAME_PATCHES');
const MINT_MARKER = grab('MINT_MARKER');
const MINT_PATCHES = grab('MINT_PATCHES');
const KICKOFF_TOKEN = grab('KICKOFF_TOKEN');
const KICKOFF_MARKER = grab('KICKOFF_MARKER');
const KICKOFF_SNIPPET = grab('KICKOFF_SNIPPET');
const EDITJOB_TOKEN = grab('EDITJOB_TOKEN');
const EDITJOB_SNIPPET = grab('EDITJOB_SNIPPET');
assert.strictEqual(JOBNAME_PATCHES.length, 6);
assert.strictEqual(MINT_PATCHES.length, 4);
assert.strictEqual(KICKOFF_SNIPPET,
  fs.readFileSync(path.join(ROOT, 'job-kickoff', 'fv_job_kickoff.snippet.html'), 'utf8').trim(),
  'embedded kickoff snippet is stale — rerun build_all_patcher.js');
assert.strictEqual(EDITJOB_SNIPPET,
  fs.readFileSync(path.join(ROOT, 'job-rename', 'fv_job_rename.snippet.html'), 'utf8').trim(),
  'embedded editjob snippet is stale — rerun build_all_patcher.js');
console.log('✓ embedded tables + snippets extracted and byte-identical to sources');

const snap = process.env.FV_APP_SNAPSHOT;
if (!snap || !fs.existsSync(snap)) {
  console.log('~ no live-master snapshot (set FV_APP_SNAPSHOT) — stage simulation skipped');
  console.log('\nConsolidated patcher pre-flight passed.');
  return;
}
let text = fs.readFileSync(snap, 'utf8');
const orig = text;

function applyAnchored(t, patches, label){
  for (const p of patches){
    const n = t.split(p.find).length - 1;
    assert.strictEqual(n, 1, label + ' anchor not unique (' + n + '×): ' + p.find.slice(0, 70));
  }
  for (const p of patches) t = t.replace(p.find, p.repl);
  return t;
}

// stage: JOBNAME
assert(!text.includes(JOBNAME_ALREADY));
text = applyAnchored(text, JOBNAME_PATCHES, 'JOBNAME');
// stage: MINT
assert(!text.includes(MINT_MARKER));
text = applyAnchored(text, MINT_PATCHES, 'MINT');
// stage: KICKOFF replace
assert(!text.includes(KICKOFF_MARKER));
const i1 = text.indexOf(KICKOFF_TOKEN);
const i2 = text.indexOf(KICKOFF_TOKEN, i1 + KICKOFF_TOKEN.length);
assert(i1 !== -1 && i2 !== -1, 'kickoff token pair present in master');
assert.strictEqual(text.indexOf(KICKOFF_TOKEN, text.indexOf('-->', i2)), -1, 'exactly 2 kickoff tokens in master');
const begin = text.lastIndexOf('<!--', i1);
const end = text.indexOf('-->', i2);
assert(begin !== -1 && end !== -1);
text = text.slice(0, begin) + KICKOFF_SNIPPET + text.slice(end + 3);
assert.strictEqual(text.split(KICKOFF_TOKEN).length - 1, 2);
assert(text.includes(KICKOFF_MARKER));
// stage: EDITJOB insert
assert(!text.includes(EDITJOB_TOKEN));
const bodyClose = text.toLowerCase().lastIndexOf('</body>');
text = text.slice(0, bodyClose) + '\n' + EDITJOB_SNIPPET + '\n' + text.slice(bodyClose);
assert.strictEqual(text.split(EDITJOB_TOKEN).length - 1, EDITJOB_SNIPPET.split(EDITJOB_TOKEN).length - 1);
console.log('✓ all 4 master stages apply against the live snapshot');

// structure: still ends properly; body-tag count = original + editjob comment mentions
assert(/<\/body>\s*<\/html>\s*$/i.test(text.slice(-200)));
const bodyCount = (s) => (s.toLowerCase().match(/<\/body>/g) || []).length;
assert.strictEqual(bodyCount(text),
  bodyCount(orig) + bodyCount(EDITJOB_SNIPPET) + bodyCount(KICKOFF_SNIPPET) - bodyCount(KICKOFF_SNIPPET),
  'closing-body count accounted for');
console.log('✓ document structure intact (ends with </body></html>)');

// syntax-check every <script> block of the PATCHED master
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvapp-'));
let blocks = 0, checked = 0;
const re = /<script>([\s\S]*?)<\/script>/g;
let m2;
while ((m2 = re.exec(text)) !== null) {
  blocks++;
  const file = path.join(tmpdir, 'block' + blocks + '.js');
  fs.writeFileSync(file, m2[1]);
  const r = spawnSync('node', ['--check', file], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'script block ' + blocks + ' fails to parse after patch:\n' + r.stderr.slice(0, 500));
  checked++;
}
assert(blocks >= 2, 'expected multiple script blocks, found ' + blocks);
console.log('✓ all ' + checked + ' <script> blocks of the patched master parse cleanly');

// idempotency: every stage's skip condition now triggers
assert(text.includes(JOBNAME_ALREADY));
assert(text.includes(MINT_MARKER));
assert(text.includes(KICKOFF_MARKER));
assert(text.includes(EDITJOB_TOKEN));
for (const p of JOBNAME_PATCHES.concat(MINT_PATCHES)) {
  assert.strictEqual(text.split(p.repl).length - 1, 1, 'replacement present exactly once');
}
console.log('✓ second run would skip every stage (idempotent)');

// behavioral spot-checks on the patched code
assert(text.includes("startswith(Job_Number,'"), 'availability verify present');
assert(text.includes('_numberConflict'), 'sync conflict flag present');
assert(text.includes('localAppJob'), 'kickoff guard present');
console.log('✓ hardened minting + guard code present in output');

console.log('\nConsolidated patcher pre-flight passed.');
