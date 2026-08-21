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

// Mirrors src/core/skill-generator.ts `replaceToolPaths`. Since Task 7 (review
// F3), the hook-path rewrite is gated on lifecycle-runtime support: Claude and
// OpenCode render their real hooks dir; codex/cursor render an explicit
// unsupported marker instead of a phantom `.codex/hooks/…` executable path.
function renderForTool(tool) {
  const CFG = {
    claude: { skillsDir: '.claude/skills', configDir: '.claude', hookRuntime: true },
    codex: { skillsDir: '.codex/skills', configDir: '.codex', hookRuntime: false },
    cursor: { skillsDir: '.cursor/skills', configDir: '.cursor', hookRuntime: false },
    opencode: { skillsDir: '.opencode/skills', configDir: '.opencode', hookRuntime: true },
  };
  const { skillsDir, configDir, hookRuntime } = CFG[tool];
  const HOOK_MISSING_MARKER = 'hooks/（⚠️ 本客户端未安装 lifecycle 运行时：codex/cursor 仅安装 skills）';
  return (content) => {
    let c = content
      .replace(/\.claude\/skills\/openflow\//g, `${skillsDir}/openflow/`)
      .replace(/~\/\.claude\/skills\/openflow\//g, `~/${skillsDir}/openflow/`);
    if (hookRuntime) {
      c = c
        .replace(/\.claude\/hooks\//g, `${configDir}/hooks/`)
        .replace(/~\/\.claude\/hooks\//g, `~/${configDir}/hooks/`);
    } else {
      c = c
        .replace(/\.claude\/hooks\//g, HOOK_MISSING_MARKER)
        .replace(/~\/\.claude\/hooks\//g, HOOK_MISSING_MARKER);
    }
    return c;
  };
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

await run('渲染到 Codex/Cursor：无幻影 hooks 路径，显式标注 lifecycle 运行时不可用（F3）', () => {
  for (const tool of ['codex', 'cursor']) {
    const render = renderForTool(tool);
    for (const rel of [...MAIN_TEMPLATES, ...SHORTCUT_TEMPLATES]) {
      const rendered = render(readTemplate(rel));
      assert.ok(!rendered.includes(`.${tool}/hooks/openflow-gate.mjs`), `${rel} 渲染后仍引用幻影 .${tool}/hooks gate 路径`);
      assert.ok(!rendered.includes(`.${tool}/hooks/openflow-detect.mjs`), `${rel} 渲染后仍引用幻影 .${tool}/hooks detect 路径`);
      if (GATE_TEMPLATES.has(rel) || rel === 'SKILL.md') {
        assert.ok(rendered.includes('未安装 lifecycle 运行时'), `${rel} 渲染后无显式不可用标注`);
      }
    }
  }
});

await run('spec.md 生成 T-001 稳定 ID + 状态后缀语法，plan-ready 绑定稳定 ID', () => {
  const c = readTemplate('spec.md');
  assert.match(c, /T-\d{3}/, '缺少 T-001 稳定 ID 示例');
  assert.ok(c.includes('::'), '缺少 file::selector 选择器格式');
  assert.match(c, /✅ PASS/, '缺少状态后缀语法文档');
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

await run('build.md 完成时先设 phase=verify 再移除 building 标记（F5）', () => {
  const c = readTemplate('build.md');
  const verifyIdx = c.indexOf('"phase":"verify"');
  const rmIdx = c.indexOf('rm -f .openflow/building');
  assert.ok(verifyIdx >= 0 && rmIdx >= 0, 'build 完成缺少 phase=verify 与 marker 移除');
  assert.ok(verifyIdx < rmIdx, 'phase=verify 应在移除 marker 之前（避免 task-build 无 marker 矛盾窗口）');
});

await run('verify.md 将 receipt 输入写入精确 verify-result.json 路径（F4）', () => {
  const c = readTemplate('verify.md');
  assert.ok(c.includes('write-verify-receipt'), '缺少 write-verify-receipt 指令');
  assert.ok(c.includes('openspec/changes/<变更名>/verify-result.json'), '未引用精确 verify-result.json 路径');
  assert.ok(!c.includes('<receipt-input>'), '仍建议任意 workspace 输入文件');
  assert.match(c, /userConfirmation/, '缺少用户确认输入字段');
  assert.match(c, /scenarioCoverage/, '缺少场景覆盖输入字段');
  assert.match(c, /"phase"\s*:\s*"close"/, '成功后才设 phase close');
});

await run('close.md 只用 archive-verified，禁止原始 openspec archive 命令', () => {
  const c = readTemplate('close.md');
  assert.ok(c.includes('archive-verified'), '缺少 archive-verified 指令');
  assert.ok(!/^\s*openspec archive\s/m.test(c), 'close 包含原始 openspec archive 命令');
});

// ===========================================================================
// [6] 端到端集成（review F1/F2/F4/F5：canonical 语法跨 enforcement/Gate/detect）
// ===========================================================================
console.log('\n[6] 端到端集成（canonical test-plan 语法跨 enforcement/Gate/detect）');

// spec.md 模板生成的 canonical plan/test-plan（稳定行 + 状态后缀）。
const CANONICAL_TP = [
  'T-001: `tests/auth/test_login.py::test_login_with_valid_credentials` ✅ PASS',
  'T-002: `tests/auth/test_login.py::test_login_with_wrong_password` ✅ PASS',
].join('\n');
const CANONICAL_TP_TODO = CANONICAL_TP.replace(
  'T-002: `tests/auth/test_login.py::test_login_with_wrong_password` ✅ PASS',
  'T-002: `tests/auth/test_login.py::test_login_with_wrong_password` ⬜ TODO'
);

const CANONICAL_PR = [
  '# 实现计划：add-widget',
  '## 来源',
  '- 测试计划：openspec/changes/add-widget/test-plan.md',
  '',
  '### Task 1: login',
  '- Test cases: T-001, T-002',
  '- Files: `src/auth/login.py`, `tests/auth/test_login.py`',
  '- 改动文件：`src/auth/login.py` [Verified]',
  '- [x] 实现登录',
  '- [x] 补测试',
  '',
].join('\n');

function writeCanonicalChange(proj, change = 'add-widget') {
  const base = `openspec/changes/${change}`;
  write(proj, `${base}/test-plan.md`, CANONICAL_TP);
  write(proj, `${base}/plan-ready.md`, CANONICAL_PR);
  write(proj, `${base}/proposal.md`, '## Why\n\nNeeds login for operators.\n\n## What Changes\n\n- add login\n');
  write(proj, `${base}/design.md`, '## 现状与影响面\n\n- 改动点 `login`\n\n## 改动文件\n\n- src/auth/login.py\n');
  write(proj, 'tests/auth/test_login.py', 'def test_login_with_valid_credentials():\n    assert True\n\ndef test_login_with_wrong_password():\n    assert True\n');
  write(proj, 'src/auth/login.py', 'def login(u, p):\n    return True\n');
}

function runInstalledGate(proj, args) {
  const gate = path.join(proj, '.claude', 'hooks', 'openflow-gate.mjs');
  return spawnSync(process.execPath, [gate, ...args], {
    cwd: proj,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENFLOW_OPENSPEC_BIN: path.join(fakeOpenspecBin(), 'openspec') },
  });
}

await run('canonical plan/test-plan → 已安装 Gate check-build-done 通过（F1）', () => {
  const { proj } = makeRuntimeFixture();
  writeCanonicalChange(proj);
  const res = runInstalledGate(proj, ['check-build-done', 'add-widget']);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, true, JSON.stringify(out));
  assert.equal(out.all_tests_pass, true);
});

await run('canonical plan/test-plan → 已安装 Gate check-cross-ref 用 T-001 对账（F1）', () => {
  const { proj } = makeRuntimeFixture();
  writeCanonicalChange(proj);
  const res = runInstalledGate(proj, ['check-cross-ref', 'add-widget']);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, true, JSON.stringify(out));
});

await run('canonical plan/test-plan → 已安装 Gate check-verify-prerequisites 通过（F1）', () => {
  const { proj } = makeRuntimeFixture();
  writeCanonicalChange(proj);
  const res = runInstalledGate(proj, ['check-verify-prerequisites', 'add-widget']);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, true, JSON.stringify(out.blockers));
});

await run('canonical plan/test-plan → 已安装 detect 统计 PASS/TODO（F1）', () => {
  const { proj } = makeRuntimeFixture();
  writeCanonicalChange(proj);
  // 一行 TODO，一行 PASS
  write(proj, 'openspec/changes/add-widget/test-plan.md', CANONICAL_TP_TODO);
  const detect = path.join(proj, '.claude', 'hooks', 'openflow-detect.mjs');
  const res = spawnSync(process.execPath, [detect], {
    cwd: proj, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  const stats = json.signals && json.signals.test_plan_stats && json.signals.test_plan_stats.value;
  assert.ok(stats, `缺少 test_plan_stats: ${JSON.stringify(json.signals && json.signals.test_plan_stats)}`);
  assert.equal(stats.pass, 1, JSON.stringify(stats));
  assert.equal(stats.todo, 1, JSON.stringify(stats));
  assert.equal(stats.fail, 0, JSON.stringify(stats));
  assert.equal(stats.total, 2, JSON.stringify(stats));
});

await run('canonical 状态后缀行 → 已安装 enforce 当前任务选择器解析（F2）', () => {
  const { proj } = makeRuntimeFixture();
  // 与 spec.md 模板一致的 status-bearing 稳定行（选择器是 jest 风格 test() 声明，
  // 与 enforcement 的 selector-region 识别一致）。行尾 ✅ PASS 后缀不得破坏解析。
  const base = 'openspec/changes/add-widget';
  write(proj, `${base}/test-plan.md`, [
    'T-001: `tests/auth/login.test.ts::valid credentials` ✅ PASS',
    'T-002: `tests/auth/login.test.ts::wrong password` ⬜ TODO',
  ].join('\n'));
  write(proj, `${base}/plan-ready.md`, [
    '### Task 1: login',
    '- Test cases: T-001, T-002',
    '- Files: `src/auth/login.ts`, `tests/auth/login.test.ts`',
    '- [x] 实现登录',
    '',
  ].join('\n'));
  write(proj, 'tests/auth/login.test.ts', [
    "test('valid credentials', () => {",
    '  expect(login()).toBe(true);',
    '});',
    '',
    "test('wrong password', () => {",
    '  expect(login()).toBe(false);',
    '});',
  ].join('\n'));
  write(proj, 'src/auth/login.ts', 'export function login(): boolean { return true; }\n');
  write(proj, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'build', mode: 'task-build', task: '1' }));
  write(proj, '.openflow/building', 'add-widget');
  const hook = path.join(proj, '.claude', 'hooks', 'openflow-enforce.mjs');
  // 写 task 声明的实现文件 → 不阻断（证明状态后缀行被正确解析为选择器映射）
  const okRes = spawnSync(process.execPath, [hook], {
    cwd: proj,
    input: JSON.stringify({ tool_name: 'Write', file_path: 'src/auth/login.ts', content: 'export function login(): boolean { return true; }\n' }),
    encoding: 'utf8',
  });
  assert.equal(okRes.status, 0, `declared write blocked: ${okRes.stdout}`);
  // 写未声明文件 → phase-boundary 阻断
  const badRes = spawnSync(process.execPath, [hook], {
    cwd: proj,
    input: JSON.stringify({ tool_name: 'Write', file_path: 'src/auth/undeclared.ts', content: 'x' }),
    encoding: 'utf8',
  });
  assert.equal(badRes.status, 1, 'undeclared write not blocked');
  assert.ok(/phase-boundary/.test(badRes.stdout), `stdout=${badRes.stdout}`);
});

await run('verify 在 verify-result.json 精确路径写 receipt 输入 → gate 原子替换（F4）', () => {
  const { proj } = makeRuntimeFixture();
  writeCanonicalChange(proj);
  // 直接把 receipt 输入写到 verify-result.json（verify 允许写入 + 指纹自污染排除）
  const receiptInput = path.join(proj, 'openspec/changes/add-widget/verify-result.json');
  write(proj, 'openspec/changes/add-widget/verify-result.json', JSON.stringify({
    testRuns: [{ name: 'full-suite', exitCode: 0 }],
    scenarioCoverage: { mapped: 2, total: 2 },
    designConsistency: { pass: true, blockers: [] },
    userConfirmation: { received: true },
  }, null, 2));
  const res = runInstalledGate(proj, ['write-verify-receipt', 'add-widget', receiptInput]);
  const out = JSON.parse(res.stdout);
  assert.equal(out.pass, true, JSON.stringify(out));
  const receipt = JSON.parse(fs.readFileSync(receiptInput, 'utf8'));
  assert.equal(receipt.change, 'add-widget');
  assert.equal(receipt.version, 1);
  assert.ok(receipt.head, '缺少 head');
  assert.ok(receipt.fingerprint, '缺少 fingerprint');
});

await run('build 完成 phase=verify + 移除 marker → detect 无矛盾且建议 verify（F5）', () => {
  const { proj } = makeRuntimeFixture();
  writeCanonicalChange(proj);
  // 模拟 build 完成（模板顺序）：先写 phase=verify，再删 marker
  write(proj, '.openflow/phase', JSON.stringify({ version: 1, change: 'add-widget', phase: 'verify' }));
  fs.rmSync(path.join(proj, '.openflow', 'building'), { force: true });
  const detect = path.join(proj, '.claude', 'hooks', 'openflow-detect.mjs');
  const res = spawnSync(process.execPath, [detect], {
    cwd: proj, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.suggested_phase, 'verify', `suggested=${json.suggested_phase} contradictions=${JSON.stringify(json.contradictions)}`);
  assert.ok(
    !(json.contradictions || []).some((c) => c.id && ['task-build-missing-artifacts', 'bootstrap-production-conflict'].includes(c.id)),
    `出现 phase/marker 阻塞矛盾: ${JSON.stringify(json.contradictions)}`
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
