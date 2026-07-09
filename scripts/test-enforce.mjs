#!/usr/bin/env node
/**
 * Regression tests for openflow enforcement hook + writing-plans detection.
 *
 * Covers:
 *   [1] dependency-check 识别 superpowers 插件形式（不再误报缺失）
 *   [2] writing-plans-gate 防火墙：标记/缺失/排除路径/逃生舱 各场景
 *
 * 用法：先 `npm run build`（[1] 依赖 dist/），再 `node scripts/test-enforce.mjs`。
 * 自包含：[2] 用本地伪 SKILL.md 模拟 available、用 OPENFLOW_FORCE_WP_MISSING 模拟缺失，
 * 不依赖真实 superpowers 是否安装。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, '..', 'hooks', 'enforce.mjs');
const DIST_DEP = path.resolve(__dirname, '..', 'dist', 'core', 'dependency-check.js');

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

function runHook(payload, { cwd, env = {} } = {}) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd,
    env: { ...process.env, ...env },
  });
  return {
    code: res.status,
    stdout: res.stdout?.toString('utf-8') ?? '',
    stderr: res.stderr?.toString('utf-8') ?? '',
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openflow-enforce-'));
}

function makeMarker(dir, change = 'test-change') {
  fs.mkdirSync(path.join(dir, '.openflow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.openflow', 'building'), change);
}

function makeFakeSkill(dir) {
  // 本地伪 writing-plans skill，让 isWritingPlansAvailable 命中（不依赖真实插件）
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'writing-plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'writing-plans', 'SKILL.md'), '# fake');
}

const srcPayload = { tool_name: 'Edit', file_path: 'src/foo.js', content: 'x' };

// ---- [1] CLI detection: plugin form recognized ----
console.log('\n[1] writing-plans 插件形式检测 (dependency-check)');
if (!fs.existsSync(DIST_DEP)) {
  console.log('  ⏭️  跳过：dist 未构建，请先 `npm run build`');
} else {
  try {
    const { checkDependencies } = await import(DIST_DEP);
    const dep = checkDependencies({ cwd: process.cwd() });
    if (!dep.superpowers.installed) {
      console.log('  ⏭️  跳过：本机未安装 superpowers（skill/插件均无），无法验证插件检测');
    } else {
      ok('superpowers.installed === true', dep.superpowers.installed === true);
      ok('path 指向 superpowers', /superpowers/.test(dep.superpowers.path ?? ''), `path=${dep.superpowers.path}`);
      ok('checkedPaths 含插件候选', (dep.superpowers.checkedPaths ?? []).some((p) => /installed_plugins|superpowers/.test(p)), `paths=${JSON.stringify(dep.superpowers.checkedPaths)}`);
    }
  } catch (e) {
    ok('检测模块加载/运行', false, e.message);
  }
}

// ---- [2] Hook gate behavior ----
console.log('\n[2] writing-plans-gate 防火墙行为 (enforce.mjs)');

// 2a. 无标记 -> 不拦
{
  const dir = makeTempDir();
  const r = runHook(srcPayload, { cwd: dir, env: { OPENFLOW_FORCE_WP_MISSING: '1' } });
  ok('无标记 -> exit 0', r.code === 0, `code=${r.code}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2b. 有标记 + writing-plans 可用（伪本地 skill） -> 不拦
{
  const dir = makeTempDir();
  makeMarker(dir);
  makeFakeSkill(dir);
  const r = runHook(srcPayload, { cwd: dir });
  ok('有标记 + writing-plans 可用 -> exit 0', r.code === 0, `code=${r.code} stdout=${r.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2c. 有标记 + 缺失 + 源码 -> 阻断
{
  const dir = makeTempDir();
  makeMarker(dir);
  const r = runHook(srcPayload, { cwd: dir, env: { OPENFLOW_FORCE_WP_MISSING: '1' } });
  ok('有标记 + 缺失 + 源码 -> exit 1', r.code === 1, `code=${r.code}`);
  ok('阻断文案含 writing-plans-gate', /writing-plans-gate/.test(r.stdout), `stdout=${r.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2d. 有标记 + 缺失 + openspec 路径 -> 不拦（排除）
{
  const dir = makeTempDir();
  makeMarker(dir);
  // 创建该 openspec 文件，避免触发防火墙 1 (no-read-no-use)，以隔离 writing-plans-gate
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec', 'changes', 'x', 'spec.md'), 'spec');
  const r = runHook(
    { tool_name: 'Edit', file_path: 'openspec/changes/x/spec.md', content: 'y' },
    { cwd: dir, env: { OPENFLOW_FORCE_WP_MISSING: '1' } }
  );
  ok('有标记 + 缺失 + openspec 路径 -> exit 0（排除）', r.code === 0, `code=${r.code} stdout=${r.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2e. 有标记 + 缺失 + .openflow 路径 -> 不拦（标记管理）
{
  const dir = makeTempDir();
  makeMarker(dir);
  const r = runHook(
    { tool_name: 'Write', file_path: '.openflow/building', content: 'z' },
    { cwd: dir, env: { OPENFLOW_FORCE_WP_MISSING: '1' } }
  );
  ok('有标记 + 缺失 + .openflow 路径 -> exit 0（标记管理）', r.code === 0, `code=${r.code} stdout=${r.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2f. 逃生舱 OPENFLOW_NO_BUILD_GATE -> 不拦
{
  const dir = makeTempDir();
  makeMarker(dir);
  const r = runHook(srcPayload, {
    cwd: dir,
    env: { OPENFLOW_FORCE_WP_MISSING: '1', OPENFLOW_NO_BUILD_GATE: '1' },
  });
  ok('逃生舱 OPENFLOW_NO_BUILD_GATE -> exit 0', r.code === 0, `code=${r.code} stdout=${r.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2g. 非 Edit/Write 工具 -> 提前 exit 0
{
  const dir = makeTempDir();
  makeMarker(dir);
  const r = runHook(
    { tool_name: 'Bash', file_path: 'src/foo.js', content: 'x' },
    { cwd: dir, env: { OPENFLOW_FORCE_WP_MISSING: '1' } }
  );
  ok('非 Edit/Write 工具 -> exit 0', r.code === 0, `code=${r.code}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2h. docs/superpowers 计划产物路径 -> 不拦（排除）
{
  const dir = makeTempDir();
  makeMarker(dir);
  const r = runHook(
    { tool_name: 'Write', file_path: 'docs/superpowers/plans/2026-01-01-x.md', content: 'plan' },
    { cwd: dir, env: { OPENFLOW_FORCE_WP_MISSING: '1' } }
  );
  ok('有标记 + 缺失 + docs/superpowers 路径 -> exit 0（计划产物）', r.code === 0, `code=${r.code} stdout=${r.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
