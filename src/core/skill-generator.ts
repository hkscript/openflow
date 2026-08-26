import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { fileExists } from '../utils/shell.js';
import { logger } from '../utils/logger.js';
import { SKILL_NAME, TOOL_PATHS, type ToolPaths } from './constants.js';
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

    const effectiveSkillsDir = global && toolPaths.globalSkillsDir ? toolPaths.globalSkillsDir : toolPaths.skillsDir;
    const skillsDir = path.join(baseDir, effectiveSkillsDir, SKILL_NAME);
    const displayPath = global
      ? path.join('~', effectiveSkillsDir, SKILL_NAME)
      : path.relative(cwd, skillsDir);

    logger.step(`Generating ${tool} skills to ${displayPath}/`);

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    const effectiveHooksDir = global && toolPaths.globalHooksDir
      ? toolPaths.globalHooksDir
      : toolPaths.hooksDir;
    // Claude and Codex use command hooks; OpenCode uses a plugin plus the same
    // helper scripts. Cursor remains skills-only.
    const hasHookRuntime = Boolean(effectiveHooksDir) || tool === 'opencode';
    const hasEnforceScript = tool === 'claude' || tool === 'codex';

    // Generate main SKILL.md
    generateSkillFile(skillsDir, 'SKILL.md', depStatus, tool, effectiveSkillsDir, effectiveHooksDir, hasHookRuntime, hasEnforceScript);

    // Generate phase files
    const phases = ['proposal', 'brainstorming', 'spec', 'amend', 'build', 'verify', 'close'];
    for (const phase of phases) {
      generateSkillFile(skillsDir, `${phase}.md`, depStatus, tool, effectiveSkillsDir, effectiveHooksDir, hasHookRuntime, hasEnforceScript);
    }

    // Generate sub-skill shortcuts (e.g., openflow-proposal, openflow-spec)
    generateSubSkillShortcuts(baseDir, toolPaths, phases, depStatus, tool, effectiveSkillsDir, effectiveHooksDir, hasHookRuntime, hasEnforceScript);

    logger.success(`${tool} skills generated`);

    // Install enforcement hooks
    if (tool === 'claude' && toolPaths.hooksDir && toolPaths.settingsFile) {
      installHooks(baseDir, toolPaths, global);
    }

    // Install OpenCode runtime (plugin + hook helpers)
    if (tool === 'opencode') {
      installOpencodeRuntime(baseDir, global, toolPaths);
    }

    if (tool === 'codex') {
      installCodexRuntime(baseDir, global, toolPaths);
    }
  }
}

function generateSubSkillShortcuts(
  baseDir: string,
  toolPaths: ToolPaths,
  phases: string[],
  depStatus: DepStatus,
  tool: string,
  effectiveSkillsDir: string,
  effectiveHooksDir: string | undefined,
  hasHookRuntime: boolean,
  hasEnforceScript: boolean
): void {
  logger.step('Generating sub-skill shortcuts ...');

  for (const phase of phases) {
    const subSkillName = `${SKILL_NAME}-${phase}`;
    const subSkillDir = path.join(baseDir, effectiveSkillsDir, subSkillName);

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

    // Replace tool-specific paths in content
    content = replaceToolPaths(content, tool, effectiveSkillsDir, effectiveHooksDir, hasHookRuntime, hasEnforceScript);

    const targetPath = path.join(subSkillDir, 'SKILL.md');
    fs.writeFileSync(targetPath, content);
    logger.step(`  ${subSkillName}/SKILL.md`);
  }
}

function replaceToolPaths(
  content: string,
  tool: string,
  effectiveSkillsDir: string,
  effectiveHooksDir: string | undefined,
  hasHookRuntime: boolean,
  hasEnforceScript: boolean
): string {
  // Replace local skill path references
  content = content.replace(/\.claude\/skills\/openflow\//g, `${effectiveSkillsDir}/openflow/`);
  // Replace global skill path references
  content = content.replace(/~\/\.claude\/skills\/openflow\//g, `~/${effectiveSkillsDir}/openflow/`);
  // Skills and runtime files use different roots for Codex: skills live under
  // .agents while hooks remain under .codex.
  const HOOK_MISSING_MARKER = 'hooks/(lifecycle runtime is not installed for this client)';
  if (hasHookRuntime && effectiveHooksDir) {
    content = content.replace(/\.claude\/hooks\//g, `${effectiveHooksDir}/`);
    content = content.replace(/~\/\.claude\/hooks\//g, `~/${effectiveHooksDir}/`);
  } else {
    content = content.replace(/\.claude\/hooks\//g, HOOK_MISSING_MARKER);
    content = content.replace(/~\/\.claude\/hooks\//g, HOOK_MISSING_MARKER);
  }
  // For tools without an enforce hook script (OpenCode uses a plugin and
  // Cursor has no lifecycle runtime), remove the legacy .py reference.
  if (!hasEnforceScript) {
    content = content.replace(/详见 `[^`]*hooks\/openflow-enforce\.py`。\n?/g, '');
  }
  if (tool === 'codex') {
    content = content.replace(/(^|[\s`])\/openflow(?=(?:[-\s`]|$))/gm, (_match, prefix: string) => `${prefix}$openflow`);
    content = content.replace(
      'enforcement / gate / detect / receipt / archive 的**生命周期运行时**由 **Claude Code** 与 **OpenCode** 安装（hooks 目录随客户端安装自动生成）。**codex / cursor 只安装 skills**——不安装 hooks/plugin 运行时，其 openflow 流程是**提示词级指导**：gate/detect 脚本不可用，阶段写入边界、receipt、`archive-verified` 均不强制执行，相关命令退回手动检查。若本地没有 gate/detect 脚本（codex/cursor，或旧版未升级），跳过相关命令，按各阶段模板的「手动检查」降级执行。',
      'Codex 安装 enforcement / gate / detect / receipt / archive 生命周期运行时。`apply_patch` 会在写入前执行阶段边界检查；gate、detect、receipt 与 `archive-verified` 可由 `.codex/hooks/` 下的 helpers 执行。首次安装或 hooks 更新后，必须通过 `/hooks` 审核并信任该仓库 hook；OpenFlow 不会绕过 Codex hook trust。'
    );
    content = content.replace('Claude hook / OpenCode plugin', 'Claude hook / OpenCode plugin / Codex hook');
  }
  return content;
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

1. **读取主协调器**：\`.claude/skills/openflow/SKILL.md\`（项目本地安装）或 \`~/.claude/skills/openflow/SKILL.md\`（全局安装）
   - 协调器包含状态检测、前置条件检查、续接规则等核心逻辑
   - 必须遵循协调器的路由和阶段写入边界规则

2. **读取阶段参考文件**：\`${phase}.md\`（与主协调器同目录）
   - 包含 ${phase} 阶段的详细指令和流程

3. **按指令执行**：先检查前置条件，再按 ${phase}.md 的流程执行

**所有协调逻辑（状态检测、前置条件、续接规则）都在主 SKILL.md 中，必须遵循。**
`;
}

function copyHookScript(hooksDir: string, srcName: string, destName: string, display: (p: string) => string, label: string): void {
  const src = path.join(HOOKS_DIR, srcName);
  const dest = path.join(hooksDir, destName);
  if (!fileExists(src)) {
    logger.warn(`${label} source (${srcName}) not found, skipping`);
    return;
  }
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  logger.step(`  ${label}: ${display(dest)}`);
}

function installHooks(baseDir: string, toolPaths: typeof TOOL_PATHS['claude'], global: boolean): void {
  const hooksDir = path.join(baseDir, toolPaths.hooksDir!);
  const settingsFile = path.join(baseDir, toolPaths.settingsFile!);
  const hookScriptSrc = path.join(HOOKS_DIR, 'enforce.mjs');
  const hookScriptDest = path.join(hooksDir, 'openflow-enforce.mjs');
  const oldPyHook = path.join(hooksDir, 'openflow-enforce.py');

  // Display path: prefix with ~/ for global installs
  const display = (p: string) => global ? path.join('~', path.relative(baseDir, p)) : path.relative(baseDir, p);

  if (!fileExists(hookScriptSrc)) {
    logger.warn('Hook script not found, skipping enforcement hooks setup');
    return;
  }

  // Create hooks directory
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // Cleanup old Python hook
  if (fileExists(oldPyHook)) {
    fs.unlinkSync(oldPyHook);
    logger.step(`  Removed legacy hook: ${display(oldPyHook)}`);
  }

  // Copy enforce, detect, gate, and shared fingerprint helpers
  copyHookScript(hooksDir, 'enforce.mjs', 'openflow-enforce.mjs', display, 'Hook installed');
  copyHookScript(hooksDir, 'detect.mjs', 'openflow-detect.mjs', display, 'Detect script');
  copyHookScript(hooksDir, 'gate.mjs', 'openflow-gate.mjs', display, 'Gate script');
  copyHookScript(hooksDir, 'lifecycle-fingerprint.mjs', 'lifecycle-fingerprint.mjs', display, 'Fingerprint helper');

  // Merge hooks into settings.json
  mergeHooksConfig(settingsFile, hookScriptDest, oldPyHook);
}

// 解析 JSON 配置文件；解析失败时把原始内容备份到 `<file>.bak` 并告警，返回 null。
// 调用方随后以空配置合并，绝不整包覆盖用户的 settings.json / opencode.json
//（JSONC/手改损坏时第三方插件等既有内容会被保留在 .bak 中，review I2）。
function parseJsonConfig(filePath: string, label: string): any | null {
  if (!fileExists(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    const bak = `${filePath}.bak`;
    try {
      fs.copyFileSync(filePath, bak);
      logger.warn(`${label} 无法解析（${filePath}），原文件已备份到 ${bak}，将以空配置合并`);
    } catch {
      logger.warn(`${label} 无法解析（${filePath}），且备份失败，将以空配置合并`);
    }
    return null;
  }
}

function mergeHooksConfig(settingsFile: string, hookScriptPath: string, oldPyHook: string): void {
  let settings: any = {};
  const parsed = parseJsonConfig(settingsFile, 'settings.json');
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;

  // Initialize hooks structure
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  const preHooks: any[] = settings.hooks.PreToolUse;

  // Remove legacy Python hook entries
  for (const entry of preHooks) {
    if (entry.hooks) {
      entry.hooks = entry.hooks.filter(
        (h: any) => h.command !== oldPyHook
      );
    }
  }

  // Check if openflow hook already registered
  const hookMatchers = ['Edit', 'Write'];
  for (const matcher of hookMatchers) {
    const existing = preHooks.find((h: any) => h.matcher === matcher);
    const newHook = {
      type: 'command',
      command: `node ${hookScriptPath}`,
    };

    if (existing) {
      // Add hook if not already present
      const exists = existing.hooks?.some(
        (h: any) => h.command === `node ${hookScriptPath}`
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
  logger.step(`  Hooks registered in ${path.basename(settingsFile)}: Edit, Write → node openflow-enforce.mjs`);
}

function installCodexRuntime(baseDir: string, global: boolean, toolPaths: ToolPaths): void {
  const hooksRelativeDir = global && toolPaths.globalHooksDir
    ? toolPaths.globalHooksDir
    : toolPaths.hooksDir;
  const hooksConfigRelative = global && toolPaths.globalHooksConfigFile
    ? toolPaths.globalHooksConfigFile
    : toolPaths.hooksConfigFile;
  if (!hooksRelativeDir || !hooksConfigRelative) {
    logger.warn('Codex hook paths are not configured, skipping lifecycle runtime');
    return;
  }

  const hooksDir = path.join(baseDir, hooksRelativeDir);
  const hooksConfigPath = path.join(baseDir, hooksConfigRelative);
  const display = (p: string) => global ? path.join('~', path.relative(baseDir, p)) : path.relative(baseDir, p);
  const adapterSrc = path.resolve(__dirname, '..', 'enforce', 'codex.js');
  const rulesSrc = path.resolve(__dirname, '..', 'enforce', 'rules.js');
  const adapterDest = path.join(hooksDir, 'openflow-codex-enforce.mjs');
  const rulesDest = path.join(hooksDir, 'openflow-rules.mjs');

  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  if (!fileExists(adapterSrc) || !fileExists(rulesSrc)) {
    logger.warn('Codex enforcement adapter not found in dist/enforce/, skipping hook registration — run `pnpm run build` first');
  } else {
    const adapter = fs.readFileSync(adapterSrc, 'utf8');
    const renderedAdapter = adapter.replace("from './rules.js'", "from './openflow-rules.mjs'");
    if (renderedAdapter === adapter) {
      logger.warn('Codex enforcement adapter did not contain the expected rules import, skipping hook registration');
    } else {
      fs.writeFileSync(adapterDest, renderedAdapter);
      fs.copyFileSync(rulesSrc, rulesDest);
      fs.chmodSync(adapterDest, 0o755);
      fs.chmodSync(rulesDest, 0o755);
      logger.step(`  Codex enforcement adapter: ${display(adapterDest)}`);
      mergeCodexHooksConfig(hooksConfigPath, adapterDest);
    }
  }

  copyHookScript(hooksDir, 'detect.mjs', 'openflow-detect.mjs', display, 'Detect script');
  copyHookScript(hooksDir, 'gate.mjs', 'openflow-gate.mjs', display, 'Gate script');
  copyHookScript(hooksDir, 'lifecycle-fingerprint.mjs', 'lifecycle-fingerprint.mjs', display, 'Fingerprint helper');
}

function mergeCodexHooksConfig(hooksConfigPath: string, adapterPath: string): void {
  let config: any = {};
  const parsed = parseJsonConfig(hooksConfigPath, 'hooks.json');
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;

  if (config.hooks === undefined) config.hooks = {};
  if (typeof config.hooks !== 'object' || config.hooks === null || Array.isArray(config.hooks)) {
    logger.warn(`hooks.json has a non-object hooks field (${hooksConfigPath}), preserving it and skipping OpenFlow hook registration`);
    return;
  }
  if (config.hooks.PreToolUse === undefined) config.hooks.PreToolUse = [];
  if (!Array.isArray(config.hooks.PreToolUse)) {
    logger.warn(`hooks.json has a non-array PreToolUse field (${hooksConfigPath}), preserving it and skipping OpenFlow hook registration`);
    return;
  }

  const groups: any[] = config.hooks.PreToolUse;
  const ownsAdapter = (handler: unknown) => typeof (handler as any)?.command === 'string'
    && /openflow-codex-enforce\.mjs["']?$/.test((handler as any).command);
  for (const group of groups) {
    if (group && typeof group === 'object' && Array.isArray(group.hooks)) {
      group.hooks = group.hooks.filter((handler: unknown) => !ownsAdapter(handler));
    }
  }

  let group = groups.find((entry: any) => entry?.matcher === 'apply_patch' && Array.isArray(entry.hooks));
  if (!group) {
    group = { matcher: 'apply_patch', hooks: [] };
    groups.push(group);
  }
  group.hooks.push({
    type: 'command',
    command: `node ${JSON.stringify(adapterPath)}`,
    statusMessage: 'Checking OpenFlow workflow policy',
  });

  fs.writeFileSync(hooksConfigPath, JSON.stringify(config, null, 2) + '\n');
  logger.step(`  Hooks registered in ${path.basename(hooksConfigPath)}: apply_patch → node openflow-codex-enforce.mjs`);
}

function installOpencodeRuntime(baseDir: string, global: boolean, toolPaths: typeof TOOL_PATHS['opencode']): void {
  const configBase = global && toolPaths.globalSkillsDir
    ? path.dirname(toolPaths.globalSkillsDir)  // ".config/opencode"
    : path.dirname(toolPaths.skillsDir);        // ".opencode"
  const pluginsDir = path.join(baseDir, configBase, 'plugins');
  const hooksDir = path.join(baseDir, configBase, 'hooks');
  const opencodeJsonPath = path.join(baseDir, configBase, 'opencode.json');

  const display = (p: string) => global ? path.join('~', path.relative(baseDir, p)) : path.relative(baseDir, p);

  // Resolve the compiled plugin from dist/enforce/opencode.js (the tsc output
  // of src/enforce/opencode.ts) — not dist/core/enforce/opencode.js.
  const pluginSrc = path.resolve(__dirname, '..', 'enforce', 'opencode.js');
  const pluginDest = path.join(pluginsDir, 'openflow-enforce.js');

  if (!fileExists(pluginSrc)) {
    logger.warn('OpenCode plugin not found in dist/enforce/, skipping plugin setup — run `pnpm run build` first');
  } else {
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }
    fs.copyFileSync(pluginSrc, pluginDest);
    logger.step(`  Plugin installed: ${display(pluginDest)}`);

    // Register the actual copied plugin destination in opencode.json.
    mergeOpencodePluginConfig(opencodeJsonPath, pluginDest);
  }

  // Install the shared hook helpers (detect/gate/fingerprint) beside the plugin
  // so OpenCode has the same runnable lifecycle runtime as Claude.
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }
  copyHookScript(hooksDir, 'detect.mjs', 'openflow-detect.mjs', display, 'Detect script');
  copyHookScript(hooksDir, 'gate.mjs', 'openflow-gate.mjs', display, 'Gate script');
  copyHookScript(hooksDir, 'lifecycle-fingerprint.mjs', 'lifecycle-fingerprint.mjs', display, 'Fingerprint helper');
}

function mergeOpencodePluginConfig(opencodeJsonPath: string, pluginDest: string): void {
  let config: any = {};
  const parsed = parseJsonConfig(opencodeJsonPath, 'opencode.json');
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;

  if (!config.plugin) config.plugin = [];
  if (!Array.isArray(config.plugin)) config.plugin = [config.plugin];

  const canonical = pathToFileURL(pluginDest).href;

  // Remove only OpenFlow legacy/canonical duplicates — any URL that resolves to
  // openflow-enforce.js (the legacy relative form and prior absolute installs) —
  // preserving unrelated third-party plugins.
  config.plugin = config.plugin.filter((p: any) => {
    if (typeof p !== 'string') return true;
    return !/openflow-enforce\.js$/.test(p);
  });

  if (!config.plugin.includes(canonical)) {
    config.plugin.push(canonical);
  }

  fs.writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 2) + '\n');
  logger.step(`  Plugin registered in opencode.json: ${canonical}`);
}

function generateSkillFile(
  skillsDir: string,
  filename: string,
  depStatus: DepStatus,
  tool?: string,
  effectiveSkillsDir?: string,
  effectiveHooksDir?: string,
  hasHookRuntime?: boolean,
  hasEnforceScript?: boolean
): void {
  const templatePath = path.join(TEMPLATES_DIR, filename);

  let content: string;

  if (fileExists(templatePath)) {
    content = fs.readFileSync(templatePath, 'utf-8');
  } else {
    // Fallback: use inline template
    content = getInlineTemplate(filename, depStatus);
  }

  // Replace tool-specific paths
  if (effectiveSkillsDir && tool) {
    content = replaceToolPaths(
      content,
      tool,
      effectiveSkillsDir,
      effectiveHooksDir,
      Boolean(hasHookRuntime),
      Boolean(hasEnforceScript)
    );
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
      '| tasks.md | close (自动派生) | 从 plan-ready.md 一行 grep+sed 生成，OpenSpec 格式约定 |',
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
