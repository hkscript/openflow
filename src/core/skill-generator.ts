import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fileExists } from '../utils/shell.js';
import { logger } from '../utils/logger.js';
import { SKILL_NAME, TOOL_PATHS, DEPS } from './constants.js';
import type { DepStatus } from './dependency-check.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve templates dir: from dist/core/ → ../../templates/
const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

// Resolve hooks dir: from dist/core/ → ../../hooks/
const HOOKS_DIR = path.resolve(__dirname, '..', '..', 'hooks');

export interface GenerateOptions {
  cwd: string;
  tools: string[];
  depStatus: DepStatus;
  global?: boolean;
}

export function generateSkills(options: GenerateOptions): void {
  const { cwd, tools, depStatus, global = false } = options;
  const baseDir = global ? os.homedir() : cwd;

  for (const tool of tools) {
    const toolPaths = TOOL_PATHS[tool];
    if (!toolPaths) {
      logger.warn(`Unknown tool: ${tool}, skipping`);
      continue;
    }

    const skillsDir = path.join(baseDir, toolPaths.skillsDir, SKILL_NAME);
    const displayPath = global
      ? path.join('~', toolPaths.skillsDir, SKILL_NAME)
      : path.relative(cwd, skillsDir);

    logger.step(`Generating ${tool} skills to ${displayPath}/`);

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    // Generate main SKILL.md
    generateSkillFile(skillsDir, 'SKILL.md', depStatus);

    // Generate phase files
    const phases = ['proposal', 'brainstorming', 'spec', 'amend', 'build', 'close'];
    for (const phase of phases) {
      generateSkillFile(skillsDir, `${phase}.md`, depStatus);
    }

    logger.success(`${tool} skills generated`);

    // Install enforcement hooks (Claude Code only)
    if (tool === 'claude' && !global && toolPaths.hooksDir && toolPaths.settingsFile) {
      installHooks(baseDir, toolPaths);
    }
  }
}

function installHooks(baseDir: string, toolPaths: typeof TOOL_PATHS['claude']): void {
  const hooksDir = path.join(baseDir, toolPaths.hooksDir!);
  const settingsFile = path.join(baseDir, toolPaths.settingsFile!);
  const hookScriptSrc = path.join(HOOKS_DIR, 'enforce.py');
  const hookScriptDest = path.join(hooksDir, 'openflow-enforce.py');

  if (!fileExists(hookScriptSrc)) {
    logger.warn('Hook script not found, skipping enforcement hooks setup');
    return;
  }

  // Create hooks directory
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // Copy hook script
  fs.copyFileSync(hookScriptSrc, hookScriptDest);
  fs.chmodSync(hookScriptDest, 0o755);
  logger.step(`  Hook installed: ${path.relative(baseDir, hookScriptDest)}`);

  // Merge hooks into settings.json
  mergeHooksConfig(settingsFile, hookScriptDest);
}

function mergeHooksConfig(settingsFile: string, hookScriptPath: string): void {
  let settings: any = {};

  if (fileExists(settingsFile)) {
    try {
      const raw = fs.readFileSync(settingsFile, 'utf-8');
      settings = JSON.parse(raw);
    } catch {
      logger.warn('Could not parse existing settings.json, creating new');
    }
  }

  // Initialize hooks structure
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  const preHooks: any[] = settings.hooks.PreToolUse;

  // Check if openflow hook already registered
  const hookMatchers = ['Edit', 'Write'];
  for (const matcher of hookMatchers) {
    const existing = preHooks.find((h: any) => h.matcher === matcher);
    const newHook = {
      type: 'command',
      command: hookScriptPath,
    };

    if (existing) {
      // Add hook if not already present
      const exists = existing.hooks?.some(
        (h: any) => h.command === hookScriptPath
      );
      if (!exists) {
        existing.hooks = existing.hooks || [];
        existing.hooks.push(newHook);
      }
    } else {
      preHooks.push({
        matcher,
        hooks: [newHook],
      });
    }
  }

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  logger.step(`  Hooks registered in ${path.basename(settingsFile)}: Edit, Write → openflow-enforce.sh`);
}

function generateSkillFile(skillsDir: string, filename: string, depStatus: DepStatus): void {
  const templatePath = path.join(TEMPLATES_DIR, filename);

  let content: string;

  if (fileExists(templatePath)) {
    content = fs.readFileSync(templatePath, 'utf-8');
  } else {
    // Fallback: use inline template
    content = getInlineTemplate(filename, depStatus);
  }

  // Inject runtime dependency checks into build.md
  if (filename === 'build.md') {
    content = injectRuntimeDepCheck(content, depStatus);
  }

  // Inject runtime dependency checks into brainstorming.md for Superpowers
  if (filename === 'brainstorming.md') {
    content = injectBrainstormingDepCheck(content, depStatus);
  }

  // Inject runtime dependency checks into spec.md for OpenSpec
  if (filename === 'spec.md') {
    content = injectSpecRuntimeCheck(content, depStatus);
  }

  const targetPath = path.join(skillsDir, filename);
  fs.writeFileSync(targetPath, content);
  logger.step(`  ${filename}`);
}

function injectRuntimeDepCheck(content: string, depStatus: DepStatus): string {
  const checkSection = [
    '',
    '### 0. 依赖检测',
    '',
    '执行前检查以下依赖是否可用：',
    '',
    '| 依赖 | 检测方式 | 不可用时 |',
    '|------|----------|----------|',
    '| Superpowers writing-plans | 当前工具的本地或全局 skills 目录下是否存在 `writing-plans/SKILL.md` | 降级为按 test-plan.md + plan-ready.md 逐 task 手动执行，仍遵循 TDD 顺序 |',
    '| OpenSpec CLI | `openspec` 命令是否可执行 | 不影响 build 阶段，但 close 阶段归档需手动 mv |',
    '| 测试框架 | 检查 `package.json`/`go.mod`/`Cargo.toml` 等 | 提示用户先配置测试框架 |',
    '',
    '如果 Superpowers 不可用，提示用户：',
    '> "Superpowers 未安装，build 将使用手动执行模式。安装后体验更佳：' + DEPS.superpowers.installHint + '"',
    '',
    '如果 Superpowers 可用，调用其 `writing-plans` skill 以 test-plan.md + plan-ready.md 为输入生成详细执行计划。',
    '',
  ].join('\n');

  const lines = content.split('\n');
  const firstH2Idx = lines.findIndex((l) => l.startsWith('## '));
  if (firstH2Idx >= 0) {
    lines.splice(firstH2Idx + 1, 0, checkSection);
  } else {
    lines.unshift(checkSection);
  }
  return lines.join('\n');
}

function injectSpecRuntimeCheck(content: string, depStatus: DepStatus): string {
  const checkNote = [
    '',
    '> **OpenSpec 检测**：根据 proposal.md 生成 design.md + specs/ + tasks.md；如果 `openspec` CLI 可用，生成后运行 `openspec validate <变更名> --strict` 校验。specs/ 中每个 requirement 必须包含至少一个 `#### Scenario:`（可验证的预期行为），这是自动生成 test-plan.md（场景→测试映射）的输入源。',
    '',
  ].join('\n');

  const lines = content.split('\n');
  const validateIdx = lines.findIndex((l) => l.includes('openspec validate'));
  if (validateIdx >= 0) {
    lines.splice(validateIdx, 0, checkNote);
  }
  return lines.join('\n');
}

function injectBrainstormingDepCheck(content: string, depStatus: DepStatus): string {
  const installHint = DEPS.superpowers.installHint;
  const hintLine = 'Superpowers 不可用时，提示用户：';
  const lines = content.split('\n');
  const hintIdx = lines.findIndex((l) => l.includes(hintLine));
  if (hintIdx >= 0 && hintIdx + 1 < lines.length) {
    // Replace the placeholder hint with the actual install command
    lines[hintIdx + 1] = '> "Superpowers brainstorming 未安装，将使用手动提问模式。安装：' + installHint + '"';
  }
  return lines.join('\n');
}

function getInlineTemplate(filename: string, depStatus: DepStatus): string {
  const templates: Record<string, string> = {
    'SKILL.md': [
      '---',
      'name: openflow',
      'description: "OpenSpec + Superpowers workflow orchestrator. Bridges requirements and implementation via test-first traceability: scenarios → test stubs → TDD → passing tests = requirements met."',
      '---',
      '',
      '# openflow',
      '',
      '## 反幻觉铁律',
      '',
      '1. 未读不用：引用任何文件/函数/API 前必须 grep/Read 确认存在',
      '2. 不确定就说：[Verified] [Inferred] [Assumption] [Unknown] 标签标注每一条判断',
      '3. 反对自己：确认方案/通过测试前先提出最强反方论点',
      '4. 重复即错误：同一问题 2 次未解决→第 3 次必须换方法',
      '',
      '## 核心设计理念',
      '',
      'OpenSpec scenarios → test-plan.md (场景→测试映射) → Superpowers TDD 执行',
      '         ↑                                                       ↓',
      '         ├──────────── close: 测试全部 PASS = 需求满足 ────────────┤',
      '         └──────────── lessons.md ← 提取经验 ← 每个变更完成后 ────┘',
      '',
      'test-plan.md 是执行期桥梁（scenario → TDD），lessons.md 是积累期桥梁（Compound 闭环）。',
      '',
      '## 关键产物',
      '',
      '| 产物 | 生成阶段 | 作用 |',
      '|------|----------|------|',
      '| proposal.md | proposal / brainstorming | 需求描述 |',
      '| design.md | spec | 技术方案 |',
      '| specs/*.md | spec | 结构化规格（requirement + scenario） |',
      '| tasks.md | spec | OpenSpec 任务清单 |',
      '| test-plan.md | spec | 场景→测试映射表（执行期桥梁） |',
      '| plan-ready.md | spec | 实现计划（每 task 绑定测试编号） |',
      '| lessons.md | close | 经验记录（积累期桥梁，Compound 闭环） |',
      '',
      '## 续接与中断恢复',
      '',
      '1. 默认继续上一 openflow 阶段',
      '2. proposal/brainstorming/spec/amend 只能更新文档，不修改代码',
      '3. build 中用户补充需求/规格变更 → 切到 /openflow amend',
      '4. 中断恢复时重新读取阶段文件、openspec/changes/ 状态和 test-plan.md',
      '',
      '## 阶段写入边界',
      '',
      '| 阶段 | 允许写入 | 禁止写入 |',
      '|------|----------|----------|',
      '| proposal | openspec/changes/**/proposal.md | 任何代码或实现文件 |',
      '| brainstorming | openspec/changes/**/proposal.md | 任何代码或实现文件 |',
      '| spec | openspec/changes/** + test-plan.md + plan-ready.md | 任何代码或实现文件 |',
      '| amend | openspec/changes/** + test-plan.md + plan-ready.md | 代码、测试、实现文件 |',
      '| build | 代码、测试、实现计划状态 | 规格文档 |',
      '| close | 归档、验证记录、close-issues.md、lessons.md | 代码、测试、实现文件 |',
      '',
      '## 子命令',
      '',
      '| 命令 | 阶段 | 说明 |',
      '|------|------|------|',
      '| /openflow proposal | proposal | 轻量提问，快速收敛需求 |',
      '| /openflow brainstorming | brainstorming | 深度设计，多轮探索 |',
      '| /openflow spec | spec | 生成规格 + test-plan.md + plan-ready.md |',
      '| /openflow amend | amend | 受控修订需求，含测试影响分析 |',
      '| /openflow build | build | 测试桩生成 → TDD 执行 |',
      '| /openflow close | close | 验证覆盖率 → 提取经验 → 归档（Compound） |',
      '',
      '## 状态检测',
      '',
      '| 检查项 | 怎么查 | 结果 |',
      '|--------|--------|------|',
      '| 活跃变更？ | openspec/changes/ 非 archive 子目录 | 有→继续 |',
      '| test-plan.md？ | 变更目录下是否存在 | 有→看测试状态 |',
      '| plan-ready.md？ | 变更目录下是否存在 | 有→看实现状态 |',
      '| 实现已开始？ | docs/superpowers/plans/ | 有→看是否完成 |',
      '| 测试全部通过？ | test-plan.md 中所有测试 PASS | 是→close |',
      '',
      '## 路由',
      '',
      '1. 续接回复 → 保持上一阶段',
      '2. build 中需求变更 → amend',
      '3. 显式子命令 → 按子命令执行',
      '4. /openflow → 状态检测自动路由',
      '',
      '### 前置条件',
      '',
      '| 阶段 | 前置条件 | 不满足时提示 |',
      '|------|----------|-------------|',
      '| spec | 需要活跃变更 | 先用 /openflow proposal |',
      '| amend | 需要活跃变更 | 先完成 /openflow spec |',
      '| build | 需要 test-plan.md + plan-ready.md | 先完成 /openflow spec |',
      '| close | 所有测试 PASS | 先完成 /openflow build |',
    ].join('\n'),
  };

  return templates[filename] ?? `# ${filename}\n\nTODO: implement\n`;
}
