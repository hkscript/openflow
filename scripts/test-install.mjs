#!/usr/bin/env node
/**
 * Local/global Claude/OpenCode installation, config merge/idempotency, and
 * installed-artifact runtime fixtures — Task 6 of the phase lifecycle plan.
 *
 * Covers:
 *   [1] local install — all Claude + OpenCode artifacts copied
 *   [2] global install (isolated HOME) — artifacts under ~/.claude and ~/.config/opencode
 *   [3] config merge — third-party preservation, legacy .py hook cleanup,
 *       OpenFlow plugin URL canonicalization + dedup, byte-stable idempotency
 *   [4] installed runtime behavior — hook/plugin/gate/detect against a phase fixture
 *
 * 用法：`pnpm run build && pnpm node scripts/test-install.mjs`。安装夹具通过
 * `process.execPath` 调用编译后的 CLI（绝不在此仓库内执行 `openflow init`），
 * 并使用隔离的临时项目根目录与隔离的 `HOME`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Assert Node 20+ immediately.
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`需要 Node 20+，当前 ${process.versions.node}`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'openflow.js');
const DIST_OPENCODE = path.join(REPO, 'dist', 'enforce', 'opencode.js');

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name} :: ${e && e.message ? e.message : e}`);
  }
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ---- fake openspec binary so `init` skips its interactive prompts ----
let fakeBin;
function fakeOpenspecBin() {
  if (fakeBin) return fakeBin;
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'openflow-fakebin-'));
  const bin = path.join(fakeBin, 'openspec');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  return fakeBin;
}

/**
 * Run the compiled CLI (`bin/openflow.js` → `dist/cli/index.js`) with an
 * isolated HOME and a fake `openspec` on PATH, never via `openflow init`.
 */
function runInit(cwd, home, { tools = ['claude', 'opencode'], global = false } = {}) {
  const args = [CLI, 'init', '--tools', tools.join(',')];
  if (global) args.push('--global');
  return spawnSync(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeOpenspecBin()}${path.delimiter}${process.env.PATH}`,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ---- git helpers (for fingerprint / receipt runtime fixtures) ----
const COMMIT_ENV = {
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00',
};
function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
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

const LOCAL_ARTIFACTS = [
  '.claude/hooks/openflow-enforce.mjs',
  '.claude/hooks/openflow-detect.mjs',
  '.claude/hooks/openflow-gate.mjs',
  '.claude/hooks/lifecycle-fingerprint.mjs',
  '.opencode/plugins/openflow-enforce.js',
  '.opencode/hooks/openflow-detect.mjs',
  '.opencode/hooks/openflow-gate.mjs',
  '.opencode/hooks/lifecycle-fingerprint.mjs',
];

const GLOBAL_ARTIFACTS = [
  '.claude/hooks/openflow-enforce.mjs',
  '.claude/hooks/openflow-detect.mjs',
  '.claude/hooks/openflow-gate.mjs',
  '.claude/hooks/lifecycle-fingerprint.mjs',
  '.config/opencode/plugins/openflow-enforce.js',
  '.config/opencode/hooks/openflow-detect.mjs',
  '.config/opencode/hooks/openflow-gate.mjs',
  '.config/opencode/hooks/lifecycle-fingerprint.mjs',
];

if (!fs.existsSync(DIST_OPENCODE)) {
  console.log('  ⚠️  未检测到 dist/enforce/opencode.js — 请先 `pnpm run build`（插件安装断言会失败）');
}

// ===========================================================================
// [1] 本地安装
// ===========================================================================
console.log('\n[1] 本地安装 (Claude + OpenCode)');

await run('本地安装拷贝全部 8 个产物', () => {
  const home = tmpdir('openflow-home-');
  const proj = tmpdir('openflow-proj-');
  write(proj, 'openspec/.gitkeep', ''); // 跳过 openspec init 交互
  const res = runInit(proj, home, {});
  assert.equal(res.status, 0, `init exit=${res.status}\nstderr=${res.stderr}`);
  for (const rel of LOCAL_ARTIFACTS) {
    assert.ok(fs.existsSync(path.join(proj, rel)), `缺少产物 ${rel}`);
  }
});

// ===========================================================================
// [2] 全局安装（隔离 HOME）
// ===========================================================================
console.log('\n[2] 全局安装 (隔离 HOME)');

await run('全局安装拷贝全部产物到 ~/.claude 与 ~/.config/opencode', () => {
  const home = tmpdir('openflow-global-home-');
  const proj = tmpdir('openflow-global-proj-');
  const res = runInit(proj, home, { global: true });
  assert.equal(res.status, 0, `init exit=${res.status}\nstderr=${res.stderr}`);
  for (const rel of GLOBAL_ARTIFACTS) {
    assert.ok(fs.existsSync(path.join(home, rel)), `缺少产物 ~/${rel}`);
  }
  // 全局安装不应写入项目目录的 hooks
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'hooks')), 'global 不应写项目 .claude/hooks');
});

// ===========================================================================
// [3] 配置合并 / 去重 / 幂等
// ===========================================================================
console.log('\n[3] 配置合并、保留、去重、幂等');

await run('保留第三方 settings hook + 精确一份 Edit/Write openflow hook，清掉 legacy .py', () => {
  const home = tmpdir('openflow-home-');
  const proj = tmpdir('openflow-proj-');
  write(proj, 'openspec/.gitkeep', '');
  const pyPath = path.join(proj, '.claude', 'hooks', 'openflow-enforce.py');
  write(proj, '.claude/hooks/openflow-enforce.py', '#!/usr/bin/env python3\n'); // legacy py 文件
  write(proj, '.claude/settings.json', JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'third-party-bash-hook' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: pyPath }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: pyPath }] },
      ],
    },
  }, null, 2));

  const res = runInit(proj, home, {});
  assert.equal(res.status, 0, `init exit=${res.status}\nstderr=${res.stderr}`);

  // legacy .py 文件被移除
  assert.ok(!fs.existsSync(pyPath), 'legacy .py 文件应被移除');

  const settings = JSON.parse(fs.readFileSync(path.join(proj, '.claude/settings.json'), 'utf8'));
  const preHooks = settings.hooks.PreToolUse;

  const bash = preHooks.find((h) => h.matcher === 'Bash');
  assert.ok(bash, '第三方 Bash matcher 保留');
  assert.equal(bash.hooks[0].command, 'third-party-bash-hook');

  for (const matcher of ['Edit', 'Write']) {
    const entry = preHooks.find((h) => h.matcher === matcher);
    assert.ok(entry, `${matcher} matcher 存在`);
    const openflowHooks = entry.hooks.filter((h) => /openflow-enforce/.test(h.command));
    assert.equal(openflowHooks.length, 1, `${matcher} 应恰好一个 openflow hook`);
    assert.ok(/openflow-enforce\.mjs$/.test(openflowHooks[0].command), `${matcher} hook 为 .mjs`);
    assert.ok(!entry.hooks.some((h) => /openflow-enforce\.py/.test(h.command)), `${matcher} 无 .py hook`);
  }

  // 不新增 Bash matcher
  assert.ok(!preHooks.some((h) => h.matcher === 'Bash' && h.hooks.some((hh) => /openflow/.test(hh.command))), 'Bash matcher 不含 openflow hook');
});

await run('OpenCode 插件 URL 规范化为 pathToFileURL(pluginDest).href，保留第三方插件并去重', () => {
  const home = tmpdir('openflow-home-');
  const proj = tmpdir('openflow-proj-');
  write(proj, 'openspec/.gitkeep', '');
  write(proj, '.opencode/opencode.json', JSON.stringify({
    plugin: [
      'third-party-plugin',
      'file://.opencode/plugins/openflow-enforce.js', // legacy 相对 URL
      'file:///old/absolute/path/openflow-enforce.js', // legacy 绝对 URL
    ],
  }, null, 2));

  const res = runInit(proj, home, {});
  assert.equal(res.status, 0, `init exit=${res.status}\nstderr=${res.stderr}`);

  const pluginDest = path.join(proj, '.opencode', 'plugins', 'openflow-enforce.js');
  const canonical = pathToFileURL(pluginDest).href;

  const config = JSON.parse(fs.readFileSync(path.join(proj, '.opencode/opencode.json'), 'utf8'));
  assert.ok(Array.isArray(config.plugin), 'plugin 为数组');
  assert.ok(config.plugin.includes('third-party-plugin'), '第三方插件保留');
  const openflowPlugins = config.plugin.filter((p) => typeof p === 'string' && /openflow-enforce\.js/.test(p));
  assert.equal(openflowPlugins.length, 1, '恰好一个 openflow 插件 URL');
  assert.equal(openflowPlugins[0], canonical, `插件 URL = ${canonical}`);
});

await run('二次安装幂等：settings.json 与 opencode.json 字节稳定', () => {
  const home = tmpdir('openflow-home-');
  const proj = tmpdir('openflow-proj-');
  write(proj, 'openspec/.gitkeep', '');
  write(proj, '.claude/settings.json', JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] },
  }, null, 2));
  write(proj, '.opencode/opencode.json', JSON.stringify({ plugin: ['third-party-plugin'] }, null, 2));

  runInit(proj, home, {});
  const claude1 = fs.readFileSync(path.join(proj, '.claude/settings.json'), 'utf8');
  const opencode1 = fs.readFileSync(path.join(proj, '.opencode/opencode.json'), 'utf8');

  runInit(proj, home, {});
  const claude2 = fs.readFileSync(path.join(proj, '.claude/settings.json'), 'utf8');
  const opencode2 = fs.readFileSync(path.join(proj, '.opencode/opencode.json'), 'utf8');

  assert.equal(claude1, claude2, 'settings.json 字节稳定');
  assert.equal(opencode1, opencode2, 'opencode.json 字节稳定');

  const settings = JSON.parse(claude2);
  for (const matcher of ['Edit', 'Write']) {
    const entry = settings.hooks.PreToolUse.find((h) => h.matcher === matcher);
    assert.equal(entry.hooks.filter((h) => /openflow-enforce\.mjs$/.test(h.command)).length, 1, `${matcher} 幂等仍恰好一个 hook`);
  }
});

await run('全局插件 URL 使用 ~/.config/opencode 实际拷贝位置', () => {
  const home = tmpdir('openflow-global-home-');
  const proj = tmpdir('openflow-global-proj-');
  write(home, '.config/opencode/opencode.json', JSON.stringify({
    plugin: ['file://.opencode/plugins/openflow-enforce.js'],
  }, null, 2));
  const res = runInit(proj, home, { global: true });
  assert.equal(res.status, 0, `init exit=${res.status}\nstderr=${res.stderr}`);

  const pluginDest = path.join(home, '.config', 'opencode', 'plugins', 'openflow-enforce.js');
  const canonical = pathToFileURL(pluginDest).href;
  const config = JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'));
  assert.equal(config.plugin.find((p) => typeof p === 'string' && /openflow-enforce\.js/.test(p)), canonical, `全局插件 URL = ${canonical}`);
});

// ===========================================================================
// [4] 已安装产物运行时行为
// ===========================================================================
console.log('\n[4] 已安装产物运行时行为');

// 带真实 git 历史的临时工程，先 init 安装，再跑已安装产物。
function makeRuntimeFixture() {
  const proj = tmpdir('openflow-runtime-');
  gitInit(proj);
  write(proj, 'src/app.js', 'console.log(1);\n');
  git(proj, ['add', '.']);
  git(proj, ['commit', '-qm', 'baseline']);
  write(proj, 'openspec/.gitkeep', ''); // 跳过 openspec init 交互
  const home = tmpdir('openflow-home-');
  const res = runInit(proj, home, {});
  assert.equal(res.status, 0, `init exit=${res.status}\nstderr=${res.stderr}`);
  return { proj, home };
}

function makeChange(proj, change = 'add-widget') {
  fs.mkdirSync(path.join(proj, 'openspec', 'changes', change), { recursive: true });
}

await run('已安装 Claude hook：spec 生产写入 → phase-boundary', () => {
  const { proj } = makeRuntimeFixture();
  makeChange(proj);
  write(proj, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'spec' }));
  const hook = path.join(proj, '.claude', 'hooks', 'openflow-enforce.mjs');
  const res = spawnSync(process.execPath, [hook], {
    cwd: proj,
    input: JSON.stringify({ tool_name: 'Write', file_path: 'src/prod.ts', content: 'x' }),
    encoding: 'utf8',
  });
  assert.equal(res.status, 1, `hook exit=${res.status}`);
  assert.ok(/phase-boundary/.test(res.stdout), `stdout=${res.stdout}`);
});

await run('已安装 OpenCode 插件：spec 生产写入 → phase-boundary abort', async () => {
  const { proj } = makeRuntimeFixture();
  makeChange(proj);
  write(proj, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'spec' }));
  const pluginDest = path.join(proj, '.opencode', 'plugins', 'openflow-enforce.js');
  const plugin = (await import(pathToFileURL(pluginDest).href)).default;
  const output = {};
  const origCwd = process.cwd();
  process.chdir(proj);
  try {
    await plugin['tool.execute.before'](
      { call: { name: 'write', input: { file_path: 'src/prod.ts', content: 'x' } } },
      output,
    );
  } finally {
    process.chdir(origCwd);
  }
  assert.ok(output.abort && /phase-boundary/.test(output.abort), `abort=${output.abort}`);
});

await run('已安装 hook：task-build 缺失测试文件 → tdd-test-file-missing', () => {
  const { proj } = makeRuntimeFixture();
  makeChange(proj);
  write(proj, 'openspec/changes/add-widget/test-plan.md', 'T-001: `src/prod.test.ts::adds prod`');
  write(proj, 'openspec/changes/add-widget/plan-ready.md', '### Task 1: prod\n\n- Test cases: T-001\n- Files: `src/prod.ts`\n');
  write(proj, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' }));
  const hook = path.join(proj, '.claude', 'hooks', 'openflow-enforce.mjs');
  const res = spawnSync(process.execPath, [hook], {
    cwd: proj,
    input: JSON.stringify({ tool_name: 'Write', file_path: 'src/prod.ts', content: 'impl' }),
    encoding: 'utf8',
  });
  assert.equal(res.status, 1, `hook exit=${res.status}`);
  assert.ok(/tdd-test-file-missing/.test(res.stdout), `stdout=${res.stdout}`);
});

await run('已安装 Gate：缺 receipt → check-close-ready 失败', () => {
  const { proj } = makeRuntimeFixture();
  makeChange(proj);
  const gate = path.join(proj, '.claude', 'hooks', 'openflow-gate.mjs');
  const res = spawnSync(process.execPath, [gate, 'check-close-ready', 'add-widget'], {
    cwd: proj,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, false, `pass=${out.pass}`);
  assert.ok(/receipt/i.test((out.blockers || []).join('\n')), `blockers=${JSON.stringify(out.blockers)}`);
});

await run('当前 receipt：仅改 .openflow/phase 不变 stale（自污染排除）', async () => {
  const { proj } = makeRuntimeFixture();
  makeChange(proj);
  const helperPath = path.join(proj, '.claude', 'hooks', 'lifecycle-fingerprint.mjs');
  const fp = await import(pathToFileURL(helperPath).href);

  const collected = fp.collectWorktreeFingerprint(proj, 'add-widget');
  assert.ok(collected.ok, collected.blocker);

  write(proj, 'openspec/changes/add-widget/verify-result.json', JSON.stringify({
    version: 1,
    change: 'add-widget',
    head: collected.head,
    fingerprint: collected.value,
    testRuns: [{ name: 'unit', exitCode: 0 }],
    scenarioCoverage: { mapped: 1, total: 1 },
    designConsistency: { pass: true, blockers: [] },
    userConfirmation: { received: true },
  }));

  assert.equal(fp.validateVerifyReceipt(proj, 'add-widget').pass, true, '初始 receipt 有效');

  // 仅改 .openflow/phase（允许的 state 写入，指纹应排除它）
  write(proj, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'close' }));
  const after = fp.validateVerifyReceipt(proj, 'add-widget');
  assert.equal(after.pass, true, `改 phase 后 receipt 变 stale: ${after.blockers.join('; ')}`);
  assert.ok(!after.blockers.includes('receipt-stale-fingerprint'), '无 stale-fingerprint');
});

await run('已安装 detect（Claude）：输出有效 JSON + change_name', () => {
  const { proj } = makeRuntimeFixture();
  makeChange(proj);
  write(proj, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'spec' }));
  const detect = path.join(proj, '.claude', 'hooks', 'openflow-detect.mjs');
  const res = spawnSync(process.execPath, [detect], {
    cwd: proj,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.change_name, 'add-widget');
});

await run('已安装 detect（OpenCode）：相对导入 lifecycle-fingerprint 正常', () => {
  const { proj } = makeRuntimeFixture();
  makeChange(proj);
  write(proj, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'spec' }));
  const detect = path.join(proj, '.opencode', 'hooks', 'openflow-detect.mjs');
  const res = spawnSync(process.execPath, [detect], {
    cwd: proj,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).change_name, 'add-widget');
});

// ===========================================================================
// [5] 静态模板检查（Task 7：phase 生命周期 / 稳定选择器 / 客户端路径）
// ===========================================================================
console.log('\n[5] 静态模板检查（phase 生命周期 / 稳定选择器 / 客户端路径）');

const MAIN_TEMPLATES = [
  'SKILL.md', 'proposal.md', 'brainstorming.md', 'spec.md',
  'amend.md', 'build.md', 'verify.md', 'close.md',
];
const SHORTCUT_TEMPLATES = [
  'openflow-proposal/SKILL.md',
  'openflow-brainstorming/SKILL.md',
  'openflow-spec/SKILL.md',
  'openflow-amend/SKILL.md',
  'openflow-build/SKILL.md',
  'openflow-verify/SKILL.md',
  'openflow-close/SKILL.md',
];

function readTemplate(rel) {
  const p = path.join(REPO, 'templates', rel);
  assert.ok(fs.existsSync(p), `模板不存在 ${rel}`);
  return fs.readFileSync(p, 'utf8');
}

// Mirrors src/core/skill-generator.ts `replaceToolPaths` so we can assert the
// client-correct rendered templates (Task 6 installed-artifact paths).
function renderForTool(tool) {
  const CFG = {
    claude: { skillsDir: '.claude/skills', configDir: '.claude' },
    codex: { skillsDir: '.codex/skills', configDir: '.codex' },
    cursor: { skillsDir: '.cursor/skills', configDir: '.cursor' },
    opencode: { skillsDir: '.opencode/skills', configDir: '.opencode' },
  };
  const { skillsDir, configDir } = CFG[tool];
  return (content) => content
    .replace(/\.claude\/skills\/openflow\//g, `${skillsDir}/openflow/`)
    .replace(/~\/\.claude\/skills\/openflow\//g, `~/${skillsDir}/openflow/`)
    .replace(/\.claude\/hooks\//g, `${configDir}/hooks/`)
    .replace(/~\/\.claude\/hooks\//g, `~/${configDir}/hooks/`);
}

// Templates that must invoke the installed gate helper (they run gate subcommands).
const GATE_TEMPLATES = new Set(['brainstorming.md', 'spec.md', 'build.md', 'verify.md', 'close.md']);

await run('全部主/快捷模板提及 .openflow/phase 且不再引用 openflow-enforce.py', () => {
  for (const rel of [...MAIN_TEMPLATES, ...SHORTCUT_TEMPLATES]) {
    const c = readTemplate(rel);
    assert.ok(c.includes('.openflow/phase'), `${rel} 未提及 .openflow/phase`);
    assert.ok(!c.includes('openflow-enforce.py'), `${rel} 仍引用 openflow-enforce.py`);
  }
});

await run('模板源码 hooks 路径用可重写规范形 .claude/hooks，不硬编码 .opencode', () => {
  for (const rel of [...MAIN_TEMPLATES, ...SHORTCUT_TEMPLATES]) {
    const c = readTemplate(rel);
    assert.ok(!c.includes('.opencode/hooks'), `${rel} 源码硬编码 .opencode/hooks`);
    assert.ok(!c.includes('.config/opencode/hooks'), `${rel} 源码硬编码 .config/opencode/hooks`);
  }
});

await run('渲染到 OpenCode：无 .claude/hooks 残留，gate 指向 .opencode/hooks 已安装路径', () => {
  const render = renderForTool('opencode');
  for (const rel of [...MAIN_TEMPLATES, ...SHORTCUT_TEMPLATES]) {
    const rendered = render(readTemplate(rel));
    assert.ok(!rendered.includes('.claude/hooks'), `${rel} 渲染后仍引用 .claude/hooks`);
    if (GATE_TEMPLATES.has(rel)) {
      assert.ok(rendered.includes('.opencode/hooks/openflow-gate.mjs'), `${rel} 渲染后无 opencode gate 路径`);
    }
  }
});

await run('渲染到 Claude：gate/detect 指向 .claude/hooks 已安装路径', () => {
  const render = renderForTool('claude');
  for (const rel of GATE_TEMPLATES) {
    assert.ok(render(readTemplate(rel)).includes('.claude/hooks/openflow-gate.mjs'), `${rel} 渲染后无 claude gate 路径`);
  }
  assert.ok(render(readTemplate('SKILL.md')).includes('.claude/hooks/openflow-detect.mjs'), 'SKILL.md 渲染后无 claude detect 路径');
});

await run('spec.md 生成 T-001 稳定 ID + file::selector 选择器，plan-ready 绑定稳定 ID', () => {
  const c = readTemplate('spec.md');
  assert.match(c, /T-\d{3}/, '缺少 T-001 稳定 ID 示例');
  assert.ok(c.includes('::'), '缺少 file::selector 选择器格式');
  assert.match(c, /Test cases?\s*:\s*T-\d{3}/i, 'plan-ready 任务未绑定稳定 ID（Test cases: T-001）');
});

await run('build.md 先写 bootstrap 再写 task-build，结尾指向 /openflow verify', () => {
  const c = readTemplate('build.md');
  assert.match(c, /"mode"\s*:\s*"bootstrap"/, '缺少 bootstrap 阶段写入');
  assert.match(c, /"mode"\s*:\s*"task-build"/, '缺少 task-build 阶段写入');
  assert.match(c, /"task"\s*:\s*"\d+"/, 'task-build 缺少 task 字段');
  assert.ok(c.includes('/openflow verify'), 'build 结尾未指向 /openflow verify');
  assert.ok(!c.includes('/openflow close'), 'build 错误指向 /openflow close');
});

await run('verify.md 运行 write-verify-receipt 且成功后才设 phase=close', () => {
  const c = readTemplate('verify.md');
  assert.ok(c.includes('write-verify-receipt'), '缺少 write-verify-receipt 指令');
  assert.match(c, /userConfirmation/, '缺少用户确认输入字段');
  assert.match(c, /scenarioCoverage/, '缺少场景覆盖输入字段');
  assert.match(c, /"phase"\s*:\s*"close"/, '成功后才设 phase close');
});

await run('close.md 只用 archive-verified，禁止原始 openspec archive 命令', () => {
  const c = readTemplate('close.md');
  assert.ok(c.includes('archive-verified'), '缺少 archive-verified 指令');
  assert.ok(!/^\s*openspec archive\s/m.test(c), 'close 包含原始 openspec archive 命令');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
