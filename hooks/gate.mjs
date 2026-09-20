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
 *   check-test-plan       — test-plan.md integrity：状态统计、桩残留、选择器唯一归属，
 *                            外加 RED 证据（✅ PASS 行必须带 🔴 RED，否则这条"通过"没见过红）
 *                            与不变量行（`INV-00x: \`选择器\` covers T-00x, …`）的 covers 对账
 *   check-cross-ref       — plan-ready ↔ test-plan cross-reference（T-id 与 INV-id 同权）
 *   check-build-done      — build completion
 *   check-close-ready     — close pre-conditions
 *   check-verify-issues   — verify-issues.md 未解决项检查
 *   check-design-consistency — design.md「改动文件」节 vs plan-ready + git（basename 兜底、跨仓库跳过）；
 *                            扩展：改动点归属对账。design 必须把每个改动点声明成 `文件路径::方法名`
 *                            （语法同 test-plan 稳定行），声明缺失/格式错 = blocker，gate 不猜；
 *                            归属漂移与声称未落地据此**精确判定**（带文件归属，不再靠裸方法名撞），
 *                            并行路径完整性仍是启发式发现，范围限同文件同前缀兄弟方法（warning 级）；
 *                            归属解析支持跨行签名（括号/花括号配对），豁免本次新增方法/直接下游/「不随改」声明；
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
import { execFileSync } from 'child_process';
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
// On Windows npm installs `openspec.cmd` (not `openspec`), which execFileSync
// would not resolve through PATHEXT (review M5).
function runOpenspec(cwd, argv) {
  const bin = process.env.OPENFLOW_OPENSPEC_BIN || (process.platform === 'win32' ? 'openspec.cmd' : 'openspec');
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

// ---- canonical test-plan stable rows (Task 7) ----

// The canonical test-plan grammar emitted by the spec template: one stable row
// per test case — `T-001: \`tests/auth/test_login.py::test_login_with_valid_credentials\`` —
// optionally followed by status markers: the RED evidence marker (`🔴 RED`,
// appended at TDD Step 2 when the finished assertion was observed failing) and
// the result marker (`✅ PASS` / `⬜ TODO` / `❌ FAIL`).
//
// Invariant rows share the grammar with an `INV-` id plus a `covers` clause:
//   INV-001: `tests/price_test.py::test_apply_today_always_acts` covers T-003, T-007 🔴 RED ✅ PASS
// They exist because a cross-combination invariant ("this input class must
// always produce an observable effect") belongs to no single scenario, and a
// plan that can only express one-scenario-one-test pushes authors toward
// negative-space assertions that a do-nothing regression satisfies.
//
// This exact regex is replicated in three places (gate.mjs / detect.mjs /
// rules.ts — the client adapters share rules.ts); keep them in sync. Here the
// captured suffix drives pass/todo/fail stats and the RED evidence check.
const CANONICAL_ROW_RE = /^([T#]\S+|INV-\d+)\s*:\s*`([^`]+)`(?:\s+(.+))?$/;
const RED_MARKER_RE = /🔴|\bRED\b/;

function parseCanonicalTestRows(content) {
  const out = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(CANONICAL_ROW_RE);
    if (!m) continue;
    const id = m[1];
    const selector = m[2].trim();
    const sep = selector.lastIndexOf('::');
    const file = sep === -1 ? selector : selector.slice(0, sep);
    const suffix = m[3] || '';
    let status = 'todo';
    if (/FAIL|❌/.test(suffix)) status = 'fail';
    else if (/PASS|✅/.test(suffix)) status = 'pass';
    // `covers T-003, T-007` — read up to the first status marker so the marker
    // text can never be swallowed into the id list.
    const covers = [];
    const cm = suffix.match(/covers\s+([^🔴✅❌⬜]+)/i);
    if (cm) {
      for (const tok of cm[1].split(/[,\s]+/)) {
        const t = tok.trim().replace(/^`|`$/g, '');
        if (/^(?:T-\d+|#\d+)$/.test(t)) covers.push(t);
      }
    }
    out.push({
      id,
      file,
      selector,
      status,
      red: RED_MARKER_RE.test(suffix),
      kind: id.startsWith('INV-') ? 'invariant' : 'test',
      covers,
    });
  }
  return out;
}

// Parse plan-ready task blocks: `### Task N: <name>` plus the canonical
// `- Test cases: T-001, …` and `- Files: <paths>` fields.
function parsePlanReadyTaskBlocks(content) {
  const tasks = [];
  let cur = null;
  for (const line of content.split('\n')) {
    const h = line.match(/^###\s*Task\s+(\d+)\s*:/);
    if (h) {
      cur = { label: `Task ${h[1]}`, testIds: [], files: [] };
      tasks.push(cur);
      continue;
    }
    if (!cur) continue;
    const tc = line.match(/^\s*-\s*Test cases?\s*:\s*(.+)$/i);
    if (tc) {
      for (const tok of tc[1].split(/[,\s]+/)) {
        const t = tok.trim().replace(/^`|`$/g, '');
        if (/^(?:T-\d+|INV-\d+|#\d+)$/.test(t)) cur.testIds.push(t);
      }
      continue;
    }
    const fl = line.match(/^\s*-\s*Files?\s*:\s*(.+)$/i);
    if (fl) {
      for (const tok of fl[1].split(',')) {
        const p = tok.trim().replace(/^`|`$/g, '');
        if (p) cur.files.push(p);
      }
    }
  }
  return tasks;
}

// Mirror the enforcement owner-map rule (rules.ts): one selector must belong to
// exactly one stable id. Exposed early so spec/amend gates catch it before build.
function findDuplicateSelectorIssues(rows) {
  const ownerMap = new Map();
  for (const r of rows) {
    const list = ownerMap.get(r.selector) ?? [];
    list.push(r.id);
    ownerMap.set(r.selector, list);
  }
  const issues = [];
  for (const [selector, ids] of ownerMap) {
    if (ids.length > 1) {
      issues.push({
        type: 'duplicate_selector',
        detail: `test-plan 中同一选择器被多个 id 拥有: ${selector} (${ids.join(', ')})`,
      });
    }
  }
  return issues;
}

// Non-blocking consistency hint: canonical machine rows (`T-001: \`file::fn\``)
// vs the human traceability table's backticked `file::fn`. Free-form tables are
// informational, so mismatches surface as warnings, never as blockers.
function findTraceabilityWarnings(tpContent, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const warnings = [];
  for (const line of tpContent.split('\n')) {
    const m = line.match(/^\|\s*(T-\d+|#\d+)\s*\|/);
    if (!m) continue;
    const id = m[1];
    const row = byId.get(id);
    if (!row) continue;
    const tm = line.match(/`([^`]+?)::([^`]+)`/);
    if (!tm) continue;
    const sep = row.selector.lastIndexOf('::');
    const rowFn = sep === -1 ? '' : row.selector.slice(sep + 2);
    const tableFn = tm[2].trim();
    if (rowFn && rowFn !== tableFn) {
      warnings.push({
        type: 'traceability_mismatch',
        detail: `${id} 机器行函数 ${rowFn} 与追溯表函数 ${tableFn} 不一致`,
      });
    }
  }
  return warnings;
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

  // Canonical stable rows are the source of truth; the legacy table grammar is
  // still accepted for pre-existing test-plans.
  const rows = parseCanonicalTestRows(content);
  let pass = 0, todo = 0, fail = 0, total = 0;
  const testFiles = new Set();
  // A row marked PASS whose assertion was never observed failing is not
  // evidence of anything: an assertion with no failing power (only `never()`
  // style checks, or no assertion at all) is green from the first run. The RED
  // marker is the one machine-checkable trace of TDD Step 2.
  const redIssues = [];
  const invIssues = [];

  if (rows.length > 0) {
    const idSet = new Set(rows.map((r) => r.id));
    for (const r of rows) {
      total++;
      if (r.status === 'pass') pass++;
      else if (r.status === 'fail') fail++;
      else todo++;
      testFiles.add(r.file);
      if (r.status === 'pass' && !r.red) {
        redIssues.push({
          type: 'red_evidence_missing',
          id: r.id,
          detail: `${r.id} 标记 ✅ PASS 但没有 🔴 RED 证据 — 没见过它红的测试不算验证（TDD Step 2）`,
        });
      }
      if (r.kind === 'invariant') {
        if (r.covers.length === 0) {
          invIssues.push({
            type: 'invariant_covers_missing',
            id: r.id,
            detail: `${r.id} 缺少 \`covers T-00x, …\` 子句 — 不变量行必须声明它横跨哪些场景`,
          });
        }
        for (const c of r.covers) {
          if (!idSet.has(c)) {
            invIssues.push({
              type: 'invariant_covers_unknown',
              id: r.id,
              detail: `${r.id} 声明覆盖 ${c}，但 test-plan 里没有 ${c} 这一行`,
            });
          }
        }
      }
    }
  } else {
    // Legacy table rows (`| 1 | … | ✅ PASS |`).
    const lines = content.split('\n');
    let inTable = false, headerSkipped = false;
    const fileRe = /`([^`]+\.[a-z]{2,6})(?:::[^`]+)?`/gi;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\|[-| ]+\|$/.test(trimmed)) { inTable = true; headerSkipped = true; continue; }
      if (!inTable) continue;
      if (!trimmed.startsWith('|')) { inTable = false; continue; }
      if (!headerSkipped) { headerSkipped = true; continue; }

      total++;
      const isPass = /✅|PASS/i.test(line);
      if (isPass) pass++;
      else if (/FAIL|❌.*FAIL/i.test(line)) fail++;
      else todo++;
      // Legacy table rows carry the RED marker in the same status cell:
      // `| 1 | 场景一 | ✅ PASS 🔴 RED |`.
      if (isPass && !RED_MARKER_RE.test(line)) {
        redIssues.push({
          type: 'red_evidence_missing',
          id: `row-${total}`,
          detail: `第 ${total} 行标记 PASS 但没有 🔴 RED 证据 — 没见过它红的测试不算验证（TDD Step 2）`,
        });
      }

      for (const m of line.matchAll(fileRe)) {
        const p = m[1].split('::')[0]; // strip function name
        testFiles.add(p);
      }
    }
  }

  const issues = [];
  if (total === 0) issues.push({ type: 'empty', detail: 'No test rows found in table' });
  if (fail > 0) issues.push({ type: 'has_failures', detail: `${fail} test(s) marked FAIL` });
  if (rows.length > 0) {
    for (const d of findDuplicateSelectorIssues(rows)) issues.push(d);
  }
  for (const r of redIssues) issues.push(r);
  for (const i of invIssues) issues.push(i);

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

  const structurallyClean = fail === 0 && stubIssues.length === 0
    && redIssues.length === 0 && invIssues.length === 0;
  return {
    pass: total > 0 && structurallyClean,
    stats: { pass, todo, fail, total, red_missing: redIssues.length },
    issues,
    all_pass: total > 0 && pass === total && structurallyClean,
    stub_issues: stubIssues,
    red_issues: redIssues,
    invariant_issues: invIssues,
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

  // Extract stable IDs (T-001 / legacy #N) from canonical test-plan rows.
  const tpIds = [];
  for (const r of parseCanonicalTestRows(tpContent)) {
    if (!tpIds.includes(r.id)) tpIds.push(r.id);
  }
  // Legacy table fallback: numeric `#` column.
  if (tpIds.length === 0) {
    for (const m of tpContent.matchAll(/\|\s*(\d+)\s*\|/g)) {
      const id = `#${parseInt(m[1])}`;
      if (!tpIds.includes(id)) tpIds.push(id);
    }
  }

  // Extract references per plan-ready task: `- Test cases: T-001, T-002`
  // (canonical), plus legacy `#N` references only when the test-plan itself is
  // in legacy numeric form (so a mixed plan never reports false orphans).
  const tasks = parsePlanReadyTaskBlocks(prContent);
  const binding = new Map(); // id -> task labels that reference it
  const refIds = new Set();
  for (const task of tasks) {
    for (const id of task.testIds) {
      refIds.add(id);
      const list = binding.get(id) ?? [];
      if (!list.includes(task.label)) list.push(task.label);
      binding.set(id, list);
    }
  }
  const usesStable = tpIds.some((id) => /^(?:T-|INV-)/.test(id));
  if (!usesStable) {
    for (const m of prContent.matchAll(/#(\d+)/g)) {
      const id = `#${parseInt(m[1])}`;
      refIds.add(id);
      if (!binding.has(id)) binding.set(id, ['(legacy)']);
    }
  }

  const canonicalRows = parseCanonicalTestRows(tpContent);
  const rowById = new Map();
  for (const r of canonicalRows) {
    if (!rowById.has(r.id)) rowById.set(r.id, r);
  }

  const issues = [];
  const orphanTests = tpIds.filter((id) => !refIds.has(id));
  const untestableTasks = [...refIds].filter((id) => !tpIds.includes(id));

  if (orphanTests.length > 0) {
    issues.push({
      type: 'uncovered_test',
      detail: `Tests ${orphanTests.join(', ')} in test-plan have no matching task in plan-ready`,
    });
  }
  if (untestableTasks.length > 0) {
    issues.push({
      type: 'orphan_task',
      detail: `plan-ready references tests ${[...untestableTasks].join(', ')} not found in test-plan`,
    });
  }
  // Fail closed on structural inconsistencies found in the real consuming repo:
  // one test id must belong to exactly one task, and every task's test selectors
  // must live in test files the task declares in `Files`.
  for (const [id, taskLabels] of binding) {
    if (taskLabels.length > 1) {
      issues.push({
        type: 'duplicate_task_binding',
        detail: `测试 ${id} 被多个 task 绑定: ${taskLabels.join(', ')}`,
      });
    }
    const row = rowById.get(id);
    if (!row) continue;
    for (const label of taskLabels) {
      if (label === '(legacy)') continue;
      const task = tasks.find((t) => t.label === label);
      if (task && !task.files.includes(row.file)) {
        issues.push({
          type: 'test_file_not_in_task_files',
          detail: `${label} 的测试 ${id} 选择器文件 ${row.file} 不在该 task 的 Files 中`,
        });
      }
    }
  }
  for (const d of findDuplicateSelectorIssues(canonicalRows)) issues.push(d);
  const warnings = findTraceabilityWarnings(tpContent, canonicalRows);

  return {
    pass: issues.length === 0,
    issues,
    warnings,
    summary: issues.length === 0
      ? `${tpIds.length} tests, all covered by plan-ready tasks.`
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
  let tasksDetail = 'Some tasks still [ ] in plan-ready.md';
  if (prContent) {
    const done = (prContent.match(/\[x\]/gi) ?? []).length;
    const pending = (prContent.match(/\[ \]/g) ?? []).length;
    allTasksDone = pending === 0 && done > 0;
    if (done === 0 && pending === 0) {
      tasksDetail = 'plan-ready.md 没有任何 [ ]/[x] task checkbox（每个 Task 需要一行，见 spec 模板）';
    }
  }

  const issues = [];
  if (!tpResult.all_pass) {
    issues.push({
      type: 'tests_not_all_pass',
      detail: `${tpResult.stats?.fail ?? 0} FAIL, ${tpResult.stats?.todo ?? 0} TODO, ${tpResult.stats?.red_missing ?? 0} 缺 RED 证据`,
    });
  }
  for (const r of tpResult.red_issues ?? []) issues.push(r);
  for (const i of tpResult.invariant_issues ?? []) issues.push(i);
  if (!allTasksDone) issues.push({ type: 'tasks_not_all_done', detail: tasksDetail });

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

// 基准分支来自 .openflow/gate.config.json（不可信数据）。使用前必须通过形态校验，
// 并在拼接进 git diff 前解析成确定性 SHA —— 绝不把原始字符串做 shell 插值（review I1）。
const BASE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// 基准分支：优先取 gate.config 的 base_branch（校验形态），否则探测常见默认分支；
// 都没有返回 null（退回只看未提交）。探测与解析均走 argv，不做 shell 拼接。
function baseBranch(cwd, config) {
  const cfg = config && config.base_branch;
  if (cfg) return BASE_REF_RE.test(cfg) ? cfg : null;
  for (const b of ['main', 'master', 'origin/main', 'origin/master', 'develop', 'origin/develop']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', b], { cwd, encoding: 'utf-8', stdio: 'pipe' });
      return b;
    } catch { /* try next */ }
  }
  return null;
}

// 把基准 ref 解析成确定性 commit SHA（仅 40 位 hex）；后续 diff 只拼接该 SHA，杜绝注入。
function resolveBaseSha(cwd, base) {
  if (!base) return null;
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch { return null; }
}

// 本次变更的文件：基准分支累计改动（含已提交）+ 未提交 + 已暂存。
// 全部走 execFileSync argv，任何文件/分支名都不经 shell。
function gitChangedFiles(cwd, config) {
  const files = [];
  const argvs = [];
  const base = resolveBaseSha(cwd, baseBranch(cwd, config));
  if (base) argvs.push(['diff', `${base}...HEAD`, '--name-only']);
  argvs.push(['diff', '--name-only'], ['diff', '--cached', '--name-only']);
  for (const argv of argvs) {
    try {
      const out = execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: 'pipe' });
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

  // 改动点声明：解析失败是 blocker，不是 warning。声明是 spec 阶段的产物契约——
  // 格式错了说明 spec 没写完，gate 不去猜；猜出来的对账等于没对账。
  const { points, errors: declErrors } = parseChangePointDeclarations(designContent);
  blockers.push(...declErrors);
  if (!declErrors.length && !points.length && extractSection(designContent, '现状与影响面')) {
    blockers.push('design.md「现状与影响面」没有任何 `### 改动点 N` 小节——改动点必须逐个声明 `文件路径::方法名`，否则无法做归属对账');
  }

  // 改动点归属 / 完整性对账（warning 级；gate.config 的 change_point_check=false 可关闭）
  if (config.change_point_check !== false) {
    warnings.push(...checkChangePointOwnership(cwd, changeName, points, config));
  }

  // 改动点逐条机械判定：声明的 `文件::方法` vs diff 实际落点（verify 清单以此为据，AI 只补充依据）
  const change_point_verdicts = changePointVerdicts(cwd, changeName, points, config);

  return { pass: blockers.length === 0, design_exists: true, design_file_count: designPaths.length, blockers, warnings, change_point_verdicts };
}

// ---- 改动点归属对账 ----
// 设计阶段若方法名与行号漂移（例：design 声称改 A 方法、行号却指 B 方法的方法体），实现按行号落点会把改动插进错误方法。
// 对账以 design 的**声明**为准（`文件路径::方法名`，见 parseChangePointDeclarations）：
//   ① 归属漂移——hunk 落点方法不在该文件的声明集合里（精确：按文件比对）；
//   ② 声称未落地——声明「随改」的方法体内没有任何 hunk（精确：按文件+行区间比对）；
//   ③ 完整性——同文件里声明目标的同前缀兄弟方法（New/Old/V2）未被声明（启发式发现，warning）。
// 精度规则（2026-09 修复：多行签名漏识别导致的成片误报）：
//   · 方法声明按括号/花括号配对解析，支持 Java/TS 等换行签名；调用点续行（`&& f(...)) {`）不算声明；
//   · hunk 区域扫描覆盖 newStart..newStart+min(newCount,12)，且只认"注释/注解/字段声明之后紧跟"的声明；
//   · 本次 diff 新增的方法、声明目标的同文件直接下游不算"归属漂移"（新增/下沉属正常分工）；
//   · ② 按行区间重叠判定落点（大 hunk 覆盖多方法），「不随改」声明是显式豁免。
// 跨仓库/测试文件不参与。

const METHOD_DECL_RES = {
  py: /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/,
  go: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:[\w<>[\], ?.&|]+)?\s*\{/,
  rb: /^\s*(?:def|class|module)\s+([A-Za-z_$][\w$]*)/,
  rs: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:fn|unsafe\s+fn)\s+([A-Za-z_$][\w$]*)\s*\(/,
};

const BRACE_LANGS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.kt', '.cs', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.scala', '.sc']);

function declRegexFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return METHOD_DECL_RES.py;
  if (ext === '.go') return METHOD_DECL_RES.go;
  if (ext === '.rb' || ext === '.rake') return METHOD_DECL_RES.rb;
  if (ext === '.rs') return METHOD_DECL_RES.rs;
  return null;
}

function isBraceLang(filePath) {
  return BRACE_LANGS.has(path.extname(filePath).toLowerCase());
}

function supportsMethodScan(filePath) {
  return isBraceLang(filePath) || declRegexFor(filePath) !== null;
}

// ---- 花括号语言（Java/TS/JS/C#/Kotlin/...）方法声明扫描 ----
// 旧实现用单行正则匹配声明，换行的签名（Java 参数换行、TS 多行参数）整体漏识别，
// 于是 hunk 被回溯归属到上一个方法；调用点续行（`&& foo(...)) {`）又会因返回类型字符类
// 含空格/&被误当成声明。这里改为：去注释/字符串 → 括号配对 → 花括号配对，得到精确方法体范围。

// 把注释/字符串内容替换为空格（保留换行与字符偏移），避免注释里的 `task_id（` 被当成调用。
// 注意：反引号不做模板字符串处理——JS 正则字面量里出现 ` 的概率远高于模板字符串里出现 //，
// 误判会吞掉后续大段代码；末尾用"空白化比例"兜底，异常时退回原文。
function stripSourceComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | str | chr
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '"' && d === '"' && src[i + 2] === '"') { state = 'textblock'; out += '   '; i += 3; continue; }
      if (c === '"') { state = 'str'; out += ' '; i += 1; continue; }
      if (c === "'") { state = 'chr'; out += ' '; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += '\n'; } else out += ' '; i += 1; continue; }
    if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; } out += blank(c); i += 1; continue; }
    if (state === 'textblock') { if (c === '"' && d === '"' && src[i + 2] === '"') { state = 'code'; out += '   '; i += 3; continue; } out += blank(c); i += 1; continue; }
    if (state === 'str') { if (c === '\\') { out += '  '; i += 2; continue; } if (c === '"') state = 'code'; out += blank(c); i += 1; continue; }
    if (state === 'chr') { if (c === '\\') { out += '  '; i += 2; continue; } if (c === "'") state = 'code'; out += blank(c); i += 1; continue; }
  }
  const nonWs = (s) => s.replace(/\s/g, '').length;
  if (nonWs(out) < nonWs(src) * 0.5) return src; // 状态机被正则/模板误判 → 退回原文（宁少剥，不吞代码）
  return out;
}

function lineIndexMap(code) {
  const map = new Array(code.length);
  let ln = 1;
  for (let i = 0; i < code.length; i++) { map[i] = ln; if (code[i] === '\n') ln++; }
  return map;
}

function matchParen(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function matchBrace(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// `)` 之后跳过 throws/返回类型/数组后缀，找到方法体 `{`；先遇到 `;` 说明是抽象/接口签名
function findBodyOpen(code, closeParenIdx) {
  let i = closeParenIdx + 1;
  let depth = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { if (depth === 0) return -1; depth--; }
    else if (c === '{' && depth === 0) return i;
    else if (c === ';' && depth === 0) return -1;
    i++;
  }
  return -1;
}

// 行首是这些字符 → 表达式/续行，不可能是声明
const BRACE_DECL_START_RE = /^(?:&&|\|\||\?|\)|\.|;|\}|\{|,|\]|=|\+|-|\*|\/|%|!|:)/;
// 同一行的声明头关键字（类/匿名类/包导入不是方法）
const BRACE_NON_METHOD_HEAD_RE = /^(?:new|class|interface|enum|record|struct|impl|module|trait|object|package|import|namespace)$/;

// 无返回类型（JS/TS 类方法）时，只接受"新鲜语句起点"：往前只有空白，或仅夹着注解行
function isFreshStatementStart(code, nameIdx) {
  let i = nameIdx - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (i < 0) return true;
  if (/[;{}]/.test(code[i])) return true;
  const stmtStart = Math.max(code.lastIndexOf(';', i), code.lastIndexOf('{', i), code.lastIndexOf('}', i));
  const gap = code.slice(stmtStart + 1, i + 1).split('\n').map((s) => s.trim()).filter(Boolean);
  return gap.length > 0 && gap.every((s) => s.startsWith('@'));
}

function scanBraceDecls(code) {
  const lineOf = lineIndexMap(code);
  const decls = [];
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[1];
    if (isControlKeyword(name)) continue;
    const beforeName = m.index > 0 ? code[m.index - 1] : '\n';
    if (!/\s/.test(beforeName)) continue; // 排除 a.b( / T::f( / @Anno( / ->f(
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    const prefix = code.slice(lineStart, m.index);
    const trimmed = prefix.trim();
    if (trimmed) {
      if (BRACE_DECL_START_RE.test(trimmed)) continue;
      if (/[=?:]|->/.test(prefix)) continue;
      if (/\b(?:return|throw|new)\b/.test(prefix)) continue;
      // prefix 不含方法名；head 就是名字之前的全部词（修饰符/返回类型/function 等）
      const head = trimmed.split(/\s+/).filter(Boolean);
      if (!head.length) continue;
      if (BRACE_NON_METHOD_HEAD_RE.test(head[0])) continue;
    } else if (!isFreshStatementStart(code, m.index)) {
      continue;
    }
    const parenIdx = m.index + m[0].length - 1;
    const closeParen = matchParen(code, parenIdx);
    if (closeParen < 0) continue;
    const bodyOpen = findBodyOpen(code, closeParen);
    if (bodyOpen < 0) continue;
    const bodyClose = matchBrace(code, bodyOpen);
    if (bodyClose < 0) continue;
    decls.push({ name, line: lineOf[m.index], bodyStart: lineOf[bodyOpen], bodyEnd: lineOf[bodyClose] });
  }
  return decls;
}

// 单行正则语言（py/go/rb/rs）的声明列表（无精确方法体范围）
function scanLineDecls(content, declRe) {
  const lines = content.split('\n');
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:new|class|interface|enum|record|struct|impl|module)\b/.test(lines[i])) continue;
    const m = lines[i].match(declRe);
    if (m && !isControlKeyword(m[1])) decls.push({ name: m[1], line: i + 1 });
  }
  return decls;
}

function parseMethodDecls(content, filePath) {
  const declRe = declRegexFor(filePath);
  if (declRe) return scanLineDecls(content, declRe);
  if (isBraceLang(filePath)) return scanBraceDecls(stripSourceComments(content));
  return [];
}

// 控制流关键字不是方法：`if (...) {` 会被 brace 正则捕获成方法名，必须排除
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'try', 'else', 'do', 'synchronized', 'foreach', 'when', 'match', 'elif', 'until', 'unless', 'using', 'with', 'throw', 'case', 'default', 'assert', 'await', 'yield', 'in', 'of', 'new', 'function', 'fun', 'fn']);
function isControlKeyword(name) {
  return CONTROL_KEYWORDS.has(name);
}


// 读取文件内容：HEAD ref 用 git show HEAD:<path>（已提交的 hunk 行号指 HEAD），否则读工作区。
// 走 argv 传参：文件名里的空格不会被 shell 拆开，恶意文件名也无法注入（review I1）。
function fileContentAt(absPath, relFile, ref) {
  if (ref === 'HEAD') {
    try {
      return execFileSync('git', ['show', `HEAD:${relFile}`], { encoding: 'utf-8', stdio: 'pipe' });
    } catch { return null; }
  }
  return safeRead(absPath);
}

// 解析基准分支累计（ref=HEAD）+ 未提交 + 已暂存（ref=worktree）的 hunk（--unified=0，零依赖）；
// 返回 { file, newStart, newCount, ref }。git 调用全部走 execFileSync argv（review I1）。
function diffHunks(cwd, config) {
  const seen = new Set();
  const hunks = [];
  const argvs = [];
  const base = resolveBaseSha(cwd, baseBranch(cwd, config));
  if (base) argvs.push({ argv: ['diff', `${base}...HEAD`, '--no-ext-diff', '--unified=0'], ref: 'HEAD' });
  argvs.push({ argv: ['diff', '--no-ext-diff', '--unified=0'], ref: 'worktree' });
  argvs.push({ argv: ['diff', '--cached', '--no-ext-diff', '--unified=0'], ref: 'worktree' });
  for (const { argv, ref } of argvs) {
    let out = '';
    try { out = execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: 'pipe' }); } catch { continue; }
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
  if (!supportsMethodScan(relFile)) return [];
  const lines = content.split('\n');
  const decls = methodDeclsFor(content, relFile, hunk.ref);
  // 区域扫描：hunk 起点到 newStart+min(newCount,12)——新增方法常带 Javadoc/注解，
  // 起点落在注释上；只认"注释/空白/注解之后紧跟的声明"，避免大段体内改动误归属到下一个方法
  const span = Math.max(1, Math.min(Number.isFinite(hunk.newCount) ? hunk.newCount : 0, 12));
  const regionScanEnd = hunk.newStart + span - 1;
  const region = decls.filter((d) => d.line >= hunk.newStart && d.line <= regionScanEnd
    && isDeclPreambleOnly(lines, hunk.newStart, d.line));
  if (region.length) return region;
  const floorLine = hunk.newStart - 2 - 400;
  const preceding = decls.filter((d) => d.line <= hunk.newStart - 1 && d.line >= floorLine);
  for (let k = preceding.length - 1; k >= 0; k--) {
    const d = preceding[k];
    // getter/setter 被远距离归属 → 低置信（getter 体不可能跨几十行），宁漏勿误
    if (/^(get|set|is|has)[A-Z]/.test(d.name) && (hunk.newStart - 1 - d.line) > 20) continue;
    return [{ name: d.name, line: d.line }];
  }
  return [];
}

// [fromLine, declLine) 只能出现空白/注释/注解/字段声明——说明这个声明是 hunk 自己新增的
function isDeclPreambleOnly(lines, fromLine, declLine) {
  for (let i = fromLine; i < declLine; i++) {
    const t = (lines[i - 1] || '').trim();
    if (!t) continue;
    if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//') || t.startsWith('@')) continue;
    // 字段/常量声明夹在 Javadoc 与新方法之间（`private Map<...> x = new HashMap<>();`）
    if (/^(?:public|protected|private|static|final|const|readonly|volatile|transient)\b/.test(t) && t.endsWith(';')) continue;
    return false;
  }
  return true;
}

// 同一份内容在一次 gate 运行里只解析一次（hunk 数量多时会重复调用）
const METHOD_DECL_CACHE = new Map();

// 全文件方法声明列表（完整性检查用）
function declaredMethods(filePath) {
  const key = `wt:${filePath}`;
  if (METHOD_DECL_CACHE.has(key)) return METHOD_DECL_CACHE.get(key);
  const content = safeRead(filePath);
  const decls = content ? parseMethodDecls(content, filePath) : [];
  if (content) METHOD_DECL_CACHE.set(key, decls);
  return decls;
}

function methodDeclsFor(content, filePath, ref) {
  const key = `${ref || 'worktree'}:${filePath}`;
  if (METHOD_DECL_CACHE.has(key)) return METHOD_DECL_CACHE.get(key);
  const decls = parseMethodDecls(content, filePath);
  METHOD_DECL_CACHE.set(key, decls);
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

// 方法 d 的体范围 [startIdx, endIdx]：优先用花括号配对得到的精确体结束行，
// 否则（py/go/rb/rs）退回"下一个声明的上一行或文件尾"
function methodBodyRange(lines, decls, d) {
  const order = [...decls].sort((x, y) => x.line - y.line);
  const idx = order.findIndex((x) => x.name === d.name && x.line === d.line);
  if (idx < 0) return [d.line - 1, lines.length - 1];
  // 有花括号配对信息时用真正的体范围（不含签名行——否则 `foo(` 会把方法名算成自己的下游调用）
  if (order[idx].bodyEnd) {
    const start = order[idx].bodyStart || d.line;
    return [start - 1, Math.max(start - 1, order[idx].bodyEnd - 1)];
  }
  const end = idx + 1 < order.length ? order[idx + 1].line - 2 : lines.length - 1;
  return [d.line - 1, Math.max(d.line - 1, end)];
}

// ---- 改动点声明（机器可解析，design.md「现状与影响面」约定）----
//
// 语法与 test-plan 稳定行同源（`文件::符号`），spec 模板生成：
//
//   ### 改动点 1：<标题>
//   - 目标：`src/pages/task/index.tsx::loadTaskList`
//   - 并行路径：`src/pages/task/index.tsx::loadTaskListNew` → 随改
//   - 并行路径：`src/pages/legacy.tsx::fetchAll` → 不随改（已废弃，无线上流量）
//
// 声明带文件归属，所以 gate 做的是**核对**不是**反推**：以前从全文正则抓裸方法名，
// 必须靠一堆启发式猜"这个 backtick 是改动目标还是引用锚点"、跨文件同名只能放过。
// 现在 (文件, 方法) 唯一确定，归属漂移与声称未落地都能精确判定。
//
// 「不随改」是显式豁免，取代了以前用 /无代码改动|不随改|复用|同构/ 扫正文的猜测。
const DECL_RE = /^[-*]\s*(目标|并行路径)\s*[:：]\s*`([^`]+)`\s*(?:(?:→|->)\s*(随改|不随改)\s*(?:[（(]([^）)]*)[）)])?)?\s*$/;

/**
 * 解析「现状与影响面」里的改动点声明。
 *
 * 返回 { points, errors }。errors 非空 = 声明格式不合约定，调用方按 blocker 处理：
 * 声明是 spec 阶段的产物契约，格式错了就是 spec 没写完，不是 gate 该猜的事。
 */
function parseChangePointDeclarations(designContent) {
  const section = extractSection(designContent, '现状与影响面');
  const points = [];
  const errors = [];
  if (!section) return { points, errors };

  let current = null;
  const flush = () => { if (current) points.push(current); current = null; };

  for (const raw of section.split('\n')) {
    const head = raw.match(/^###\s*改动点\s*(\d+)\s*[:：]?\s*(.*)$/);
    if (head) {
      flush();
      current = { num: head[1], title: head[2].trim(), targets: [] };
      continue;
    }
    if (!current) continue;

    const line = raw.trim();
    const m = line.match(DECL_RE);
    if (!m) {
      // 形似声明却解析不了：报错而不是静默忽略，否则漏一个目标就等于漏一次对账
      if (/^[-*]\s*(目标|并行路径)\s*[:：]/.test(line)) {
        errors.push(`改动点 ${current.num} 的声明无法解析：${line}——格式应为 \`- 目标：\`文件路径::方法名\`\` 或 \`- 并行路径：\`文件路径::方法名\` → 随改/不随改（理由）\``);
      }
      continue;
    }

    const [, kind, selector, follow, reason] = m;
    const sep = selector.lastIndexOf('::');
    if (sep <= 0 || sep + 2 >= selector.length) {
      errors.push(`改动点 ${current.num} 的选择器缺少 \`::\` 文件/方法分隔：\`${selector}\`——必须写成 \`文件路径::方法名\`，只写方法名无法定位文件`);
      continue;
    }
    if (kind === '并行路径' && !follow) {
      errors.push(`改动点 ${current.num} 的并行路径 \`${selector}\` 未标注「随改」或「不随改」——并行路径必须逐条决定，不能悬空`);
      continue;
    }

    current.targets.push({
      kind,
      file: selector.slice(0, sep),
      method: selector.slice(sep + 2),
      selector,
      follow: kind === '目标' ? true : follow === '随改',
      reason: (reason || '').trim(),
    });
  }
  flush();

  for (const p of points) {
    if (p.targets.length === 0) {
      errors.push(`改动点 ${p.num}（${p.title || '无标题'}）没有任何 \`- 目标：\` 声明——每个改动点必须声明至少一个 \`文件路径::方法名\``);
    }
  }
  return { points, errors };
}

/** 所有需要落地的声明（目标 + 随改的并行路径）。不随改的是显式豁免。 */
function followedDeclarations(points) {
  return points.flatMap((p) => p.targets.filter((t) => t.follow).map((t) => ({ ...t, num: p.num })));
}

/** (文件 → 该文件下所有被声明的方法名)，含不随改的——不随改也算"design 知道它"，不报归属漂移。 */
function declaredByFile(points) {
  const byFile = new Map();
  for (const p of points) {
    for (const t of p.targets) {
      if (!byFile.has(t.file)) byFile.set(t.file, new Set());
      byFile.get(t.file).add(t.method);
    }
  }
  return byFile;
}

// 去掉并行路径后缀（New / Old / V2 / _new / _old）得前缀；无后缀返回 null
function stripParallelSuffix(name) {
  const m = name.match(/^(.*?)(?:New|Old|V[0-9]+|_new|_old)$/);
  if (!m || m[1].length < 2) return null; // 剩余前缀太短不像方法名（bold→b 这类误切不判）
  return m[1];
}

// 改动点归属对账：声明的 (文件, 方法) vs diff 实际落点。三个方向：
//   ① 归属漂移——hunk 落在该文件某个**未被声明**的方法里（插错方法）
//   ② 声称未落地——声明了「随改」，但该文件有改动却没有 hunk 落进这个方法
//   ③ 完整性——同文件里声明目标的并行兄弟方法（New/Old/V2 后缀）未被声明
// ①② 现在是精确判定（声明带文件归属）；③ 仍是启发式发现，范围收窄到同文件兄弟。
function checkChangePointOwnership(cwd, changeName, points, config) {
  const warnings = [];
  if (!points.length) return warnings;

  const followed = followedDeclarations(points);
  const declared = declaredByFile(points);

  const cd = changeDir(cwd, changeName);
  const planContent = safeRead(path.join(cd, 'plan-ready.md'));
  const planPaths = planContent ? extractFilePaths(planContent) : [];
  const referenced = new Set([...declared.keys(), ...planPaths]);

  const hunks = diffHunks(cwd, config).filter((h) =>
    !isTestFilePath(h.file) && !isCrossRepoPath(cwd, h.file) && pathMatches([...referenced], h.file));

  const hunksByFile = new Map();
  for (const h of hunks) {
    if (!hunksByFile.has(h.file)) hunksByFile.set(h.file, []);
    hunksByFile.get(h.file).push(h);
  }

  // 本 diff 新增/改写的行区间：落在其中的方法声明 = 本次新增的方法，不可能"插错方法"
  const addedRangesByFile = new Map();
  function isAddedLine(file, line) {
    if (!addedRangesByFile.has(file)) {
      addedRangesByFile.set(file, (hunksByFile.get(file) || [])
        .map((h) => [h.newStart, h.newStart + Math.max(0, h.newCount) - 1]));
    }
    return addedRangesByFile.get(file).some(([s, e]) => e >= s && line >= s && line <= e);
  }

  // 声明目标在**同文件**的直接下游调用：实现落在入口的私有下游属正常分工，不算漂移
  const downstreamByFile = new Map();
  function declaredDownstream(file) {
    if (downstreamByFile.has(file)) return downstreamByFile.get(file);
    const absPath = path.join(cwd, file);
    const content = safeRead(absPath);
    const set = new Set();
    const names = declared.get(file);
    if (content && names) {
      const codeLines = stripSourceComments(content).split('\n');
      const decls = declaredMethods(absPath);
      for (const m of decls) {
        if (!names.has(m.name)) continue;
        const [s, e] = methodBodyRange(codeLines, decls, m);
        for (const c of methodCallees(codeLines, s, e)) set.add(c);
      }
    }
    downstreamByFile.set(file, set);
    return set;
  }

  // ① 归属漂移：按文件比对，不再跨文件靠方法名撞
  for (const h of hunks) {
    const names = declared.get(h.file);
    for (const cm of containingMethods(path.join(cwd, h.file), h.file, h)) {
      if (names && names.has(cm.name)) continue;
      if (isAddedLine(h.file, cm.line)) continue;
      if (declaredDownstream(h.file).has(cm.name)) continue;
      warnings.push(`改动点归属：${h.file} 的 ${cm.name}（第 ${cm.line} 行）未被任何改动点声明，但 diff 落点在此方法内（第 ${h.newStart} 行）——方法归属漂移，人工核对是否插错方法`);
    }
  }

  // ② 声称未落地：声明「随改」但该方法体内没有任何 hunk
  for (const t of followed) {
    const fileHunks = hunksByFile.get(t.file);
    if (!fileHunks || !fileHunks.length) {
      warnings.push(`声称未落地：改动点 ${t.num} 声明改 \`${t.selector}\`，但 ${t.file} 在本次变更中没有任何改动——未实现，或文件路径写错`);
      continue;
    }
    const absPath = path.join(cwd, t.file);
    const decls = declaredMethods(absPath);
    const target = decls.find((d) => d.name === t.method);
    if (!target) {
      warnings.push(`声称未落地：改动点 ${t.num} 声明的 \`${t.selector}\` 在 ${t.file} 里找不到该方法声明——方法名写错，或已被重命名/删除`);
      continue;
    }
    // 大 hunk（一次新增几百行）会覆盖多个方法：按行区间重叠判定落点
    const end = target.bodyEnd || target.line;
    const landed = fileHunks.some((h) =>
      h.newStart <= end && h.newStart + Math.max(1, h.newCount) - 1 >= target.line);
    if (!landed) {
      warnings.push(`声称未落地：改动点 ${t.num} 声明改 \`${t.selector}\`（${t.file}:${target.line}），但该文件有改动却没有任何落点在这个方法里——改动落在了别的方法，或该点未实现`);
    }
  }

  // ③ 完整性：同文件里声明目标的并行兄弟方法（New/Old/V2 后缀）未被声明
  for (const [file, names] of declared) {
    if (!hunksByFile.has(file)) continue;
    const absPath = path.join(cwd, file);
    const decls = declaredMethods(absPath);
    for (const d of decls) {
      if (names.has(d.name)) continue; // 已声明（含不随改的显式豁免）
      for (const declaredName of names) {
        const prefixDeclared = stripParallelSuffix(declaredName);
        const prefixD = stripParallelSuffix(d.name);
        const isSibling = (prefixDeclared !== null && prefixDeclared === d.name)
          || (prefixD !== null && prefixD === declaredName)
          || (prefixD !== null && prefixDeclared !== null && prefixD === prefixDeclared);
        if (!isSibling) continue;
        warnings.push(`改动点完整性：${file} 的 ${d.name} 与已声明的 ${declaredName} 是并行路径（同前缀兄弟方法），但没有任何改动点声明它——确认是「随改」还是「不随改」并写进 design`);
        break;
      }
    }
  }

  return [...new Set(warnings)];
}

// ---- 改动点逐条机械判定 ----
// 把每个改动点的声明变成机器可核验的行：声明的 `文件::方法` vs diff 实际落点。
// 判定依据是**行区间重叠**——声明目标的方法体内有 hunk = ✅，没有 = ⚠️（并给出实际落点方法）。
//
// 以前没有文件归属，只能从改动点正文抽「罕见标识符」当关键词、再嗅探哪个方法体里出现过它，
// 既要 stopword 表又要词频过滤，还会把同名方法认到别的文件去。声明式让这一整套启发式消失。

function changePointVerdicts(cwd, changeName, points, config) {
  const verdicts = [];
  if (!points.length) return verdicts;

  const cd = changeDir(cwd, changeName);
  const planContent = safeRead(path.join(cd, 'plan-ready.md'));
  const planPaths = planContent ? extractFilePaths(planContent) : [];
  const declared = declaredByFile(points);
  const referenced = new Set([...declared.keys(), ...planPaths]);

  const hunksByFile = new Map();
  for (const h of diffHunks(cwd, config)) {
    if (isTestFilePath(h.file) || isCrossRepoPath(cwd, h.file) || !pathMatches([...referenced], h.file)) continue;
    if (!hunksByFile.has(h.file)) hunksByFile.set(h.file, []);
    hunksByFile.get(h.file).push(h);
  }

  const declsCache = new Map();
  function declsOf(file) {
    if (!declsCache.has(file)) declsCache.set(file, declaredMethods(path.join(cwd, file)));
    return declsCache.get(file);
  }
  function overlaps(fileHunks, decl) {
    const end = decl.bodyEnd || decl.line;
    return fileHunks.some((h) => h.newStart <= end && h.newStart + Math.max(1, h.newCount) - 1 >= decl.line);
  }

  for (const p of points) {
    const details = [];
    for (const t of p.targets) {
      // 不随改是显式决定，不参与落地判定；理由留给人工核对
      if (!t.follow) {
        details.push({ target: t.selector, hit: true, actual: null, note: `不随改：${t.reason || '未写理由'}` });
        continue;
      }
      const fileHunks = hunksByFile.get(t.file) || [];
      const decls = declsOf(t.file);
      const decl = decls.find((d) => d.name === t.method);
      if (!decl) {
        details.push({ target: t.selector, hit: false, actual: null, note: '该文件里找不到此方法声明' });
        continue;
      }
      if (overlaps(fileHunks, decl)) {
        details.push({ target: t.selector, hit: true, actual: `${t.method}@${decl.line}` });
        continue;
      }
      // 没落在声明目标里 → 报出实际落在了哪个方法，这正是「改 A 结果改了 ANew」的信号
      let actual = null;
      for (const d of decls) {
        if (overlaps(fileHunks, d)) { actual = `${d.name}@${d.line}`; break; }
      }
      details.push({ target: t.selector, hit: false, actual });
    }
    if (!details.length) continue;
    verdicts.push({
      point: `改动点 ${p.num}`,
      title: p.title,
      claimed: p.targets.map((t) => t.selector),
      details,
      verdict: details.every((d) => d.hit) ? '✅' : '⚠️',
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
    path.join(cwd, '.agents/skills/writing-plans/SKILL.md'),
    path.join(home, '.agents/skills/writing-plans/SKILL.md'),
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
      : 'Install writing-plans in a client-recognized skill location.\n'
        + 'Claude Code: /plugin install superpowers@claude-plugins-official\n'
        + 'Codex/OpenCode compatible path: .agents/skills/writing-plans/SKILL.md',
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
    path.join(cwd, '.agents/skills/brainstorming/SKILL.md'),
    path.join(home, '.agents/skills/brainstorming/SKILL.md'),
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
