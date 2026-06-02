#!/usr/bin/env node
/**
 * openflow enforcement hooks for Claude Code — 四道防火墙
 *
 * standalone .mjs, no dependencies. Called by Claude Code PreToolUse hook.
 * Reads tool-call JSON from stdin, prints warnings to stdout, exits 1 if blocked.
 */

import fs from 'fs';
import path from 'path';

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
