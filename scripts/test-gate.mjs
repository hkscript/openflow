#!/usr/bin/env node
/**
 * Temporary-Git fixture tests for canonical fingerprint records and receipt
 * primitives — Task 2 of the phase lifecycle plan.
 *
 * Covers:
 *   [1] collectWorktreeFingerprint — deterministic vectors, change-type deltas,
 *       failure fail-closed, exact self-pollution exclusion
 *   [2] readVerifyReceipt — absent / malformed / valid receipt parsing
 *   [3] validateVerifyReceipt — shape, identity, freshness, receipt-change-mismatch
 *
 * 用法：`pnpm node scripts/test-gate.mjs`（无构建依赖，纯 Node 20+ 运行时）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Assert Node 20+ immediately.
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`需要 Node 20+，当前 ${process.versions.node}`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(__dirname, '..', 'hooks', 'lifecycle-fingerprint.mjs');
const GATE = path.resolve(__dirname, '..', 'hooks', 'gate.mjs');
const fp = await import(pathToFileURL(HELPER).href);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name} :: ${e && e.message ? e.message : e}`);
    return;
  }
  passed++;
  console.log(`  ✅ ${name}`);
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openflow-gate-'));
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// Fixed author/committer timestamps make every commit hash deterministic
// (Q2): two independently initialized baselines share the same HEAD, so
// fingerprint equality fixtures are never flaky across a second boundary.
const COMMIT_ENV = {
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00',
};

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, ...COMMIT_ENV, ...(opts.env || {}) },
    ...opts,
  });
}

const GIT_CFG = [
  ['user.email', 'test@openflow.local'],
  ['user.name', 'OpenFlow Test'],
];

function gitInit(dir) {
  git(dir, ['init', '-q']);
  for (const [k, v] of GIT_CFG) git(dir, ['config', k, v]);
}

// Baseline repo: identical content, one commit, no .gitignore (so untracked
// self-pollution files really exercise the exact-path exclusion).
function makeRepo() {
  const dir = tmpdir();
  gitInit(dir);
  write(dir, 'a.txt', 'alpha\n');
  write(dir, 'b.txt', 'bravo\n');
  write(dir, 'src/app.js', 'console.log(1);\n');
  write(dir, 'package.json', '{"name":"fixture","version":"1.0.0"}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'baseline']);
  return dir;
}

function collect(dir, change = 'add-widget') {
  const r = fp.collectWorktreeFingerprint(dir, change);
  if (!r.ok) throw new Error(`collect failed: ${r.blocker}`);
  return r;
}

console.log('\n[1] 确定性向量（collectWorktreeFingerprint）');

{
  run('baseline 指纹是 sha256:64-hex 且带 records', () => {
    const r = collect(makeRepo());
    assert.match(r.value, /^sha256:[0-9a-f]{64}$/);
    assert.ok(Array.isArray(r.records) && r.records.every((b) => Buffer.isBuffer(b)));
    assert.match(r.head, /^[0-9a-f]{40}$/);
  });

  // Q2: identical repos share a fixed author/committer timestamp, so HEAD is
  // deterministic across runs and the semantic-equality fixture is stable.
  run('两个语义相同工作树 -> 相同指纹', () => {
    const r1 = makeRepo();
    const r2 = makeRepo();
    write(r1, 'x.txt', 'same\n');
    write(r2, 'x.txt', 'same\n');
    write(r1, 'y.txt', 'yyy\n');
    write(r2, 'y.txt', 'yyy\n');
    assert.equal(collect(r1).value, collect(r2).value);
  });

  run('clone 基线与原仓库指纹一致', () => {
    const r1 = makeRepo();
    const copy = path.join(tmpdir(), 'copy');
    git(r1, ['clone', '-q', r1, copy]);
    assert.equal(collect(r1).value, collect(copy).value);
  });

  run('记录排序与文件创建顺序无关', () => {
    const r1 = makeRepo();
    const r2 = makeRepo();
    write(r1, 'z.txt', 'z\n');
    write(r1, 'a.txt', 'a\n');
    write(r2, 'a.txt', 'a\n');
    write(r2, 'z.txt', 'z\n');
    assert.equal(collect(r1).value, collect(r2).value);
  });

  run('同一工作树重复采集 -> 指纹稳定', () => {
    const dir = makeRepo();
    assert.equal(collect(dir).value, collect(dir).value);
  });
}

// Each change type must differ from the receipt baseline fingerprint.
// Q1: baseline and mutation come from the SAME repository so a swallowed
// mutation cannot hide behind a different HEAD.
function differsFromBaseline(label, mutate) {
  run(`${label} -> 指纹与基线不同（同一仓库）`, () => {
    const dir = makeRepo();
    const base = collect(dir).value;
    mutate(dir);
    assert.notEqual(collect(dir).value, base);
  });
}

differsFromBaseline('unstaged tracked 编辑', (dir) => write(dir, 'a.txt', 'alpha edited\n'));
differsFromBaseline('staged-only 编辑', (dir) => {
  write(dir, 'b.txt', 'bravo staged\n');
  git(dir, ['add', 'b.txt']);
});
differsFromBaseline('untracked 内容新增', (dir) => write(dir, 'new-untracked.txt', 'hello\n'));
differsFromBaseline('删除 tracked 文件', (dir) => fs.rmSync(path.join(dir, 'a.txt')));
differsFromBaseline('重命名 tracked 文件', (dir) => fs.renameSync(path.join(dir, 'a.txt'), path.join(dir, 'renamed.txt')));
differsFromBaseline('executable 模式变更', (dir) => fs.chmodSync(path.join(dir, 'src/app.js'), 0o755));

{
  // Q4: probe symlink capability first; skip only for genuinely unsupported
  // platforms/capabilities, never swallow assertion failures.
  run('symlink 目标变更 -> 指纹与基线不同（平台支持时）', () => {
    const dir = tmpdir();
    gitInit(dir);
    const probeTarget = path.join(dir, '__probe__');
    const probeLink = path.join(dir, '__probe_link__');
    fs.writeFileSync(probeTarget, 'x');
    try {
      fs.symlinkSync('__probe__', probeLink);
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES' || process.platform === 'win32') {
        console.log(`  ⏭️  symlink 不受支持，跳过 :: ${e.message}`);
        return;
      }
      throw e;
    }
    fs.rmSync(probeLink);
    fs.rmSync(probeTarget);

    write(dir, 'a.txt', 'alpha\n');
    write(dir, 'b.txt', 'bravo\n');
    fs.symlinkSync('a.txt', path.join(dir, 'link'));
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', 'baseline']);
    const base = collect(dir).value;
    fs.rmSync(path.join(dir, 'link'));
    fs.symlinkSync('b.txt', path.join(dir, 'link'));
    assert.notEqual(collect(dir).value, base);
  });
}

{
  // Q3: only unsupported SETUP is caught; the fingerprint-difference assertion
  // stays outside any catch so a regression fails loudly.
  run('submodule 条目变更 -> 指纹与基线不同（平台支持时）', () => {
    let main = null;
    let sub = null;
    let setupFailed = null;
    try {
      sub = tmpdir();
      gitInit(sub);
      write(sub, 's.txt', 'sub v1\n');
      git(sub, ['add', '.']);
      git(sub, ['commit', '-qm', 'sub v1']);

      main = tmpdir();
      gitInit(main);
      write(main, 'root.txt', 'root\n');
      git(main, ['add', '.']);
      git(main, ['commit', '-qm', 'base']);
      // git 2.38+ blocks the file transport for submodules unless allowed.
      git(main, ['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'sub']);
      git(main, ['commit', '-qm', 'add submodule']);
    } catch (e) {
      setupFailed = e;
    }
    if (setupFailed) {
      if (main) fs.rmSync(main, { recursive: true, force: true });
      if (sub) fs.rmSync(sub, { recursive: true, force: true });
      console.log(`  ⏭️  submodule 不受支持，跳过 :: ${setupFailed.message}`);
      return;
    }
    try {
      const base = collect(main).value;
      // advance the submodule commit inside main/sub
      write(path.join(main, 'sub'), 's.txt', 'sub v2\n');
      git(path.join(main, 'sub'), ['add', '.']);
      git(path.join(main, 'sub'), ['commit', '-qm', 'sub v2']);
      assert.notEqual(collect(main).value, base);
    } finally {
      if (main) fs.rmSync(main, { recursive: true, force: true });
      if (sub) fs.rmSync(sub, { recursive: true, force: true });
    }
  });
}

console.log('\n[2] 失败即 fail closed');

{
  run('非 git 目录 -> pass false / 非空 blocker', () => {
    const dir = tmpdir();
    const r = fp.collectWorktreeFingerprint(dir, 'add-widget');
    assert.equal(r.ok, false);
    assert.ok(typeof r.blocker === 'string' && r.blocker.length > 0, `blocker=${r.blocker}`);
  });

  run('空仓库（无提交，HEAD unborn）-> blocker', () => {
    const dir = tmpdir();
    gitInit(dir);
    write(dir, 'a.txt', 'x\n');
    git(dir, ['add', '.']);
    const r = fp.collectWorktreeFingerprint(dir, 'add-widget');
    assert.equal(r.ok, false);
    assert.ok(r.blocker.length > 0, `blocker=${r.blocker}`);
  });

  // Q4: unreadable-via-chmod only holds on POSIX and only for non-root; skip
  // for those platform/capability conditions, never for assertion failures.
  run('不可读 untracked 路径 -> blocker（fail closed）', () => {
    if (process.platform === 'win32') {
      console.log('  ⏭️  Windows 不按 chmod 限制读取，跳过');
      return;
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('  ⏭️  root 可读任意文件，跳过');
      return;
    }
    const dir = makeRepo();
    const p = write(dir, 'secret.txt', 'do not read\n');
    fs.chmodSync(p, 0o000);
    try {
      const r = fp.collectWorktreeFingerprint(dir, 'add-widget');
      assert.equal(r.ok, false);
      assert.ok(r.blocker.length > 0, `blocker=${r.blocker}`);
    } finally {
      fs.chmodSync(p, 0o600);
    }
  });
}

console.log('\n[3] 精确自污染路径排除');

{
  run('六个精确自污染路径被排除 -> 指纹不变', () => {
    const dir = makeRepo();
    const before = collect(dir).value;
    write(dir, '.openflow/phase', JSON.stringify({
      version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap',
    }));
    write(dir, '.openflow/building', 'add-widget');
    write(dir, 'openspec/changes/add-widget/verify-issues.md', '# issues\n');
    write(dir, 'openspec/changes/add-widget/verify-result.json', '{}');
    write(dir, 'openspec/changes/add-widget/lessons.md', '# 经验\n');
    write(dir, 'openspec/changes/add-widget/tasks.md', '- [x] 任务\n');
    assert.equal(collect(dir).value, before);
  });

  run('其他 .openflow 文件不豁免 -> 指纹变化', () => {
    const dir = makeRepo();
    const before = collect(dir).value;
    write(dir, '.openflow/other.txt', 'x\n');
    assert.notEqual(collect(dir).value, before);
  });

  run('写入 verify-result.json 后回读校验仍 fresh（排除生效）', () => {
    const dir = makeRepo();
    const r = collect(dir);
    const receipt = {
      version: 1,
      change: 'add-widget',
      head: r.head,
      fingerprint: r.value,
      testRuns: [{ name: 'verify', exitCode: 0 }],
      scenarioCoverage: { mapped: 3, total: 3 },
      designConsistency: { pass: true, blockers: [] },
      userConfirmation: { received: true },
    };
    write(dir, 'openspec/changes/add-widget/verify-result.json', JSON.stringify(receipt, null, 2));
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, true, JSON.stringify(v.blockers));
  });

  run('close 生成 lessons.md/tasks.md 后 receipt 仍 fresh（排除生效）', () => {
    const dir = makeRepo();
    const r = collect(dir);
    const receipt = {
      version: 1,
      change: 'add-widget',
      head: r.head,
      fingerprint: r.value,
      testRuns: [{ name: 'verify', exitCode: 0 }],
      scenarioCoverage: { mapped: 3, total: 3 },
      designConsistency: { pass: true, blockers: [] },
      userConfirmation: { received: true },
    };
    write(dir, 'openspec/changes/add-widget/verify-result.json', JSON.stringify(receipt, null, 2));
    // 模拟 close 步骤 1/2：归档前生成 lessons.md + tasks.md。
    write(dir, 'openspec/changes/add-widget/lessons.md', '# 经验\n');
    write(dir, 'openspec/changes/add-widget/tasks.md', '- [x] 任务\n');
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, true, JSON.stringify(v.blockers));
  });
}

console.log('\n[4] readVerifyReceipt 解析');

{
  run('缺文件 -> ok false / nonempty blocker', () => {
    const dir = makeRepo();
    const r = fp.readVerifyReceipt(dir, 'add-widget');
    assert.equal(r.ok, false);
    assert.ok(r.blocker.length > 0);
  });

  run('malformed JSON -> ok false / nonempty blocker', () => {
    const dir = makeRepo();
    write(dir, 'openspec/changes/add-widget/verify-result.json', '{bad json');
    const r = fp.readVerifyReceipt(dir, 'add-widget');
    assert.equal(r.ok, false);
    assert.ok(r.blocker.length > 0);
  });

  run('合法 JSON -> ok true / receipt 返回', () => {
    const dir = makeRepo();
    write(dir, 'openspec/changes/add-widget/verify-result.json', '{"version":1,"change":"add-widget"}');
    const r = fp.readVerifyReceipt(dir, 'add-widget');
    assert.equal(r.ok, true);
    assert.equal(r.receipt.change, 'add-widget');
  });
}

console.log('\n[5] validateVerifyReceipt 校验');

function receiptWorkspace() {
  const dir = makeRepo();
  const r = collect(dir);
  const receipt = {
    version: 1,
    change: 'add-widget',
    head: r.head,
    fingerprint: r.value,
    testRuns: [{ name: 'verify', exitCode: 0 }],
    scenarioCoverage: { mapped: 3, total: 3 },
    designConsistency: { pass: true, blockers: [] },
    userConfirmation: { received: true },
  };
  write(dir, 'openspec/changes/add-widget/verify-result.json', JSON.stringify(receipt, null, 2));
  return { dir, receipt };
}

function withMutatedReceipt(mutate) {
  const { dir, receipt } = receiptWorkspace();
  const clone = JSON.parse(JSON.stringify(receipt));
  mutate(clone);
  write(dir, 'openspec/changes/add-widget/verify-result.json', JSON.stringify(clone, null, 2));
  return dir;
}

function assertFails(label, mutate, blockerRe) {
  run(label, () => {
    const dir = withMutatedReceipt(mutate);
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, false);
    assert.ok(v.blockers.length > 0, 'expected nonempty blockers');
    if (blockerRe) assert.match(v.blockers.join('\n'), blockerRe);
  });
}

{
  run('有效 receipt -> pass true / blockers 空', () => {
    const { dir } = receiptWorkspace();
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, true);
    assert.deepEqual(v.blockers, []);
    assert.equal(v.receipt.change, 'add-widget');
  });

  run('缺失 receipt 文件 -> pass false 不抛异常', () => {
    const dir = makeRepo();
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, false);
    assert.ok(v.blockers.length > 0);
  });

  run('malformed receipt JSON -> pass false 不抛异常', () => {
    const dir = makeRepo();
    write(dir, 'openspec/changes/add-widget/verify-result.json', '{bad');
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, false);
    assert.ok(v.blockers.some((b) => /receipt/i.test(b)), JSON.stringify(v.blockers));
  });

  run('receipt.change 与 changeName 不一致 -> receipt-change-mismatch', () => {
    const dir = withMutatedReceipt((r) => { r.change = 'other-change'; });
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, false);
    assert.ok(v.blockers.includes('receipt-change-mismatch'), JSON.stringify(v.blockers));
  });

  assertFails('version != 1 -> pass false', (r) => { r.version = 2; });
  assertFails('head 非 40-hex -> pass false', (r) => { r.head = 'abc123'; }, /receipt-invalid-head/);
  assertFails('fingerprint 空串 -> pass false', (r) => { r.fingerprint = ''; }, /fingerprint/i);
  assertFails('fingerprint 非 sha256: 前缀 -> pass false', (r) => { r.fingerprint = 'md5:abc'; }, /fingerprint/i);
  assertFails('无 testRuns -> pass false', (r) => { r.testRuns = []; }, /test-runs/i);
  assertFails('testRuns 无 exitCode 0 -> pass false', (r) => { r.testRuns = [{ name: 'x', exitCode: 1 }]; }, /test-runs/i);
  assertFails('scenarioCoverage mapped != total -> pass false', (r) => { r.scenarioCoverage = { mapped: 2, total: 3 }; }, /scenario-coverage/i);
  assertFails('scenarioCoverage total 0 -> pass false', (r) => { r.scenarioCoverage = { mapped: 0, total: 0 }; }, /scenario-coverage/i);
  assertFails('designConsistency.blockers 非空 -> pass false', (r) => { r.designConsistency.blockers = ['issue']; }, /design/i);
  assertFails('userConfirmation.received 非 true -> pass false', (r) => { r.userConfirmation.received = false; }, /confirmation|received/i);
}

console.log('\n[6] 过期（stale）场景');

{
  run('tracked unstaged 改动后 receipt 过期 -> pass false', () => {
    const { dir } = receiptWorkspace();
    write(dir, 'a.txt', 'edited after receipt\n');
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, false);
    assert.ok(v.blockers.some((b) => /stale|fingerprint/i.test(b)), JSON.stringify(v.blockers));
  });

  run('staged 改动后 receipt 过期 -> pass false', () => {
    const { dir } = receiptWorkspace();
    write(dir, 'b.txt', 'staged after receipt\n');
    git(dir, ['add', 'b.txt']);
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, false);
    assert.ok(v.blockers.some((b) => /stale|fingerprint/i.test(b)), JSON.stringify(v.blockers));
  });

  run('untracked 新增后 receipt 过期 -> pass false', () => {
    const { dir } = receiptWorkspace();
    write(dir, 'untracked-after.txt', 'new\n');
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, false);
    assert.ok(v.blockers.some((b) => /stale|fingerprint/i.test(b)), JSON.stringify(v.blockers));
  });

  run('HEAD 移动后 receipt 过期 -> pass false', () => {
    const { dir } = receiptWorkspace();
    write(dir, 'a.txt', 'new commit\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', 'new head']);
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, false);
    assert.ok(v.blockers.some((b) => /stale|head/i.test(b)), JSON.stringify(v.blockers));
  });
}

// ============ Task 3: safe Gate receipt + verified archive ============

// Fake OpenSpec runner: an executable Node script (shebang = process.execPath)
// that logs argv to an out-of-repo log and obeys FAKE_VALIDATE_EXIT /
// FAKE_ARCHIVE_EXIT plus archive behavior toggles. The Gate runner invokes it
// via execFileSync(process.env.OPENFLOW_OPENSPEC_BIN || 'openspec', argv).
// FAKE_ARGV_LOG lives in os.tmpdir() (NOT the fixture repo) so the fake's own
// argv logging can never perturb the worktree fingerprint under test.
const FAKE_ARGV_LOG = path.join(os.tmpdir(), 'openflow-fake-argv.log');

function makeFakeOpenspec(dir) {
  const bin = path.join(dir, 'openspec-fake');
  const lines = [
    'const fs = require("fs");',
    'const path = require("path");',
    'const argv = process.argv.slice(2);',
    'if (process.env.FAKE_ARGV_LOG) fs.appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(argv) + "\\n");',
    'const mode = argv[0];',
    'const key = mode === "validate" ? "FAKE_VALIDATE_EXIT" : mode === "archive" ? "FAKE_ARCHIVE_EXIT" : "FAKE_EXIT";',
    'let code = process.env[key] !== undefined ? Number(process.env[key]) : 0;',
    'const cwd = process.cwd();',
    'const src = path.join(cwd, "openspec", "changes", argv[1] || "");',
    'if (code === 0 && mode === "archive" && process.env.FAKE_ARCHIVE_NOOP !== "1" && fs.existsSync(src)) {',
    '  const dst = path.join(cwd, "openspec", "changes", "archive", new Date().toISOString().slice(0, 10) + "-" + argv[1]);',
    '  fs.mkdirSync(dst, { recursive: true });',
    '  const missing = (process.env.FAKE_ARCHIVE_MISSING || "").split(",").filter(Boolean);',
    '  for (const f of fs.readdirSync(src)) {',
    '    if (missing.includes(f)) { fs.rmSync(path.join(src, f), { force: true }); continue; }',
    '    fs.renameSync(path.join(src, f), path.join(dst, f));',
    '  }',
    '  if (!missing.includes("tasks.md")) fs.writeFileSync(path.join(dst, "tasks.md"), "# tasks\\n");',
    '  if (!missing.includes("lessons.md")) fs.writeFileSync(path.join(dst, "lessons.md"), "# lessons\\n");',
    '  fs.rmSync(src, { recursive: true, force: true });',
    '}',
    'if (code === 0 && mode === "archive" && process.env.FAKE_ARCHIVE_MULTI === "1") {',
    '  fs.mkdirSync(path.join(cwd, "openspec", "changes", "archive", new Date().toISOString().slice(0, 10) + "-other-change"), { recursive: true });',
    '}',
    'if (code !== 0 && process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);',
    'process.exit(code);',
  ];
  fs.writeFileSync(bin, `#!${process.execPath}\n` + lines.join('\n'));
  fs.chmodSync(bin, 0o755);
  return bin;
}

// Mutable env injected into every runGate subprocess.
let gateEnv = {};

function runGate(dir, subcommand, changeName, ...extra) {
  const args = [GATE, subcommand];
  if (changeName !== undefined) args.push(changeName);
  args.push(...extra);
  const env = { ...process.env, ...gateEnv, FAKE_ARGV_LOG };
  let out;
  try {
    out = execFileSync(process.execPath, args, {
      cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env,
    });
  } catch (e) {
    out = (e.stdout ? String(e.stdout) : '') + (e.stderr ? String(e.stderr) : '');
    if (!out.trim()) throw e;
  }
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

function argvLog() {
  try {
    return fs.readFileSync(FAKE_ARGV_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function clearArgvLog() {
  fs.writeFileSync(FAKE_ARGV_LOG, '');
}
function archiveInvocations() {
  return argvLog().filter((a) => a[0] === 'archive');
}

// A change fixture that passes check-verify-prerequisites: complete
// proposal / test-plan (all PASS) / plan-ready (all [x]) / strict design,
// no building marker, no unresolved issues, fake `openspec validate` exit 0.
const PROPOSAL = [
  '## Why', '',
  'The widget dashboard needs live widget data for on-call operators.', '',
  '## What Changes', '',
  '- Add widget dashboard', '- Add widget data source', '',
  '## Impact', '', '- New widget module',
].join('\n');

const TEST_PLAN = [
  '# test-plan', '',
  '| # | 场景 | 状态 |',
  '|---|---|---|',
  '| 1 | 场景一：widget 渲染 | ✅ PASS 🔴 RED |',
  '| 2 | 场景二：widget 数据 | ✅ PASS 🔴 RED |',
].join('\n');

const PLAN_READY = [
  '# plan-ready', '',
  '- [x] 实现 widget 渲染',
  '- [x] 实现 widget 数据源', '',
  '- [Verified] 改动文件 src/app.js',
].join('\n');

const DESIGN = [
  '## 现状与影响面', '',
  '### 改动点 1：新增 widget 渲染',
  '- 目标：`src/app.js::renderWidget`', '',
  '## 改动文件', '',
  '- src/app.js',
].join('\n');

function makeGateFixture() {
  const dir = makeRepo();
  write(dir, 'openspec/changes/add-widget/proposal.md', PROPOSAL);
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY);
  write(dir, 'openspec/changes/add-widget/design.md', DESIGN);
  const fakeBin = makeFakeOpenspec(dir);
  gateEnv = { OPENFLOW_OPENSPEC_BIN: fakeBin };
  return { dir, fakeBin };
}

function writeReceipt(dir, mutate) {
  const r = fp.collectWorktreeFingerprint(dir, 'add-widget');
  if (!r.ok) throw new Error(r.blocker);
  const receipt = {
    version: 1,
    change: 'add-widget',
    head: r.head,
    fingerprint: r.value,
    testRuns: [{ name: 'verify', exitCode: 0 }],
    scenarioCoverage: { mapped: 3, total: 3 },
    designConsistency: { pass: true, blockers: [] },
    userConfirmation: { received: true },
  };
  if (mutate) mutate(receipt);
  write(dir, 'openspec/changes/add-widget/verify-result.json', JSON.stringify(receipt, null, 2));
  return receipt;
}

// Ready-to-archive fixture: valid fresh receipt + .openflow/phase marker,
// no .openflow/building (build phase already exited).
function archiveFixture() {
  const { dir } = makeGateFixture();
  writeReceipt(dir);
  write(dir, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'verify' }));
  return { dir };
}

console.log('\n[7] 安全 argv 注入拒绝（runner 边界）');

{
  const cases = ['', '../x', 'x y', 'x; touch pwned'];
  for (const bad of cases) {
    run(`拒绝非法 change 名 ${JSON.stringify(bad)} 不调用 runner`, () => {
      const { dir } = makeGateFixture();
      clearArgvLog();
      const r = runGate(dir, 'check-verify-prerequisites', bad);
      assert.equal(r.pass, false, JSON.stringify(r));
      assert.match((r.blockers || []).join('\n'), /invalid-change/i, JSON.stringify(r));
      assert.equal(argvLog().length, 0, 'runner must not be invoked for an invalid change name');
    });
  }

  // Review I1: gate.config.json 的 base_branch 是不可信数据，绝不 shell 插值。
  run('恶意 base_branch 不执行 shell（降级为无基准 diff）', () => {
    const { dir } = makeGateFixture();
    write(dir, '.openflow/gate.config.json', JSON.stringify({ base_branch: 'main; touch pwned' }));
    const marker = path.join(dir, 'pwned');
    assert.ok(!fs.existsSync(marker));
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    assert.ok(r && typeof r === 'object', JSON.stringify(r));
    assert.ok(!fs.existsSync(marker), '恶意 base_branch 不得触发 shell 命令');
    assert.equal(r.pass, true, JSON.stringify(r)); // 恶意 ref 被拒绝 -> 退回只看未提交
  });

  run('合法 base_branch 仍参与基准 diff（回归）', () => {
    const { dir } = makeGateFixture();
    write(dir, '.openflow/gate.config.json', JSON.stringify({ base_branch: 'main' }));
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r));
  });
}

console.log('\n[8] check-verify-prerequisites');

{
  run('完整 fixture -> pass true', () => {
    const { dir } = makeGateFixture();
    assert.equal(runGate(dir, 'check-verify-prerequisites', 'add-widget').pass, true);
  });

  run('缺 ## 现状与影响面 -> pass false', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/design.md', DESIGN.replace('## 现状与影响面', '## 现状'));
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /现状与影响面/);
  });

  run('缺 ## 改动文件 -> pass false（strict）', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/design.md', DESIGN.replace('## 改动文件', '## 其他'));
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /改动文件/);
  });

  run('测试未全通过 -> pass false', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN.replace('✅ PASS', '❌ FAIL'));
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    assert.equal(r.pass, false);
  });

  run('任务未完成 -> pass false', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY.replace('[x]', '[ ]'));
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    assert.equal(r.pass, false);
  });

  run('building marker 存在 -> pass false', () => {
    const { dir } = makeGateFixture();
    write(dir, '.openflow/building', 'add-widget');
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /building|marker/i);
  });

  run('未解决 verify issues -> pass false', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/verify-issues.md', '# issues\n\n- ❌ 未解决项\n');
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /阻挡|verify/i);
  });

  run('openspec validate 失败 -> pass false', () => {
    const { dir } = makeGateFixture();
    gateEnv.FAKE_VALIDATE_EXIT = '1';
    gateEnv.FAKE_STDERR = 'validate failed: bad spec';
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    delete gateEnv.FAKE_VALIDATE_EXIT;
    delete gateEnv.FAKE_STDERR;
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /validate/i);
  });
}

console.log('\n[8b] canonical test-plan 稳定行（review F1/F2）');

{
  const CANONICAL_TP = [
    'T-001: `tests/auth/test_login.py::test_login_with_valid_credentials` 🔴 RED ✅ PASS',
    'T-002: `tests/auth/test_login.py::test_login_with_wrong_password` 🔴 RED ✅ PASS',
  ].join('\n');
  const CANONICAL_PR = [
    '# plan-ready', '',
    '### Task 1: login',
    '- Test cases: T-001, T-002',
    '- Files: `src/auth/login.py`, `tests/auth/test_login.py`',
    '- 改动文件：`src/auth/login.py` [Verified]',
    '- [x] 实现登录',
    '- [x] 补测试',
  ].join('\n');

  run('canonical 稳定行 -> check-build-done pass', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', CANONICAL_TP);
    write(dir, 'openspec/changes/add-widget/plan-ready.md', CANONICAL_PR);
    write(dir, 'tests/auth/test_login.py', 'def test_login_with_valid_credentials():\n    assert True\n\ndef test_login_with_wrong_password():\n    assert True\n');
    write(dir, 'src/auth/login.py', 'def login(u, p):\n    return True\n');
    const r = runGate(dir, 'check-build-done', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r));
  });

  run('canonical 稳定行 -> check-cross-ref 用 T-001 对账 pass', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', CANONICAL_TP);
    write(dir, 'openspec/changes/add-widget/plan-ready.md', CANONICAL_PR);
    const r = runGate(dir, 'check-cross-ref', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r));
  });

  run('canonical 稳定行 + ❌ FAIL 后缀 -> all_tests_pass false', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', CANONICAL_TP.replace(/✅ PASS/g, '❌ FAIL'));
    const r = runGate(dir, 'check-build-done', 'add-widget');
    assert.equal(r.pass, false);
    assert.equal(r.all_tests_pass, false);
  });
}

// A ✅ PASS row whose assertion was never observed failing is the exact shape of
// the real-world bug this check exists for: an assertion with no failing power
// (only `never()`-style checks, or none at all) is green from the first run, so
// a do-nothing regression keeps it green. RED is the machine trace of TDD Step 2.
console.log('\n[8b-red] 🔴 RED 证据（✅ PASS 必须见过红）');

{
  const TEST_FILE = 'def test_login_with_valid_credentials():\n    assert True\n\ndef test_login_with_wrong_password():\n    assert True\n';
  const NO_RED = [
    'T-001: `tests/auth/test_login.py::test_login_with_valid_credentials` ✅ PASS',
    'T-002: `tests/auth/test_login.py::test_login_with_wrong_password` 🔴 RED ✅ PASS',
  ].join('\n');
  const WITH_RED = NO_RED.replace(
    'test_login_with_valid_credentials` ✅ PASS',
    'test_login_with_valid_credentials` 🔴 RED ✅ PASS',
  );

  function redFixture(tp) {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', tp);
    write(dir, 'tests/auth/test_login.py', TEST_FILE);
    return dir;
  }

  run('✅ PASS 缺 🔴 RED -> check-test-plan fail + red_evidence_missing', () => {
    const r = runGate(redFixture(NO_RED), 'check-test-plan', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    assert.equal(r.all_pass, false, JSON.stringify(r));
    assert.equal(r.stats.red_missing, 1, JSON.stringify(r.stats));
    const issue = (r.issues || []).find((i) => i.type === 'red_evidence_missing');
    assert.ok(issue, JSON.stringify(r.issues));
    assert.equal(issue.id, 'T-001', JSON.stringify(issue));
  });

  run('✅ PASS 带 🔴 RED -> check-test-plan pass', () => {
    const r = runGate(redFixture(WITH_RED), 'check-test-plan', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.equal(r.all_pass, true, JSON.stringify(r));
    assert.equal(r.stats.red_missing, 0, JSON.stringify(r.stats));
  });

  run('缺 🔴 RED -> check-build-done all_tests_pass false', () => {
    const dir = redFixture(NO_RED);
    write(dir, 'openspec/changes/add-widget/plan-ready.md', [
      '# plan-ready', '',
      '### Task 1: login',
      '- Test cases: T-001, T-002',
      '- Files: `tests/auth/test_login.py`',
      '- [x] 补测试',
    ].join('\n'));
    const r = runGate(dir, 'check-build-done', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    assert.equal(r.all_tests_pass, false, JSON.stringify(r));
    assert.ok((r.issues || []).some((i) => i.type === 'red_evidence_missing'), JSON.stringify(r.issues));
  });

  // The whole point is that the receipt gate inherits it: a plan whose green
  // rows were never red must not be able to reach a verify receipt.
  run('缺 🔴 RED -> check-verify-prerequisites blocker（传导到 receipt 闸门）', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN.replace(/ 🔴 RED/g, ''));
    const r = runGate(dir, 'check-verify-prerequisites', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    assert.match(r.blockers.join('\n'), /red_evidence_missing/, JSON.stringify(r.blockers));
  });

  run('legacy 表格行同样要求 🔴 RED', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN.replace(' 🔴 RED', ''));
    const r = runGate(dir, 'check-test-plan', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    assert.equal(r.stats.red_missing, 1, JSON.stringify(r.stats));
  });

  run('未完成的行不要求 🔴 RED（TODO 不是谎言）', () => {
    const r = runGate(redFixture([
      'T-001: `tests/auth/test_login.py::test_login_with_valid_credentials` ⬜ TODO',
      'T-002: `tests/auth/test_login.py::test_login_with_wrong_password` 🔴 RED ✅ PASS',
    ].join('\n')), 'check-test-plan', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.equal(r.all_pass, false, JSON.stringify(r)); // 还有 TODO
    assert.equal(r.stats.red_missing, 0, JSON.stringify(r.stats));
  });
}

// Invariant rows carry the cross-combination assertions that a one-scenario-one-
// test plan has no slot for. They are ordinary owned selectors plus a `covers`
// clause that must resolve — an invariant claiming to cover a scenario that does
// not exist is worse than no invariant at all.
console.log('\n[8b-inv] INV 不变量行');

{
  const INV_TEST_FILE = 'def test_login_with_valid_credentials():\n    assert True\n\ndef test_always_has_effect():\n    assert True\n';

  function invFixture(tp, pr) {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', tp);
    if (pr) write(dir, 'openspec/changes/add-widget/plan-ready.md', pr);
    write(dir, 'tests/auth/test_login.py', INV_TEST_FILE);
    return dir;
  }

  const GOOD_TP = [
    'T-001: `tests/auth/test_login.py::test_login_with_valid_credentials` 🔴 RED ✅ PASS',
    'INV-001: `tests/auth/test_login.py::test_always_has_effect` covers T-001 🔴 RED ✅ PASS',
  ].join('\n');
  const INV_PR = [
    '# plan-ready', '',
    '### Task 1: login',
    '- Test cases: T-001, INV-001',
    '- Files: `tests/auth/test_login.py`',
    '- [x] 补测试',
  ].join('\n');

  run('合法 INV 行 -> check-test-plan pass 且计入统计', () => {
    const r = runGate(invFixture(GOOD_TP), 'check-test-plan', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.equal(r.stats.total, 2, JSON.stringify(r.stats));
    assert.equal(r.stats.pass, 2, JSON.stringify(r.stats));
  });

  run('INV 行缺 covers 子句 -> invariant_covers_missing', () => {
    const r = runGate(invFixture(GOOD_TP.replace(' covers T-001', '')), 'check-test-plan', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    assert.ok((r.issues || []).some((i) => i.type === 'invariant_covers_missing'), JSON.stringify(r.issues));
  });

  run('INV 行 covers 指向不存在的 ID -> invariant_covers_unknown', () => {
    const r = runGate(invFixture(GOOD_TP.replace('covers T-001', 'covers T-001, T-099')), 'check-test-plan', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    const issue = (r.issues || []).find((i) => i.type === 'invariant_covers_unknown');
    assert.ok(issue, JSON.stringify(r.issues));
    assert.match(issue.detail, /T-099/);
  });

  run('INV 行被 task 引用 -> check-cross-ref pass 且 INV 计入对账', () => {
    const r = runGate(invFixture(GOOD_TP, INV_PR), 'check-cross-ref', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r));
    // 计数断言是这条用例的失败能力所在：只断言 pass=true 的话，"INV 行压根没被
    // 解析"（旧行为）同样满足它——零解析满足一切负空间断言。
    assert.match(r.summary, /\b2 tests\b/, JSON.stringify(r));
  });

  run('INV 行没有任何 task 认领 -> uncovered_test', () => {
    const pr = INV_PR.replace('- Test cases: T-001, INV-001', '- Test cases: T-001');
    const r = runGate(invFixture(GOOD_TP, pr), 'check-cross-ref', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    const issue = (r.issues || []).find((i) => i.type === 'uncovered_test');
    assert.ok(issue, JSON.stringify(r.issues));
    assert.match(issue.detail, /INV-001/);
  });

  run('INV 行 ✅ PASS 缺 🔴 RED -> 同样 red_evidence_missing', () => {
    const r = runGate(invFixture(GOOD_TP.replace('covers T-001 🔴 RED ✅ PASS', 'covers T-001 ✅ PASS')), 'check-test-plan', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    const issue = (r.issues || []).find((i) => i.type === 'red_evidence_missing');
    assert.ok(issue, JSON.stringify(r.issues));
    assert.equal(issue.id, 'INV-001', JSON.stringify(issue));
  });
}

console.log('\n[8c] plan-ready 一致性硬校验（真实案例回归）');

{
  const TP = [
    'T-001: `tests/auth/test_login.py::test_login_with_valid_credentials` 🔴 RED ✅ PASS',
    'T-002: `tests/auth/test_login.py::test_login_with_wrong_password` 🔴 RED ✅ PASS',
  ].join('\n');
  const PR_HEAD = ['# plan-ready', ''];

  run('同一 T-id 绑定多个 task -> check-cross-ref fail closed', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', TP);
    write(dir, 'openspec/changes/add-widget/plan-ready.md', [
      ...PR_HEAD,
      '### Task 1: login',
      '- Test cases: T-001',
      '- Files: `tests/auth/test_login.py`',
      '',
      '### Task 2: logout',
      '- Test cases: T-001, T-002',
      '- Files: `tests/auth/test_login.py`',
    ].join('\n'));
    const r = runGate(dir, 'check-cross-ref', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    assert.ok((r.issues || []).some((i) => i.type === 'duplicate_task_binding'), JSON.stringify(r.issues));
  });

  run('task 的 Test cases 选择器文件不在 Files -> fail closed', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', TP);
    write(dir, 'openspec/changes/add-widget/plan-ready.md', [
      ...PR_HEAD,
      '### Task 1: login',
      '- Test cases: T-001, T-002',
      '- Files: `src/auth/login.py`',
    ].join('\n'));
    const r = runGate(dir, 'check-cross-ref', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    const filesIssue = (r.issues || []).find((i) => i.type === 'test_file_not_in_task_files');
    assert.ok(filesIssue, JSON.stringify(r.issues));
    assert.match(filesIssue.detail, /tests\/auth\/test_login\.py/);
  });

  run('同一选择器被多个 T-id 拥有 -> duplicate_selector 提前拦截', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', [
      'T-001: `tests/auth/test_login.py::test_login_valid` 🔴 RED ✅ PASS',
      'T-002: `tests/auth/test_login.py::test_login_valid` 🔴 RED ✅ PASS',
    ].join('\n'));
    write(dir, 'openspec/changes/add-widget/plan-ready.md', [
      ...PR_HEAD,
      '### Task 1: login',
      '- Test cases: T-001, T-002',
      '- Files: `tests/auth/test_login.py`',
    ].join('\n'));
    const r = runGate(dir, 'check-cross-ref', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    assert.ok((r.issues || []).some((i) => i.type === 'duplicate_selector'), JSON.stringify(r.issues));
    const tp = runGate(dir, 'check-test-plan', 'add-widget');
    assert.ok((tp.issues || []).some((i) => i.type === 'duplicate_selector'), JSON.stringify(tp.issues));
  });

  run('机器行与追溯表函数名不一致 -> warning 不阻断', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', [
      'T-001: `tests/auth/test_login.py::test_login_a` 🔴 RED ✅ PASS',
      'T-002: `tests/auth/test_login.py::test_login_b` 🔴 RED ✅ PASS',
      '',
      '## 追溯表',
      '',
      '| ID | 来源 | 场景 | 测试文件::测试函数 | 类型 |',
      '|----|------|------|--------------------|------|',
      '| T-001 | REQ-1 | 登录 | `tests/auth/test_login.py::test_login_wrong_name` | 单元 |',
      '| T-002 | REQ-2 | 登出 | `tests/auth/test_login.py::test_login_b` | 单元 |',
    ].join('\n'));
    write(dir, 'openspec/changes/add-widget/plan-ready.md', [
      ...PR_HEAD,
      '### Task 1: login',
      '- Test cases: T-001, T-002',
      '- Files: `tests/auth/test_login.py`',
    ].join('\n'));
    const r = runGate(dir, 'check-cross-ref', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r));
    const warn = (r.warnings || []).find((w) => w.type === 'traceability_mismatch');
    assert.ok(warn, JSON.stringify(r.warnings));
    assert.match(warn.detail, /T-001/);
  });

  run('plan-ready 无任何 checkbox -> check-build-done 报准确错误', () => {
    const { dir } = makeGateFixture();
    write(dir, 'openspec/changes/add-widget/test-plan.md', TP);
    write(dir, 'tests/auth/test_login.py', 'def test_login_with_valid_credentials():\n    assert True\n\ndef test_login_with_wrong_password():\n    assert True\n');
    write(dir, 'openspec/changes/add-widget/plan-ready.md', [
      ...PR_HEAD,
      '### Task 1: login',
      '- Test cases: T-001, T-002',
      '- Files: `tests/auth/test_login.py`',
    ].join('\n'));
    const r = runGate(dir, 'check-build-done', 'add-widget');
    assert.equal(r.pass, false, JSON.stringify(r));
    const issue = (r.issues || []).find((i) => i.type === 'tasks_not_all_done');
    assert.ok(issue, JSON.stringify(r.issues));
    assert.match(issue.detail, /没有任何 \[ \]\/\[x\]/);
  });
}

console.log('\n[9] write-verify-receipt 原子写入');

{
  const INPUT = {
    testRuns: [{ name: 'verify', exitCode: 0 }],
    scenarioCoverage: { mapped: 3, total: 3 },
    designConsistency: { pass: true, blockers: [] },
    userConfirmation: { received: true },
  };

  run('写 receipt -> pass true / 回读校验通过', () => {
    const { dir } = makeGateFixture();
    write(dir, 'receipt-input.json', JSON.stringify(INPUT));
    const r = runGate(dir, 'write-verify-receipt', 'add-widget', path.join(dir, 'receipt-input.json'));
    assert.equal(r.pass, true, JSON.stringify(r.blockers));
    assert.ok(r.receipt_path, 'receipt_path missing');
    assert.ok(fs.existsSync(path.join(dir, 'openspec', 'changes', 'add-widget', 'verify-result.json')));
    const v = fp.validateVerifyReceipt(dir, 'add-widget');
    assert.equal(v.pass, true, JSON.stringify(v.blockers));
  });

  run('非法 input JSON -> pass false', () => {
    const { dir } = makeGateFixture();
    write(dir, 'receipt-input.json', '{bad json');
    const r = runGate(dir, 'write-verify-receipt', 'add-widget', path.join(dir, 'receipt-input.json'));
    assert.equal(r.pass, false);
  });

  run('scenarioCoverage 不一致 -> pass false', () => {
    const { dir } = makeGateFixture();
    write(dir, 'receipt-input.json', JSON.stringify({ ...INPUT, scenarioCoverage: { mapped: 2, total: 3 } }));
    const r = runGate(dir, 'write-verify-receipt', 'add-widget', path.join(dir, 'receipt-input.json'));
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /scenario/i);
  });

  run('prerequisites 未满足 -> 不写 receipt', () => {
    const { dir } = makeGateFixture();
    write(dir, '.openflow/building', 'add-widget');
    write(dir, 'receipt-input.json', JSON.stringify(INPUT));
    const r = runGate(dir, 'write-verify-receipt', 'add-widget', path.join(dir, 'receipt-input.json'));
    assert.equal(r.pass, false);
    assert.equal(fs.existsSync(path.join(dir, 'openspec', 'changes', 'add-widget', 'verify-result.json')), false);
  });
}

console.log('\n[10] check-verify-ready');

{
  run('有效 receipt -> pass true', () => {
    const { dir } = makeGateFixture();
    writeReceipt(dir);
    const r = runGate(dir, 'check-verify-ready', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r.blockers));
  });

  run('无 receipt -> pass false / blockers 含 receipt', () => {
    const { dir } = makeGateFixture();
    const r = runGate(dir, 'check-verify-ready', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /receipt/i);
  });

  run('receipt.change 不一致 -> pass false', () => {
    const { dir } = makeGateFixture();
    writeReceipt(dir, (r) => { r.change = 'other-change'; });
    const r = runGate(dir, 'check-verify-ready', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /mismatch|change/i);
  });

  const staleCases = [
    ['tracked 改动', (d) => write(d, 'a.txt', 'edited after receipt\n')],
    ['staged 改动', (d) => { write(d, 'b.txt', 'staged after receipt\n'); git(d, ['add', 'b.txt']); }],
    ['untracked 新增', (d) => write(d, 'new-untracked.txt', 'new\n')],
    ['config 改动', (d) => write(d, 'package.json', '{"name":"fixture","version":"2.0.0"}\n')],
  ];
  for (const [label, mutate] of staleCases) {
    run(`receipt 后 ${label} -> 过期 pass false`, () => {
      const { dir } = makeGateFixture();
      writeReceipt(dir);
      mutate(dir);
      const r = runGate(dir, 'check-verify-ready', 'add-widget');
      assert.equal(r.pass, false);
      assert.match(r.blockers.join('\n'), /stale|fingerprint/i);
    });
  }
}

console.log('\n[11] archive-verified 归档事务');

{
  run('成功归档 -> 源移除 + 恰一个归档目录 + 标记移除', () => {
    const { dir } = archiveFixture();
    const r = runGate(dir, 'archive-verified', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r.blockers));
    assert.equal(fs.existsSync(path.join(dir, 'openspec', 'changes', 'add-widget')), false);
    const archiveDir = path.join(dir, 'openspec', 'changes', 'archive');
    const entries = fs.readdirSync(archiveDir);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.match(entries[0], /^\d{4}-\d{2}-\d{2}-add-widget$/);
    for (const f of ['tasks.md', 'lessons.md', 'verify-result.json']) {
      assert.ok(fs.existsSync(path.join(archiveDir, entries[0], f)), `missing ${f}`);
    }
    assert.equal(fs.existsSync(path.join(dir, '.openflow', 'phase')), false);
  });

  run('close 生成 lessons/tasks 后归档 -> 成功（排除生效）', () => {
    const { dir } = archiveFixture();
    // 模拟 close 步骤 1/2：归档前先写 lessons.md + tasks.md。
    write(dir, 'openspec/changes/add-widget/lessons.md', '# 经验记录\n');
    write(dir, 'openspec/changes/add-widget/tasks.md', '- [x] 任务\n');
    const r = runGate(dir, 'archive-verified', 'add-widget');
    assert.equal(r.pass, true, JSON.stringify(r.blockers));
    assert.equal(fs.existsSync(path.join(dir, 'openspec', 'changes', 'add-widget')), false);
    const archiveDir = path.join(dir, 'openspec', 'changes', 'archive');
    const entries = fs.readdirSync(archiveDir);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    for (const f of ['tasks.md', 'lessons.md', 'verify-result.json']) {
      assert.ok(fs.existsSync(path.join(archiveDir, entries[0], f)), `missing ${f}`);
    }
  });

  run('readiness 后改动 -> 归档失败 / archive 未调用 / 标记保留', () => {
    const { dir } = archiveFixture();
    write(dir, 'a.txt', 'mutated after ready\n');
    clearArgvLog();
    const r = runGate(dir, 'archive-verified', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /stale|fingerprint/i);
    assert.equal(archiveInvocations().length, 0, 'archive must not be invoked when receipt is stale');
    assert.ok(fs.existsSync(path.join(dir, '.openflow', 'phase')), 'phase marker preserved');
    assert.ok(fs.existsSync(path.join(dir, 'openspec', 'changes', 'add-widget')), 'source preserved');
  });

  run('runner 失败 -> 归档失败 / 标记保留', () => {
    const { dir } = archiveFixture();
    gateEnv.FAKE_ARCHIVE_EXIT = '1';
    gateEnv.FAKE_STDERR = 'archive failed';
    const r = runGate(dir, 'archive-verified', 'add-widget');
    delete gateEnv.FAKE_ARCHIVE_EXIT;
    delete gateEnv.FAKE_STDERR;
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /archive-failed/i);
    assert.ok(fs.existsSync(path.join(dir, '.openflow', 'phase')));
    assert.ok(fs.existsSync(path.join(dir, 'openspec', 'changes', 'add-widget')));
  });

  run('源目录归档后仍存在 -> 归档失败', () => {
    const { dir } = archiveFixture();
    gateEnv.FAKE_ARCHIVE_NOOP = '1';
    const r = runGate(dir, 'archive-verified', 'add-widget');
    delete gateEnv.FAKE_ARCHIVE_NOOP;
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /source/i);
  });

  run('预存在归档目录 -> 归档失败（0 新目录）', () => {
    const { dir } = archiveFixture();
    const date = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'archive', `${date}-add-widget`), { recursive: true });
    const r = runGate(dir, 'archive-verified', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /archive-dir|count/i);
  });

  run('多个新归档目录 -> 归档失败', () => {
    const { dir } = archiveFixture();
    gateEnv.FAKE_ARCHIVE_MULTI = '1';
    const r = runGate(dir, 'archive-verified', 'add-widget');
    delete gateEnv.FAKE_ARCHIVE_MULTI;
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /archive-dir|count/i);
  });

  run('丢失 tasks.md/lessons.md -> 归档失败', () => {
    const { dir } = archiveFixture();
    gateEnv.FAKE_ARCHIVE_MISSING = 'tasks.md,lessons.md';
    const r = runGate(dir, 'archive-verified', 'add-widget');
    delete gateEnv.FAKE_ARCHIVE_MISSING;
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /tasks|lessons/i);
  });

  run('丢失 verify-result.json -> 归档失败', () => {
    const { dir } = archiveFixture();
    gateEnv.FAKE_ARCHIVE_MISSING = 'verify-result.json';
    const r = runGate(dir, 'archive-verified', 'add-widget');
    delete gateEnv.FAKE_ARCHIVE_MISSING;
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /verify-result/i);
  });
}

console.log('\n[12] 改动点归属对账（Java 多行签名 / 窗口 / 豁免 回归）');

{
  // 归属对账需要「已提交的 base + 未提交的改动」才能稳定产出 hunk；
  // HEAD 提交基线后写 head 版本（不提交），diffHunks 走 worktree ref。
  function ownershipFixture({ base, head, design }) {
    const dir = tmpdir();
    gitInit(dir);
    for (const [rel, content] of Object.entries(base)) write(dir, rel, content);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', 'base']);
    for (const [rel, content] of Object.entries(head)) write(dir, rel, content);
    write(dir, 'openspec/changes/add-widget/design.md', design);
    return dir;
  }

  const JAVA = 'src/main/java/com/x/Multi.java';

  /**
   * 造一份声明式 design.md。
   *
   * decls 每项：
   *   'file::method'                                     → `- 目标：`file::method``
   *   { selector, follow: false, reason: '已废弃' }      → `- 并行路径：… → 不随改（已废弃）`
   *   { selector, follow: true }                         → `- 并行路径：… → 随改`
   */
  const designFor = (decls, files, title = '变更') => [
    '## 现状与影响面', '',
    `### 改动点 1：${title}`,
    ...decls.map((d) => (typeof d === 'string'
      ? `- 目标：\`${d}\``
      : `- 并行路径：\`${d.selector}\` → ${d.follow ? '随改' : `不随改（${d.reason}）`}`)),
    '',
    '## 改动文件', '', ...files.map((f) => `- ${f}`),
  ].join('\n');
  const joined = (lines) => lines.join('\n') + '\n';

  // ---- 声明契约：解析失败是 blocker，不是 warning ----

  const declBlockerFixture = (impactBody) => ownershipFixture({
    base: { [JAVA]: 'package com.x;\n\npublic class D {\n    void a() {\n        int x = 1;\n    }\n}\n' },
    head: { [JAVA]: 'package com.x;\n\npublic class D {\n    void a() {\n        int x = 2;\n    }\n}\n' },
    design: ['## 现状与影响面', '', ...impactBody, '', '## 改动文件', '', `- ${JAVA}`].join('\n'),
  });

  run('现状与影响面无 ### 改动点 小节 -> blocker', () => {
    const dir = declBlockerFixture(['widget 模块需要改一下。']);
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    assert.equal(r.pass, false, '无声明必须 pass false');
    assert.match(r.blockers.join('\n'), /改动点/, `blocker 应指出缺改动点声明: ${r.blockers.join('\n')}`);
  });

  run('改动点有小节但无目标声明 -> blocker', () => {
    const dir = declBlockerFixture(['### 改动点 1：改点东西', '', '随便写点说明。']);
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /没有任何.*目标/, r.blockers.join('\n'));
  });

  run('选择器缺 :: 分隔（只写方法名）-> blocker', () => {
    const dir = declBlockerFixture(['### 改动点 1：改点东西', '- 目标：`justAMethodName`']);
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /::/, r.blockers.join('\n'));
  });

  run('并行路径未标注随改/不随改 -> blocker（不能悬空）', () => {
    const dir = declBlockerFixture([
      '### 改动点 1：改点东西',
      `- 目标：\`${JAVA}::a\``,
      `- 并行路径：\`${JAVA}::aNew\``,
    ]);
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /随改|不随改/, r.blockers.join('\n'));
  });

  run('形似声明但格式错 -> blocker（不静默忽略）', () => {
    const dir = declBlockerFixture(['### 改动点 1：改点东西', '- 目标：src/a.java::a（忘了加反引号）']);
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    assert.equal(r.pass, false);
    assert.match(r.blockers.join('\n'), /无法解析/, r.blockers.join('\n'));
  });

  run('多行 Java 签名：hunk 归属到真实方法而非上一个方法', () => {
    const lines = (marker) => [
      'package com.x;', '',
      'public class Multi {',
      '    private void before() {',
      '        int a = 1;',
      '    }', '',
      '    public void processStrategyRule(String ruleType, String rule,',
      '            String task) {',
      '        int b = 2;',
      marker,
      '    }',
      '}', '',
    ];
    const dir = ownershipFixture({
      base: { [JAVA]: joined(lines('')) },
      head: { [JAVA]: joined(lines('        int c = 3;')) },
      design: designFor([`${JAVA}::processStrategyRule`], [JAVA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/改动点归属/.test(w), `多行签名不应误报归属漂移: ${w}`);
  });

  run('新增方法带 Javadoc：hunk 起点落在注释上仍归属到新方法', () => {
    const base = joined([
      'package com.x;', '',
      'public class Added {',
      '    private void existing() {',
      '        int a = 1;',
      '    }',
      '}', '',
    ]);
    const head = joined([
      'package com.x;', '',
      'public class Added {',
      '    private void existing() {',
      '        int a = 1;',
      '    }', '',
      '    /**',
      '     * 驳回/超时后作废暂停活动。',
      '     */',
      '    private void handleApproveNotPassVoidPausedActivity(String status, String remark) {',
      '        int b = 2;',
      '    }',
      '}', '',
    ]);
    const dir = ownershipFixture({
      base: { [JAVA]: base },
      head: { [JAVA]: head },
      design: designFor([`${JAVA}::handleApproveNotPassVoidPausedActivity`], [JAVA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/改动点归属/.test(w), `Javadoc 窗口不应误报归属漂移: ${w}`);
  });

  run('调用点不是方法声明：多行条件续行 && foo(... ) 不得当声明', () => {
    const lines = (marker) => [
      'package com.x;', '',
      'public class CallSite {',
      '    private boolean filterCompanyUnfitRuleParam(String ruleType,',
      '            String source, String entity) {',
      '        if (entity != null',
      '                && isCompanyPbPstApprove(entity, source)) {',
      marker,
      '        }',
      '        return false;',
      '    }', '',
      '    private boolean isCompanyPbPstApprove(String a, String b) {',
      '        return a != null;',
      '    }',
      '}', '',
    ];
    const dir = ownershipFixture({
      base: { [JAVA]: joined(lines('')) },
      head: { [JAVA]: joined(lines('            return true;')) },
      design: designFor([`${JAVA}::filterCompanyUnfitRuleParam`], [JAVA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/改动点归属/.test(w), `调用点续行不应被当成声明: ${w}`);
    assert.ok(!/isCompanyPbPstApprove/.test(w), `不应把调用点方法名当作落点: ${w}`);
  });

  run('本次新增的方法即使 design 未点名也不报归属漂移', () => {
    const baseSrc = 'package com.x;\n\npublic class Helper {\n    private void mainFlow() {\n        int a = 1;\n    }\n}\n';
    const headSrc = joined([
      'package com.x;', '',
      'public class Helper {',
      '    private void mainFlow() {',
      '        int a = 1;',
      '    }', '',
      '    private boolean useSelfParam(String entity) {',
      '        return entity != null;',
      '    }',
      '}', '',
    ]);
    const dir = ownershipFixture({
      base: { [JAVA]: baseSrc },
      head: { [JAVA]: headSrc },
      design: designFor([`${JAVA}::mainFlow`], [JAVA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/改动点归属/.test(w), `新增方法不应报归属漂移: ${w}`);
  });

  run('声明为「不随改」的并行路径不报声称未落地（显式豁免，不再靠正则猜）', () => {
    const baseSrc = joined([
      'package com.x;', '',
      'public class Exempt {',
      '    public void rejectHandleFollowStatus(long id) {',
      '        int a = 1;',
      '    }', '',
      '    public void other(long id) {',
      '        int b = 1;',
      '    }',
      '}', '',
    ]);
    const headSrc = baseSrc.replace('        int b = 1;', '        int b = 2;');
    const dir = ownershipFixture({
      base: { [JAVA]: baseSrc },
      head: { [JAVA]: headSrc },
      design: designFor([
        `${JAVA}::other`,
        { selector: `${JAVA}::rejectHandleFollowStatus`, follow: false, reason: 'status=1 命中，无代码改动' },
      ], [JAVA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/声称未落地/.test(w), `显式豁免不应报声称未落地: ${w}`);
  });

  run('注释里的标识符不算下游调用（完整性不误报）', () => {
    const baseSrc = joined([
      'package com.x;', '',
      'public class Comments {',
      '    public void alpha(long id) {',
      '        int a = 1;',
      '    }', '',
      '    public String gamma(String s) {',
      '        // 关联 task_id（同一次市调）',
      '        return s;',
      '    }',
      '}', '',
    ]);
    // gamma 在 base/head 完全相同（未随改）；alpha 内新增同样的注释作为「改动链路」
    const headSrc = baseSrc.replace('        int a = 1;', '        // 关联 task_id（同一次市调）\n        int a = 2;');
    const dir = ownershipFixture({
      base: { [JAVA]: baseSrc },
      head: { [JAVA]: headSrc },
      design: designFor([`${JAVA}::alpha`], [JAVA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/改动点完整性/.test(w), `注释里的 task_id 不应触发完整性警告: ${w}`);
  });

  run('方法体范围不越界：多行签名方法之后的兄弟方法不背锅', () => {
    const baseSrc = joined([
      'package com.x;', '',
      'public class Over {',
      '    private void alpha(String a) {',
      '        int x = 1;',
      '    }', '',
      '    private void shared(String a,',
      '            String b) {',
      '        int y = 1;',
      '    }', '',
      '    private void gamma(String a) {',
      '        shared("a", "b");',
      '    }',
      '}', '',
    ]);
    const headSrc = baseSrc.replace('        int x = 1;', '        int x = 2;');
    const dir = ownershipFixture({
      base: { [JAVA]: baseSrc },
      head: { [JAVA]: headSrc },
      design: designFor([`${JAVA}::alpha`, { selector: `${JAVA}::shared`, follow: false, reason: '本次不改，仅被调用' }], [JAVA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/改动点完整性/.test(w), `alpha 的方法体不应吞掉 shared/gamma 的调用: ${w}`);
  });

  run('真实归属漂移仍报警（防过度豁免）', () => {
    const baseSrc = joined([
      'package com.x;', '',
      'public class Real {',
      '    private void alpha(String a) {',
      '        int x = 1;',
      '    }', '',
      '    private void unrelated(String a) {',
      '        int y = 1;',
      '    }',
      '}', '',
    ]);
    const headSrc = baseSrc.replace('        int y = 1;', '        int y = 2;');
    const dir = ownershipFixture({
      base: { [JAVA]: baseSrc },
      head: { [JAVA]: headSrc },
      design: designFor([`${JAVA}::alpha`], [JAVA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.match(w, /改动点归属/, `改动落进未被声称的方法时必须报警: ${w}`);
    assert.match(w, /unrelated/, `警告应点名真实落点方法: ${w}`);
  });

  run('无修饰符方法（void foo(...)）也要被识别为声明', () => {
    const lines = (marker) => [
      'package com.x;', '',
      'public class Bare {',
      '    private void before(String a) {',
      '        int a = 1;',
      '    }', '',
      '    void helper(String a) {',
      marker,
      '    }',
      '}', '',
    ];
    const dir = ownershipFixture({
      base: { [JAVA]: joined(lines('')) },
      head: { [JAVA]: joined(lines('        int x = 2;')) },
      design: designFor([`${JAVA}::helper`], [JAVA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/改动点归属/.test(w), `无修饰符方法不应被回溯归属到 before: ${w}`);
  });

  run('TS/JS function 声明与多行参数也要被识别', () => {
    const TS = 'src/util.ts';
    const lines = (marker) => [
      'export function untouched(a: number) {',
      '    return a;',
      '}', '',
      'function computeTotal(items: number[],',
      '        ratio: number) {',
      marker,
      '    return ratio;',
      '}', '',
    ];
    const dir = ownershipFixture({
      base: { [TS]: joined(lines('')) },
      head: { [TS]: joined(lines('    const total = ratio * 2;')) },
      design: designFor([`${TS}::computeTotal`], [TS]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/改动点归属/.test(w), `TS 声明不应被回溯归属到 untouched: ${w}`);
  });

  run('正则字面量里的反引号不得吞掉后续方法', () => {
    const TS = 'src/parse.ts';
    const lines = (marker) => [
      'export function recognized(a: number) {',
      '    return a;',
      '}', '',
      'export function parseRow(content: string) {',
      '    return content.match(/^([T#]\\S+)\\s*:\\s*`([^`]+)`$/);',
      '}', '',
      'function computeTotal(items: number[],',
      '        ratio: number) {',
      marker,
      '}', '',
    ];
    const dir = ownershipFixture({
      base: { [TS]: joined(lines('')) },
      head: { [TS]: joined(lines('    const total = ratio * 2;')) },
      design: designFor([`${TS}::computeTotal`], [TS]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/改动点归属/.test(w), `正则里的反引号不应破坏后续解析: ${w}`);
  });

  run('跨文件同名：声明带文件归属，各判各的（不再互相顶替）', () => {
    const ALPHA = 'src/main/java/com/x/Alpha.java';
    const BETA = 'src/main/java/com/x/Beta.java';
    const alphaLines = (marker) => [
      'package com.x;', '',
      'public class Alpha {',
      '    public void target(String a) {',
      marker,
      '    }',
      '}', '',
    ];
    const betaSrc = joined([
      'package com.x;', '',
      'public class Beta {',
      '    public void target(String a) {',
      '        int a1 = 1;',
      '    }', '',
      '    public void other(String a) {',
      '        int b1 = 1;',
      '    }',
      '}', '',
    ]);
    const dir = ownershipFixture({
      base: { [ALPHA]: joined(alphaLines('        int x = 1;')), [BETA]: betaSrc },
      head: { [ALPHA]: joined(alphaLines('        int x = 2;')), [BETA]: betaSrc.replace('        int b1 = 1;', '        int b1 = 2;') },
      design: designFor([`${ALPHA}::target`, `${BETA}::other`], [ALPHA, BETA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.ok(!/声称未落地/.test(w), `两处声明都已落地，不应报未落地: ${w}`);
  });

  run('跨文件同名：声明 Beta::target 但改动只落在 Alpha::target -> 必须报未落地', () => {
    const ALPHA = 'src/main/java/com/x/Alpha.java';
    const BETA = 'src/main/java/com/x/Beta.java';
    const alphaLines = (marker) => [
      'package com.x;', '',
      'public class Alpha {',
      '    public void target(String a) {',
      marker,
      '    }',
      '}', '',
    ];
    const betaSrc = joined([
      'package com.x;', '',
      'public class Beta {',
      '    public void target(String a) {',
      '        int a1 = 1;',
      '    }', '',
      '    public void other(String a) {',
      '        int b1 = 1;',
      '    }',
      '}', '',
    ]);
    const dir = ownershipFixture({
      base: { [ALPHA]: joined(alphaLines('        int x = 1;')), [BETA]: betaSrc },
      head: {
        [ALPHA]: joined(alphaLines('        int x = 2;')),
        [BETA]: betaSrc.replace('        int b1 = 1;', '        int b1 = 2;'),
      },
      // 声明 Beta::target 要改，但 Beta 的改动实际落在 other 里。
      // 旧实现只比对裸方法名，看到 Alpha 里有个同名 target 落了地就放过（landedNamesGlobal）；
      // 声明带文件归属后这是确定的缺陷，必须报出来。
      design: designFor([`${BETA}::target`, `${ALPHA}::target`], [ALPHA, BETA]),
    });
    const r = runGate(dir, 'check-design-consistency', 'add-widget');
    const w = (r.warnings || []).join('\n');
    assert.match(w, /声称未落地/, `Beta::target 未落地必须报出: ${w}`);
    assert.match(w, /Beta\.java::target/, `警告必须点名是哪个文件的方法: ${w}`);
  });
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
