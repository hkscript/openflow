#!/usr/bin/env node
/**
 * openflow enforcement hooks for Claude Code — 六道防火墙
 *
 * standalone .mjs, no dependencies. Called by Claude Code PreToolUse hook.
 * Reads tool-call JSON from stdin, prints warnings to stdout, exits 1 if blocked.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ---- helpers ----

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

// ---- firewall 1: No-Read-No-Use (block) ----

function checkFileExists(toolName, filePath, cwd) {
  if (toolName !== 'Edit') return null;
  if (!filePath.includes('openspec/')) return null;
  const absolute = path.join(cwd, filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return {
      id: 'no-read-no-use',
      level: 'block',
      message: `Edit 的目标文件不存在: ${filePath}`,
      detail: '你可能在编造一个不存在的文件路径。请先用 ls/grep 确认文件存在。',
    };
  }
  return null;
}

// ---- firewall 2: Certainty Tags (warn / block if ≥2) ----

function checkCertaintyTags(filePath, content) {
  if (!content) return null;
  const name = path.basename(filePath);
  if (!name.includes('plan-ready') && !name.includes('test-plan')) return null;
  const count = (content.match(/\[Assumption\]/g) ?? []).length;
  if (count === 0) return null;
  return {
    id: 'certainty-tags',
    level: count >= 2 ? 'block' : 'warn',
    message: `${filePath} 包含 ${count} 个 [Assumption] 标签`,
    detail: count >= 2
      ? '超过 1 个 [Assumption]，建议拆分 task 或回到 spec 阶段补读代码。build 阶段执行前须消解为 [Verified] 或 [Inferred]。'
      : 'build 阶段执行前须消解为 [Verified] 或 [Inferred]。',
  };
}

// ---- firewall 3: Phase Boundary (block) ----

function checkPhaseBoundary(filePath, cwd) {
  if (!filePath.includes('openspec/changes/')) return null;
  const parts = filePath.split('openspec/changes/');
  if (parts.length < 2) return null;
  const changeName = parts[1].split('/')[0];
  if (!changeName) return null;
  const testPlan = path.join(cwd, 'openspec', 'changes', changeName, 'test-plan.md');
  const tpContent = safeRead(testPlan);
  if (!tpContent) return null;
  if (!tpContent.includes('TODO') && !tpContent.includes('FAIL')) return null;
  const protectedPatterns = ['/specs/', '/proposal.md', '/design.md'];
  for (const pat of protectedPatterns) {
    if (filePath.includes(pat)) {
      return {
        id: 'phase-boundary',
        level: 'block',
        message: `build 阶段不允许修改规格文档: ${filePath}`,
        detail: '如果确实需要修改需求，请用 /openflow amend。',
      };
    }
  }
  return null;
}

// ---- firewall 4: Tasks Sync (warn) ----

function checkTasksSync(filePath, content, cwd) {
  if (!filePath.includes('plan-ready.md')) return null;
  const parent = path.dirname(path.join(cwd, filePath));
  const tasksFile = path.join(parent, 'tasks.md');
  if (!fs.existsSync(tasksFile)) return null;
  if (!content.includes('[x]') && !content.includes('[ ]')) return null;
  return {
    id: 'tasks-sync',
    level: 'warn',
    message: 'plan-ready.md checkbox 变化，请同步更新 tasks.md',
    detail: `tasks.md 路径: ${tasksFile}\n提示: close 阶段会从 plan-ready.md 自动重新生成 tasks.md，现在可以跳过手动同步。`,
  };
}

// ---- firewall 5: Writing-Plans Gate (block) ----
//
// build 阶段标记 .openflow/building 存在时，若 writing-plans 不可用（skill 文件和
// superpowers 插件都查不到），阻断实现类文件编辑。防止 AI 在 writing-plans 缺失时
// 自行合理化、跳过 build.md 步骤 0.1 的"报错终止"而继续写代码。

function isWritingPlansAvailable(cwd, home) {
  if (process.env.OPENFLOW_FORCE_WP_MISSING === '1') return false;
  const skillCandidates = [
    path.join(cwd, '.claude/skills/writing-plans/SKILL.md'),
    path.join(home, '.claude/skills/writing-plans/SKILL.md'),
    path.join(cwd, '.opencode/skills/writing-plans/SKILL.md'),
    path.join(home, '.config/opencode/skills/writing-plans/SKILL.md'),
  ];
  for (const c of skillCandidates) {
    if (fs.existsSync(c)) return true;
  }
  // Claude Code 插件形式：superpowers@* in installed_plugins.json
  const pluginsFile = path.join(home, '.claude/plugins/installed_plugins.json');
  try {
    const data = JSON.parse(fs.readFileSync(pluginsFile, 'utf-8'));
    const plugins = data && data.plugins;
    if (plugins && typeof plugins === 'object') {
      for (const [key, value] of Object.entries(plugins)) {
        if (!key.startsWith('superpowers@')) continue;
        const entries = Array.isArray(value) ? value : [value];
        for (const entry of entries) {
          const installPath = entry && entry.installPath;
          if (installPath && fs.existsSync(path.join(installPath, 'skills/writing-plans/SKILL.md'))) {
            return true;
          }
        }
      }
    }
  } catch { /* ignore */ }
  return false;
}

function checkWritingPlansGate(filePath, cwd) {
  if (process.env.OPENFLOW_NO_BUILD_GATE === '1') return null;
  const marker = path.join(cwd, '.openflow', 'building');
  if (!fs.existsSync(marker)) return null;
  // openspec 规格文档归 phase-boundary 管；计划产物和标记自身管理不拦
  if (filePath.includes('openspec/')) return null;
  if (filePath.includes('docs/superpowers/')) return null;
  if (filePath.includes('.openflow/')) return null;
  if (isWritingPlansAvailable(cwd, os.homedir())) return null;
  return {
    id: 'writing-plans-gate',
    level: 'block',
    message: `build 阶段需要 writing-plans，但未检测到（已查 skills 目录和 superpowers 插件）`,
    detail: '请先安装 Superpowers writing-plans（Claude Code: /plugin install superpowers@claude-plugins-official）后重试，或退出 build 阶段（删除 .openflow/building）。',
  };
}

// ---- firewall 6: TDD Stub Check (block) ----
//
// build 阶段标记 .openflow/building 存在时，若 AI 正在编辑实现文件（非测试文件），
// 检查 test-plan.md 中列出的测试文件是否仍残留 TODO 桩。如有则阻断——必须先补全
// 测试再写实现代码（TDD 铁律：Step 1 补全测试 → Step 2 确认 FAIL → Step 3 写实现）。

function checkTddStubs(filePath, cwd) {
  if (process.env.OPENFLOW_NO_BUILD_GATE === '1') return null;
  const marker = path.join(cwd, '.openflow', 'building');
  if (!fs.existsSync(marker)) return null;

  // Only check implementation files, not test files themselves
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/test/') || normalized.includes('/tests/') ||
      normalized.includes('/__tests__/') || normalized.includes('/spec/') ||
      normalized.endsWith('Test.java') || normalized.endsWith('Test.kt') ||
      normalized.endsWith('test.js') || normalized.endsWith('test.ts') ||
      normalized.endsWith('_test.py') || normalized.endsWith('_test.go') ||
      normalized.endsWith('_test.rs') || normalized.endsWith('.test.js') ||
      normalized.endsWith('.test.ts') || normalized.endsWith('.test.tsx') ||
      normalized.endsWith('.spec.js') || normalized.endsWith('.spec.ts')) {
    return null;
  }

  // Skip non-code files
  if (!normalized.includes('src/')) return null;

  // Find the active change
  const changesDir = path.join(cwd, 'openspec', 'changes');
  let changeDir = null;
  try {
    const entries = fs.readdirSync(changesDir, { withFileTypes: true });
    const active = entries.filter(e => e.isDirectory() && e.name !== 'archive');
    if (active.length === 1) {
      changeDir = path.join(changesDir, active[0].name);
    }
  } catch { return null; }
  if (!changeDir) return null;

  // Read test-plan.md to find test files
  const tpPath = path.join(changeDir, 'test-plan.md');
  const tpContent = safeRead(tpPath);
  if (!tpContent) return null;

  // Extract test file paths from the mapping table
  const testFiles = new Set();
  const fileRe = /`([^`]+\.[a-z]{2,6}(?:::[^`]+)?)`/gi;
  for (const m of tpContent.matchAll(fileRe)) {
    const p = m[1].split('::')[0]; // strip function name
    testFiles.add(p);
  }

  if (testFiles.size === 0) return null;

  // Check each test file for TODO stubs
  const stubs = [];
  for (const tf of testFiles) {
    const absPath = path.join(cwd, tf);
    const testContent = safeRead(absPath);
    if (!testContent) continue;
    // Check for test stubs: assert False "TODO", fail("TODO"), TODO: 实现测试
    const todoLine = testContent.match(/^(?!.*\*).*(assert\s+False|fail\s*\(|throw\s+new\s+\w+Exception).*TODO/im);
    if (todoLine) {
      stubs.push(`${tf}: ${todoLine[0].trim().slice(0, 80)}`);
    }
  }

  if (stubs.length === 0) return null;

  return {
    id: 'tdd-stub-check',
    level: 'block',
    message: `build 阶段：${stubs.length} 个测试文件仍有 TODO 桩，必须先补全测试再写实现代码`,
    detail: stubs.map(s => `  - ${s}`).join('\n')
      + `\n\nTDD 铁律：Step 1 补全测试 → Step 2 确认 FAIL（红）→ Step 3 写实现代码。`,
  };
}

// ---- main ----

function main() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8');
    let data;
    try { data = JSON.parse(raw); } catch { process.exit(0); }

    const toolName = String(data.tool_name ?? '');
    const filePath = String(data.file_path ?? '');
    const content = String(data.content ?? data.new_string ?? '');
    const cwd = process.cwd();

    if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

    const checks = [
      () => checkFileExists(toolName, filePath, cwd),
      () => checkCertaintyTags(filePath, content),
      () => checkPhaseBoundary(filePath, cwd),
      () => checkTasksSync(filePath, content, cwd),
      () => checkWritingPlansGate(filePath, cwd),
      () => checkTddStubs(filePath, cwd),
    ];
    let blocked = false;

    for (const run of checks) {
      const result = run();
      if (!result) continue;
      const prefix = result.level === 'block' ? '❌' : '⚠️';
      process.stdout.write(`${prefix} [openflow 防火墙: ${result.id}] ${result.message}\n`);
      if (result.detail) {
        for (const line of result.detail.split('\n')) {
          process.stdout.write(`   ${line}\n`);
        }
      }
      if (result.level === 'block') blocked = true;
    }

    process.exit(blocked ? 1 : 0);
  });
}

main();
