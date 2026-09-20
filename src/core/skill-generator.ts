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
      throw new Error(
        `Unsupported tool: ${tool}. Supported clients: ${Object.keys(TOOL_PATHS).join(', ')}. OpenFlow only supports clients that can run the lifecycle enforcement runtime.`
      );
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

    // Claude and Codex use command hooks; OpenCode uses a plugin plus the same
    // helper scripts under its own hooks dir. Every supported client gets the
    // full lifecycle runtime — a client that cannot run it is not supported.
    const effectiveHooksDir = global && toolPaths.globalHooksDir
      ? toolPaths.globalHooksDir
      : tool === 'opencode'
        ? path.join(path.dirname(effectiveSkillsDir), 'hooks')
        : toolPaths.hooksDir;
    if (!effectiveHooksDir) {
      throw new Error(
        `Tool ${tool} has no hooks directory configured — OpenFlow cannot install its enforcement runtime and will not install skills without it.`
      );
    }

    // Generate main SKILL.md (the only file carrying codex rewrite anchors)
    generateSkillFile(skillsDir, 'SKILL.md', depStatus, tool, effectiveSkillsDir, effectiveHooksDir, true);

    // Generate phase files
    const phases = ['proposal', 'brainstorming', 'spec', 'amend', 'build', 'verify', 'close'];
    for (const phase of phases) {
      generateSkillFile(skillsDir, `${phase}.md`, depStatus, tool, effectiveSkillsDir, effectiveHooksDir);
    }

    // Generate phase reference files (loaded on demand, not on every invocation)
    generateReferenceFiles(skillsDir, tool, effectiveSkillsDir, effectiveHooksDir);

    // Generate sub-skill shortcuts (e.g., openflow-proposal, openflow-spec)
    generateSubSkillShortcuts(baseDir, toolPaths, phases, depStatus, tool, effectiveSkillsDir, effectiveHooksDir);

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

/**
 * Installs templates/references/*.md alongside the skill.
 *
 * These carry the long-form checklists that phase files pull in on demand, so
 * a phase file stays small enough to load on every invocation. Every file in
 * templates/references is installed; a missing directory is a packaging defect.
 */
function generateReferenceFiles(
  skillsDir: string,
  tool: string,
  effectiveSkillsDir: string,
  effectiveHooksDir: string
): void {
  const referencesSrc = path.join(TEMPLATES_DIR, 'references');
  if (!fs.existsSync(referencesSrc)) {
    throw new Error(
      `Reference directory not found at ${referencesSrc}. Reinstall the package — phase files depend on these files existing.`
    );
  }

  const referencesDest = path.join(skillsDir, 'references');
  if (!fs.existsSync(referencesDest)) {
    fs.mkdirSync(referencesDest, { recursive: true });
  }

  const entries = fs.readdirSync(referencesSrc).filter((name) => name.endsWith('.md'));
  if (entries.length === 0) {
    throw new Error(`Reference directory ${referencesSrc} is empty — refusing to install an incomplete skill set.`);
  }

  for (const name of entries) {
    const content = replaceToolPaths(
      fs.readFileSync(path.join(referencesSrc, name), 'utf-8'),
      tool,
      effectiveSkillsDir,
      effectiveHooksDir,
      false
    );
    fs.writeFileSync(path.join(referencesDest, name), content);
    logger.step(`  references/${name}`);
  }
}

function generateSubSkillShortcuts(
  baseDir: string,
  toolPaths: ToolPaths,
  phases: string[],
  depStatus: DepStatus,
  tool: string,
  effectiveSkillsDir: string,
  effectiveHooksDir: string
): void {
  logger.step('Generating sub-skill shortcuts ...');

  for (const phase of phases) {
    const subSkillName = `${SKILL_NAME}-${phase}`;
    const subSkillDir = path.join(baseDir, effectiveSkillsDir, subSkillName);

    if (!fs.existsSync(subSkillDir)) {
      fs.mkdirSync(subSkillDir, { recursive: true });
    }

    const templatePath = path.join(TEMPLATES_DIR, subSkillName, 'SKILL.md');
    if (!fileExists(templatePath)) {
      throw new Error(
        `Sub-skill template ${subSkillName}/SKILL.md not found at ${templatePath}. Reinstall the package — OpenFlow will not install a partial skill set.`
      );
    }
    let content = fs.readFileSync(templatePath, 'utf-8');

    // Replace tool-specific paths in content
    content = replaceToolPaths(content, tool, effectiveSkillsDir, effectiveHooksDir, false);

    const targetPath = path.join(subSkillDir, 'SKILL.md');
    fs.writeFileSync(targetPath, content);
    logger.step(`  ${subSkillName}/SKILL.md`);
  }
}

/** Exported so tests exercise the real rewrite instead of a drifting copy. */
export function replaceToolPaths(
  content: string,
  tool: string,
  effectiveSkillsDir: string,
  effectiveHooksDir: string,
  assertCodexAnchors: boolean
): string {
  // Replace local skill path references
  content = content.replace(/\.claude\/skills\/openflow\//g, `${effectiveSkillsDir}/openflow/`);
  // Replace global skill path references
  content = content.replace(/~\/\.claude\/skills\/openflow\//g, `~/${effectiveSkillsDir}/openflow/`);
  // Skills and runtime files use different roots for Codex: skills live under
  // .agents while hooks remain under .codex. Every supported client installs
  // the lifecycle runtime, so there is no "hooks missing" rendering.
  content = content.replace(/\.claude\/hooks\//g, `${effectiveHooksDir}/`);
  content = content.replace(/~\/\.claude\/hooks\//g, `~/${effectiveHooksDir}/`);
  if (tool === 'codex') {
    content = content.replace(/(^|[\s`])\/openflow(?=(?:[-\s`]|$))/gm, (_match, prefix: string) => `${prefix}$openflow`);
    // Only the main SKILL.md carries these anchors; phase files and sub-skill
    // shortcuts legitimately lack them.
    if (assertCodexAnchors) {
      content = mustReplace(
        content,
        'Claude hook / OpenCode plugin',
        'Claude hook / OpenCode plugin / Codex hook',
        'codex enforcement-artifact list'
      );
      content = mustReplace(
        content,
        '每个客户端都装完整生命周期运行时',
        '每个客户端都装完整生命周期运行时（Codex 首次安装或 hooks 更新后，必须通过 `/hooks` 审核并信任该仓库 hook；OpenFlow 不会绕过 Codex hook trust）',
        'codex hook-trust note'
      );
    }
  }
  return content;
}

/**
 * Template rewrite that refuses to no-op.
 *
 * A drifted anchor used to silently skip the rewrite, shipping a template that
 * described the wrong client. Anchor drift is a build defect, so it fails here
 * rather than downstream in the agent's instructions.
 */
function mustReplace(content: string, anchor: string, replacement: string, label: string): string {
  if (!content.includes(anchor)) {
    throw new Error(
      `Template anchor for ${label} not found: "${anchor}". A template was edited without updating skill-generator.ts — fix the anchor instead of shipping an unrewritten template.`
    );
  }
  return content.replace(anchor, replacement);
}


function copyHookScript(hooksDir: string, srcName: string, destName: string, display: (p: string) => string, label: string): void {
  const src = path.join(HOOKS_DIR, srcName);
  const dest = path.join(hooksDir, destName);
  if (!fileExists(src)) {
    throw new Error(
      `${label} source (${srcName}) not found at ${src}. OpenFlow refuses to install a partial lifecycle runtime — reinstall the package or run \`pnpm run build\`.`
    );
  }
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  logger.step(`  ${label}: ${display(dest)}`);
}

/**
 * Installs a compiled enforcement adapter next to the shared policy module.
 *
 * Claude and Codex both run their adapter as a standalone Node script, so the
 * adapter's `./rules.js` import is rewritten to the installed filename. There is
 * exactly one hand-maintained policy source (src/enforce/rules.ts); adapters own
 * only their client's I/O contract.
 */
function installEnforcementAdapter(
  hooksDir: string,
  adapterFile: string,
  adapterDestName: string,
  display: (p: string) => string,
  label: string
): string {
  const adapterSrc = path.resolve(__dirname, '..', 'enforce', adapterFile);
  const rulesSrc = path.resolve(__dirname, '..', 'enforce', 'rules.js');
  const adapterDest = path.join(hooksDir, adapterDestName);
  const rulesDest = path.join(hooksDir, 'openflow-rules.mjs');

  if (!fileExists(adapterSrc) || !fileExists(rulesSrc)) {
    throw new Error(
      `${label} not found in dist/enforce/ (expected ${adapterFile} and rules.js). Run \`pnpm run build\` before installing — OpenFlow will not install an agent without its enforcement layer.`
    );
  }

  const adapter = fs.readFileSync(adapterSrc, 'utf8');
  const rendered = adapter.replace("from './rules.js'", "from './openflow-rules.mjs'");
  if (rendered === adapter) {
    throw new Error(
      `${label} (${adapterFile}) does not import './rules.js' as expected — the installer cannot rewire it. This is a build defect, not a recoverable condition.`
    );
  }

  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }
  fs.writeFileSync(adapterDest, rendered);
  fs.copyFileSync(rulesSrc, rulesDest);
  fs.chmodSync(adapterDest, 0o755);
  fs.chmodSync(rulesDest, 0o755);
  logger.step(`  ${label}: ${display(adapterDest)}`);
  return adapterDest;
}

function installHooks(baseDir: string, toolPaths: typeof TOOL_PATHS['claude'], global: boolean): void {
  const hooksDir = path.join(baseDir, toolPaths.hooksDir!);
  const settingsFile = path.join(baseDir, toolPaths.settingsFile!);
  const oldPyHook = path.join(hooksDir, 'openflow-enforce.py');

  // Display path: prefix with ~/ for global installs
  const display = (p: string) => global ? path.join('~', path.relative(baseDir, p)) : path.relative(baseDir, p);

  // Create hooks directory
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // Cleanup old Python hook
  if (fileExists(oldPyHook)) {
    fs.unlinkSync(oldPyHook);
    logger.step(`  Removed legacy hook: ${display(oldPyHook)}`);
  }

  // Enforcement adapter + shared policy, then detect/gate/fingerprint helpers
  const hookScriptDest = installEnforcementAdapter(
    hooksDir, 'claude.js', 'openflow-enforce.mjs', display, 'Hook installed'
  );
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
  } catch (err) {
    // Merging into an empty config would silently discard the user's settings
    // and, worse, register hooks into a file that no longer matches what they
    // wrote. Stop and let them fix the JSON.
    throw new Error(
      `${label} 无法解析（${filePath}）：${(err as Error).message}\n请先修复该文件的 JSON 语法再重新运行 openflow init——OpenFlow 不会用空配置覆盖它。`
    );
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
    throw new Error(
      'Codex hook paths are not configured — cannot install the lifecycle runtime. OpenFlow will not install skills without enforcement.'
    );
  }

  const hooksDir = path.join(baseDir, hooksRelativeDir);
  const hooksConfigPath = path.join(baseDir, hooksConfigRelative);
  const display = (p: string) => global ? path.join('~', path.relative(baseDir, p)) : path.relative(baseDir, p);
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const adapterDest = installEnforcementAdapter(
    hooksDir, 'codex.js', 'openflow-codex-enforce.mjs', display, 'Codex enforcement adapter'
  );
  mergeCodexHooksConfig(hooksConfigPath, adapterDest);

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
    throw new Error(
      `hooks.json has a non-object "hooks" field (${hooksConfigPath}). OpenFlow cannot register its enforcement hook without overwriting your config — fix the field and re-run init.`
    );
  }
  if (config.hooks.PreToolUse === undefined) config.hooks.PreToolUse = [];
  if (!Array.isArray(config.hooks.PreToolUse)) {
    throw new Error(
      `hooks.json has a non-array "hooks.PreToolUse" field (${hooksConfigPath}). OpenFlow cannot register its enforcement hook without overwriting your config — fix the field and re-run init.`
    );
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

  // Self-contained bundle generated by scripts/build-opencode-plugin.mjs —
  // policy is inlined, so the plugin resolves nothing at load time and cannot
  // silently lose its enforcement layer inside OpenCode's runtime.
  const pluginSrc = path.resolve(__dirname, '..', 'enforce', 'opencode-plugin.mjs');
  const pluginDest = path.join(pluginsDir, 'openflow-enforce.js');

  if (!fileExists(pluginSrc)) {
    throw new Error(
      'OpenCode plugin bundle not found at dist/enforce/opencode-plugin.mjs. Run `pnpm run build` before installing — OpenFlow will not install skills without enforcement.'
    );
  }

  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }
  fs.copyFileSync(pluginSrc, pluginDest);
  logger.step(`  Plugin installed: ${display(pluginDest)}`);

  // Register the actual copied plugin destination in opencode.json.
  mergeOpencodePluginConfig(opencodeJsonPath, pluginDest);

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
  tool: string,
  effectiveSkillsDir: string,
  effectiveHooksDir: string,
  assertCodexAnchors = false
): void {
  const templatePath = path.join(TEMPLATES_DIR, filename);

  if (!fileExists(templatePath)) {
    throw new Error(
      `Template ${filename} not found at ${templatePath}. OpenFlow will not install a skill set with missing phases — reinstall the package.`
    );
  }
  let content = fs.readFileSync(templatePath, 'utf-8');

  content = replaceToolPaths(content, tool, effectiveSkillsDir, effectiveHooksDir, assertCodexAnchors);

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

