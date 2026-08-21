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
  run('四个精确自污染路径被排除 -> 指纹不变', () => {
    const dir = makeRepo();
    const before = collect(dir).value;
    write(dir, '.openflow/phase', JSON.stringify({
      version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap',
    }));
    write(dir, '.openflow/building', 'add-widget');
    write(dir, 'openspec/changes/add-widget/verify-issues.md', '# issues\n');
    write(dir, 'openspec/changes/add-widget/verify-result.json', '{}');
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
  '| 1 | 场景一：widget 渲染 | ✅ PASS |',
  '| 2 | 场景二：widget 数据 | ✅ PASS |',
].join('\n');

const PLAN_READY = [
  '# plan-ready', '',
  '- [x] 实现 widget 渲染',
  '- [x] 实现 widget 数据源', '',
  '- [Verified] 改动文件 src/app.js',
].join('\n');

const DESIGN = [
  '## 现状与影响面', '',
  'widget 模块目前缺失，需要新增。', '',
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
  write(dir, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'verify', mode: 'bootstrap' }));
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

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
