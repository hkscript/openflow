#!/usr/bin/env node
/**
 * Regression + three-way conformance tests for openflow enforcement adapters.
 *
 * Covers:
 *   [1] dependency-check 识别 superpowers 插件形式（不再误报缺失）
 *   [2] writing-plans-gate 防火墙：标记/缺失/排除路径/逃生舱 各场景
 *   [3] 三向一致性矩阵：shared rules / Claude enforce.mjs / OpenCode plugin
 *       对每个 fixture 产出完全相同的 sorted level:id 向量。
 *
 * 用法：先 `pnpm run build`（[1] 依赖 dist/，[3] 依赖 dist/enforce/rules.js 与
 * dist/enforce/opencode.js），再 `pnpm node scripts/test-enforce.mjs`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, '..', 'hooks', 'enforce.mjs');
const DIST_DEP = path.resolve(__dirname, '..', 'dist', 'core', 'dependency-check.js');
const DIST_RULES = path.resolve(__dirname, '..', 'dist', 'enforce', 'rules.js');
const DIST_OPENCODE = path.resolve(__dirname, '..', 'dist', 'enforce', 'opencode.js');

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
  // process.execPath so the hook runs under pnpm's Node 20+, not the system Node.
  const res = spawnSync(process.execPath, [HOOK], {
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
  console.log('  ⏭️  跳过：dist 未构建，请先 `pnpm run build`');
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

// ---- [3] Three-way conformance matrix ----
console.log('\n[3] 三向一致性矩阵 (rules / enforce.mjs / opencode)');

if (!fs.existsSync(DIST_RULES) || !fs.existsSync(DIST_OPENCODE)) {
  console.log('  ⏭️  跳过：dist/enforce 未构建，请先 `pnpm run build`');
} else {
  const rules = await import(pathToFileURL(DIST_RULES).href);
  const opencodePlugin = (await import(pathToFileURL(DIST_OPENCODE).href)).default;

  // ---- fixture helpers ----

  function writeRel(root, rel, content) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  }
  function writePhaseObj(root, obj) {
    return writeRel(root, '.openflow/phase', JSON.stringify(obj));
  }
  function makeChangeDir(root, change = 'add-widget') {
    const d = path.join(root, 'openspec', 'changes', change);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

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
  ].join('\n');

  function makeSelectorWorkspaceInto(root) {
    const changeDir = makeChangeDir(root);
    writeRel(changeDir, 'test-plan.md', TEST_PLAN);
    writeRel(changeDir, 'plan-ready.md', PLAN_READY);
  }

  function setupBuildPhase(root, mode, task) {
    makeSelectorWorkspaceInto(root);
    const st = { version: 1, change: 'add-widget', phase: 'build', mode };
    if (task !== undefined) st.task = task;
    writePhaseObj(root, st);
  }

  const doneComponentTest = [
    "test('adds widget', () => {",
    '  expect(add(1, 2)).toBe(3);',
    '});',
  ].join('\n');

  const stubComponentTest = [
    "test('adds widget', () => {",
    "  // TODO: implement",
    "  assert(false, 'TODO');",
    '});',
  ].join('\n');

  // ---- fixtures ----

  const fixtures = [
    {
      name: 'invalid phase (malformed JSON) writes source',
      setup: (dir) => writeRel(dir, '.openflow/phase', '{bad json'),
      operation: 'write', filePath: 'src/a.ts', content: 'x',
    },
    {
      name: 'phase repair writes .openflow/phase',
      setup: (dir) => writeRel(dir, '.openflow/phase', '{bad json'),
      operation: 'write', filePath: '.openflow/phase', content: '{"version":1}',
    },
    {
      name: 'archived phase (change only in archive)',
      setup: (dir) => {
        fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'archive', 'add-widget'), { recursive: true });
        writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'build', mode: 'bootstrap' });
      },
      operation: 'write', filePath: 'src/a.ts', content: 'x',
    },
    {
      name: 'bootstrap declared test file',
      setup: (dir) => setupBuildPhase(dir, 'bootstrap'),
      operation: 'write', filePath: 'src/component.test.ts', content: 'test',
    },
    {
      name: 'bootstrap undeclared test file',
      setup: (dir) => setupBuildPhase(dir, 'bootstrap'),
      operation: 'write', filePath: 'src/other.test.ts', content: 'test',
    },
    {
      name: 'bootstrap production file',
      setup: (dir) => setupBuildPhase(dir, 'bootstrap'),
      operation: 'write', filePath: 'src/component.ts', content: 'impl',
    },
    {
      name: 'bootstrap declared framework setup (package.json)',
      setup: (dir) => setupBuildPhase(dir, 'bootstrap'),
      operation: 'write', filePath: 'package.json', content: '{}',
    },
    {
      name: 'bootstrap undeclared framework setup (Cargo.toml)',
      setup: (dir) => setupBuildPhase(dir, 'bootstrap'),
      operation: 'write', filePath: 'Cargo.toml', content: '[package]',
    },
    {
      name: 'task-build selector isolation (future task TODO does not block)',
      setup: (dir) => {
        setupBuildPhase(dir, 'task-build', '1');
        writeRel(dir, 'src/component.test.ts', [
          "test('adds widget', () => {",
          '  expect(add(1, 2)).toBe(3);',
          '});',
          "test('removes widget', () => {",
          "  // TODO: implement",
          "  assert(false, 'TODO');",
          '});',
        ].join('\n'));
      },
      operation: 'write', filePath: 'src/component.ts', content: 'impl',
    },
    {
      name: 'task-build current selector unfinished',
      setup: (dir) => {
        setupBuildPhase(dir, 'task-build', '1');
        writeRel(dir, 'src/component.test.ts', stubComponentTest);
      },
      operation: 'write', filePath: 'src/component.ts', content: 'impl',
    },
    {
      name: 'task-build selector test file missing',
      setup: (dir) => setupBuildPhase(dir, 'task-build', '1'),
      operation: 'write', filePath: 'src/component.ts', content: 'impl',
    },
    {
      name: 'task-build marker conflict',
      setup: (dir) => {
        setupBuildPhase(dir, 'task-build', '1');
        writeRel(dir, '.openflow/building', 'other-change');
        writeRel(dir, 'src/component.test.ts', doneComponentTest);
      },
      operation: 'write', filePath: 'src/component.ts', content: 'impl',
    },
    {
      name: 'task-build unique legacy #2',
      setup: (dir) => {
        setupBuildPhase(dir, 'task-build', '2');
        writeRel(dir, 'src/legacy.test.ts', [
          "test('legacy behavior', () => {",
          '  expect(legacy()).toBe(true);',
          '});',
        ].join('\n'));
      },
      operation: 'write', filePath: 'src/legacy.ts', content: 'impl',
    },
    {
      name: 'task-build ambiguous legacy #3',
      setup: (dir) => setupBuildPhase(dir, 'task-build', '3'),
      operation: 'write', filePath: 'src/amb.ts', content: 'impl',
    },
    {
      name: 'no-phase compat TDD stub (writing-plans + tdd-stub)',
      setup: (dir) => {
        makeMarker(dir, 'test-change');
        const changeDir = makeChangeDir(dir, 'test-change');
        writeRel(changeDir, 'test-plan.md', 'T-001: `src/foo.test.ts::test case`');
        writeRel(dir, 'src/foo.test.ts', [
          "test('test case', () => {",
          "  fail('TODO: implement');",
          '});',
        ].join('\n'));
      },
      env: { OPENFLOW_FORCE_WP_MISSING: '1' },
      operation: 'write', filePath: 'src/foo.ts', content: 'impl',
    },
    {
      name: 'no-phase no-read Edit (nonexistent openspec file)',
      setup: () => {},
      operation: 'edit', filePath: 'openspec/changes/x/spec.md', content: 's',
    },
    {
      name: 'no-phase certainty tags (1 Assumption)',
      setup: () => {},
      operation: 'write', filePath: 'openspec/changes/x/plan-ready.md', content: 'a [Assumption] b',
    },
    {
      name: 'no-phase certainty tags (2 Assumptions)',
      setup: () => {},
      operation: 'write', filePath: 'openspec/changes/x/plan-ready.md', content: 'a [Assumption] b [Assumption] c',
    },
    {
      name: 'no-phase writing-plans gate',
      setup: (dir) => makeMarker(dir, 'test-change'),
      env: { OPENFLOW_FORCE_WP_MISSING: '1' },
      operation: 'write', filePath: 'src/foo.ts', content: 'x',
    },
    {
      name: 'proposal phase writes proposal.md',
      setup: (dir) => { makeChangeDir(dir); writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'proposal' }); },
      operation: 'write', filePath: 'openspec/changes/add-widget/proposal.md', content: 'p',
    },
    {
      name: 'proposal phase writes source',
      setup: (dir) => { makeChangeDir(dir); writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'proposal' }); },
      operation: 'write', filePath: 'src/a.ts', content: 'x',
    },
    {
      name: 'verify phase writes verify-result.json',
      setup: (dir) => { makeChangeDir(dir); writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'verify' }); },
      operation: 'write', filePath: 'openspec/changes/add-widget/verify-result.json', content: '{}',
    },
    {
      name: 'verify phase writes source',
      setup: (dir) => { makeChangeDir(dir); writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'verify' }); },
      operation: 'write', filePath: 'src/a.ts', content: 'x',
    },
    {
      name: 'close phase writes lessons.md',
      setup: (dir) => { makeChangeDir(dir); writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'close' }); },
      operation: 'write', filePath: 'openspec/changes/add-widget/lessons.md', content: 'l',
    },
    {
      name: 'close phase writes source',
      setup: (dir) => { makeChangeDir(dir); writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'close' }); },
      operation: 'write', filePath: 'src/a.ts', content: 'x',
    },
    {
      name: 'nested Claude payload (tool_input + new_string)',
      setup: (dir) => { makeChangeDir(dir); writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'proposal' }); },
      claudeForm: 'nested', claudeNewString: true,
      operation: 'write', filePath: 'src/a.ts', content: 'n',
    },
    {
      name: 'OpenCode call.input (filePath + new_string)',
      setup: (dir) => { makeChangeDir(dir); writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'proposal' }); },
      opFileKey: 'filePath', opNewString: true,
      operation: 'write', filePath: 'src/a.ts', content: 'v',
    },
    {
      name: 'OPENFLOW_NO_BUILD_GATE does not bypass phase boundary',
      setup: (dir) => { makeChangeDir(dir); writePhaseObj(dir, { version: 1, change: 'add-widget', phase: 'proposal' }); },
      env: { OPENFLOW_NO_BUILD_GATE: '1' },
      operation: 'write', filePath: 'src/a.ts', content: 'x',
    },
    {
      name: 'no-phase design.md certainty (1 Assumption, warning-only)',
      setup: () => {},
      operation: 'write', filePath: 'openspec/changes/x/design.md', content: 'a [Assumption] b',
    },
    {
      name: 'no-phase design.md certainty (2 Assumptions, warning-only)',
      setup: () => {},
      operation: 'write', filePath: 'openspec/changes/x/design.md', content: 'a [Assumption] b [Assumption] c',
    },
  ];

  // ---- payload builders + vector extractors ----

  function buildClaudePayload(f) {
    const toolName = f.operation === 'edit' ? 'Edit' : 'Write';
    const fields = { file_path: f.filePath };
    if (f.claudeNewString) fields.new_string = f.content;
    else fields.content = f.content;
    if (f.claudeForm === 'nested') return { tool_name: toolName, tool_input: fields };
    return { tool_name: toolName, ...fields };
  }

  function buildOpenCodeInput(f) {
    const fields = { [f.opFileKey || 'file_path']: f.filePath };
    if (f.opNewString) fields.new_string = f.content;
    else fields.content = f.content;
    return fields;
  }

  function extractClaudeIds(stdout) {
    const ids = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(❌|⚠️) \[openflow 防火墙: ([a-z0-9-]+)\]/);
      if (!m) continue;
      ids.push(`${m[1] === '❌' ? 'block' : 'warn'}:${m[2]}`);
    }
    return ids.sort();
  }

  function extractOpenCodeIds(output, warns) {
    const ids = [];
    if (output.abort) {
      for (const seg of output.abort.split('; ')) {
        const m = seg.match(/^\[([a-z0-9-]+)\]/);
        if (m) ids.push(`block:${m[1]}`);
      }
    }
    for (const w of warns) {
      const m = w.match(/\[openflow 防火墙: ([a-z0-9-]+)\]/);
      if (m) ids.push(`warn:${m[1]}`);
    }
    return ids.sort();
  }

  async function withEnv(env, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  async function runOpenCodeVector(f, dir) {
    const origCwd = process.cwd();
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warns.push(args.map(String).join(' ')); };
    const output = {};
    process.chdir(dir);
    try {
      await opencodePlugin['tool.execute.before'](
        { call: { name: f.operation, input: buildOpenCodeInput(f) } },
        output,
      );
    } finally {
      process.chdir(origCwd);
      console.warn = origWarn;
    }
    return extractOpenCodeIds(output, warns);
  }

  // ---- run the matrix ----

  for (const f of fixtures) {
    const dir = makeTempDir();
    try {
      f.setup(dir);
      const env = f.env || {};

      const expected = await withEnv(env, () =>
        rules.runAllChecks({ operation: f.operation, filePath: f.filePath, content: f.content, cwd: dir })
          .map((r) => `${r.level}:${r.id}`)
          .sort(),
      );

      const claude = extractClaudeIds(
        runHook(buildClaudePayload(f), { cwd: dir, env }).stdout,
      );

      const opencode = await withEnv(env, () => runOpenCodeVector(f, dir));

      assert.deepEqual(claude, expected, `${f.name}: claude vector`);
      assert.deepEqual(opencode, expected, `${f.name}: opencode vector`);
      ok(f.name, true);
    } catch (e) {
      ok(f.name, false, e && e.message ? e.message : e);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
