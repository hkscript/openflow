import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fileExists } from '../utils/shell.js';
import { logger } from '../utils/logger.js';
import { SKILL_NAME, TOOL_PATHS } from './constants.js';
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
    const phases = ['proposal', 'brainstorming', 'spec', 'amend', 'build', 'verify', 'close'];
    for (const phase of phases) {
      generateSkillFile(skillsDir, `${phase}.md`, depStatus);
    }

    // Generate sub-skill shortcuts (e.g., openflow-proposal, openflow-spec)
    generateSubSkillShortcuts(baseDir, toolPaths, phases, depStatus);

    logger.success(`${tool} skills generated`);

    // Install enforcement hooks (Claude Code only, project-local only)
    if (tool === 'claude' && toolPaths.hooksDir && toolPaths.settingsFile) {
      installHooks(baseDir, toolPaths);
    }
  }
}

function generateSubSkillShortcuts(
  baseDir: string,
  toolPaths: typeof TOOL_PATHS['claude'],
  phases: string[],
  depStatus: DepStatus
): void {
  logger.step('Generating sub-skill shortcuts ...');

  for (const phase of phases) {
    const subSkillName = `${SKILL_NAME}-${phase}`;
    const subSkillDir = path.join(baseDir, toolPaths.skillsDir, subSkillName);

    if (!fs.existsSync(subSkillDir)) {
      fs.mkdirSync(subSkillDir, { recursive: true });
    }

    // Check if template exists, otherwise generate inline
    const templatePath = path.join(TEMPLATES_DIR, subSkillName, 'SKILL.md');
    let content: string;

    if (fileExists(templatePath)) {
      content = fs.readFileSync(templatePath, 'utf-8');
    } else {
      content = getSubSkillTemplate(phase);
    }

    const targetPath = path.join(subSkillDir, 'SKILL.md');
    fs.writeFileSync(targetPath, content);
    logger.step(`  ${subSkillName}/SKILL.md`);
  }
}

function getSubSkillTemplate(phase: string): string {
  const phaseDescriptions: Record<string, string> = {
    proposal: 'create a change proposal',
    brainstorming: 'deep design exploration',
    spec: 'generate specs, test-plan, and plan-ready',
    amend: 'revise requirements with test impact analysis',
    build: 'execute TDD implementation',
    verify: 'run verification gate before close',
    close: 'archive and extract lessons',
  };

  const description = phaseDescriptions[phase] || phase;

  return `---
name: openflow-${phase}
description: "Quick start ${phase} phase. Use /openflow-${phase} to ${description}, equivalent to /openflow ${phase}."
---

这是 \`/openflow ${phase}\` 的快捷方式，等效于 \`/openflow ${phase}\`。

**执行步骤**：

1. **读取主协调器**：\`~/.claude/skills/openflow/SKILL.md\`
   - 协调器包含状态检测、前置条件检查、续接规则等核心逻辑
   - 必须遵循协调器的路由和阶段写入边界规则

2. **读取阶段参考文件**：\`~/.claude/skills/openflow/${phase}.md\`
   - 包含 ${phase} 阶段的详细指令和流程

3. **按指令执行**：先检查前置条件，再按 ${phase}.md 的流程执行

**所有协调逻辑（状态检测、前置条件、续接规则）都在主 SKILL.md 中，必须遵循。**
`;
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
  logger.step(`  Hooks registered in ${path.basename(settingsFile)}: Edit, Write → openflow-enforce.py`);
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

  // Inject validation hint into spec.md for OpenSpec CLI
  if (filename === 'spec.md') {
    content = injectSpecRuntimeCheck(content, depStatus);
  }

  const targetPath = path.join(skillsDir, filename);
  fs.writeFileSync(targetPath, content);
  logger.step(`  ${filename}`);
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
      '| verify | 验证记录、verify-issues.md | 代码、测试、规格文档 |',
'| close | 归档、lessons.md | 代码、测试、其它实现文件 |',
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
      '| /openflow verify | verify | 验证闸门：测试+覆盖率+设计一致性 |',
'| /openflow close | close | 经验沉淀+归档（Compound） |',
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
      '4. /openflow（无子命令）→ 状态检测 → 展示结果 → 用户选择（不自动路由）',
      '',
      '### 前置条件',
      '',
      '| 阶段 | 前置条件 | 不满足时提示 |',
      '|------|----------|-------------|',
      '| spec | 需要活跃变更 | 先用 /openflow proposal |',
      '| amend | 需要活跃变更 | 先完成 /openflow spec |',
      '| build | 需要 test-plan.md + plan-ready.md | 先完成 /openflow spec |',
      '| verify | 所有测试 PASS | 先完成 /openflow build |',
'| close | verify 已通过 | 先完成 /openflow verify |',
    ].join('\n'),
  };

  return templates[filename] ?? `# ${filename}\n\nTODO: implement\n`;
}
