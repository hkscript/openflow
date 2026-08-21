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

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
