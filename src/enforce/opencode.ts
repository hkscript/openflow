/**
 * OpenCode enforcement plugin.
 *
 * Installed to .opencode/plugins/openflow-enforce.ts by openflow init.
 * Registered in opencode.json: "plugin": ["file://.opencode/plugins/openflow-enforce.ts"]
 *
 * Uses OpenCode's tool.execute.before hook. Set output.abort to block.
 */
import fs from 'fs';
import path from 'path';

// ---- inlined from rules.ts (same logic, zero-dependency for plugin portability) ----

interface CheckResult {
  id: string;
  level: 'block' | 'warn';
  message: string;
  detail?: string;
}

function safeRead(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function checkFileExists(toolName: string, filePath: string, cwd: string): CheckResult | null {
  if (toolName !== 'edit') return null;
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
    detail: count >= 2
      ? '超过 1 个 [Assumption]，建议拆分 task 或回到 spec 阶段补读代码。'
      : 'build 阶段执行前须消解为 [Verified] 或 [Inferred]。',
  };
}

function checkPhaseBoundary(filePath: string, cwd: string): CheckResult | null {
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
    detail: `tasks.md 路径: ${tasksFile}`,
  };
}

function runAllChecks(toolName: string, filePath: string, content: string, cwd: string): CheckResult[] {
  if (toolName !== 'edit' && toolName !== 'write') return [];
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

// ---- OpenCode plugin entry ----

interface OpencodeToolInput {
  call: {
    name: string;
    input: Record<string, unknown>;
  };
}

interface OpencodeOutput {
  abort?: string;
}

export default {
  'tool.execute.before': async (input: OpencodeToolInput, output: OpencodeOutput) => {
    const toolName = (input.call.name ?? '').toLowerCase();
    const filePath = String(input.call.input.file_path ?? input.call.input.filePath ?? '');
    const content = String(input.call.input.content ?? input.call.input.new_string ?? '');
    const cwd = process.cwd();

    const results = runAllChecks(toolName, filePath, content, cwd);

    const blocks = results.filter(r => r.level === 'block');
    const warns = results.filter(r => r.level === 'warn');

    for (const w of warns) {
      console.warn(`⚠️  [openflow ${w.id}] ${w.message}`);
      if (w.detail) console.warn(`   ${w.detail}`);
    }

    if (blocks.length > 0) {
      const msg = blocks.map(b => `[${b.id}] ${b.message}`).join('; ');
      output.abort = msg;
    }
  },
};
