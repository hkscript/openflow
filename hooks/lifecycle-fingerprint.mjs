#!/usr/bin/env node
/**
 * Canonical, dependency-free lifecycle fingerprint and receipt primitives.
 * Task 2 of the phase lifecycle plan.
 *
 * Exports:
 *   FINGERPRINT_VERSION = 1
 *   collectWorktreeFingerprint(cwd, changeName)
 *   readVerifyReceipt(cwd, changeName)
 *   validateVerifyReceipt(cwd, changeName)
 *
 * Zero dependencies (Node 20+ stdlib); every subprocess is execFileSync.
 *
 * Fingerprint preimage framing (version 1), NUL-framed Buffer records:
 *   OF-FP\0<version>\0
 *   HEAD\0<40-byte-hex>\0
 *   TRACKED\0<relative-path-utf8>\0<git-diff-binary-bytes>\0
 *   STAGED\0<relative-path-utf8>\0<git-cached-diff-binary-bytes>\0
 *   UNTRACKED\0<relative-path-utf8>\0<kind>\0<sha256-or-link-target>\0
 *   ERROR\0<operation>\0<relative-path-utf8>\0<error-code>\0
 *
 * Records are sorted by bytewise UTF-8 relative path, then record tag. The
 * ERROR record only surfaces failed collection as { ok: false, blocker };
 * a successful fingerprint never contains an ERROR record.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

export const FINGERPRINT_VERSION = 1;

// The only four exact self-pollution paths excluded from the fingerprint
// (Global Constraints): .openflow/phase, .openflow/building, and the active
// change's exact verify-issues.md / verify-result.json. Never .openflow/** broadly.
function selfPollutionPaths(cwd, changeName) {
  return new Set([
    path.join(cwd, '.openflow', 'phase'),
    path.join(cwd, '.openflow', 'building'),
    path.join(cwd, 'openspec', 'changes', changeName, 'verify-issues.md'),
    path.join(cwd, 'openspec', 'changes', changeName, 'verify-result.json'),
  ]);
}

function errMsg(e) {
  if (!e) return String(e);
  if (e.stderr) return String(e.stderr).trim();
  if (e.message) return String(e.message);
  return String(e);
}

// Fixed cap so legitimately large diffs/name lists are hashable. Oversized
// git output (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) still makes execFileSync
// throw, and the surrounding per-operation try/catch turns it into a blocker —
// fail closed, never a partial fingerprint.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function gitText(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: GIT_MAX_BUFFER });
}

function gitBuf(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', maxBuffer: GIT_MAX_BUFFER });
}

// Git -z output is raw bytes. Filename decoding assumes UTF-8: the record
// framing declares <relative-path-utf8>, so a non-UTF-8 path byte is decoded
// lossily rather than rejected. This is a documented assumption of the
// canonical preimage, not a silent correctness guarantee for exotic paths.
function listGitPaths(cwd, args) {
  const out = gitText(cwd, args);
  return out.split('\0').filter((s) => s.length > 0);
}

// Deterministic diff flags: no color, no external/textconv drivers, no rename
// detection (a rename must surface as delete+add, not be swallowed), binary
// byte preservation, and full blob ids.
const DIFF_FLAGS = [
  '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
  '--binary', '--full-index',
];

// Build one serialized NUL-framed record Buffer. HEAD carries no path field.
function mkRecord(tag, relPath, value) {
  const tagBuf = Buffer.from(tag, 'utf8');
  const pathBuf = Buffer.isBuffer(relPath) ? relPath : Buffer.from(relPath, 'utf8');
  let buf;
  if (tag === 'HEAD') {
    buf = Buffer.concat([tagBuf, Buffer.from('\0'), value, Buffer.from('\0')]);
  } else {
    buf = Buffer.concat([
      tagBuf, Buffer.from('\0'), pathBuf, Buffer.from('\0'), value, Buffer.from('\0'),
    ]);
  }
  return { tag: tagBuf, path: pathBuf, buf };
}

/**
 * Collect the deterministic worktree fingerprint.
 * @returns {{ok:true,value:string,records:Buffer[],head:string}|{ok:false,blocker:string}}
 */
export function collectWorktreeFingerprint(cwd, changeName) {
  const excluded = selfPollutionPaths(cwd, changeName);
  const records = [];

  // HEAD — empty path so it sorts first among records.
  let head;
  try {
    head = gitText(cwd, ['rev-parse', 'HEAD']).trim();
  } catch (e) {
    return { ok: false, blocker: `fingerprint-git-head-failed: ${errMsg(e)}` };
  }
  records.push(mkRecord('HEAD', Buffer.alloc(0), Buffer.from(head, 'utf8')));

  // Unstaged tracked changes (worktree vs index).
  let unstagedPaths;
  try {
    unstagedPaths = listGitPaths(cwd, ['diff', '--name-only', '-z', '--no-renames']);
  } catch (e) {
    return { ok: false, blocker: `fingerprint-git-diff-failed: ${errMsg(e)}` };
  }
  for (const p of unstagedPaths) {
    if (excluded.has(path.resolve(cwd, p))) continue;
    let diff;
    try {
      diff = gitBuf(cwd, ['diff', ...DIFF_FLAGS, '--', p]);
    } catch (e) {
      return { ok: false, blocker: `fingerprint-git-diff-failed: ${p}: ${errMsg(e)}` };
    }
    records.push(mkRecord('TRACKED', p, diff));
  }

  // Staged changes (index vs HEAD).
  let stagedPaths;
  try {
    stagedPaths = listGitPaths(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames']);
  } catch (e) {
    return { ok: false, blocker: `fingerprint-git-cached-failed: ${errMsg(e)}` };
  }
  for (const p of stagedPaths) {
    if (excluded.has(path.resolve(cwd, p))) continue;
    let diff;
    try {
      diff = gitBuf(cwd, ['diff', '--cached', ...DIFF_FLAGS, '--', p]);
    } catch (e) {
      return { ok: false, blocker: `fingerprint-git-cached-failed: ${p}: ${errMsg(e)}` };
    }
    records.push(mkRecord('STAGED', p, diff));
  }

  // Untracked files (respecting .gitignore); fail closed on read errors.
  let untracked;
  try {
    untracked = listGitPaths(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  } catch (e) {
    return { ok: false, blocker: `fingerprint-git-ls-files-failed: ${errMsg(e)}` };
  }
  for (const p of untracked) {
    const abs = path.resolve(cwd, p);
    if (excluded.has(abs)) continue;
    let st;
    try {
      st = lstatSync(abs);
    } catch (e) {
      return { ok: false, blocker: `fingerprint-read-failed: ${p}: ${errMsg(e)}` };
    }
    let kind;
    let value;
    if (st.isSymbolicLink()) {
      try {
        value = readlinkSync(abs);
      } catch (e) {
        return { ok: false, blocker: `fingerprint-read-failed: ${p}: ${errMsg(e)}` };
      }
      kind = 'symlink';
    } else if (st.isFile()) {
      let content;
      try {
        content = readFileSync(abs);
      } catch (e) {
        return { ok: false, blocker: `fingerprint-read-failed: ${p}: ${errMsg(e)}` };
      }
      value = createHash('sha256').update(content).digest('hex');
      kind = 'file';
    } else {
      // FIFO / socket / unexpected kind reported by git — cannot hash
      // deterministically, so fail closed.
      return { ok: false, blocker: `fingerprint-unsupported-kind: ${p}` };
    }
    records.push(mkRecord('UNTRACKED', p, Buffer.from(`${kind}\0${value}`, 'utf8')));
  }

  // Sort by bytewise UTF-8 relative path, then record tag.
  records.sort((a, b) => {
    const pc = Buffer.compare(a.path, b.path);
    if (pc !== 0) return pc;
    return Buffer.compare(a.tag, b.tag);
  });

  const header = Buffer.from(`OF-FP\0${FINGERPRINT_VERSION}\0`, 'utf8');
  const parts = [header, ...records.map((r) => r.buf)];
  const preimage = Buffer.concat(parts);
  const hex = createHash('sha256').update(preimage).digest('hex');
  return { ok: true, value: `sha256:${hex}`, records: parts, head };
}

/**
 * Read the active change's verify-result.json without throwing.
 * @returns {{ok:true,receipt:object}|{ok:false,blocker:string}}
 */
export function readVerifyReceipt(cwd, changeName) {
  const receiptPath = path.join(cwd, 'openspec', 'changes', changeName, 'verify-result.json');
  let raw;
  try {
    raw = readFileSync(receiptPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, blocker: 'receipt-not-found' };
    return { ok: false, blocker: `receipt-read-failed: ${errMsg(e)}` };
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    return { ok: false, blocker: 'receipt-invalid-json' };
  }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, blocker: 'receipt-invalid-json' };
  }
  return { ok: true, receipt };
}

/**
 * Validate receipt shape, identity, and HEAD/fingerprint freshness.
 * Never throws on absent/malformed JSON or Git failures.
 * @returns {{pass:boolean,blockers:string[],receipt?:object}}
 */
export function validateVerifyReceipt(cwd, changeName) {
  const blockers = [];
  const read = readVerifyReceipt(cwd, changeName);
  if (!read.ok) {
    blockers.push(read.blocker);
  } else {
    const receipt = read.receipt;

    // Identity: the receipt JSON must agree with the exact change argument.
    if (receipt.change !== changeName) {
      blockers.push('receipt-change-mismatch');
    }

    // Shape: version, HEAD format, fingerprint, test runs, coverage, design.
    if (receipt.version !== FINGERPRINT_VERSION) {
      blockers.push(`receipt-invalid-version: expected ${FINGERPRINT_VERSION}`);
    }
    if (typeof receipt.head !== 'string' || !/^[0-9a-f]{40}$/.test(receipt.head)) {
      blockers.push('receipt-invalid-head');
    }
    if (
      typeof receipt.fingerprint !== 'string'
      || !receipt.fingerprint.startsWith('sha256:')
      || receipt.fingerprint.length <= 'sha256:'.length
    ) {
      blockers.push('receipt-invalid-fingerprint');
    }
    if (
      !Array.isArray(receipt.testRuns)
      || receipt.testRuns.length === 0
      || !receipt.testRuns.some((tr) => tr && tr.exitCode === 0)
    ) {
      blockers.push('receipt-no-successful-test-runs');
    }
    const cov = receipt.scenarioCoverage;
    if (
      !cov || typeof cov !== 'object'
      || !(Number(cov.mapped) === Number(cov.total) && Number(cov.mapped) > 0)
    ) {
      blockers.push('receipt-invalid-scenario-coverage');
    }
    const design = receipt.designConsistency;
    if (
      !design || typeof design !== 'object'
      || !Array.isArray(design.blockers)
      || design.blockers.length !== 0
    ) {
      blockers.push('receipt-design-blockers-present');
    }
    if (!receipt.userConfirmation || receipt.userConfirmation.received !== true) {
      blockers.push('receipt-user-confirmation-missing');
    }

    // Freshness: compare current HEAD + fingerprint; fail closed on Git errors.
    const fp = collectWorktreeFingerprint(cwd, changeName);
    if (!fp.ok) {
      blockers.push(`fingerprint-collect-failed: ${fp.blocker}`);
    } else {
      if (receipt.head !== fp.head) blockers.push('receipt-stale-head');
      if (receipt.fingerprint !== fp.value) blockers.push('receipt-stale-fingerprint');
    }
  }

  const result = { pass: blockers.length === 0, blockers };
  if (read.ok) result.receipt = read.receipt;
  return result;
}
