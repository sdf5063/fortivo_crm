#!/usr/bin/env node
// Fortivo Ops Automation — deterministic snippet installer.
// Inserts a *.snippet.html block into an app master (before </body>), with a
// timestamped backup, idempotency (marker detection), and post-write
// verification. Designed to be run by the deploying agent — no hand edits.
//
//   node insert_snippets.js --target <master.html> --snippet <block.snippet.html>
//                           [--relay-key <value>] [--update] [--dry-run]
//
//   --relay-key   replaces RELAY_KEY: 'SET-ME' in the block (Invoice Desk only)
//   --update      if the block is already installed, replace it in place
//   --dry-run     report what would happen; write nothing
//
// Exit codes: 0 ok/installed · 2 already installed (no --update) · 1 error
'use strict';
const fs = require('fs');
const path = require('path');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : (process.argv[i + 1] || true);
}
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

const targetPath = arg('target');
const snippetPath = arg('snippet');
const relayKey = arg('relay-key');
const update = process.argv.includes('--update');
const dryRun = process.argv.includes('--dry-run');

if (!targetPath || !snippetPath || targetPath === true || snippetPath === true) {
  fail('usage: node insert_snippets.js --target <master.html> --snippet <block.snippet.html> [--relay-key K] [--update] [--dry-run]');
}
if (!fs.existsSync(targetPath)) fail('target not found: ' + targetPath);
if (!fs.existsSync(snippetPath)) fail('snippet not found: ' + snippetPath);

let snippet = fs.readFileSync(snippetPath, 'utf8');
let target = fs.readFileSync(targetPath, 'utf8');

// Identify the block by its title token (present in both BEGIN comment and nowhere else)
const TOKENS = ['FORTIVO JOB KICKOFF', 'FORTIVO INVOICE → QUICKBOOKS DESK'];
const token = TOKENS.find((t) => snippet.includes(t));
if (!token) fail('snippet has no recognized Fortivo block token');
const endMarker = '<!-- ══════ ' + token + ' — END ══════ -->';
if (!snippet.includes(endMarker)) fail('snippet is missing its END marker (' + endMarker + ') — refusing to install a truncated block');

// Optional relay key injection (Invoice Desk)
if (relayKey && relayKey !== true) {
  if (!snippet.includes("RELAY_KEY: 'SET-ME'")) {
    console.log("• note: snippet has no RELAY_KEY: 'SET-ME' placeholder — --relay-key ignored");
  } else {
    snippet = snippet.replace("RELAY_KEY: 'SET-ME'", "RELAY_KEY: '" + relayKey.replace(/'/g, '') + "'");
    console.log('• RELAY_KEY injected');
  }
}
if (snippet.includes("RELAY_KEY: 'SET-ME'")) {
  console.log('⚠ RELAY_KEY is still SET-ME — QuickBooks sync (step 2) will be disabled until configured');
}

// Safety: a literal closing script tag inside the JS would truncate the block
const inner = snippet.slice(snippet.indexOf('<script>') + 8, snippet.lastIndexOf('</' + 'script>'));
if (inner.toLowerCase().includes('</' + 'script')) fail('snippet JS contains a literal closing script tag — aborting');

const already = target.includes(token);
if (already && !update) {
  console.log('= block "' + token + '" already installed in ' + path.basename(targetPath) + ' (use --update to replace)');
  process.exit(2);
}

let next;
if (already) {
  // Replace in place: from the <!-- that opens the BEGIN comment to the END marker
  const tIdx = target.indexOf(token);
  const begin = target.lastIndexOf('<!--', tIdx);
  const end = target.indexOf(endMarker, tIdx);
  if (begin === -1 || end === -1) fail('found the token but not clean BEGIN/END boundaries — refusing to guess; remove the old block manually');
  next = target.slice(0, begin) + snippet.trim() + target.slice(end + endMarker.length);
  console.log('• replacing existing block in place');
} else {
  const bodyClose = target.toLowerCase().lastIndexOf('</body>');
  if (bodyClose === -1) fail('target has no </body> tag');
  next = target.slice(0, bodyClose) + '\n' + snippet.trim() + '\n' + target.slice(bodyClose);
  console.log('• inserting block before </body>');
}

// Verify BEFORE writing anything
const count = next.split(token).length - 1;
const snippetTokens = snippet.split(token).length - 1;
// exactly one installed block: all token occurrences must come from the snippet
if (count !== snippetTokens) fail('post-insert verification failed: token count ' + count + ' (expected ' + snippetTokens + ' — is an old copy of the block still present?)');
// the snippet's own comments may mention </body>; the real closing tag must survive unchanged
const bodyCount = (s) => (s.toLowerCase().match(/<\/body>/g) || []).length;
const expectedBody = (already ? bodyCount(target) - 0 : bodyCount(target)) + bodyCount(snippet) - (already ? bodyCount(snippet) : 0);
if (bodyCount(next) !== expectedBody) fail('post-insert verification failed: </body> count ' + bodyCount(next) + ' (expected ' + expectedBody + ')');
if (!/<\/body>/i.test(next.slice(next.lastIndexOf(endMarker)))) fail('post-insert verification failed: closing body tag no longer follows the block');

if (dryRun) {
  console.log('DRY RUN — verified insert of "' + token + '" into ' + path.basename(targetPath) + ' (' + next.length + ' bytes); nothing written.');
  process.exit(0);
}

// Timestamped backup next to the master, then atomic-ish write
const backupDir = path.join(path.dirname(targetPath), '_backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const backupPath = path.join(backupDir, path.basename(targetPath, '.html') + '_' + stamp + '_preinstall.html');
fs.copyFileSync(targetPath, backupPath);
fs.writeFileSync(targetPath, next);

// Re-read and confirm
const check = fs.readFileSync(targetPath, 'utf8');
if (!check.includes(endMarker)) fail('post-write verification failed — restore from ' + backupPath);
console.log('✓ "' + token + '" installed into ' + path.basename(targetPath));
console.log('  backup: ' + backupPath);
console.log('  next: sync to OneDrive/Site Assets, then deploy with sp_deploy_console.js (canary-first)');
