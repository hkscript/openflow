#!/usr/bin/env node
/**
 * Contract fixtures for src/enforce/rules.ts — Task 1 of the phase lifecycle plan.
 *
 * Covers:
 *   [1] normalizeToolInput   — Claude top-level, Claude nested tool_input, OpenCode call.input variants
 *   [2] toWorkspaceRelativePath — separators, .., absolute in/out, file://, drive/UNC, new Write targets, symlink parent escape
 *   [3] readPhaseState       — absent, malformed, version/change/phase, mode/task shape, active/archive change dir
 *   [4] resolveCurrentTask   — task-build only, stable T-XXX + legacy #N, ambiguity/dedup fail-closed
 *   [5] runAllChecks         — invalid-state repair-only, bootstrap restrictions, selector isolation, legacy
 *   [6] compatibility        — phase absent: retain no-read/certainty/writing-plan and old global TDD scan
 *
 * 用法：先 `pnpm run build`，再 `pnpm node scripts/test-enforce-rules.mjs`。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Assert Node 20+ immediately.
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`需要 Node 20+，当前 ${process.versions.node}`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_RULES = path.resolve(__dirname, '..', 'dist', 'enforce', 'rules.js');
const rules = await import(pathToFileURL(DIST_RULES).href);

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openflow-rules-'));
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function writePhase(root, obj) {
  write(root, '.openflow/phase', typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function makeChange(root, change = 'add-widget') {
  fs.mkdirSync(path.join(root, 'openspec', 'changes', change), { recursive: true });
  return path.join(root, 'openspec', 'changes', change);
}

// Standard test-plan + plan-ready for selector fixtures.
const TEST_PLAN = [
  'T-001: `src/component.test.ts::adds widget`',
  'T-002: `src/component.test.ts::removes widget`',
  '#2: `src/legacy.test.ts::legacy behavior`',
  '#3: `src/amb-a.test.ts::ambiguous a`',
  '#3: `src/amb-b.test.ts::ambiguous b`',
  'T-005: `src/dup.test.ts::dup case`',
  'T-006: `src/dup.test.ts::dup case`',
].join('\n');

const PLAN_READY = [
  '### Task 1: 组件实现',
  '',
  '- Test cases: T-001',
  '- Files: `src/component.ts`, `src/component.test.ts`',
  '- Test framework setup: package.json',
  '',
  '### Task 2: 旧用例迁移',
  '',
  '- Test cases: #2',
  '- Files: `src/legacy.ts`, `src/legacy.test.ts`',
  '- Test framework setup: pom.xml',
  '',
  '### Task 3: 歧义旧用例',
  '',
  '- Test cases: #3',
  '- Files: `src/amb.ts`',
  '',
  '### Task 4: 混合引用',
  '',
  '- Test cases: T-001, #2',
  '- Files: `src/mixed.ts`',
  '',
  '### Task 5: 重复 ID',
  '',
  '- Test cases: T-001, T-001',
  '- Files: `src/dup-id.ts`',
  '',
  '### Task 6: 重复选择器归属',
  '',
  '- Test cases: T-005',
  '- Files: `src/dup.ts`',
  '',
  '### Task 7: 未匹配引用',
  '',
  '- Test cases: T-999',
  '- Files: `src/nope.ts`',
].join('\n');

function makeSelectorWorkspace() {
  const dir = tmpdir();
  const changeDir = makeChange(dir);
  write(changeDir, 'test-plan.md', TEST_PLAN);
  write(changeDir, 'plan-ready.md', PLAN_READY);
  return dir;
}

console.log('\n[1] normalizeToolInput 载荷归一化');
run('Claude 顶层 Edit', () => {
  assert.deepEqual(rules.normalizeToolInput({ tool_name: 'Edit', file_path: 'src/a.ts', content: 'x' }, '/cwd'), {
    operation: 'edit', filePath: 'src/a.ts', content: 'x', cwd: '/cwd',
  });
});
run('Claude 顶层 Write (toolName/filePath)', () => {
  assert.deepEqual(rules.normalizeToolInput({ toolName: 'Write', filePath: 'src/b.ts', new_string: 'y' }, '/cwd'), {
    operation: 'write', filePath: 'src/b.ts', content: 'y', cwd: '/cwd',
  });
});
run('Claude 嵌套 tool_input', () => {
  assert.deepEqual(rules.normalizeToolInput({ tool_name: 'Edit', tool_input: { file_path: 'src/c.ts', content: 'z' } }, '/cwd'), {
    operation: 'edit', filePath: 'src/c.ts', content: 'z', cwd: '/cwd',
  });
});
run('Claude 嵌套 tool_input.new_string', () => {
  assert.deepEqual(rules.normalizeToolInput({ tool_name: 'Write', tool_input: { file_path: 'src/f.ts', new_string: 'n' } }, '/cwd'), {
    operation: 'write', filePath: 'src/f.ts', content: 'n', cwd: '/cwd',
  });
});
run('OpenCode call.input (call.name + file_path)', () => {
  assert.deepEqual(rules.normalizeToolInput({ call: { name: 'edit', input: { file_path: 'src/d.ts', content: 'w' } } }, '/cwd'), {
    operation: 'edit', filePath: 'src/d.ts', content: 'w', cwd: '/cwd',
  });
});
run('OpenCode call.input (call.toolName + filePath + new_string)', () => {
  assert.deepEqual(rules.normalizeToolInput({ call: { toolName: 'write', input: { filePath: 'src/e.ts', new_string: 'v' } } }, '/cwd'), {
    operation: 'write', filePath: 'src/e.ts', content: 'v', cwd: '/cwd',
  });
});
run('非 Edit/Write 工具 -> null', () => {
  assert.equal(rules.normalizeToolInput({ tool_name: 'Bash', file_path: 'src/a.ts', content: 'x' }, '/cwd'), null);
});
run('缺 filePath -> null', () => {
  assert.equal(rules.normalizeToolInput({ tool_name: 'Edit', content: 'x' }, '/cwd'), null);
});
run('非对象 payload -> null', () => {
  assert.equal(rules.normalizeToolInput(null, '/cwd'), null);
});

console.log('\n[2] toWorkspaceRelativePath 路径安全');
{
  const cwd = tmpdir();
  run('反斜杠分隔符归一化', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath('packages\\app/src/a.ts', cwd), {
      ok: true, relative: 'packages/app/src/a.ts',
    });
  });
  run('相对 .. 越界 -> traversal', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath('../src/a.ts', cwd), {
      ok: false, reason: 'traversal',
    });
  });
  run('空串 -> empty', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath('', cwd), { ok: false, reason: 'empty' });
  });
  run('绝对 in-workspace -> relative', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath(path.join(cwd, 'src/a.ts'), cwd), {
      ok: true, relative: 'src/a.ts',
    });
  });
  run('绝对 outside -> outside-workspace', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath(path.join(cwd, '..', 'outside', 'x.ts'), cwd), {
      ok: false, reason: 'outside-workspace',
    });
  });
  run('file:// URL -> unsupported-path', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath('file:///etc/passwd', cwd), {
      ok: false, reason: 'unsupported-path',
    });
  });
  run('Windows drive -> unsupported-path', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath('C:\\Users\\me\\a.ts', cwd), {
      ok: false, reason: 'unsupported-path',
    });
  });
  run('UNC -> unsupported-path', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath('\\\\server\\share\\a.ts', cwd), {
      ok: false, reason: 'unsupported-path',
    });
  });
  run('不存在的 Write 目标（父目录也不存在）-> ok', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath('new-dir/sub/file.ts', cwd), {
      ok: true, relative: 'new-dir/sub/file.ts',
    });
  });
  run('symlink 父目录逃逸 -> outside-workspace', () => {
    const outside = tmpdir();
    fs.symlinkSync(outside, path.join(cwd, 'escape'));
    assert.deepEqual(rules.toWorkspaceRelativePath('escape/evil.ts', cwd), {
      ok: false, reason: 'outside-workspace',
    });
  });
  run('symlink 环 realpath 失败 -> fail closed outside-workspace', () => {
    // self-referential loop: realpath must throw ELOOP, and we must fail closed,
    // not fall back to lexical containment (F1).
    fs.symlinkSync('loop', path.join(cwd, 'loop'));
    assert.deepEqual(rules.toWorkspaceRelativePath('loop/evil.ts', cwd), {
      ok: false, reason: 'outside-workspace',
    });
  });
  run('Windows drive 无分隔符 C:foo.txt -> unsupported-path', () => {
    assert.deepEqual(rules.toWorkspaceRelativePath('C:foo.txt', cwd), {
      ok: false, reason: 'unsupported-path',
    });
  });
}

console.log('\n[3] readPhaseState 阶段解析');
{
  const dir = tmpdir();
  run('无 .openflow/phase -> state null error null', () => {
    assert.deepEqual(rules.readPhaseState(dir), { state: null, error: null });
  });
}
{
  const dir = tmpdir();
  writePhase(dir, '{bad json');
  run('malformed JSON -> error', () => {
    assert.notEqual(rules.readPhaseState(dir).error, null);
  });
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap' });
  run('合法 bootstrap -> state ok', () => {
    const r = rules.readPhaseState(dir);
    assert.equal(r.error, null);
    assert.equal(r.state.phase, 'build');
    assert.equal(r.state.mode, 'bootstrap');
  });
  run('合法 bootstrap 不携带 task', () => {
    const r = rules.readPhaseState(dir);
    assert.equal(r.state.task, undefined);
  });
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  run('合法 task-build -> state ok', () => {
    const r = rules.readPhaseState(dir);
    assert.equal(r.error, null);
    assert.equal(r.state.mode, 'task-build');
    assert.equal(r.state.task, '1');
  });
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 2, change: 'add-widget', phase: 'build', mode: 'bootstrap' });
  run('version=2 -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'Add Widget', phase: 'build', mode: 'bootstrap' });
  run('非法 change 名（大写/空格）-> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add_widget', phase: 'build', mode: 'bootstrap' });
  run('非法 change 名（下划线）-> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'foo', mode: 'bootstrap' });
  run('非法 phase -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap' });
  run('active change 目录缺失 -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'archive', 'add-widget'), { recursive: true });
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap' });
  run('archive-only change -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build' });
  run('build 缺 mode -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap', task: '1' });
  run('bootstrap 携带 task -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build' });
  run('task-build 缺 task -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'spec', mode: 'bootstrap' });
  run('非 build phase 携带 mode -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'spec', task: '1' });
  run('非 build phase 携带 task -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 123 });
  run('非字符串 mode -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: 456 });
  run('非字符串 task -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}
{
  const dir = tmpdir();
  makeChange(dir);
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'spec', mode: 123 });
  run('非字符串 mode 即便非 build -> error', () => assert.notEqual(rules.readPhaseState(dir).error, null));
}

console.log('\n[4] resolveCurrentTask 选择器解析');
{
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  let state = null;
  try { state = rules.readPhaseState(dir).state; } catch { state = null; }
  run('task 1 稳定 T-001 解析', () => {
    const r = rules.resolveCurrentTask(dir, state);
    assert.equal(r.error, null);
    assert.equal(r.task.id, '1');
    assert.deepEqual(r.task.testIds, ['T-001']);
    assert.deepEqual(r.task.declaredFiles, ['src/component.ts', 'src/component.test.ts']);
    assert.deepEqual(r.task.frameworkSetupFiles, ['package.json']);
    assert.deepEqual(r.task.selectors, [{
      id: 'T-001', file: 'src/component.test.ts', selector: 'src/component.test.ts::adds widget',
    }]);
  });
  run('task 2 唯一 legacy #2 解析', () => {
    const st = { ...state, task: '2' };
    const r = rules.resolveCurrentTask(dir, st);
    assert.equal(r.error, null);
    assert.deepEqual(r.task.selectors, [{
      id: '#2', file: 'src/legacy.test.ts', selector: 'src/legacy.test.ts::legacy behavior',
    }]);
    assert.deepEqual(r.task.frameworkSetupFiles, ['pom.xml']);
  });
  run('task 3 歧义 legacy #3 -> error', () => {
    const st = { ...state, task: '3' };
    const r = rules.resolveCurrentTask(dir, st);
    assert.notEqual(r.error, null);
  });
  run('task 4 混合引用形式 -> error', () => {
    const st = { ...state, task: '4' };
    const r = rules.resolveCurrentTask(dir, st);
    assert.notEqual(r.error, null);
  });
  run('task 5 重复 ID -> error', () => {
    const st = { ...state, task: '5' };
    const r = rules.resolveCurrentTask(dir, st);
    assert.notEqual(r.error, null);
  });
  run('task 6 重复选择器归属 -> error', () => {
    const st = { ...state, task: '6' };
    const r = rules.resolveCurrentTask(dir, st);
    assert.notEqual(r.error, null);
  });
  run('task 7 未匹配引用 -> error', () => {
    const st = { ...state, task: '7' };
    const r = rules.resolveCurrentTask(dir, st);
    assert.notEqual(r.error, null);
    assert.match(r.error, /tdd-task-unmapped/);
  });
  run('非 task-build -> task null error', () => {
    const st = { ...state, mode: 'bootstrap' };
    const r = rules.resolveCurrentTask(dir, st);
    assert.equal(r.task, null);
    assert.notEqual(r.error, null);
  });
}

console.log('\n[5] runAllChecks 阶段策略与选择器隔离');
{
  // 5a. invalid phase state -> 仅 .openflow/phase 可写
  const dir = tmpdir();
  writePhase(dir, '{bad');
  run('invalid state 写 src/a.ts -> block invalid-phase-state', () => {
    const input = { operation: 'write', filePath: 'src/a.ts', content: 'x', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'invalid-phase-state'));
  });
  run('invalid state 写 .openflow/phase -> 放行', () => {
    const input = { operation: 'write', filePath: '.openflow/phase', content: '{}', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.id === 'invalid-phase-state'));
  });
}
{
  // 5b. bootstrap 限制：只写 test-plan 声明的测试 + 声明式框架配置文件；禁生产
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap' });
  let st = null;
  try { st = rules.readPhaseState(dir); } catch { st = null; }
  run('bootstrap 阶段状态合法', () => {
    assert.equal(st.error, null);
  });
  run('bootstrap 写 test-plan 声明的测试文件 -> 放行', () => {
    const input = { operation: 'write', filePath: 'src/component.test.ts', content: 'test', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
  run('bootstrap 写声明式 package.json -> 放行', () => {
    const input = { operation: 'write', filePath: 'package.json', content: '{}', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
  run('bootstrap 写未声明 Cargo.toml -> block', () => {
    const input = { operation: 'write', filePath: 'Cargo.toml', content: '[package]', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
  run('bootstrap 写生产文件 -> block phase-boundary', () => {
    const input = { operation: 'write', filePath: 'src/component.ts', content: 'impl', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'phase-boundary'), JSON.stringify(rs));
  });
  run('bootstrap 写未声明的 test-plan.md -> block phase-boundary', () => {
    // F2: bootstrap allows only declared test selectors + declared framework setup, not broad change docs
    const input = { operation: 'write', filePath: 'openspec/changes/add-widget/test-plan.md', content: 't', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'phase-boundary'), JSON.stringify(rs));
  });
}
{
  // 5c. task-build 选择器隔离：未来 task 的 TODO 不得阻断当前 task
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  write(dir, 'src/component.test.ts', [
    "test('adds widget', () => {",
    '  expect(add(1, 2)).toBe(3);',
    '});',
    "test('removes widget', () => {",
    "  // TODO: implement",
    "  assert(false, 'TODO');",
    '});',
  ].join('\n'));
  run('task 1 写生产文件，仅查 T-001 区域，未来 task 的 TODO 不阻断', () => {
    const input = { operation: 'write', filePath: 'src/component.ts', content: 'impl', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
  run('task 1 写测试文件区域 -> 放行', () => {
    const input = { operation: 'write', filePath: 'src/component.test.ts', content: 'test', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
  run('task 1 写未声明的 tasks.md -> block phase-boundary', () => {
    // F2: task-build allows only declared files + selector regions, not broad change docs
    const input = { operation: 'write', filePath: 'openspec/changes/add-widget/tasks.md', content: 't', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'phase-boundary'), JSON.stringify(rs));
  });
}
{
  // 5c2. task-build 选择器路径越界 -> 在读选择器文件前先做 workspace 包含性校验
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  // 故意让 test-plan 选择器指向工作区之外
  write(dir, 'openspec/changes/add-widget/test-plan.md', 'T-001: `../evil.test.ts::evil test`');
  const evil = path.join(path.dirname(dir), 'evil.test.ts');
  fs.writeFileSync(evil, "test('evil test', () => { expect(1).toBe(1); });\n");
  run('task 1 选择器路径越界 -> block tdd-test-file-missing', () => {
    const input = { operation: 'write', filePath: 'src/component.ts', content: 'impl', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'tdd-test-file-missing'), JSON.stringify(rs));
  });
}
{
  // 5c3. 选择器区域精确匹配：同名子串出现在其他测试的 TODO 不得误报当前选择器
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  write(dir, 'src/component.test.ts', [
    "test('adds widget synchronously', () => {",
    "  // TODO: implement",
    "  assert(false, 'TODO');",
    '});',
    "test('adds widget', () => {",
    '  expect(add(1, 2)).toBe(3);',
    '});',
  ].join('\n'));
  run('task 1 精确选择器区域已完成，子串测试的 TODO 不误报', () => {
    const input = { operation: 'write', filePath: 'src/component.ts', content: 'impl', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
}
{
  // 5d. 当前任务选择器区域未完成 -> tdd-stub-check
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  write(dir, 'src/component.test.ts', [
    "test('adds widget', () => {",
    "  // TODO: implement",
    "  assert(false, 'TODO');",
    '});',
  ].join('\n'));
  run('task 1 当前选择器 TODO 桩 -> block tdd-stub-check', () => {
    const input = { operation: 'write', filePath: 'src/component.ts', content: 'impl', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'tdd-stub-check'), JSON.stringify(rs));
  });
}
{
  // 5e. 当前选择器测试文件缺失 -> tdd-test-file-missing
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  run('task 1 选择器测试文件缺失 -> block tdd-test-file-missing', () => {
    const input = { operation: 'write', filePath: 'src/component.ts', content: 'impl', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'tdd-test-file-missing'), JSON.stringify(rs));
  });
}
{
  // 5f. 唯一 legacy 兼容
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '2' });
  write(dir, 'src/legacy.test.ts', [
    "test('legacy behavior', () => {",
    '  expect(legacy()).toBe(true);',
    '});',
  ].join('\n'));
  run('task 2 唯一 legacy #2 -> 生产写放行', () => {
    const input = { operation: 'write', filePath: 'src/legacy.ts', content: 'impl', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
}
{
  // 5g. 歧义 legacy 拒绝
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '3' });
  run('task 3 歧义 legacy -> block tdd-task-unmapped', () => {
    const input = { operation: 'write', filePath: 'src/amb.ts', content: 'impl', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'tdd-task-unmapped'), JSON.stringify(rs));
  });
}
{
  // 5h. marker/change 不一致 -> change-state-conflict
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' });
  write(dir, '.openflow/building', 'other-change');
  write(dir, 'src/component.test.ts', [
    "test('adds widget', () => {",
    '  expect(add(1, 2)).toBe(3);',
    '});',
  ].join('\n'));
  run('task-build marker 与 phase change 不一致 -> block change-state-conflict', () => {
    const input = { operation: 'write', filePath: 'src/component.ts', content: 'impl', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'change-state-conflict'), JSON.stringify(rs));
  });
}
{
  // 5i. proposal / verify / close 阶段边界
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'proposal' });
  run('proposal 写 proposal.md -> 放行', () => {
    const input = { operation: 'write', filePath: 'openspec/changes/add-widget/proposal.md', content: 'p', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
  run('proposal 写其他文件 -> block', () => {
    const input = { operation: 'write', filePath: 'src/a.ts', content: 'x', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
}
{
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'verify' });
  run('verify 写 verify-result.json -> 放行', () => {
    const input = { operation: 'write', filePath: 'openspec/changes/add-widget/verify-result.json', content: '{}', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
  run('verify 写生产文件 -> block', () => {
    const input = { operation: 'write', filePath: 'src/a.ts', content: 'x', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
}
{
  const dir = makeSelectorWorkspace();
  writePhase(dir, { version: 1, change: 'add-widget', phase: 'close' });
  run('close 写 lessons.md -> 放行', () => {
    const input = { operation: 'write', filePath: 'openspec/changes/add-widget/lessons.md', content: 'l', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
  run('close 写生产文件 -> block', () => {
    const input = { operation: 'write', filePath: 'src/a.ts', content: 'x', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
}

console.log('\n[6] 兼容模式（无 phase）保留旧检查');
{
  const dir = tmpdir();
  run('无 phase 写 plan-ready 含 [Assumption] -> warn certainty-tags', () => {
    const input = { operation: 'write', filePath: 'openspec/changes/x/plan-ready.md', content: 'a [Assumption] b', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.id === 'certainty-tags'), JSON.stringify(rs));
  });
}
{
  const dir = tmpdir();
  run('无 phase 写 design.md 含 1 个 [Assumption] -> warn certainty-tags', () => {
    const input = { operation: 'write', filePath: 'openspec/changes/x/design.md', content: 'a [Assumption] b', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.id === 'certainty-tags' && r.level === 'warn'), JSON.stringify(rs));
  });
}
{
  const dir = tmpdir();
  run('无 phase 写 design.md 含 2 个 [Assumption] -> 仍为 warn（不 block）', () => {
    const input = { operation: 'write', filePath: 'openspec/changes/x/design.md', content: 'a [Assumption] b [Assumption] c', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.id === 'certainty-tags' && r.level === 'warn'), JSON.stringify(rs));
    assert.ok(!rs.some((r) => r.level === 'block'), JSON.stringify(rs));
  });
}
{
  const dir = tmpdir();
  write(dir, '.openflow/building', 'test-change');
  run('无 phase + building 标记 + 缺 writing-plans -> block writing-plans-gate', () => {
    const before = process.env.OPENFLOW_FORCE_WP_MISSING;
    process.env.OPENFLOW_FORCE_WP_MISSING = '1';
    try {
      const input = { operation: 'write', filePath: 'src/foo.ts', content: 'x', cwd: dir };
      const rs = rules.runAllChecks(input);
      assert.ok(rs.some((r) => r.level === 'block' && r.id === 'writing-plans-gate'), JSON.stringify(rs));
    } finally {
      if (before === undefined) delete process.env.OPENFLOW_FORCE_WP_MISSING;
      else process.env.OPENFLOW_FORCE_WP_MISSING = before;
    }
  });
}
{
  const dir = tmpdir();
  write(dir, '.openflow/building', 'test-change');
  const changeDir = makeChange(dir, 'test-change');
  write(changeDir, 'test-plan.md', 'T-001: `src/foo.test.ts::test case`');
  write(dir, 'src/foo.test.ts', [
    "test('test case', () => {",
    "  fail('TODO: implement');",
    '});',
  ].join('\n'));
  run('无 phase + building 标记 + 旧全局 TDD 扫描 TODO -> block tdd-stub-check', () => {
    const before = process.env.OPENFLOW_FORCE_WP_MISSING;
    process.env.OPENFLOW_FORCE_WP_MISSING = '1';
    try {
      const input = { operation: 'write', filePath: 'src/foo.ts', content: 'impl', cwd: dir };
      const rs = rules.runAllChecks(input);
      assert.ok(rs.some((r) => r.level === 'block' && r.id === 'tdd-stub-check'), JSON.stringify(rs));
    } finally {
      if (before === undefined) delete process.env.OPENFLOW_FORCE_WP_MISSING;
      else process.env.OPENFLOW_FORCE_WP_MISSING = before;
    }
  });
}
{
  const dir = tmpdir();
  run('无 phase Edit 不存在的 openspec 文件 -> block no-read-no-use', () => {
    const input = { operation: 'edit', filePath: 'openspec/changes/x/spec.md', content: 's', cwd: dir };
    const rs = rules.runAllChecks(input);
    assert.ok(rs.some((r) => r.level === 'block' && r.id === 'no-read-no-use'), JSON.stringify(rs));
  });
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
