#!/usr/bin/env node
/**
 * Temporary-workspace fixtures for detect routing — Task 5 of the phase
 * lifecycle plan.
 *
 * Covers:
 *   [1] phase state parsing — absent / valid build state
 *   [2] phase-first change selection (phase beats mtime among multiple changes)
 *   [3] invalid / missing / archive-only phase target
 *   [4] build modes — bootstrap (with/without marker), task-build missing
 *       artifacts, marker change mismatch
 *   [5] amend — with and without marker (legal either way)
 *   [6] verify receipt routing — valid → close, stale → verify, close phase
 *       with invalid receipt → contradiction + no auto-close
 *
 * 用法：`pnpm node scripts/test-detect.mjs`（无构建依赖，纯 Node 20+ 运行时）。
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
const DETECT = path.resolve(__dirname, '..', 'hooks', 'detect.mjs');
const HELPER = path.resolve(__dirname, '..', 'hooks', 'lifecycle-fingerprint.mjs');
const lifecycle = await import(pathToFileURL(HELPER).href);

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openflow-detect-'));
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function mkChange(root, name) {
  fs.mkdirSync(path.join(root, 'openspec', 'changes', name), { recursive: true });
}

function setPhase(root, phaseJson) {
  write(root, '.openflow/phase', JSON.stringify(phaseJson));
}

function setMarker(root, change) {
  write(root, '.openflow/building', `${change}\n`);
}

// test-plan with a mix of PASS + TODO (never allPass, so the pre-existing
// "all PASS + all done + marker" stale rule never fires on clean fixtures).
const TEST_PLAN_MIXED = [
  '# Test Plan',
  '| # | 测试 | 状态 |',
  '| --- | --- | --- |',
  '| T-001 | unit test | ✅ PASS |',
  '| T-002 | another case | TODO |',
  '',
].join('\n');

const PLAN_READY_MIXED = [
  '# Plan Ready',
  '## Task 1',
  '- [x] task one done',
  '- [ ] task two pending',
  '',
].join('\n');

function runDetect(dir) {
  const out = execFileSync(process.execPath, [DETECT], {
    cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

// ---- git helpers for receipt fixtures ----
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
function gitInit(dir) {
  git(dir, ['init', '-q']);
  for (const [k, v] of [['user.email', 'test@openflow.local'], ['user.name', 'OpenFlow Test']]) {
    git(dir, ['config', k, v]);
  }
}

// Workspace with a real git history (so the fingerprint helper can compute a
// current HEAD + fingerprint) and the active change directory.
function makeGitWorkspace(change = 'add-widget') {
  const dir = tmpdir();
  gitInit(dir);
  write(dir, 'src/app.js', 'console.log(1);\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'baseline']);
  mkChange(dir, change);
  return dir;
}

// Write a verify-result.json whose head/fingerprint match the current
// worktree. Call ONLY after all non-self-pollution files (test-plan.md,
// plan-ready.md, tracked edits) are in place.
function writeValidReceipt(dir, change) {
  const fp = lifecycle.collectWorktreeFingerprint(dir, change);
  if (!fp.ok) throw new Error(`fingerprint failed: ${fp.blocker}`);
  const receipt = {
    version: 1,
    change,
    head: fp.head,
    fingerprint: fp.value,
    testRuns: [{ name: 'unit', exitCode: 0 }],
    scenarioCoverage: { mapped: 3, total: 3 },
    designConsistency: { pass: true, blockers: [] },
    userConfirmation: { received: true },
  };
  write(dir, `openspec/changes/${change}/verify-result.json`, JSON.stringify(receipt, null, 2));
}

function contradictionIds(json) {
  return (json.contradictions || []).map((c) => c.id).filter(Boolean);
}

console.log('\n[1] phase state parsing');

run('phase 缺失 -> phase_state.value null，按现有启发式路由', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  const json = runDetect(dir);
  assert.equal(json.signals.phase_state.value, null);
  assert.equal(json.change_name, 'add-widget');
  assert.equal(json.suggested_phase, 'spec'); // no test-plan -> existing heuristic
});

run('有效 build/task-build 状态 -> 路由 build（phase_state 完整）', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  const json = runDetect(dir);
  assert.equal(json.signals.phase_state.value.phase, 'build');
  assert.equal(json.signals.phase_state.value.mode, 'task-build');
  assert.equal(json.change_name, 'add-widget');
  assert.equal(json.suggested_phase, 'build');
  assert.deepEqual(contradictionIds(json), []);
});

run('canonical 稳定行状态后缀 -> test_plan_stats 计数（F1）', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', [
    'T-001: `tests/auth/login.test.ts::valid credentials` ✅ PASS',
    'T-002: `tests/auth/login.test.ts::wrong password` ⬜ TODO',
    'T-003: `tests/auth/login.test.ts::reuse session` ❌ FAIL',
  ].join('\n'));
  const json = runDetect(dir);
  const stats = json.signals.test_plan_stats.value;
  assert.ok(stats, `缺少 test_plan_stats: ${JSON.stringify(json.signals.test_plan_stats)}`);
  assert.equal(stats.pass, 1, JSON.stringify(stats));
  assert.equal(stats.todo, 1, JSON.stringify(stats));
  assert.equal(stats.fail, 1, JSON.stringify(stats));
  assert.equal(stats.total, 3, JSON.stringify(stats));
  assert.equal(stats.allPass, false);
});

console.log('\n[2] phase-first change selection');

run('多个活跃变更时 phase 指定的 change 优先于 mtime', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  // newer-mtime change created after the phase-named one
  mkChange(dir, 'zzz-latest');
  write(dir, 'openspec/changes/zzz-latest/later.txt', 'later\n');
  const json = runDetect(dir);
  assert.equal(json.change_name, 'add-widget'); // phase beats mtime
  assert.equal(json.signals.phase_state.value.change, 'add-widget');
  assert.equal(json.suggested_phase, 'build');
});

console.log('\n[3] invalid / missing / archive-only phase target');

run('phase JSON 非法 -> 矛盾 + 不自动路由', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  write(dir, '.openflow/phase', '{not valid json');
  const json = runDetect(dir);
  assert.equal(json.signals.phase_state.value, null);
  assert.ok(json.signals.phase_state.error);
  assert.ok(contradictionIds(json).includes('phase-state-invalid'));
  assert.equal(json.suggested_phase, null);
});

run('phase 指向缺失的 change -> 矛盾 + 不自动路由', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'ghost-change', phase: 'build', mode: 'task-build', task: '1' });
  const json = runDetect(dir);
  assert.ok(contradictionIds(json).includes('phase-target-missing'));
  assert.equal(json.suggested_phase, null);
});

run('phase 指向仅归档的 change -> 矛盾 + 不自动路由', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'archive', 'old-change'), { recursive: true });
  setPhase(dir, { version: 1, change: 'old-change', phase: 'close' });
  const json = runDetect(dir);
  assert.ok(contradictionIds(json).includes('phase-target-archived'));
  assert.equal(json.suggested_phase, null);
});

console.log('\n[4] build modes and marker');

run('bootstrap 带 marker -> 路由 build', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap' });
  const json = runDetect(dir);
  assert.equal(json.signals.phase_state.value.mode, 'bootstrap');
  assert.equal(json.suggested_phase, 'build');
  assert.deepEqual(contradictionIds(json), []);
});

run('bootstrap 缺 marker -> bootstrap 生产态冲突矛盾 + 不自动路由', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap' });
  const json = runDetect(dir);
  assert.ok(contradictionIds(json).includes('bootstrap-production-conflict'));
  assert.equal(json.suggested_phase, null);
});

run('task-build 缺 marker/test-plan/plan-ready -> 矛盾 + 不自动路由', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  const json = runDetect(dir);
  assert.ok(contradictionIds(json).includes('task-build-missing-artifacts'));
  assert.equal(json.suggested_phase, null);
});

run('task-build 有 marker+test-plan 但缺 plan-ready -> 矛盾 + 不自动路由', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  const json = runDetect(dir);
  assert.ok(contradictionIds(json).includes('task-build-missing-artifacts'));
  assert.equal(json.suggested_phase, null);
});

run('marker 内容与 phase change 不一致 -> 矛盾 + 不自动路由', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY_MIXED);
  setMarker(dir, 'other-change'); // mismatch with phase change
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  const json = runDetect(dir);
  assert.ok(contradictionIds(json).includes('marker-mismatch'));
  assert.equal(json.suggested_phase, null);
});

console.log('\n[5] amend without/with marker');

run('amend 不带 marker -> 合法，路由 amend', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'amend' });
  const json = runDetect(dir);
  assert.equal(json.suggested_phase, 'amend');
  assert.deepEqual(contradictionIds(json), []);
});

run('amend 带 marker -> 合法，路由 amend', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'amend' });
  const json = runDetect(dir);
  assert.equal(json.suggested_phase, 'amend');
  assert.deepEqual(contradictionIds(json), []);
});

console.log('\n[6] verify receipt routing');

// D1 review fix: receipt-driven verify/close routing applies ONLY to declared
// verify/close phases. Every other declared phase (amend/spec/build) returns
// its declared phase regardless of receipt validity/staleness. For those phases
// the receipt is validated cheaply (shape + HEAD compare, no worktree
// fingerprint), since receipt state cannot affect their routing (I4).

run('phase=verify + 有效 receipt -> 路由 close', () => {
  const dir = makeGitWorkspace('add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'verify' });
  writeValidReceipt(dir, 'add-widget');
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, true);
  assert.equal(json.suggested_phase, 'close');
});

run('phase=verify + stale receipt -> 仍路由 verify（re-verify）', () => {
  const dir = makeGitWorkspace('add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'verify' });
  writeValidReceipt(dir, 'add-widget');
  fs.appendFileSync(path.join(dir, 'src', 'app.js'), '// post-verify edit\n');
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, false);
  assert.ok(contradictionIds(json).includes('receipt-stale'));
  assert.equal(json.suggested_phase, 'verify');
});

run('phase=amend + 有效 receipt -> 仍路由 amend（phase 权威）', () => {
  const dir = makeGitWorkspace('add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'amend' });
  writeValidReceipt(dir, 'add-widget');
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, true);
  assert.equal(json.suggested_phase, 'amend'); // NOT close
});

run('phase=amend + stale receipt（HEAD 变更）-> 仍路由 amend（phase 权威）', () => {
  const dir = makeGitWorkspace('add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'amend' });
  writeValidReceipt(dir, 'add-widget');
  // 非 verify/close 阶段 receipt 走廉价校验（仅 HEAD 比对）：post-receipt commit 使其过期
  write(dir, 'src/extra.js', 'console.log(2);\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'post-receipt']);
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, false);
  assert.ok(contradictionIds(json).includes('receipt-stale'));
  assert.equal(json.suggested_phase, 'amend'); // NOT verify
});

run('非 verify/close 阶段：仅工作区漂移（未提交）-> 廉价校验按 HEAD 判定 pass true', () => {
  const dir = makeGitWorkspace('add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'amend' });
  writeValidReceipt(dir, 'add-widget');
  fs.appendFileSync(path.join(dir, 'src', 'app.js'), '// drift\n'); // 未提交的工作区漂移
  const json = runDetect(dir);
  // 廉价路径不计算 worktree fingerprint，工作区漂移不视为 stale；verify/close 阶段才做完整校验
  assert.equal(json.signals.verify_receipt.value.pass, true, JSON.stringify(json.signals.verify_receipt));
  assert.equal(json.suggested_phase, 'amend');
});

run('phase=spec + 有效 receipt -> 仍路由 spec（phase 权威）', () => {
  const dir = makeGitWorkspace('add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'spec' });
  writeValidReceipt(dir, 'add-widget');
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, true);
  assert.equal(json.suggested_phase, 'spec');
});

run('phase=spec + stale receipt（HEAD 变更）-> 仍路由 spec（phase 权威）', () => {
  const dir = makeGitWorkspace('add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'spec' });
  writeValidReceipt(dir, 'add-widget');
  write(dir, 'src/extra.js', 'console.log(2);\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'post-receipt']);
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, false);
  assert.ok(contradictionIds(json).includes('receipt-stale'));
  assert.equal(json.suggested_phase, 'spec');
});

run('phase=build/task-build + 有效 receipt -> 仍路由 build（phase 权威）', () => {
  const dir = makeGitWorkspace('add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  writeValidReceipt(dir, 'add-widget');
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, true);
  assert.equal(json.suggested_phase, 'build'); // NOT close
});

run('phase=build/task-build + stale receipt（HEAD 变更）-> 仍路由 build（phase 权威）', () => {
  const dir = makeGitWorkspace('add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  writeValidReceipt(dir, 'add-widget');
  write(dir, 'src/extra.js', 'console.log(2);\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'post-receipt']);
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, false);
  assert.ok(contradictionIds(json).includes('receipt-stale'));
  assert.equal(json.suggested_phase, 'build'); // NOT verify
});

run('phase=close + 有效 receipt -> 路由 close', () => {
  const dir = makeGitWorkspace('add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'close' });
  writeValidReceipt(dir, 'add-widget');
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, true);
  assert.equal(json.suggested_phase, 'close');
});

run('close 阶段带无效(malformed) receipt -> 矛盾 + 不自动建议 close', () => {
  const dir = makeGitWorkspace('add-widget');
  write(dir, 'openspec/changes/add-widget/verify-result.json', '{malformed');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'close' });
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, false);
  assert.ok(contradictionIds(json).includes('close-without-current-receipt'));
  assert.equal(json.suggested_phase, null);
});

run('close 阶段带 stale receipt -> 矛盾 + 不自动建议 close', () => {
  const dir = makeGitWorkspace('add-widget');
  write(dir, 'openspec/changes/add-widget/test-plan.md', TEST_PLAN_MIXED);
  write(dir, 'openspec/changes/add-widget/plan-ready.md', PLAN_READY_MIXED);
  setMarker(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'verify' });
  writeValidReceipt(dir, 'add-widget');
  fs.appendFileSync(path.join(dir, 'src', 'app.js'), '// stale\n');
  // explicitly set phase to close with a now-stale receipt
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'close' });
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, false);
  assert.ok(contradictionIds(json).includes('receipt-stale'));
  assert.equal(json.suggested_phase, null);
});

run('close 阶段无 receipt -> 矛盾 + 不自动建议 close', () => {
  const dir = tmpdir();
  mkChange(dir, 'add-widget');
  setPhase(dir, { version: 1, change: 'add-widget', phase: 'close' });
  const json = runDetect(dir);
  assert.equal(json.signals.verify_receipt.value.pass, false);
  assert.ok(contradictionIds(json).includes('close-without-current-receipt'));
  assert.equal(json.suggested_phase, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
