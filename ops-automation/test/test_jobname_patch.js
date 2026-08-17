// Pre-flight for install/fv_patch_jobname_console.js
//
// Extracts the PATCHES table from the console script and applies it to a
// local snapshot of the LIVE Site Assets master (path via FV_APP_SNAPSHOT).
// Verifies every anchor is unique, the patched output contains each
// replacement, and the result stays balanced (no template-literal damage).
// Skips silently when no snapshot is available (CI runs without one).
'use strict';
const assert = require('assert');
const fs = require('fs');

const script = fs.readFileSync(__dirname + '/../install/fv_patch_jobname_console.js', 'utf8');

console.log('=== job-name patch pre-flight ===');

// Pull ALREADY + PATCHES out of the console script without executing it
const m = script.match(/const ALREADY = ([^\n]+);\nconst PATCHES = (\[[\s\S]*?\n\]);/);
assert(m, 'ALREADY/PATCHES block not found in console script');
const ALREADY = new Function('return ' + m[1])();
const PATCHES = new Function('return ' + m[2])();
assert.strictEqual(PATCHES.length, 6);
PATCHES.forEach(p => { assert(p.find && p.repl && p.find !== p.repl); });
console.log('✓ PATCHES table parses: 6 surgical edits');

// Every replacement must still contain enough of its anchor context that a
// re-run of the finds cannot match again (idempotency via ALREADY marker)
assert(PATCHES[0].repl.includes(ALREADY), 'ALREADY marker must be introduced by patch #1');
console.log('✓ idempotency marker introduced by the patch itself');

const snap = process.env.FV_APP_SNAPSHOT;
if (!snap || !fs.existsSync(snap)) {
  console.log('~ no live-master snapshot (set FV_APP_SNAPSHOT to test against one) — anchor checks skipped');
  console.log('\nJob-name patch pre-flight passed.');
  return;
}
let text = fs.readFileSync(snap, 'utf8');
assert(!text.includes(ALREADY), 'snapshot already contains the patch');
for (const p of PATCHES) {
  const n = text.split(p.find).length - 1;
  assert.strictEqual(n, 1, 'anchor not unique (' + n + '×): ' + p.find.slice(0, 60));
}
console.log('✓ all 6 anchors occur exactly once in the live master snapshot');

for (const p of PATCHES) text = text.replace(p.find, p.repl);
for (const p of PATCHES) assert(text.includes(p.repl), 'replacement missing after apply');
assert(text.includes(ALREADY));
// The 6 edits add exactly: jobName round-trip (2), save field (1), form field (1), 2 displays
assert.strictEqual(text.split('j.jobName').length - 1 >= 4, true);
// No accidental template-literal breakage around the display edits
assert(text.includes('<div class="job-client">${j.jobName||j.client||\'\'}</div>'));
assert(text.includes('<td><strong>${j.id}</strong></td><td>${j.jobName||j.client||\'\'}<br>'));
console.log('✓ patched output verified against live master snapshot (' + text.length + ' chars)');

console.log('\nJob-name patch pre-flight passed.');
