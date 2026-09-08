// Anchored patches — number-minting hardening for fortivo_app.html.
// Root cause of the Weinstein incident (folders 2 numbers behind, 2026-09-07):
//   1. The SP max-scan splits on '-' and requires exactly 3 parts, so any row
//      whose number carries a suffix ("26-01-00060 (Kodiak-Mit)") or is
//      malformed is INVISIBLE to minting → the next job reuses/lags numbers.
//   2. The local scan only counted unsynced jobs, so a device whose synced
//      rows were newer than SP's view could still mint behind its own data.
//   3. No verify-before-use: a computed number was trusted blindly.
//   4. syncLocalToSP linked a local job to ANY SP row with the same number —
//      even another client's job.
// Shared by the console patcher generator and the pre-flight test.
'use strict';

const MINT_MARKER = 'Verify the number is truly free in SP';

const MINT_PATCHES = [
  { // SP max-scan: prefix regex counts suffixed rows; malformed rows ignored
    find: "        spNums.forEach(sp => {\n          const num = sp.Job_Number || sp.Title || '';\n          const parts = num.split('-');\n          if (parts.length === 3 && parts[0] === yy) { const seq = parseInt(parts[2], 10); if (seq > maxSeq) maxSeq = seq; }\n        });",
    repl: "        spNums.forEach(sp => {\n          // Prefix match so suffixed numbers (\"26-01-00060 (Kodiak-Mit)\") still\n          // count toward the max — they used to be invisible to this scan.\n          const num = String(sp.Job_Number || sp.Title || '').trim();\n          const m = /^(\\d{2})-(\\d{2})-(\\d{5})(?!\\d)/.exec(num);\n          if (m && m[1] === yy) { const seq = parseInt(m[3], 10); if (seq > maxSeq) maxSeq = seq; }\n        });"
  },
  { // Local scan: count EVERY local job (synced or not), strict format
    find: "        localJobs.forEach(function(j) {\n          if (!j._spId && j.id) {\n            var pts = (j.id||'').split('-');\n            if (pts.length === 3 && pts[0] === yy) { var sq = parseInt(pts[2], 10); if (sq > maxSeq) maxSeq = sq; }\n          }\n        });",
    repl: "        localJobs.forEach(function(j) {\n          // Count EVERY local job (synced or not): this device's sequence must\n          // never fall behind its own data even when SP rows are stale.\n          var lm = /^(\\d{2})-(\\d{2})-(\\d{5})$/.exec(String(j.id || '').trim());\n          if (lm && lm[1] === yy) { var sq = parseInt(lm[3], 10); if (sq > maxSeq) maxSeq = sq; }\n        });"
  },
  { // Mint + availability verify: never trust the computed max
    find: "    const nextSeq = String(maxSeq + 1).padStart(5, '0');\n    jobNumber = yy + '-' + pp + '-' + nextSeq;",
    repl: "    let seqTry = maxSeq + 1;\n    jobNumber = yy + '-' + pp + '-' + String(seqTry).padStart(5, '0');\n    // Verify the number is truly free in SP before using it: another device\n    // may have minted since, and startswith() also catches suffixed variants\n    // the scans can't see. Bump until free.\n    if (onSP()) {\n      for (let numGuard = 0; numGuard < 10; numGuard++) {\n        let clash = [];\n        try {\n          clash = await spGet('Jobs_Master', \"$filter=startswith(Job_Number,'\" + jobNumber + \"') or startswith(Title,'\" + jobNumber + \"')&$top=1&$select=Id\");\n        } catch(e) { break; }\n        if (!clash.length) break;\n        seqTry++;\n        jobNumber = yy + '-' + pp + '-' + String(seqTry).padStart(5, '0');\n      }\n    }"
  },
  { // syncLocalToSP: never link a local job to another client's SP row
    find: "      var existing = await spGet('Jobs_Master', \"$filter=Job_Number eq '\" + j.id + \"' or Title eq '\" + j.id + \"'&$top=1&$select=Id,Job_Number,Title\");\n      if (existing.length > 0) {\n        // Job already in SP (created from another device) &mdash; link to it, do NOT overwrite\n        j._spId = existing[0].Id;\n        linked++;",
    repl: "      var existing = await spGet('Jobs_Master', \"$filter=Job_Number eq '\" + j.id + \"' or Title eq '\" + j.id + \"'&$top=1&$select=Id,Job_Number,Title,Client_Name\");\n      if (existing.length > 0) {\n        var spClient = String(existing[0].Client_Name || '').trim().toLowerCase();\n        var myClient = String(j.clientName || j.client || '').trim().toLowerCase();\n        if (spClient && myClient && spClient !== myClient) {\n          // Number already used by a DIFFERENT client's job: never link, never\n          // overwrite. Leave unsynced and flag loudly for renumbering.\n          j._numberConflict = true;\n          console.warn('syncLocalToSP: NUMBER CONFLICT for ' + j.id + ' - used in SP by ' + (existing[0].Client_Name || 'another client') + '. Renumber this job.');\n          toast('Job ' + j.id + ': number already used by ' + (existing[0].Client_Name || 'another client') + ' in SharePoint - renumber this job', 'error');\n          continue;\n        }\n        // Same job created from another device &mdash; link to it, do NOT overwrite\n        j._spId = existing[0].Id;\n        linked++;"
  }
];

module.exports = { MINT_PATCHES, MINT_MARKER };
