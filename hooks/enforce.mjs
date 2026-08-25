#!/usr/bin/env node
/**
 * openflow enforcement hooks for Claude Code — 阶段生命周期防火墙
 *
 * standalone .mjs, no dependencies. Called by Claude Code PreToolUse hook.
 * Reads tool-call JSON from stdin, prints warnings to stdout, exits 1 if blocked.
 *
 * Parity target: src/enforce/rules.ts (Task 1 reference contract). Recreates the
 * full phase/selector/path policy with identical `id`, `level`, and ordering
 * semantics. Keeps zero-dependency; adapts Claude top-level and nested tool_input
 * payloads; preserves absent-phase compatibility scanning and building-marker TDD.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ---- constants ----

const PHASE_NAMES = new Set([
  'proposal', 'brainstorming', 'spec', 'amend', 'build', 'verify', 'close',
]);

const CHANGE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TEST_FRAMEWORK_CONFIGS = new Set([
  'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'pyproject.toml', 'Cargo.toml',
]);

// ---- helpers ----

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function block(id, message, detail) {
  return detail === undefined ? { level: 'block', id, message } : { level: 'block', id, message, detail };
}

function warn(id, message, detail) {
  return detail === undefined ? { level: 'warn', id, message } : { level: 'warn', id, message, detail };
}

/** Normalized sorted level:id result vector (blocks first, then by id). */
function sortResults(results) {
  return [...results].sort((a, b) => {
    if (a.level !== b.level) return a.level === 'block' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

// ---- 1. normalizeToolInput ----

/**
 * Normalize host tool-call payloads to one shape. Accepts Claude top-level
 * (`tool_name`/`file_path`), Claude nested `tool_input`, and OpenCode
 * `call.{name|toolName}` + `call.input` field variants.
 */
function normalizeToolInput(payload, cwd) {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload;

  let operation = null;
  const topTool = typeof p.tool_name === 'string' ? p.tool_name : typeof p.toolName === 'string' ? p.toolName : '';
  if (topTool) {
    const t = topTool.toLowerCase();
    if (t === 'edit') operation = 'edit';
    else if (t === 'write') operation = 'write';
  }
  if (operation === null && typeof p.call === 'object' && p.call !== null) {
    const call = p.call;
    const callTool = typeof call.name === 'string' ? call.name : typeof call.toolName === 'string' ? call.toolName : '';
    const t = callTool.toLowerCase();
    if (t === 'edit') operation = 'edit';
    else if (t === 'write') operation = 'write';
  }
  if (operation === null) return null;

  let filePath = typeof p.file_path === 'string' ? p.file_path : typeof p.filePath === 'string' ? p.filePath : '';
  if (!filePath && typeof p.tool_input === 'object' && p.tool_input !== null) {
    const ti = p.tool_input;
    filePath = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.filePath === 'string' ? ti.filePath : '';
  }
  if (!filePath && typeof p.call === 'object' && p.call !== null) {
    const ci = p.call.input;
    if (typeof ci === 'object' && ci !== null) {
      filePath = typeof ci.file_path === 'string' ? ci.file_path : typeof ci.filePath === 'string' ? ci.filePath : '';
    }
  }
  if (!filePath) return null;

  let content = typeof p.content === 'string' ? p.content : typeof p.new_string === 'string' ? p.new_string : '';
  if (!content && typeof p.tool_input === 'object' && p.tool_input !== null) {
    const ti = p.tool_input;
    content = typeof ti.content === 'string' ? ti.content : typeof ti.new_string === 'string' ? ti.new_string : '';
  }
  if (!content && typeof p.call === 'object' && p.call !== null) {
    const ci = p.call.input;
    if (typeof ci === 'object' && ci !== null) {
      content = typeof ci.content === 'string' ? ci.content : typeof ci.new_string === 'string' ? ci.new_string : '';
    }
  }

  return { operation, filePath, content, cwd };
}

// ---- 2. toWorkspaceRelativePath ----

function isWithin(root, target) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false; // cannot establish workspace root -> fail closed
  }
  let realTarget;
  try {
    if (fs.existsSync(target)) {
      realTarget = fs.realpathSync(target);
    } else {
      let ancestor = target;
      const tail = [];
      for (;;) {
        let present = false;
        try { fs.lstatSync(ancestor); present = true; } catch { present = false; }
        if (present) break;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        tail.unshift(path.basename(ancestor));
        ancestor = parent;
      }
      realTarget = path.join(fs.realpathSync(ancestor), ...tail);
    }
  } catch {
    return false;
  }
  const rel = path.relative(realRoot, realTarget);
  return !(rel.startsWith('..') || path.isAbsolute(rel));
}

function toWorkspaceRelativePath(rawPath, cwd) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { ok: false, reason: 'empty' };
  }
  const p = rawPath.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return { ok: false, reason: 'unsupported-path' };
  if (/^[a-zA-Z]:/.test(p)) return { ok: false, reason: 'unsupported-path' };
  if (/^[\\/]{2}/.test(p)) return { ok: false, reason: 'unsupported-path' };

  const normalized = p.replace(/\\/g, '/');
  const workspaceAbs = path.resolve(cwd);

  const isAbs = path.isAbsolute(normalized);
  const abs = isAbs ? path.normalize(normalized) : path.resolve(workspaceAbs, normalized);

  const rel = path.relative(workspaceAbs, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: isAbs ? 'outside-workspace' : 'traversal' };
  }

  if (!isWithin(workspaceAbs, abs)) {
    return { ok: false, reason: 'outside-workspace' };
  }

  return { ok: true, relative: rel.split(path.sep).join('/') };
}

// ---- 3. readPhaseState ----

function readPhaseState(cwd) {
  const phaseFile = path.join(cwd, '.openflow', 'phase');
  const raw = safeRead(phaseFile);
  if (raw === null) return { state: null, error: null };

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { state: null, error: '.openflow/phase 不是合法 JSON' };
  }
  if (!data || typeof data !== 'object') {
    return { state: null, error: '.openflow/phase 必须是 JSON 对象' };
  }
  const obj = data;

  if (obj.version !== 1) return { state: null, error: `不支持的 version: ${String(obj.version)}` };
  const change = typeof obj.change === 'string' ? obj.change : '';
  if (!CHANGE_NAME_RE.test(change)) return { state: null, error: `非法 change 名: ${change}` };
  const phase = typeof obj.phase === 'string' ? obj.phase : '';
  if (!PHASE_NAMES.has(phase)) return { state: null, error: `非法 phase: ${phase}` };
  const phaseName = phase;

  const activeDir = path.join(cwd, 'openspec', 'changes', change);
  const archiveDir = path.join(cwd, 'openspec', 'changes', 'archive', change);
  const hasActive = isDir(activeDir);
  const hasArchive = isDir(archiveDir);
  if (!hasActive) {
    return { state: null, error: hasArchive ? `change 已归档: ${change}` : `active change 目录缺失: ${change}` };
  }

  if ('mode' in obj && typeof obj.mode !== 'string') {
    return { state: null, error: `mode 必须是字符串: ${String(obj.mode)}` };
  }
  if ('task' in obj && typeof obj.task !== 'string') {
    return { state: null, error: `task 必须是字符串: ${String(obj.task)}` };
  }
  const modeRaw = typeof obj.mode === 'string' ? obj.mode : undefined;
  const taskRaw = typeof obj.task === 'string' ? obj.task : undefined;

  if (phaseName === 'build') {
    if (modeRaw === undefined) return { state: null, error: 'build 阶段缺少 mode' };
    if (modeRaw !== 'bootstrap' && modeRaw !== 'task-build') return { state: null, error: `非法 build mode: ${modeRaw}` };
    if (modeRaw === 'bootstrap') {
      if (taskRaw !== undefined) return { state: null, error: 'bootstrap 不允许携带 task' };
      return { state: { version: 1, change, phase: phaseName, mode: 'bootstrap' }, error: null };
    }
    if (taskRaw === undefined) return { state: null, error: 'task-build 缺少 task' };
    if (!/^\d+$/.test(taskRaw)) return { state: null, error: `非法 task: ${taskRaw}` };
    return { state: { version: 1, change, phase: phaseName, mode: 'task-build', task: taskRaw }, error: null };
  }

  if (modeRaw !== undefined || taskRaw !== undefined) {
    return { state: null, error: `非 build phase 不允许携带 mode/task: ${phaseName}` };
  }
  return { state: { version: 1, change, phase: phaseName }, error: null };
}

// ---- 4. resolveCurrentTask ----

function parseTestPlanRows(content) {
  const out = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Canonical stable-row grammar (Task 7): `T-001: \`file::selector\`` with an
    // optional trailing status suffix (`✅ PASS` / `⬜ TODO` / `❌ FAIL`). The
    // suffix is captured-and-ignored here — the selector mapping only reads the
    // backtick content, so status updates never corrupt TDD scoping. This exact
    // regex is the canonical pattern shared by gate.mjs / detect.mjs / enforce.mjs
    // / opencode.ts; keep the five in sync (review M3).
    const m = trimmed.match(/^([T#]\S+)\s*:\s*`([^`]+)`(?:\s+(.+))?$/);
    if (!m) continue;
    const id = m[1];
    const selector = m[2].trim();
    const sep = selector.lastIndexOf('::');
    const file = sep === -1 ? selector : selector.slice(0, sep);
    out.push({ id, file, selector });
  }
  return out;
}

function parseAllTaskBlocks(content) {
  const blocks = [];
  let current = null;
  for (const line of content.split('\n')) {
    const h = line.match(/^###\s+Task\s+(\d+)\s*:/);
    if (h) {
      current = { taskId: h[1], testCases: [], files: [], frameworkSetup: [] };
      blocks.push(current);
      continue;
    }
    if (current === null) continue;
    const t = line.match(/^\s*-\s*Test cases?\s*:\s*(.+)$/i);
    if (t) {
      for (const tok of t[1].split(/[,\s]+/)) {
        const x = tok.trim();
        if (x) current.testCases.push(x);
      }
      continue;
    }
    const f = line.match(/^\s*-\s*Files?\s*:\s*(.+)$/i);
    if (f) {
      for (const tok of f[1].split(',')) {
        const x = tok.trim().replace(/^`|`$/g, '');
        if (x) current.files.push(x);
      }
      continue;
    }
    const fs2 = line.match(/^\s*-\s*Test framework setup\s*:\s*(.+)$/i);
    if (fs2) {
      for (const tok of fs2[1].split(/[,\s]+/)) {
        const x = tok.trim().replace(/^`|`$/g, '');
        if (x) current.frameworkSetup.push(x);
      }
    }
  }
  return blocks;
}

function resolveCurrentTask(cwd, state) {
  if (state.mode !== 'task-build') {
    return { task: null, error: '当前 phase 不是 task-build，无法解析 current task' };
  }
  if (typeof state.task !== 'string') {
    return { task: null, error: 'task-build 缺少 task 字段' };
  }
  const taskId = state.task;
  const changeDir = path.join(cwd, 'openspec', 'changes', state.change);
  const planReady = safeRead(path.join(changeDir, 'plan-ready.md'));
  const testPlan = safeRead(path.join(changeDir, 'test-plan.md'));
  if (planReady === null) return { task: null, error: 'plan-ready.md 缺失' };
  if (testPlan === null) return { task: null, error: 'test-plan.md 缺失' };

  const rows = parseTestPlanRows(testPlan);
  const byId = new Map();
  for (const row of rows) {
    const list = byId.get(row.id) ?? [];
    list.push(row);
    byId.set(row.id, list);
  }
  const ownerMap = new Map();
  for (const row of rows) {
    const list = ownerMap.get(row.selector) ?? [];
    list.push(row.id);
    ownerMap.set(row.selector, list);
  }

  const block2 = parseAllTaskBlocks(planReady).find((b) => b.taskId === taskId);
  if (!block2) return { task: null, error: `plan-ready 中未找到 Task ${taskId}` };

  const testIds = block2.testCases;
  if (testIds.length === 0) return { task: null, error: `Task ${taskId} 没有声明 Test cases` };

  const hasStable = testIds.some((id) => /^T-\d+$/.test(id));
  const hasLegacy = testIds.some((id) => /^#\d+$/.test(id));
  if (hasStable && hasLegacy) {
    return { task: null, error: 'tdd-task-unmapped: 混用稳定 T-id 与 legacy #N 引用' };
  }

  const seen = new Set();
  for (const id of testIds) {
    if (seen.has(id)) return { task: null, error: `tdd-task-unmapped: 任务内重复 id ${id}` };
    seen.add(id);
  }

  const selectors = [];
  for (const id of testIds) {
    const candidates = byId.get(id) ?? [];
    if (candidates.length === 0) return { task: null, error: `tdd-task-unmapped: 引用未映射 ${id}` };
    if (candidates.length > 1) {
      return { task: null, error: `tdd-task-unmapped: ${id} 歧义，匹配 ${candidates.length} 行` };
    }
    const sel = candidates[0];
    const owners = ownerMap.get(sel.selector) ?? [];
    if (owners.length > 1) {
      return { task: null, error: `tdd-task-unmapped: 选择器 ${sel.selector} 被多个 id 拥有 (${owners.join(',')})` };
    }
    selectors.push(sel);
  }

  const frameworkSetupFiles = block2.frameworkSetup.filter((f) => TEST_FRAMEWORK_CONFIGS.has(f));

  return {
    task: {
      id: taskId,
      declaredFiles: block2.files,
      testIds,
      selectors,
      frameworkSetupFiles,
    },
    error: null,
  };
}

// ---- 5. phase-boundary policy ----

function changePrefixOf(state) {
  return `openspec/changes/${state.change}/`;
}

function isDatedPlanPath(relPath) {
  const name = path.basename(relPath);
  return /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(name);
}

function readTestPlanSelectorFiles(cwd, change) {
  const tp = safeRead(path.join(cwd, 'openspec', 'changes', change, 'test-plan.md'));
  const set = new Set();
  if (tp === null) return set;
  for (const row of parseTestPlanRows(tp)) set.add(row.file);
  return set;
}

function readDeclaredFrameworkSetupFiles(cwd, change) {
  const pr = safeRead(path.join(cwd, 'openspec', 'changes', change, 'plan-ready.md'));
  const set = new Set();
  if (pr === null) return set;
  for (const b of parseAllTaskBlocks(pr)) {
    for (const f of b.frameworkSetup) {
      if (TEST_FRAMEWORK_CONFIGS.has(f)) set.add(f);
    }
  }
  return set;
}

function checkBootstrapBoundary(state, relPath, cwd) {
  if (readTestPlanSelectorFiles(cwd, state.change).has(relPath)) return null;
  if (readDeclaredFrameworkSetupFiles(cwd, state.change).has(relPath)) return null;
  return block('phase-boundary', `bootstrap 阶段仅允许修改测试或声明的框架配置，禁止生产文件: ${relPath}`);
}

function checkTaskBuildBoundary(state, relPath, cwd) {
  const resolved = resolveCurrentTask(cwd, state);
  if (resolved.error !== null) {
    return block('tdd-task-unmapped', `无法解析当前任务: ${resolved.error}`, resolved.error);
  }
  const task = resolved.task;
  const declared = new Set(task.declaredFiles);
  if (declared.has(relPath)) return null;
  for (const sel of task.selectors) {
    if (relPath === sel.file) return null;
  }
  return block('phase-boundary', `task-build 阶段仅允许修改 Task ${task.id} 声明的文件或选择器区域`);
}

// ---- selector-aware TDD checks (task-build) ----

function isTestFilePath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/test/') || normalized.includes('/tests/') ||
      normalized.includes('/__tests__/') || normalized.includes('/spec/') ||
      normalized.endsWith('Test.java') || normalized.endsWith('Test.kt') ||
      normalized.endsWith('test.js') || normalized.endsWith('test.ts') ||
      normalized.endsWith('_test.py') || normalized.endsWith('_test.go') ||
      normalized.endsWith('_test.rs') || normalized.endsWith('.test.js') ||
      normalized.endsWith('.test.ts') || normalized.endsWith('.test.tsx') ||
      normalized.endsWith('.spec.js') || normalized.endsWith('.spec.ts')) {
    return true;
  }
  return false;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSelectorRegionUnfinished(content, sel) {
  const sep = sel.selector.lastIndexOf('::');
  const name = sep === -1 ? sel.selector : sel.selector.slice(sep + 2);
  if (!name) return true;
  const lines = content.split('\n');
  let start = -1;
  if (name.startsWith('@openflow(')) {
    // marker-region form: locate the documented marker token
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(name)) { start = i; break; }
    }
  } else {
    // Language-neutral declaration recognition (Task 7 re-review): Jest
    // test/it/describe('name'), Python `def test_name():`, Go `func TestName()`,
    // Rust `#[test] fn test_name()`, and JUnit `@Test` method. Selector forms
    // none of these recognize must use the `@openflow(T-001)` marker region.
    const esc = escapeRegExp(name);
    const declPatterns = [
      new RegExp(`\\b(?:test|it|describe)(?:\\.\\w+)?\\s*\\(\\s*['"\`]${esc}['"\`]`),
      new RegExp(`\\bdef\\s+${esc}\\s*\\(`),
      new RegExp(`\\bfunc\\s+${esc}\\s*\\(`),
      new RegExp(`\\bfn\\s+${esc}\\s*\\(`),
      // JUnit/Java method: return type + name(`void testLogin()`, `String foo()`…)
      new RegExp(`\\b(?:void|boolean|int|long|float|double|char|byte|short|String|Object|List|Map|Set|[A-Z][\\w<>\\[\\], ]*)\\s+${esc}\\s*\\(`),
    ];
    const nameCallRe = new RegExp(`\\b${esc}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const p of declPatterns) {
        if (p.test(line)) { start = i; break; }
      }
      if (start !== -1) break;
      // JUnit `@Test` annotation whose method declaration is on this/next line.
      if (/@Test\b/.test(line) && (nameCallRe.test(line) || nameCallRe.test(lines[i + 1] || ''))) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) return true; // cannot establish exact location -> conservative block
  let end = lines.length;
  const nextDeclRe = /(?:^|\s)(?:test|it|describe)\s*\(|^\s*(?:async\s+)?def\s+\w+\s*\(|^\s*fn\s+\w+\s*\(|^\s*func\s+Test\w*\s*\(|@Test\b|#\[test\]/;
  for (let i = start + 1; i < lines.length; i++) {
    if (nextDeclRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  const region = lines.slice(start, end).join('\n');
  return /TODO|FAIL|assert\s*\(\s*false|assert\s+False\b|pending\s*\(/.test(region);
}

function runTaskBuildTdd(state, relPath, cwd) {
  const out = [];
  const resolved = resolveCurrentTask(cwd, state);
  if (resolved.error !== null) return out;

  const marker = safeRead(path.join(cwd, '.openflow', 'building'));
  if (marker !== null) {
    const markerChange = marker.trim();
    if (markerChange.length > 0 && markerChange !== state.change) {
      out.push(block(
        'change-state-conflict',
        `.openflow/building 指向 "${markerChange}"，与 phase change "${state.change}" 不一致`,
      ));
      return out;
    }
  }

  if (isTestFilePath(relPath)) return out;
  const task = resolved.task;
  const declared = new Set(task.declaredFiles);
  if (!declared.has(relPath)) return out;

  for (const sel of task.selectors) {
    const selRel = toWorkspaceRelativePath(sel.file, cwd);
    if (!selRel.ok) {
      out.push(block('tdd-test-file-missing', `当前任务选择器路径不安全: ${sel.file}`, `原因: ${selRel.reason}`));
      return out;
    }
    const testAbs = path.join(cwd, selRel.relative);
    if (!fs.existsSync(testAbs) || !fs.statSync(testAbs).isFile()) {
      out.push(block('tdd-test-file-missing', `当前任务测试文件缺失: ${sel.file}`, '先按测试计划补上测试文件。'));
      return out;
    }
    const testContent = safeRead(testAbs);
    if (testContent === null) continue;
    if (isSelectorRegionUnfinished(testContent, sel)) {
      out.push(block('tdd-stub-check', `当前任务选择器区域未完成: ${sel.selector}`, 'TDD 铁律：Step 1 补全测试 → Step 2 确认 FAIL → Step 3 写实现。'));
      return out;
    }
  }
  return out;
}

function checkPhaseBoundary(state, relPath, cwd) {
  if (relPath === '.openflow/phase' || relPath === '.openflow/building') return null;

  const changePrefix = changePrefixOf(state);
  switch (state.phase) {
    case 'proposal':
    case 'brainstorming': {
      if (relPath === `${changePrefix}proposal.md`) return null;
      return block('phase-boundary', `${state.phase} 阶段仅允许修改 proposal.md`);
    }
    case 'spec': {
      if (relPath.startsWith(changePrefix)) return null;
      return block('phase-boundary', 'spec 阶段仅允许修改 active change 文档');
    }
    case 'amend': {
      if (relPath.startsWith(changePrefix)) return null;
      if (isDatedPlanPath(relPath)) return null;
      return block('phase-boundary', 'amend 阶段仅允许修改 change 文档或 dated plan');
    }
    case 'build': {
      return state.mode === 'bootstrap'
        ? checkBootstrapBoundary(state, relPath, cwd)
        : checkTaskBuildBoundary(state, relPath, cwd);
    }
    case 'verify': {
      const allowed = new Set([`${changePrefix}verify-issues.md`, `${changePrefix}verify-result.json`]);
      if (allowed.has(relPath)) return null;
      return block('phase-boundary', 'verify 阶段仅允许修改 verify-issues.md / verify-result.json');
    }
    case 'close': {
      const allowed = new Set([`${changePrefix}lessons.md`, `${changePrefix}tasks.md`]);
      if (allowed.has(relPath)) return null;
      return block('phase-boundary', 'close 阶段仅允许修改 lessons.md / tasks.md');
    }
    default:
      return null;
  }
}

// ---- 6. compatibility checks (phase absent) ----

function checkFileExists(toolName, filePath, cwd) {
  if (toolName !== 'Edit') return null;
  if (!filePath.includes('openspec/')) return null;

  const absolute = path.join(cwd, filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return block('no-read-no-use', `Edit 的目标文件不存在: ${filePath}`, '你可能在编造一个不存在的文件路径。请先用 ls/grep 确认文件存在。');
  }
  return null;
}

function checkCertaintyTags(filePath, content) {
  if (!content) return null;

  const name = path.basename(filePath);
  const isDesignDoc = name === 'design.md';
  const isTaskDoc = name.includes('plan-ready') || name.includes('test-plan');
  if (!isDesignDoc && !isTaskDoc) return null;

  const count = (content.match(/\[Assumption\]/g) ?? []).length;
  if (count === 0) return null;

  // design.md is warning-only (a soft reminder resolved during spec); plan-ready/test-plan
  // escalate to a block at 2+ assumptions to force task splitting before build.
  const level = isDesignDoc ? 'warn' : count >= 2 ? 'block' : 'warn';
  return {
    level,
    id: 'certainty-tags',
    message: `${filePath} 包含 ${count} 个 [Assumption] 标签`,
    detail:
      level === 'block'
        ? '超过 1 个 [Assumption]，建议拆分 task 或回到 spec 阶段补读代码。build 阶段执行前须消解为 [Verified] 或 [Inferred]。'
        : 'build 阶段执行前须消解为 [Verified] 或 [Inferred]。',
  };
}

function checkCompatPhaseBoundary(filePath, cwd) {
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
      return block('phase-boundary', `build 阶段不允许修改规格文档: ${filePath}`, '如果确实需要修改需求，请用 /openflow amend。');
    }
  }
  return null;
}

function checkTasksSync(filePath, content, cwd) {
  if (!filePath.includes('plan-ready.md')) return null;

  const parent = path.dirname(path.join(cwd, filePath));
  const tasksFile = path.join(parent, 'tasks.md');

  if (!fs.existsSync(tasksFile)) return null;
  if (!content.includes('[x]') && !content.includes('[ ]')) return null;

  return warn('tasks-sync', 'plan-ready.md checkbox 变化，请同步更新 tasks.md', `tasks.md 路径: ${tasksFile}\n提示: close 阶段会从 plan-ready.md 自动重新生成 tasks.md，现在可以跳过手动同步。`);
}

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
  if (filePath.includes('openspec/')) return null;
  if (filePath.includes('docs/superpowers/')) return null;
  if (filePath.includes('.openflow/')) return null;
  if (isWritingPlansAvailable(cwd, os.homedir())) return null;
  return block('writing-plans-gate', 'build 阶段需要 writing-plans，但未检测到（已查 skills 目录和 superpowers 插件）', '请先安装 Superpowers writing-plans（Claude Code: /plugin install superpowers@claude-plugins-official）后重试，或退出 build 阶段（删除 .openflow/building）。');
}

/** Old global TDD scan, run only when .openflow/building exists (phase-absent compat). */
function checkTddStubs(filePath, cwd) {
  if (process.env.OPENFLOW_NO_BUILD_GATE === '1') return null;
  const marker = path.join(cwd, '.openflow', 'building');
  if (!fs.existsSync(marker)) return null;

  const normalized = filePath.replace(/\\/g, '/');
  if (isTestFilePath(normalized)) return null;

  if (!normalized.includes('src/')) return null;

  const changesDir = path.join(cwd, 'openspec', 'changes');
  let changeDir = null;
  try {
    const entries = fs.readdirSync(changesDir, { withFileTypes: true });
    const active = entries.filter((e) => e.isDirectory() && e.name !== 'archive');
    if (active.length === 1) {
      changeDir = path.join(changesDir, active[0].name);
    }
  } catch { return null; }
  if (!changeDir) return null;

  const tpPath = path.join(changeDir, 'test-plan.md');
  const tpContent = safeRead(tpPath);
  if (!tpContent) return null;

  const testFiles = new Set();
  const fileRe = /`([^`]+\.[a-z]{2,6}(?:::[^`]+)?)`/gi;
  for (const m of tpContent.matchAll(fileRe)) {
    const p = m[1].split('::')[0];
    testFiles.add(p);
  }

  if (testFiles.size === 0) return null;

  const stubs = [];
  for (const tf of testFiles) {
    const absPath = path.join(cwd, tf);
    const testContent = safeRead(absPath);
    if (!testContent) continue;
    const todoLine = testContent.match(/^(?!.*\*).*(assert\s+False|fail\s*\(|throw\s+new\s+\w+Exception).*TODO/im);
    if (todoLine) {
      stubs.push(`${tf}: ${todoLine[0].trim().slice(0, 80)}`);
    }
  }

  if (stubs.length === 0) return null;

  return block('tdd-stub-check', `build 阶段：${stubs.length} 个测试文件仍有 TODO 桩，必须先补全测试再写实现代码`, stubs.map((s) => `  - ${s}`).join('\n') + '\n\nTDD 铁律：Step 1 补全测试 → Step 2 确认 FAIL（红）→ Step 3 写实现代码。');
}

function runCompatChecks(operation, relPath, content, cwd) {
  const toolName = operation === 'edit' ? 'Edit' : 'Write';
  const results = [];
  const r1 = checkFileExists(toolName, relPath, cwd);
  if (r1) results.push(r1);
  const r2 = checkCertaintyTags(relPath, content);
  if (r2) results.push(r2);
  const r3 = checkCompatPhaseBoundary(relPath, cwd);
  if (r3) results.push(r3);
  const r4 = checkTasksSync(relPath, content, cwd);
  if (r4) results.push(r4);
  const r5 = checkWritingPlansGate(relPath, cwd);
  if (r5) results.push(r5);
  const r6 = checkTddStubs(relPath, cwd);
  if (r6) results.push(r6);
  return sortResults(results);
}

// ---- main entry ----

function runAllChecks(input) {
  const { operation, filePath, content, cwd } = input;
  if (operation !== 'edit' && operation !== 'write') return [];

  const rel = toWorkspaceRelativePath(filePath, cwd);
  if (!rel.ok) {
    return [block('unsafe-path', `不安全的文件路径: ${filePath}`, `原因: ${rel.reason}`)];
  }
  const relPath = rel.relative;

  const stateRes = readPhaseState(cwd);

  if (stateRes.error !== null) {
    if (relPath !== '.openflow/phase') {
      return [block('invalid-phase-state', '.openflow/phase 状态无效，仅允许修复 .openflow/phase', stateRes.error)];
    }
    return [];
  }

  if (stateRes.state === null) {
    return runCompatChecks(operation, relPath, content, cwd);
  }

  const state = stateRes.state;

  const boundary = checkPhaseBoundary(state, relPath, cwd);
  if (boundary) {
    return [boundary];
  }

  const results = [];

  if (state.phase === 'build' && state.mode === 'task-build') {
    results.push(...runTaskBuildTdd(state, relPath, cwd));
  }

  return sortResults(results);
}

// ---- Claude hook entry (stdin JSON → stdout, exit code) ----

function main() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8');
    let data;
    try { data = JSON.parse(raw); } catch { process.exit(0); }

    const input = normalizeToolInput(data, process.cwd());
    if (input === null) process.exit(0);

    const results = runAllChecks(input);

    let blocked = false;
    for (const result of results) {
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
