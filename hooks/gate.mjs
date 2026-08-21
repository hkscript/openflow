#!/usr/bin/env node
/**
 * openflow-gate — phase gate checks
 *
 * Deterministic pre-condition validation for each openflow phase.
 * Replaces manual grep/Read/count operations in the AI instructions.
 *
 * Usage:
 *   node .claude/hooks/openflow-gate.mjs <subcommand> <change-name>
 *
 * Subcommands:
 *   check-proposal        — validate proposal.md format
 *   check-test-plan       — test-plan.md integrity
 *   check-cross-ref       — plan-ready ↔ test-plan cross-reference
 *   check-build-done      — build completion
 *   check-close-ready     — close pre-conditions
 *   check-verify-issues   — verify-issues.md 未解决项检查
 *   check-design-consistency — design.md「改动文件」节 vs plan-ready + git（basename 兜底、跨仓库跳过）；
 *                            扩展：改动点归属对账（claim-vs-actual + 声称未落地反查）与并行入口完整性（共享下游链路，warning 级）；
 *                            diff 含基准分支累计改动（git diff <base>...HEAD），不只看未提交
 *   check-amend-count     — amendment tracking
 *   check-writing-plans   — writing-plans availability
 *   check-brainstorming   — brainstorming availability
 *   check-test-framework  — detect language + test framework + command
 *
 * Project config (.openflow/gate.config.json, optional):
 *   { "required_sections": ["现状与影响面"], "change_point_check": true, "base_branch": "main" }
 *     — required_sections 覆盖 design.md 必填章节；
 *     — change_point_check=false 关闭改动点归属/完整性对账（默认开启，warning 级）；
 *     — base_branch 指定基准分支（默认探测 main/master/develop），用于核对已提交的变更改动
 *
 * Zero dependencies, pure Node 20+.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { FINGERPRINT_VERSION, collectWorktreeFingerprint, validateVerifyReceipt } from './lifecycle-fingerprint.mjs';

// ---- helpers ----

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function exists(p) {
  return fs.existsSync(p);
}

function changeDir(cwd, changeName) {
  return path.join(cwd, 'openspec', 'changes', changeName);
}

// ---- Task 3: validated runner boundary + change-name guard ----

const CHANGE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isValidChangeName(changeName) {
  return typeof changeName === 'string' && CHANGE_RE.test(changeName);
}

function errMsg(e) {
  if (!e) return String(e);
  if (e.stderr) return String(e.stderr).trim();
  if (e.message) return String(e.message);
  return String(e);
}

// No-shell dispatch boundary: every OpenSpec invocation goes through this one
// function. The binary comes from OPENFLOW_OPENSPEC_BIN (tests inject a fake),
// never from a shell-interpolated string; argv is a fixed argument array.
function runOpenspec(cwd, argv) {
  const bin = process.env.OPENFLOW_OPENSPEC_BIN || 'openspec';
  return execFileSync(bin, argv, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

// Subcommands that take a <change> argument; every one must reject an invalid
// change name before any path construction or subprocess use.
const CHANGE_SUBCOMMANDS = new Set([
  'check-proposal', 'check-test-plan', 'check-cross-ref', 'check-build-done',
  'check-close-ready', 'check-amend-count', 'check-verify-issues',
  'check-design-consistency', 'check-verify-prerequisites', 'write-verify-receipt',
  'check-verify-ready', 'archive-verified',
]);

// ---- check-proposal ----

function checkProposal(cwd, changeName) {
  const cd = changeDir(cwd, changeName);
  const proposalPath = path.join(cd, 'proposal.md');
  const content = safeRead(proposalPath);

  if (!content) {
    return {
      pass: false,
      checks: {
        file_exists: { pass: false, detail: 'proposal.md not found' },
      },
      fix_hint: `Create proposal.md at openspec/changes/${changeName}/proposal.md`,
    };
  }

  const whyMatch = content.match(/^## Why/m);
  const whySection = whyMatch ? content.slice(whyMatch.index) : '';
  // Find the next ## header after ## Why to measure section length
  const nextHeader = whySection.slice(4).match(/^## /m);
  const whyContent = nextHeader ? whySection.slice(0, nextHeader.index + 4) : whySection;
  const whyCharCount = whyContent.replace(/^#.*$/gm, '').replace(/\s/g, '').length;

  const whatMatch = content.match(/^## What Changes/m);
  const impactMatch = content.match(/^## Impact/m);

  return {
    pass: Boolean(whyMatch) && Boolean(whatMatch),
    checks: {
      why_exists: {
        pass: Boolean(whyMatch),
        detail: whyMatch
          ? `## Why found at line ${content.slice(0, whyMatch.index).split('\n').length}, ~${whyCharCount} content chars`
          : '## Why not found',
      },
      what_changes_exists: {
        pass: Boolean(whatMatch),
        detail: whatMatch ? '## What Changes found' : '## What Changes not found',
      },
      impact_exists: {
        pass: Boolean(impactMatch),
        detail: impactMatch ? '## Impact found' : '## Impact not found (recommended)',
      },
    },
    fix_hint: !whyMatch ? "Add '## Why' section (at least 50 chars)" :
               !whatMatch ? "Add '## What Changes' section with bullet list" : null,
  };
}

// ---- check-test-plan ----

function checkTestPlan(cwd, changeName) {
  const cd = changeDir(cwd, changeName);
  const tpPath = path.join(cd, 'test-plan.md');
  const content = safeRead(tpPath);

  if (!content) {
    return {
      pass: false,
      stats: null,
      issues: [{ type: 'missing', detail: 'test-plan.md not found' }],
      all_pass: false,
      stub_issues: [],
    };
  }

  // Count test rows and statuses
  const lines = content.split('\n');
  let inTable = false, headerSkipped = false;
  let pass = 0, todo = 0, fail = 0, total = 0;

  // Also extract test file paths from the table
  const testFiles = new Set();
  const fileRe = /`([^`]+\.[a-z]{2,6})(?:::[^`]+)?`/gi;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|[-| ]+\|$/.test(trimmed)) { inTable = true; headerSkipped = true; continue; }
    if (!inTable) continue;
    if (!trimmed.startsWith('|')) { inTable = false; continue; }
    if (!headerSkipped) { headerSkipped = true; continue; }

    total++;
    if (/✅|PASS/i.test(line)) pass++;
    else if (/FAIL|❌.*FAIL/i.test(line)) fail++;
    else todo++;

    // Extract test file paths from this row
    for (const m of line.matchAll(fileRe)) {
      const p = m[1].split('::')[0]; // strip function name
      testFiles.add(p);
    }
  }

  const issues = [];
  if (total === 0) issues.push({ type: 'empty', detail: 'No test rows found in table' });
  if (fail > 0) issues.push({ type: 'has_failures', detail: `${fail} test(s) marked FAIL` });

  // Firewall: check actual test files for TODO stubs
  const stubIssues = [];
  for (const tf of testFiles) {
    if (isCrossRepoPath(cwd, tf)) continue; // 跨仓库测试文件无法在本工作区解析 → 宁漏勿误，跳过
    const testContent = safeRead(path.join(cwd, tf));
    if (testContent === null) {
      stubIssues.push({ type: 'missing_file', file: tf, detail: `test-plan references ${tf} but file not found` });
      continue;
    }
    // Check for test stubs that were never completed
    const stubMatch = testContent.match(/assert\s+False.*TODO|fail\s*\(.*TODO|TODO.*实现测试/gi);
    if (stubMatch) {
      stubIssues.push({
        type: 'stub_found',
        file: tf,
        detail: `${tf} still has TODO stub: ${stubMatch[0].trim().slice(0, 80)}`,
      });
    }
  }

  if (stubIssues.length > 0 && pass > 0) {
    issues.push({
      type: 'marker_mismatch',
      detail: `${pass} test(s) marked PASS in test-plan but ${stubIssues.length} test file(s) still have TODO stubs — markers may be fabricated`,
    });
  }

  return {
    pass: total > 0 && fail === 0 && stubIssues.length === 0,
    stats: { pass, todo, fail, total },
    issues,
    all_pass: total > 0 && pass === total && stubIssues.length === 0,
    stub_issues: stubIssues,
  };
}

// ---- check-cross-ref ----

function checkCrossRef(cwd, changeName) {
  const cd = changeDir(cwd, changeName);
  const tpContent = safeRead(path.join(cd, 'test-plan.md'));
  const prContent = safeRead(path.join(cd, 'plan-ready.md'));

  if (!tpContent || !prContent) {
    return {
      pass: false,
      issues: [{ type: 'missing_file', detail: !tpContent ? 'test-plan.md missing' : 'plan-ready.md missing' }],
      summary: 'Cannot cross-reference — one or both files missing.',
    };
  }

  // Extract test numbers from test-plan.md (from the # column)
  const testNums = [];
  for (const m of tpContent.matchAll(/\|\s*(\d+)\s*\|/g)) {
    const num = parseInt(m[1]);
    if (!testNums.includes(num)) testNums.push(num);
  }

  // Extract test references from plan-ready.md
  // Patterns: "#1, #2", "覆盖场景：#1,#3", "测试编号：#5", etc.
  const refNums = new Set();
  for (const m of prContent.matchAll(/#(\d+)/g)) {
    refNums.add(parseInt(m[1]));
  }

  // Also check "覆盖场景" lines specifically
  const covRe = /覆盖场景[：:]\s*(.+)/gi;
  for (const m of prContent.matchAll(covRe)) {
    for (const nm of m[1].matchAll(/#(\d+)/g)) {
      refNums.add(parseInt(nm[1]));
    }
  }

  const issues = [];
  const orphanTests = testNums.filter(n => !refNums.has(n));
  const untestableTasks = [...refNums].filter(n => !testNums.includes(n));

  if (orphanTests.length > 0) {
    issues.push({
      type: 'uncovered_test',
      detail: `Tests #${orphanTests.join(', #')} in test-plan have no matching task in plan-ready`,
    });
  }
  if (untestableTasks.length > 0) {
    issues.push({
      type: 'orphan_task',
      detail: `plan-ready references tests #${[...untestableTasks].join(', #')} not found in test-plan`,
    });
  }

  return {
    pass: issues.length === 0,
    issues,
    summary: issues.length === 0
      ? `${testNums.length} tests, all covered by plan-ready tasks.`
      : `${issues.length} cross-reference issue(s) found.`,
  };
}

// ---- check-build-done ----

function checkBuildDone(cwd, changeName) {
  const cd = changeDir(cwd, changeName);
  const tpPath = path.join(cd, 'test-plan.md');
  const prPath = path.join(cd, 'plan-ready.md');
  const bMarker = exists(path.join(cwd, '.openflow', 'building'));

  const tpResult = checkTestPlan(cwd, changeName);
  const prContent = safeRead(prPath);

  let allTasksDone = false;
  if (prContent) {
    const done = (prContent.match(/\[x\]/gi) ?? []).length;
    const pending = (prContent.match(/\[ \]/g) ?? []).length;
    allTasksDone = pending === 0 && done > 0;
  }

  const issues = [];
  if (!tpResult.all_pass) issues.push({ type: 'tests_not_all_pass', detail: `${tpResult.stats?.fail ?? 0} FAIL, ${tpResult.stats?.todo ?? 0} TODO` });
  if (!allTasksDone) issues.push({ type: 'tasks_not_all_done', detail: 'Some tasks still [ ] in plan-ready.md' });

  return {
    pass: tpResult.all_pass && allTasksDone && !bMarker,
    all_tasks_done: allTasksDone,
    all_tests_pass: tpResult.all_pass,
    building_marker_exists: bMarker,
    issues,
    fix_hint: bMarker ? 'Remove .openflow/building marker to exit build phase' : null,
  };
}

// ---- check-verify-issues ----

function checkVerifyIssues(cwd, changeName) {
  const viPath = path.join(changeDir(cwd, changeName), 'verify-issues.md');
  const content = safeRead(viPath);
  if (!content) {
    return { pass: true, exists: false, unresolved_count: 0, blockers: [] };
  }
  // 逐行状态机：❌/⚠️ 开启一个条目，后续 ✅ 关闭最近一个未关闭条目。
  // 这样 "#1 ✅ 断言匹配 / #2 ⚠️ 未匹配" 里的 ✅ 只抵消 #1，不会误吞 #2。
  const stack = [];
  for (const line of content.split('\n')) {
    if (/❌/.test(line)) stack.push('hard');
    else if (/⚠️/.test(line)) stack.push('soft');
    if (/✅/.test(line) && stack.length > 0) stack.pop();
  }
  const unresolved = stack.length;
  const unresolvedHard = stack.filter((t) => t === 'hard').length;
  const unresolvedSoft = unresolved - unresolvedHard;
  const blockers = [];
  if (unresolvedHard > 0) blockers.push(`${unresolvedHard} 个 verify 阻挡项（❌）未解决`);
  if (unresolvedSoft > 0) blockers.push(`${unresolvedSoft} 个 verify 警告（⚠️）未解决`);
  return { pass: unresolved === 0, exists: true, unresolved_count: unresolved, blockers };
}

// ---- check-design-consistency ----

const FILE_PATH_RE = /[A-Za-z0-9_@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|py|go|java|rs|c|cc|cpp|h|hpp|kt|swift|sql|sh|yml|yaml|json|css|scss|html)\b/g;
const CERTAINTY_TAG_RE = /\[(?:Verified|Inferred|Assumption)/;

// basename 兜底匹配：design.md 写裸文件名、plan-ready 写全路径时也能命中（宽松，宁漏勿误）
function pathMatches(haystack, p) {
  const base = p.split('/').pop();
  return haystack.some((c) => c === p || (base && c.split('/').pop() === base));
}

// 跨仓库路径：顶层目录不在当前工作区 → 无法在本仓库落盘解析（裸文件名不判跨仓库）
function isCrossRepoPath(cwd, p) {
  if (!p.includes('/')) return false;
  const top = p.split('/')[0];
  if (!top || top === '.' || top === '..') return false;
  return !fs.existsSync(path.join(cwd, top));
}

// 测试文件改动不算设计漂移（test-plan 已引用即可，design 无需逐条列）
function isTestFilePath(p) {
  return /(?:^|[\/_.-])(?:test|tests|spec|__tests__|e2e)(?:[\/_.-]|$)/i.test(p)
      || /(?:Test|Tests|Spec)\.(?:java|kt|swift|go|rs|js|ts|mjs|cjs|py|sql)$/i.test(p);
}

// 提取「## title」节内容（不含节标题，到下一个 ## 为止）；无该节返回 null
function extractSection(content, title) {
  const m = content.match(new RegExp(`^##\\s*${title}\\s*$`, 'm'));
  if (!m) return null;
  const start = m.index + m[0].length;
  const after = content.slice(start);
  const next = after.match(/^## /m);
  return next ? after.slice(0, next.index) : after;
}

// 从文本收集所有文件路径（无标签过滤——用于「改动文件」这种本身就是声明的节）
function collectPaths(text) {
  const paths = new Set();
  if (!text) return [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(FILE_PATH_RE)) {
      const p = m[0].replace(/^\.\//, '');
      if (p.startsWith('openspec/') || p.endsWith('.md')) continue;
      paths.add(p);
    }
  }
  return [...paths];
}

function extractFilePaths(content) {
  const paths = new Set();
  if (!content) return [];
  for (const line of content.split('\n')) {
    if (!CERTAINTY_TAG_RE.test(line)) continue;
    for (const m of line.matchAll(FILE_PATH_RE)) {
      const p = m[0].replace(/^\.\//, '');
      if (p.startsWith('openspec/') || p.endsWith('.md')) continue;
      paths.add(p);
    }
  }
  return [...paths];
}

// 基准分支：优先取 gate.config 的 base_branch，否则探测常见默认分支；都没有返回 null（退回只看未提交）
function baseBranch(cwd, config) {
  if (config && config.base_branch) return config.base_branch;
  for (const b of ['main', 'master', 'origin/main', 'origin/master', 'develop', 'origin/develop']) {
    try {
      execSync(`git rev-parse --verify --quiet ${b}`, { cwd, encoding: 'utf-8', stdio: 'pipe' });
      return b;
    } catch { /* try next */ }
  }
  return null;
}

// 本次变更的文件：基准分支累计改动（含已提交）+ 未提交 + 已暂存
function gitChangedFiles(cwd, config) {
  const files = [];
  const cmds = [];
  const base = baseBranch(cwd, config);
  if (base) cmds.push(`git diff ${base}...HEAD --name-only`);
  cmds.push('git diff --name-only', 'git diff --cached --name-only');
  for (const cmd of cmds) {
    try {
      const out = execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' });
      for (const s of out.split('\n')) { const t = s.trim(); if (t) files.push(t); }
    } catch { /* ignore */ }
  }
  return [...new Set(files)];
}

// 项目级配置 .openflow/gate.config.json 可覆盖必填章节、关闭改动点对账、指定基准分支
function loadGateConfig(cwd) {
  const cfgPath = path.join(cwd, '.openflow', 'gate.config.json');
  const raw = safeRead(cfgPath);
  if (!raw) return { required_sections: ['现状与影响面'], change_point_check: true, base_branch: null };
  try {
    const cfg = JSON.parse(raw);
    return {
      required_sections: Array.isArray(cfg.required_sections) ? cfg.required_sections : ['现状与影响面'],
      change_point_check: cfg.change_point_check !== false,
      base_branch: typeof cfg.base_branch === 'string' && cfg.base_branch ? cfg.base_branch : null,
    };
  } catch {
    return { required_sections: ['现状与影响面'], change_point_check: true, base_branch: null };
  }
}

function checkDesignConsistency(cwd, changeName, opts = {}) {
  const strict = opts.strict === true;
  const cd = changeDir(cwd, changeName);
  const designContent = safeRead(path.join(cd, 'design.md'));
  if (!designContent) {
    return { pass: true, design_exists: false, design_file_count: 0, blockers: [], warnings: [] };
  }
  const config = loadGateConfig(cwd);
  const blockers = [];
  const warnings = [];

  // 必填章节（spec 阶段约定；项目可用 .openflow/gate.config.json 覆盖）
  for (const section of config.required_sections) {
    if (!designContent.includes(section)) {
      blockers.push(`design.md 缺少「${section}」章节（spec 阶段必填；可在 .openflow/gate.config.json 覆盖）`);
    }
  }

  // 改动文件只从「## 改动文件」节提取——现状影响面里的 [Verified] 既有代码引用不再被当改动文件
  const changeSection = extractSection(designContent, '改动文件');
  if (changeSection === null) {
    if (strict) blockers.push('design.md 缺少「改动文件」章节（verify 前置条件必填）');
    else warnings.push('design.md 缺少「改动文件」章节，文件一致性对账已跳过（宁漏勿误）');
    return { pass: blockers.length === 0, design_exists: true, design_file_count: 0, blockers, warnings };
  }
  const designPaths = collectPaths(changeSection);

  const planContent = safeRead(path.join(cd, 'plan-ready.md'));
  const planPaths = planContent ? extractFilePaths(planContent) : [];
  const testPlanContent = safeRead(path.join(cd, 'test-plan.md'));
  const testPlanPaths = testPlanContent ? collectPaths(testPlanContent) : [];
  const gitPaths = gitChangedFiles(cwd, config);

  // design → plan/git：design 改动文件应能被 plan-ready 或变更（含已提交的 base diff）命中（basename 兜底）
  const evidenceSet = new Set([...planPaths, ...gitPaths]);
  for (const p of designPaths) {
    if (isCrossRepoPath(cwd, p)) {
      warnings.push(`改动文件 ${p} 顶层目录不在当前工作区，跳过一致性断言（跨仓库，人工核对）`);
      continue;
    }
    if (!pathMatches([...evidenceSet], p)) {
      blockers.push(`design.md「改动文件」列出 ${p}，但 plan-ready 改动文件 / 变更（含已提交）中都没有它`);
    }
  }

  // git → design（防漂移）：只对本变更文档引用过的 git 文件报漂移——workspace 噪音与测试文件跳过
  const referencedSet = new Set([...designPaths, ...planPaths, ...testPlanPaths]);
  for (const p of gitPaths) {
    if (isTestFilePath(p)) continue;
    if (!pathMatches([...referencedSet], p)) continue;
    if (!pathMatches(designPaths, p)) {
      blockers.push(`变更改动了 ${p}（含已提交），但 design.md「改动文件」未列出`);
    }
  }

  // 改动点归属 / 完整性对账（warning 级，宁漏勿误；gate.config 的 change_point_check=false 可关闭）
  if (config.change_point_check !== false) {
    warnings.push(...checkChangePointOwnership(cwd, changeName, designContent, config));
  }

  // 改动点逐条机械判定：design 每个改动点声称的目标方法 vs 关键词实际落点（verify 清单以此为据，AI 只补充依据）
  const change_point_verdicts = changePointVerdicts(cwd, changeName, designContent);

  return { pass: blockers.length === 0, design_exists: true, design_file_count: designPaths.length, blockers, warnings, change_point_verdicts };
}

// ---- 改动点归属对账（warning 级，宁漏勿误） ----
// 设计阶段若方法名与行号漂移（例：design 声称改 A 方法、行号却指 B 方法的方法体），实现按行号落点会把改动插进错误方法；
// 三类检查：
// ① 归属漂移——diff hunk 实际所在方法是否在 design 声称集合内（已提交的 base diff 也查，不只未提交）；
// ② 声称未落地——design backtick 声称的改动目标方法，若其文件有改动却无 hunk 落进它 → 未实现或已提交，反方向兜底；
// ③ 完整性——命名不限：任何未覆盖的方法调用 design 点名的下游链路方法就报；同前缀兄弟方法（New/Old/V2）共享下游调用兜底。
// 注意：③ 依赖 design 点名下游链路；② 只覆盖 backtick 命名的目标、①/③ 的同前缀部分只覆盖"同前缀 + 已知后缀"命名。
// 启发式找不到声明就静默跳过，跨仓库/测试文件不参与。

const METHOD_DECL_RES = {
  py: /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/,
  go: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:[\w<>[\], ?.&|]+)?\s*\{/,
  rb: /^\s*(?:def|class|module)\s+([A-Za-z_$][\w$]*)/,
  rs: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:fn|unsafe\s+fn)\s+([A-Za-z_$][\w$]*)\s*\(/,
  brace: /^\s*(?:[\w<>[\], ?.&|]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::\s*[\w<>[\], ?.&|]+)?\s*\{/,
};

const BRACE_LANGS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.kt', '.cs', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.scala', '.sc']);

function declRegexFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return METHOD_DECL_RES.py;
  if (ext === '.go') return METHOD_DECL_RES.go;
  if (ext === '.rb' || ext === '.rake') return METHOD_DECL_RES.rb;
  if (ext === '.rs') return METHOD_DECL_RES.rs;
  if (BRACE_LANGS.has(ext)) return METHOD_DECL_RES.brace;
  return null;
}

// new Runnable() { 这类匿名类/类型声明不是方法，扫描时跳过
function isNoiseDecl(line) {
  return /^\s*(?:new|class|interface|enum|record|struct|impl|module)\b/.test(line);
}

// 控制流关键字不是方法：`if (...) {` 会被 brace 正则捕获成方法名，必须排除
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'try', 'else', 'do', 'synchronized', 'foreach', 'when', 'match', 'elif', 'until', 'unless', 'using', 'with', 'throw', 'case', 'default', 'assert', 'await', 'yield', 'in', 'of', 'new', 'function', 'fun', 'fn']);
function isControlKeyword(name) {
  return CONTROL_KEYWORDS.has(name);
}

// 太通用的方法调用不能当"改动链路"锚点（否则凡调用它们的方法全被报）
const GENERIC_CALLEES = new Set(['get', 'set', 'is', 'has', 'put', 'add', 'remove', 'getOrDefault', 'ofNullable', 'orElse', 'orElseGet', 'orElseThrow', 'map', 'filter', 'collect', 'stream', 'forEach', 'toString', 'equals', 'hashCode', 'valueOf', 'size', 'isEmpty', 'contains', 'indexOf', 'substring', 'length', 'format', 'join', 'split', 'findFirst', 'findAny', 'parse', 'build', 'create', 'newInstance', 'close', 'open', 'println', 'print', 'log', 'info', 'warn', 'error', 'debug', 'execute', 'apply', 'run', 'accept', 'compareTo', 'compare', 'ifPresent', 'of', 'values', 'value', 'name', 'list', 'array', 'iterator', 'next', 'hasNext', 'forEachRemaining', 'reduce', 'sorted', 'distinct', 'limit', 'skip', 'anyMatch', 'allMatch', 'noneMatch', 'orElseThrow', 'optional', 'requireNonNull', 'empty', 'getAndSet', 'computeIfAbsent', 'computeIfPresent']);

// 读取文件内容：HEAD ref 用 git show HEAD:<path>（已提交的 hunk 行号指 HEAD），否则读工作区
function fileContentAt(absPath, relFile, ref) {
  if (ref === 'HEAD') {
    try { return execSync(`git show HEAD:${relFile}`, { encoding: 'utf-8', stdio: 'pipe' }); } catch { return null; }
  }
  return safeRead(absPath);
}

// 解析基准分支累计（ref=HEAD）+ 未提交 + 已暂存（ref=worktree）的 hunk（--unified=0，零依赖）；返回 { file, newStart, newCount, ref }
function diffHunks(cwd, config) {
  const seen = new Set();
  const hunks = [];
  const cmds = [];
  const base = baseBranch(cwd, config);
  if (base) cmds.push({ cmd: `git diff ${base}...HEAD --no-ext-diff --unified=0`, ref: 'HEAD' });
  cmds.push({ cmd: 'git diff --no-ext-diff --unified=0', ref: 'worktree' });
  cmds.push({ cmd: 'git diff --cached --no-ext-diff --unified=0', ref: 'worktree' });
  for (const { cmd, ref } of cmds) {
    let out = '';
    try { out = execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }); } catch { continue; }
    let file = null;
    for (const line of out.split('\n')) {
      const fm = line.match(/^\+\+\+\s+(.*)$/);
      if (fm) {
        let p = fm[1].replace(/\t.*$/, '').trim().replace(/^b\//, '');
        file = p === '/dev/null' ? null : p;
        continue;
      }
      const hm = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (hm && file) {
        const newStart = parseInt(hm[1], 10);
        const newCount = hm[2] ? parseInt(hm[2], 10) : 1;
        const key = `${ref}:${file}:${newStart}`;
        if (!seen.has(key)) { seen.add(key); hunks.push({ file, newStart, newCount, ref }); }
      }
    }
  }
  return hunks;
}

// diff hunk 落在哪个方法：hunk 自身含新增声明 → 返回这些声明（可能有多个）；否则向上找最近前驱声明（400 行内）
function containingMethods(absPath, relFile, hunk) {
  const content = fileContentAt(absPath, relFile, hunk.ref);
  if (!content) return [];
  const declRe = declRegexFor(relFile);
  if (!declRe) return [];
  const lines = content.split('\n');
  const regionEnd = Math.min(lines.length, hunk.newStart - 1 + Math.max(1, hunk.newCount));
  // 仅当 hunk 开头就是（或紧邻）方法声明时用区域扫描——真·新增/改签名方法；大段体内改动不扫区域，避免误归属到下一个方法
  const region = [];
  const scanLimit = Math.min(regionEnd, hunk.newStart + 1);
  for (let i = hunk.newStart - 1; i < scanLimit; i++) {
    if (isNoiseDecl(lines[i])) continue;
    const m = lines[i].match(declRe);
    if (m && !isControlKeyword(m[1])) region.push({ name: m[1], line: i + 1 });
  }
  if (region.length) return region;
  const floor = Math.max(0, hunk.newStart - 2 - 400);
  for (let i = hunk.newStart - 2; i >= floor; i--) {
    if (isNoiseDecl(lines[i])) continue;
    const m = lines[i].match(declRe);
    if (m && !isControlKeyword(m[1])) {
      // getter/setter 被远距离归属 → 低置信（getter 体不可能跨几十行），宁漏勿误
      if (/^(get|set|is|has)[A-Z]/.test(m[1]) && (hunk.newStart - 1 - i) > 20) continue;
      return [{ name: m[1], line: i + 1 }];
    }
  }
  return [];
}

// 全文件方法声明列表（完整性检查用）
function declaredMethods(filePath) {
  const content = safeRead(filePath);
  if (!content) return [];
  const declRe = declRegexFor(filePath);
  if (!declRe) return [];
  const lines = content.split('\n');
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    if (isNoiseDecl(lines[i])) continue;
    const m = lines[i].match(declRe);
    if (m && !isControlKeyword(m[1])) decls.push({ name: m[1], line: i + 1 });
  }
  return decls;
}

// 方法体内的调用点（限定标识符 + （/( 跟随）；控制流关键字不算
const CALL_STOPWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'throw', 'new', 'function', 'typeof', 'instanceof', 'delete', 'void', 'assert', 'import', 'export', 'case', 'in', 'of', 'yield', 'await', 'with', 'synchronized', 'try']);
function methodCallees(lines, startIdx, endIdx) {
  const callees = new Set();
  for (let i = startIdx; i <= endIdx; i++) {
    for (const m of lines[i].matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[（(]/g)) {
      const last = m[1].split('.').pop();
      if (!CALL_STOPWORDS.has(last)) callees.add(last);
    }
  }
  return callees;
}

// 方法 d 的体范围 [startIdx, endIdx]（到下一个声明的上一行或文件尾）
function methodBodyRange(lines, decls, d) {
  const order = [...decls].sort((x, y) => x.line - y.line);
  const idx = order.findIndex((x) => x.name === d.name && x.line === d.line);
  if (idx < 0) return [d.line - 1, lines.length - 1];
  const end = idx + 1 < order.length ? order[idx + 1].line - 2 : lines.length - 1;
  return [d.line - 1, Math.max(d.line - 1, end)];
}

// 两个方法共享的下游调用列表（并行路径信号）
function sharedCallees(lines, decls, a, b) {
  const [as, ae] = methodBodyRange(lines, decls, a);
  const [bs, be] = methodBodyRange(lines, decls, b);
  const aSet = methodCallees(lines, as, ae);
  const bSet = methodCallees(lines, bs, be);
  const shared = [];
  for (const c of aSet) if (bSet.has(c)) shared.push(c);
  return shared;
}

// 从 design.md 提取声称的方法名：backtick 标识符 + 裸标识符（/（ 跟随
function claimedMethodNames(designContent) {
  const section = extractSection(designContent, '现状与影响面') || designContent;
  const claimed = new Set();
  for (const m of section.matchAll(/`([\w$.]+)`/g)) claimed.add(m[1]);
  for (const m of section.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[（(]/g)) claimed.add(m[1]);
  return claimed;
}

function claimedMatches(claimed, name) {
  if (claimed.has(name)) return true;
  for (const c of claimed) if (c.endsWith('.' + name)) return true;
  return false;
}

// 去掉并行路径后缀（New / Old / V2 / _new / _old）得前缀；无后缀返回 null
function stripParallelSuffix(name) {
  const m = name.match(/^(.*?)(?:New|Old|V[0-9]+|_new|_old)$/);
  if (!m || m[1].length < 2) return null; // 剩余前缀太短不像方法名（bold→b 这类误切不判）
  return m[1];
}

function isGenericCallee(name) {
  if (GENERIC_CALLEES.has(name)) return true;
  if (/^(get|set|is|has|list|find|put|add|remove|to|from|of)[A-Z]/.test(name)) return true; // getter/setter/收集器模式
  if (/^(failure|success|ok|error|result|response|request)$/i.test(name)) return true;   // 响应包装
  if (/^[A-Z]/.test(name)) return true; // 类名/构造器不是链路方法
  return false;
}

// 改动点目标：design「现状与影响面」里 backtick 命名的标识符（spec 约定：改动点必须 backtick 命名目标方法）。
// 与 claimed 不同：claimed 含裸标识符（/（跟随的链上 callee，用于归属/完整性比对）；这里只取 backtick，用于"声称未落地"反查。
// 排除同时以（/（ 形式出现的引用方法（链上 callee 如 fillOtherInfo（1085 行）这类"被引用不是目标"）。
function claimedTargetNames(designContent) {
  const section = extractSection(designContent, '现状与影响面') || designContent;
  const targets = new Set();
  const refs = new Set();
  for (const m of section.matchAll(/`([\w$.]+)`/g)) targets.add(m[1]);
  for (const m of section.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[（(]/g)) refs.add(m[1]);
  for (const r of refs) targets.delete(r);
  return targets;
}

// 改动点归属 / 完整性对账：design 声称的方法 vs diff 实际落点，以及并行入口覆盖（共享下游链路）
function checkChangePointOwnership(cwd, changeName, designContent, config) {
  const warnings = [];
  const claimed = claimedMethodNames(designContent);
  if (claimed.size === 0) return warnings; // design 未命名方法 → 空转（宁漏勿误）

  const cd = changeDir(cwd, changeName);
  const planContent = safeRead(path.join(cd, 'plan-ready.md'));
  const planPaths = planContent ? extractFilePaths(planContent) : [];
  const changeSection = extractSection(designContent, '改动文件');
  const designPaths = changeSection ? collectPaths(changeSection) : [];
  const referenced = new Set([...designPaths, ...planPaths]);

  const hunks = diffHunks(cwd, config).filter((h) =>
    !isTestFilePath(h.file) && !isCrossRepoPath(cwd, h.file) && pathMatches([...referenced], h.file));

  const hunksByFile = new Map();
  for (const h of hunks) {
    if (!hunksByFile.has(h.file)) hunksByFile.set(h.file, []);
    hunksByFile.get(h.file).push(h);
  }

  // 归属漂移：diff hunk 实际所在方法是否在 design 声称集合内
  for (const h of hunks) {
    for (const cm of containingMethods(path.join(cwd, h.file), h.file, h)) {
      if (!claimedMatches(claimed, cm.name)) {
        warnings.push(`改动点归属：design 声称改动未包含方法 ${cm.name}（${h.file}:${cm.line}），但 diff 落点在此方法内（第 ${h.newStart} 行）——方法归属漂移，人工核对是否插错方法`);
      }
    }
  }

  // 声称未落地：design backtick 声称的改动目标方法，若其文件有改动却无 hunk 落进它 → 未实现或已在上游提交（反方向兜底）
  const claimedTargets = claimedTargetNames(designContent);
  for (const [file, fileHunks] of hunksByFile) {
    const absPath = path.join(cwd, file);
    const decls = declaredMethods(absPath);
    const landed = new Set();
    for (const h of fileHunks) {
      for (const cm of containingMethods(absPath, file, h)) landed.add(cm.name);
    }
    for (const d of decls) {
      if (!claimedTargets.has(d.name)) continue;
      if (landed.has(d.name)) continue;
      warnings.push(`声称未落地：design 声称改 ${d.name}（${file}:${d.line}），但该文件有改动却没有任何落点在它里面——改动点未实现或已在上游提交，人工核对`);
    }
  }

  // 完整性：未覆盖的并行入口
  // ① 命名不限——未被 design 覆盖的方法，若调用"改动链路"下游方法（design 点名 + 同文件声称目标实际调用 + 非通用方法）就报；
  // ② 兜底——同前缀兄弟方法（带 New/Old/V2 后缀）与设计覆盖的方法共享下游调用（design 未点名链路时仍有网）
  for (const [file, fileHunks] of hunksByFile) {
    const absPath = path.join(cwd, file);
    const decls = declaredMethods(absPath);
    const lines = safeRead(absPath)?.split('\n') || [];
    // 有效锚点：design 声称的目标方法实际调用的下游方法（同文件）——这才是改动链路
    const chainCallees = new Set();
    for (const m of decls) {
      if (!claimedMatches(claimed, m.name)) continue;
      const [ms, me] = methodBodyRange(lines, decls, m);
      for (const c of methodCallees(lines, ms, me)) {
        if (!isGenericCallee(c)) chainCallees.add(c);
      }
    }
    for (const d of decls) {
      if (claimedMatches(claimed, d.name)) continue; // design 已覆盖
      const [ds, de] = methodBodyRange(lines, decls, d);
      const dCallees = methodCallees(lines, ds, de);
      const chainCallee = [...dCallees].find((c) =>
        claimedMatches(claimed, c) && chainCallees.has(c));
      if (chainCallee) {
        warnings.push(`改动点完整性：${file} 的 ${d.name} 调用设计点名的下游方法 ${chainCallee}（与改动点同链路），但 design 未覆盖 ${d.name}——确认该并行入口是否也需改`);
        continue;
      }
      // 兜底：与某个被 design 覆盖的方法同前缀（New/Old/V2 后缀）且共享下游调用
      for (const m of decls) {
        if (m.line === d.line) continue;
        if (!claimedMatches(claimed, m.name)) continue;
        const prefixM = stripParallelSuffix(m.name);
        const prefixD = stripParallelSuffix(d.name);
        const isSibling = (prefixM !== null && prefixM === d.name)
          || (prefixD !== null && prefixD === m.name)
          || (prefixD !== null && prefixM !== null && prefixD === prefixM);
        if (!isSibling) continue;
        if (sharedCallees(lines, decls, m, d).length) {
          warnings.push(`改动点完整性：${file} 的 ${d.name} 与 ${m.name} 是并行路径且共享下游调用，design 声称改 ${m.name} 却未覆盖 ${d.name}——确认是否也需改`);
          break;
        }
      }
    }
  }

  return [...new Set(warnings)];
}

// ---- 改动点逐条机械判定 ----
// 把 design 每个「改动点」变成机器可核验的行：声称的目标方法 vs 改动关键词的实际落点。
// 关键词 = 改动点文本里、非声明方法、非通用、且在主文件中罕见的标识符（改动特有，如字段/表名）。
// 判定：声称目标方法的方法体含关键词 → ✅；不含 → ⚠️（并给出关键词实际落点方法）。
// 局限：只判定"目标方法体是否含改动特有标识"；中文关键词（\w 不含）检测不到 → 宁漏勿误。

const KEYWORD_STOPWORDS = new Set(['ext', 'task', 'dto', 'list', 'map', 'id', 'ids', 'value', 'values', 'status', 'time', 'data', 'info', 'result', 'param', 'config', 'cfg', 'key', 'name', 'type', 'code', 'msg', 'message', 'json', 'entity', 'record', 'log', 'logger', 'method', 'class', 'array', 'object', 'string', 'number', 'bool', 'set', 'get', 'theOne', 'dtoList', 'listDtos', 'utils', 'util', 'impl', 'service', 'manager', 'dao', 'mapper']);

function parseChangePointSections(designContent) {
  const section = extractSection(designContent, '现状与影响面');
  if (!section) return [];
  const points = [];
  let current = null;
  for (const line of section.split('\n')) {
    const m = line.match(/^###\s*改动点\s*(\d+)[:：]?\s*(.*)$/);
    if (m) {
      if (current) points.push(current);
      current = { num: m[1], title: m[2].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) points.push(current);
  return points;
}

function changePointVerdicts(cwd, changeName, designContent) {
  const verdicts = [];
  const points = parseChangePointSections(designContent);
  if (!points.length) return verdicts;

  const cd = changeDir(cwd, changeName);
  const planContent = safeRead(path.join(cd, 'plan-ready.md'));
  const planPaths = planContent ? extractFilePaths(planContent) : [];
  const changeSection = extractSection(designContent, '改动文件');
  const designPaths = changeSection ? collectPaths(changeSection) : [];
  const referenced = [...new Set([...designPaths, ...planPaths])];

  // 每个文件的改动新增行文本（--unified=0 的 hunk 新增行；HEAD ref 用 HEAD 内容）
  const addedTextByFile = new Map();
  for (const h of diffHunks(cwd, loadGateConfig(cwd))) {
    if (isTestFilePath(h.file) || isCrossRepoPath(cwd, h.file) || !pathMatches(referenced, h.file)) continue;
    const abs = path.join(cwd, h.file);
    const content = fileContentAt(abs, h.file, h.ref);
    if (!content) continue;
    const lines = content.split('\n');
    const start = h.newStart - 1;
    const end = Math.min(lines.length, start + Math.max(1, h.newCount));
    let buf = addedTextByFile.get(h.file) || '';
    for (let i = start; i < end; i++) buf += lines[i] + '\n';
    addedTextByFile.set(h.file, buf);
  }

  // 有改动新增行的文件列表（每个改动点按含其目标方法的文件单独判定）
  const filesWithAdded = [];
  for (const [rel, added] of addedTextByFile) {
    if (!added) continue;
    const abs = path.join(cwd, rel);
    const content = safeRead(abs);
    if (!content) continue;
    const decls = declaredMethods(abs);
    if (!decls.length) continue;
    const byName = new Map();
    for (const d of decls) if (!byName.has(d.name)) byName.set(d.name, d);
    filesWithAdded.push({ rel, lines: content.split('\n'), decls, byName, added });
  }
  if (!filesWithAdded.length) return verdicts;

  for (const p of points) {
    const text = `${p.title}\n${p.body.join('\n')}`;
    const backtickIds = [...text.matchAll(/`([\w$.]+)`/g)].map((m) => m[1]);
    const parenSet = new Set(
      [...text.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[（(]/g)].map((m) => m[1].split('.').pop()));
    // 声称目标：backtick 声明方法，且非（/（ 跟随的引用；每个目标在自己所在文件里判定
    const rawTargets = [...new Set(backtickIds)].filter((x) => !parenSet.has(x));
    if (!rawTargets.length) continue;

    const details = [];
    let allHit = true;
    for (const t of rawTargets) {
      // 找到含该目标方法的文件
      const f = filesWithAdded.find((x) => x.byName.has(t));
      if (!f) continue; // 目标不在改动文件 → 跳过
      const allDeclNames = new Set(f.decls.map((d) => d.name));
      // 该文件视角的关键词：section 标识符 + 本文件改动新增行 + 罕见
      const tokens = new Set([
        ...backtickIds,
        ...parenSet,
        ...[...text.matchAll(/([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      ]);
      const keywords = [];
      for (const id of tokens) {
        if (id.length < 3) continue;
        if (KEYWORD_STOPWORDS.has(id) || isGenericCallee(id)) continue;
        if (allDeclNames.has(id)) continue;
        if (!f.added.includes(id)) continue; // 必须在本文件改动新增行里
        let count = 0;
        for (const d of f.decls) {
          const [s, e] = methodBodyRange(f.lines, f.decls, d);
          for (let i = s; i <= e; i++) {
            if (f.lines[i].includes(id)) { count++; break; }
          }
        }
        if (count >= 1 && count <= 2) keywords.push(id);
      }
      if (!keywords.length) continue; // 该文件无法判定 → 跳过目标
      const tDecl = f.byName.get(t);
      let hit = false;
      let actual = null;
      if (tDecl) {
        const [s, e] = methodBodyRange(f.lines, f.decls, tDecl);
        for (let i = s; i <= e; i++) {
          if (keywords.some((k) => f.lines[i].includes(k))) { hit = true; break; }
        }
      }
      if (!hit) {
        for (const d of f.decls) {
          const [ds, de] = methodBodyRange(f.lines, f.decls, d);
          for (let i = ds; i <= de; i++) {
            const kw = keywords.find((k) => f.lines[i].includes(k));
            if (kw) { actual = `${d.name}@${i + 1}`; break; }
          }
          if (actual) break;
        }
        allHit = false;
      }
      details.push({ target: t, hit, actual });
    }
    if (!details.length) continue;
    verdicts.push({
      point: `改动点 ${p.num}`,
      title: p.title,
      claimed: details.map((d) => d.target),
      details,
      verdict: allHit ? '✅' : '⚠️',
    });
  }
  return verdicts;
}

// ---- check-verify-prerequisites ----
// Verify 前置条件：build 完成 + 未解决项清零 + 严格 design + proposal 格式 +
// 严格 openspec validate。刻意不读 receipt（receipt 由 checkVerifyReady 单独校验）。

function checkVerifyPrerequisites(cwd, changeName) {
  const blockers = [];

  const buildDone = checkBuildDone(cwd, changeName);
  if (!buildDone.pass) {
    for (const i of buildDone.issues) blockers.push(`build: ${i.type}: ${i.detail}`);
    if (buildDone.building_marker_exists) blockers.push('build: building marker still present (build phase not exited)');
  }

  const verifyIssues = checkVerifyIssues(cwd, changeName);
  blockers.push(...verifyIssues.blockers);

  const designConsistency = checkDesignConsistency(cwd, changeName, { strict: true });
  blockers.push(...designConsistency.blockers);

  const propCheck = checkProposal(cwd, changeName);
  if (!propCheck.pass) blockers.push('proposal format invalid');

  let openspecValid = true;
  try {
    runOpenspec(cwd, ['validate', changeName, '--strict']);
  } catch (e) {
    openspecValid = false;
    blockers.push(`openspec validate failed: ${errMsg(e)}`);
  }

  return {
    pass: blockers.length === 0,
    checks: {
      build_done: buildDone.pass,
      verify_issues_resolved: verifyIssues.pass,
      design_consistent: designConsistency.pass,
      proposal_format: propCheck.pass,
      openspec_validate: openspecValid,
    },
    blockers,
    warnings: designConsistency.warnings || [],
  };
}

// ---- write-verify-receipt ----

function writeVerifyReceipt(cwd, changeName, inputPath) {
  const blockers = [];

  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    return { pass: false, blockers: [`receipt-input-invalid: ${errMsg(e)}`], receipt_path: null };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { pass: false, blockers: ['receipt-input-invalid: expected a JSON object'], receipt_path: null };
  }

  // Validate the four input fields (mirror validateVerifyReceipt shape rules).
  if (!Array.isArray(input.testRuns) || input.testRuns.length === 0 || !input.testRuns.some((tr) => tr && tr.exitCode === 0)) {
    blockers.push('receipt-input-test-runs: requires >=1 run with exitCode 0');
  }
  const cov = input.scenarioCoverage;
  if (!cov || typeof cov !== 'object' || !(Number(cov.mapped) === Number(cov.total) && Number(cov.mapped) > 0)) {
    blockers.push('receipt-input-scenario-coverage: mapped must equal total (>0)');
  }
  const design = input.designConsistency;
  if (!design || typeof design !== 'object' || !Array.isArray(design.blockers) || design.blockers.length !== 0) {
    blockers.push('receipt-input-design-consistency: blockers must be empty');
  }
  if (!input.userConfirmation || input.userConfirmation.received !== true) {
    blockers.push('receipt-input-user-confirmation: received must be true');
  }
  if (blockers.length > 0) {
    return { pass: false, blockers, receipt_path: null };
  }

  // Prerequisites must hold; never write a receipt for an unverified change.
  const prereq = checkVerifyPrerequisites(cwd, changeName);
  if (!prereq.pass) {
    return { pass: false, blockers: prereq.blockers, receipt_path: null };
  }

  // Collect the final fingerprint only after all verify writes are complete.
  const fp = collectWorktreeFingerprint(cwd, changeName);
  if (!fp.ok) {
    return { pass: false, blockers: [`fingerprint-collect-failed: ${fp.blocker}`], receipt_path: null };
  }

  const receipt = {
    version: FINGERPRINT_VERSION,
    change: changeName,
    head: fp.head,
    fingerprint: fp.value,
    testRuns: input.testRuns,
    scenarioCoverage: input.scenarioCoverage,
    designConsistency: input.designConsistency,
    userConfirmation: input.userConfirmation,
  };

  // Atomic write: same-directory temporary file, then renameSync.
  const receiptPath = path.join(changeDir(cwd, changeName), 'verify-result.json');
  const tmpPath = `${receiptPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(receipt, null, 2));
    fs.renameSync(tmpPath, receiptPath);
  } catch (e) {
    return { pass: false, blockers: [`receipt-write-failed: ${errMsg(e)}`], receipt_path: null };
  }

  return { pass: true, blockers: [], receipt_path: receiptPath };
}

// ---- check-verify-ready ----

function checkVerifyReady(cwd, changeName) {
  const prereq = checkVerifyPrerequisites(cwd, changeName);
  const receipt = validateVerifyReceipt(cwd, changeName);

  const blockers = [...prereq.blockers, ...receipt.blockers];
  return {
    pass: blockers.length === 0,
    checks: { ...prereq.checks, receipt_valid: receipt.pass },
    blockers,
    warnings: prereq.warnings || [],
    receipt: receipt.receipt || null,
  };
}

// ---- check-close-ready ----

function checkCloseReady(cwd, changeName) {
  const verifyReady = checkVerifyReady(cwd, changeName);
  const amend = checkAmendCount(cwd, changeName);
  const warnings = [...(verifyReady.warnings || [])];
  if (amend.warning) warnings.push(amend.warning);
  return {
    pass: verifyReady.pass,
    checks: verifyReady.checks,
    blockers: verifyReady.blockers,
    warnings,
    amend_count: amend.amend_count,
  };
}

// ---- archive-verified ----

function archiveSnapshot(cwd) {
  const changesDir = path.join(cwd, 'openspec', 'changes');
  const archiveDir = path.join(changesDir, 'archive');
  const list = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { return []; }
  };
  return {
    changes: new Set(list(changesDir).filter((n) => n !== 'archive')),
    archive: new Set(list(archiveDir)),
  };
}

function archiveVerified(cwd, changeName) {
  const blockers = [];

  // 1. Snapshot archive layout before invoking OpenSpec.
  const before = archiveSnapshot(cwd);

  // 2. Re-run checkVerifyReady immediately before archive (mutation gate).
  const ready = checkVerifyReady(cwd, changeName);
  if (!ready.pass) {
    return { pass: false, blockers: ready.blockers, archived_to: null, checks: ready.checks };
  }

  // 3. Invoke `openspec archive <change> --yes` through the runner.
  // 4. Require runner success.
  try {
    runOpenspec(cwd, ['archive', changeName, '--yes']);
  } catch (e) {
    return { pass: false, blockers: [`openspec-archive-failed: ${errMsg(e)}`], archived_to: null, checks: ready.checks };
  }

  // 5. Confirm the source change directory no longer exists.
  if (exists(changeDir(cwd, changeName))) {
    return { pass: false, blockers: ['archive-source-still-present'], archived_to: null, checks: ready.checks };
  }

  // 6. Exactly one newly-created archive directory from before/after snapshots.
  const after = archiveSnapshot(cwd);
  const newDirs = [...after.archive].filter((d) => !before.archive.has(d));
  if (newDirs.length !== 1) {
    return {
      pass: false,
      blockers: [`archive-dir-count: expected exactly 1 new archive dir, got ${newDirs.length}${newDirs.length ? ` (${newDirs.join(', ')})` : ''}`],
      archived_to: null,
      checks: ready.checks,
    };
  }
  const archivedName = newDirs[0];
  if (!new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${changeName}$`).test(archivedName)) {
    return {
      pass: false,
      blockers: [`archive-dir-name: ${archivedName} does not match YYYY-MM-DD-${changeName}`],
      archived_to: null,
      checks: ready.checks,
    };
  }

  // 7. Confirm the retained archive directory carries tasks/lessons/receipt.
  const archivedDir = path.join(cwd, 'openspec', 'changes', 'archive', archivedName);
  for (const f of ['tasks.md', 'lessons.md', 'verify-result.json']) {
    if (!exists(path.join(archivedDir, f))) {
      return { pass: false, blockers: [`archive-missing-${f}`], archived_to: null, checks: ready.checks };
    }
  }

  // 8. Only now remove the exact phase + building markers.
  for (const m of ['.openflow/phase', '.openflow/building']) {
    try { fs.rmSync(path.join(cwd, m), { force: true }); } catch { /* ignore */ }
  }

  return { pass: true, blockers: [], archived_to: archivedName, checks: ready.checks };
}

// ---- check-amend-count ----

function checkAmendCount(cwd, changeName) {
  const cd = changeDir(cwd, changeName);
  const files = ['proposal.md', 'test-plan.md', 'plan-ready.md'];
  let count = 0;
  const sources = {};

  for (const f of files) {
    const content = safeRead(path.join(cd, f));
    if (!content) continue;
    // Count "## Amendments" sections or amendment date headers
    const matches = content.match(/## Amendments/g);
    if (matches) {
      sources[f] = matches.length;
      count += matches.length;
    }
  }

  // Also check for amendment date markers like "### 2026-07-30"
  for (const f of files) {
    const content = safeRead(path.join(cd, f));
    if (!content) continue;
    const dateMatches = content.match(/^### \d{4}-\d{2}-\d{2}/gm);
    if (dateMatches) {
      count += dateMatches.length;
      sources[f] = (sources[f] || 0) + dateMatches.length;
    }
  }

  return {
    amend_count: count,
    sources,
    warning: count >= 3
      ? `此变更已修订 ${count} 次。频繁 amend 可能意味着原始 proposal 范围不够清晰。`
      : null,
  };
}

// ---- check-writing-plans ----

function checkWritingPlans(cwd) {
  const home = os.homedir();

  // Check skill files (local + global)
  const skillCandidates = [
    path.join(cwd, '.claude/skills/writing-plans/SKILL.md'),
    path.join(home, '.claude/skills/writing-plans/SKILL.md'),
    path.join(cwd, '.opencode/skills/writing-plans/SKILL.md'),
    path.join(home, '.config/opencode/skills/writing-plans/SKILL.md'),
  ];
  let foundPath = null;
  let foundType = null;
  for (const c of skillCandidates) {
    if (exists(c)) { foundPath = c; foundType = 'skill'; break; }
  }

  // Check Claude Code plugin
  if (!foundPath) {
    const pluginsFile = path.join(home, '.claude/plugins/installed_plugins.json');
    if (exists(pluginsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(pluginsFile, 'utf-8'));
        const plugins = data && data.plugins;
        if (plugins && typeof plugins === 'object') {
          for (const [key, value] of Object.entries(plugins)) {
            if (!key.startsWith('superpowers@')) continue;
            const entries = Array.isArray(value) ? value : [value];
            for (const entry of entries) {
              const installPath = entry && entry.installPath;
              const wpSkill = installPath ? path.join(installPath, 'skills/writing-plans/SKILL.md') : null;
              if (wpSkill && exists(wpSkill)) {
                foundPath = wpSkill;
                foundType = 'plugin';
                break;
              }
            }
            if (foundPath) break;
          }
        }
      } catch { /* ignore */ }
    }
  }

  return {
    pass: foundPath !== null,
    found_type: foundType,
    found_path: foundPath,
    install_hint: foundPath
      ? null
      : 'Install: /plugin install superpowers@claude-plugins-official (recommended)\n'
        + 'Or: download writing-plans to .claude/skills/writing-plans/SKILL.md',
  };
}

// ---- check-test-framework ----

function checkTestFramework(cwd) {
  // Check config files in priority order
  const configs = [
    { file: 'package.json', lang: 'javascript/typescript', parse: (c) => {
      const pkg = JSON.parse(c);
      const devDeps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (devDeps.jest || devDeps['ts-jest'] || devDeps.vitest) {
        const fw = devDeps.vitest ? 'vitest' : 'jest';
        return { framework: fw, cmd: devDeps.vitest ? 'npx vitest run' : 'npx jest' };
      }
      if (devDeps.mocha) return { framework: 'mocha', cmd: 'npx mocha' };
      if (devDeps['@playwright/test']) return { framework: 'playwright', cmd: 'npx playwright test' };
      if (pkg.scripts?.test) return { framework: 'npm', cmd: 'npm test', fromScript: true };
      return null;
    }},
    { file: 'pyproject.toml', lang: 'python', parse: (c) => {
      if (c.includes('[tool.pytest') || c.includes('pytest')) return { framework: 'pytest', cmd: 'pytest -v' };
      return null;
    }},
    { file: 'requirements.txt', lang: 'python', parse: (c) => {
      if (c.includes('pytest')) return { framework: 'pytest', cmd: 'pytest -v' };
      if (c.includes('unittest')) return { framework: 'unittest', cmd: 'python -m unittest' };
      return null;
    }},
    { file: 'go.mod', lang: 'go', parse: () => ({ framework: 'go test', cmd: 'go test ./...' }) },
    { file: 'Cargo.toml', lang: 'rust', parse: () => ({ framework: 'cargo test', cmd: 'cargo test' }) },
    { file: 'Makefile', lang: 'c/c++', parse: (c) => {
      if (c.includes('test:')) return { framework: 'make', cmd: 'make test' };
      return null;
    }},
    { file: 'pom.xml', lang: 'java', parse: (c, cwd) => {
      const hasTestDeps = (pom) =>
        pom.includes('<artifactId>junit-jupiter')
        || pom.includes('<artifactId>junit')
        || pom.includes('<artifactId>mockito');
      if (hasTestDeps(c)) return { framework: 'junit', cmd: 'mvn test' };
      // Maven multi-module aggregator: test deps live in submodule poms,
      // not the root pom (which is often <packaging>pom</packaging>).
      const seen = new Set([cwd]);
      let queue = [...c.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)]
        .map((m) => path.join(cwd, m[1].trim()));
      for (let depth = 0; depth < 6 && queue.length; depth++) {
        const next = [];
        for (const subDir of queue) {
          if (seen.has(subDir)) continue;
          seen.add(subDir);
          const subPom = safeRead(path.join(subDir, 'pom.xml'));
          if (!subPom) continue;
          if (hasTestDeps(subPom)) return { framework: 'junit', cmd: 'mvn test' };
          next.push(...[...subPom.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)]
            .map((m) => path.join(subDir, m[1].trim())));
        }
        queue = next;
      }
      return null;
    }},
    { file: 'build.gradle', lang: 'java', parse: (c) => {
      if (c.includes('junit') || c.includes('mockito') || c.includes('useJUnitPlatform'))
        return { framework: 'junit', cmd: './gradlew test' };
      return null;
    }},
    { file: 'build.gradle.kts', lang: 'kotlin', parse: (c) => {
      if (c.includes('junit') || c.includes('mockito') || c.includes('useJUnitPlatform'))
        return { framework: 'junit', cmd: './gradlew test' };
      return null;
    }},
  ];

  for (const { file, lang, parse } of configs) {
    const content = safeRead(path.join(cwd, file));
    if (!content) continue;
    const result = parse(content, cwd);
    if (result) {
      // Detect test directory
      let testDir = null;
      const candidates = ['tests', '__tests__', 'test', 'spec', 'e2e', 'src/test'];
      for (const d of candidates) {
        if (exists(path.join(cwd, d))) { testDir = d; break; }
      }
      return {
        pass: true,
        language: lang,
        framework: result.framework,
        test_command: result.cmd,
        test_dir: testDir,
        from_script: result.fromScript || false,
      };
    }
  }

  return {
    pass: false,
    language: null,
    framework: null,
    test_command: null,
    test_dir: null,
    hint: 'No test framework detected. Check package.json, pyproject.toml, go.mod, Cargo.toml, Makefile, pom.xml, or build.gradle.',
  };
}

// ---- check-brainstorming ----

function checkBrainstorming(cwd) {
  const home = os.homedir();

  const skillCandidates = [
    path.join(cwd, '.claude/skills/brainstorming/SKILL.md'),
    path.join(home, '.claude/skills/brainstorming/SKILL.md'),
    path.join(cwd, '.opencode/skills/brainstorming/SKILL.md'),
    path.join(home, '.config/opencode/skills/brainstorming/SKILL.md'),
  ];
  let foundPath = null;
  let foundType = null;
  for (const c of skillCandidates) {
    if (exists(c)) { foundPath = c; foundType = 'skill'; break; }
  }

  if (!foundPath) {
    const pluginsFile = path.join(home, '.claude/plugins/installed_plugins.json');
    if (exists(pluginsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(pluginsFile, 'utf-8'));
        const plugins = data && data.plugins;
        if (plugins && typeof plugins === 'object') {
          for (const [key, value] of Object.entries(plugins)) {
            if (!key.startsWith('superpowers@')) continue;
            const entries = Array.isArray(value) ? value : [value];
            for (const entry of entries) {
              const installPath = entry && entry.installPath;
              const skillPath = installPath ? path.join(installPath, 'skills/brainstorming/SKILL.md') : null;
              if (skillPath && exists(skillPath)) {
                foundPath = skillPath;
                foundType = 'plugin';
                break;
              }
            }
            if (foundPath) break;
          }
        }
      } catch { /* ignore */ }
    }
  }

  return {
    pass: foundPath !== null,
    found_type: foundType,
    found_path: foundPath,
    install_hint: foundPath
      ? null
      : 'Install: /plugin install superpowers@claude-plugins-official',
  };
}

// ---- main ----

function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const changeName = args[1];

  // check-writing-plans / check-brainstorming / check-test-framework don't need a change name
  if (subcommand === 'check-writing-plans') {
    process.stdout.write(JSON.stringify(checkWritingPlans(cwd), null, 2) + '\n');
    return;
  }
  if (subcommand === 'check-brainstorming') {
    process.stdout.write(JSON.stringify(checkBrainstorming(cwd), null, 2) + '\n');
    return;
  }
  if (subcommand === 'check-test-framework') {
    process.stdout.write(JSON.stringify(checkTestFramework(cwd), null, 2) + '\n');
    return;
  }

  if (!subcommand) {
    process.stderr.write('Usage: openflow-gate.mjs <subcommand> <change-name>\n');
    process.stderr.write('Subcommands: check-proposal, check-test-plan, check-cross-ref, check-build-done, check-close-ready, check-amend-count, check-writing-plans, check-brainstorming, check-test-framework, check-verify-issues, check-design-consistency, check-verify-prerequisites, write-verify-receipt, check-verify-ready, archive-verified\n');
    process.exit(1);
  }

  // Validate the change argument before any path construction or subprocess.
  if (CHANGE_SUBCOMMANDS.has(subcommand) && !isValidChangeName(changeName)) {
    process.stdout.write(JSON.stringify({
      pass: false,
      blockers: [`invalid-change-name: ${String(changeName)}`],
      error: 'change name must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/',
    }, null, 2) + '\n');
    process.exit(1);
  }

  let result;
  switch (subcommand) {
    case 'check-proposal':
      result = checkProposal(cwd, changeName);
      break;
    case 'check-test-plan':
      result = checkTestPlan(cwd, changeName);
      break;
    case 'check-cross-ref':
      result = checkCrossRef(cwd, changeName);
      break;
    case 'check-build-done':
      result = checkBuildDone(cwd, changeName);
      break;
    case 'check-close-ready':
      result = checkCloseReady(cwd, changeName);
      break;
    case 'check-amend-count':
      result = checkAmendCount(cwd, changeName);
      break;
    case 'check-verify-issues':
      result = checkVerifyIssues(cwd, changeName);
      break;
    case 'check-design-consistency':
      result = checkDesignConsistency(cwd, changeName);
      break;
    case 'check-verify-prerequisites':
      result = checkVerifyPrerequisites(cwd, changeName);
      break;
    case 'write-verify-receipt':
      result = writeVerifyReceipt(cwd, changeName, args[2]);
      break;
    case 'check-verify-ready':
      result = checkVerifyReady(cwd, changeName);
      break;
    case 'archive-verified':
      result = archiveVerified(cwd, changeName);
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
      process.exit(1);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
