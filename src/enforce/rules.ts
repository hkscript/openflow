/**
 * Shared enforcement rules for openflow — used by both Claude Code and OpenCode adapters.
 *
 * Four firewalls derived from openflow's "反幻觉铁律":
 *   1. No-Read-No-Use  — Edit target must exist
 *   2. Certainty Tags   — warn on [Assumption] in plan/test files
 *   3. Phase Boundary   — build phase: block spec doc modification
 *   4. Tasks Sync       — remind to sync tasks.md when plan-ready checkboxes change
 */

import fs from 'fs';
import path from 'path';

// ---- types ----

export interface ToolInput {
  /** "Edit" | "Write" */
  toolName: string;
  filePath: string;
  content: string;
}

export interface CheckResult {
  /** Unique check id */
  id: string;
  /** "block" | "warn" */
  level: 'block' | 'warn';
  message: string;
  detail?: string;
}

// ---- helpers ----

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function basename(filePath: string): string {
  return path.basename(filePath);
}

function dirname(filePath: string): string {
  return path.dirname(filePath);
}

function joinPath(...segments: string[]): string {
  return path.join(...segments);
}

// ---- firewall 1: No-Read-No-Use ----

function checkFileExists(toolName: string, filePath: string, cwd: string): CheckResult | null {
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

// ---- firewall 2: Certainty Tags ----

function checkCertaintyTags(filePath: string, content: string): CheckResult | null {
  if (!content) return null;

  const name = path.basename(filePath);
  if (!name.includes('plan-ready') && !name.includes('test-plan')) return null;

  const count = (content.match(/\[Assumption\]/g) ?? []).length;
  if (count === 0) return null;

  return {
    id: 'certainty-tags',
    level: count >= 2 ? 'block' : 'warn',
    message: `${filePath} 包含 ${count} 个 [Assumption] 标签`,
    detail:
      count >= 2
        ? '超过 1 个 [Assumption]，建议拆分 task 或回到 spec 阶段补读代码。build 阶段执行前须消解为 [Verified] 或 [Inferred]。'
        : 'build 阶段执行前须消解为 [Verified] 或 [Inferred]。',
  };
}

// ---- firewall 3: Phase Boundary ----

function checkPhaseBoundary(filePath: string, cwd: string): CheckResult | null {
  if (!filePath.includes('openspec/changes/')) return null;

  const parts = filePath.split('openspec/changes/');
  if (parts.length < 2) return null;

  const changeName = parts[1].split('/')[0];
  if (!changeName) return null;

  const changeDir = path.join(cwd, 'openspec', 'changes', changeName);
  const testPlan = path.join(changeDir, 'test-plan.md');

  const tpContent = safeRead(testPlan);
  if (!tpContent) return null;

  const hasPending = tpContent.includes('TODO') || tpContent.includes('FAIL');
  if (!hasPending) return null;

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

// ---- firewall 4: Tasks Sync ----

function checkTasksSync(filePath: string, content: string, cwd: string): CheckResult | null {
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

// ---- main entry ----

export interface EnforceInput {
  toolName: string;
  filePath: string;
  content: string;
  cwd: string;
}

export function runAllChecks(input: EnforceInput): CheckResult[] {
  const { toolName, filePath, content, cwd } = input;

  if (toolName !== 'Edit' && toolName !== 'Write') return [];

  const results: CheckResult[] = [];

  const r1 = checkFileExists(toolName, filePath, cwd);
  if (r1) results.push(r1);

  const r2 = checkCertaintyTags(filePath, content);
  if (r2) results.push(r2);

  const r3 = checkPhaseBoundary(filePath, cwd);
  if (r3) results.push(r3);

  const r4 = checkTasksSync(filePath, content, cwd);
  if (r4) results.push(r4);

  return results;
}
