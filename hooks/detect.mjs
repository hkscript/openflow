#!/usr/bin/env node
/**
 * openflow-detect — state detection script
 *
 * Collects all signals about current workflow state, cross-validates
 * for contradictions, and outputs a JSON routing recommendation.
 *
 * Usage: node .claude/hooks/openflow-detect.mjs
 * Output: JSON to stdout
 *
 * Zero dependencies, pure Node 20+.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { validateVerifyReceipt } from './lifecycle-fingerprint.mjs';

// ---- phase state contract (mirrors src/enforce/rules.ts / hooks/enforce.mjs) ----

const PHASE_NAMES = new Set([
  'proposal', 'brainstorming', 'spec', 'amend', 'build', 'verify', 'close',
]);
const CHANGE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read and validate `.openflow/phase`.
 * @returns {{state: object|null, error: string|null}} — absent file = both null.
 */
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

  if (phase === 'build') {
    if (modeRaw === undefined) return { state: null, error: 'build 阶段缺少 mode' };
    if (modeRaw !== 'bootstrap' && modeRaw !== 'task-build') return { state: null, error: `非法 build mode: ${modeRaw}` };
    if (modeRaw === 'bootstrap') {
      if (taskRaw !== undefined) return { state: null, error: 'bootstrap 不允许携带 task' };
      return { state: { version: 1, change, phase, mode: 'bootstrap' }, error: null };
    }
    if (taskRaw === undefined) return { state: null, error: 'task-build 缺少 task' };
    if (!/^\d+$/.test(taskRaw)) return { state: null, error: `非法 task: ${taskRaw}` };
    return { state: { version: 1, change, phase, mode: 'task-build', task: taskRaw }, error: null };
  }

  if (modeRaw !== undefined || taskRaw !== undefined) {
    return { state: null, error: `非 build phase 不允许携带 mode/task: ${phase}` };
  }
  return { state: { version: 1, change, phase }, error: null };
}

// ---- helpers ----

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function dirList(dirPath) {
  try { return fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return []; }
}

function exists(p) {
  return fs.existsSync(p);
}

// ---- signal collectors ----

/**
 * Get active (non-archive) change directories.
 * Returns array of {name, path}.
 */
function collectActiveChanges(cwd) {
  const changesDir = path.join(cwd, 'openspec', 'changes');
  if (!exists(changesDir)) return [];
  const entries = dirList(changesDir);
  return entries
    .filter(e => e.isDirectory() && e.name !== 'archive')
    .map(e => ({ name: e.name, path: path.join(changesDir, e.name) }));
}

/**
 * Check if test-plan.md exists for a change and parse stats.
 * Returns null if no test-plan, otherwise {pass, todo, fail, total, allPass}.
 */
function collectTestPlanStats(changeDir) {
  const tpPath = path.join(changeDir, 'test-plan.md');
  const content = safeRead(tpPath);
  if (!content) return null;

  let pass = 0, todo = 0, fail = 0;

  // Count status markers in table rows. Common patterns:
  // ✅ PASS / ✅ / PASS
  // TODO / ❌ TODO / ⬜
  // FAIL / ❌ FAIL / ❌
  // Match a marker at the START of a table cell (`| ✅`), so we never
  // count "pass" inside words like bypass/passed. No `g` flag: a global
  // regex .test() keeps lastIndex across rows, silently skipping ~half
  // of them (one match sets lastIndex to end-of-line; a shorter next
  // line fails and resets before its marker is ever checked).
  const passRe = /\|\s*(?:✅|PASS\b)/i;
  const todoRe = /\|\s*(?:TODO\b|⬜|⏳)/i;
  const failRe = /\|\s*(?:❌|FAIL\b)/i;

  // Split by table rows (lines starting with | after the header)
  const lines = content.split('\n');
  let inTable = false;
  for (const line of lines) {
    // Table separator lines like |---| skip
    if (/^\|[-| ]+\|$/.test(line.trim())) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line.trim().startsWith('|')) { inTable = false; continue; }

    // Count statuses in this row
    if (passRe.test(line)) pass++;
    else if (failRe.test(line)) fail++;
    else if (todoRe.test(line)) todo++;
  }

  // If no status markers found, check for alternative patterns
  // (like separate status column, or per-row markers)
  if (pass === 0 && todo === 0 && fail === 0) {
    // Try counting row-by-row status columns
    for (const line of lines) {
      if (!line.trim().startsWith('|')) continue;
      if (/^\|[-| ]+\|$/.test(line.trim())) continue;
      // Assume last or second-to-last column has status
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      // Skip header
      if (cells[0] === '#' || cells[0] === '测试编号') continue;

      // If no explicit status marker, count rows as "unmarked"
      // This is a heuristic — assume unmarked = not started = todo
    }
    // If still nothing, count all data rows as potential tests
  }

  const total = pass + todo + fail;
  return { pass, todo, fail, total, allPass: total > 0 && todo === 0 && fail === 0 };
}

/**
 * Check if plan-ready.md exists and count [x]/[ ] tasks.
 */
function collectPlanReadyTasks(changeDir) {
  const prPath = path.join(changeDir, 'plan-ready.md');
  const content = safeRead(prPath);
  if (!content) return null;

  const done = (content.match(/\[x\]/gi) ?? []).length;
  const pending = (content.match(/\[ \]/g) ?? []).length;
  return { done, pending, total: done + pending, allDone: pending === 0 && done > 0 };
}

/**
 * Check if a Superpowers plan file exists for this change.
 */
function collectSuperpowersPlan(cwd, changeName) {
  const plansDir = path.join(cwd, 'docs', 'superpowers', 'plans');
  if (!exists(plansDir)) return null;
  const files = dirList(plansDir).filter(e => e.isFile() && e.name.endsWith('.md'));
  // Match by change name in filename (e.g., 2026-07-24-ml-measure-package-fill.md)
  const match = files.find(f => f.name.includes(changeName));
  return match ? path.join(plansDir, match.name) : null;
}

/**
 * Count git commits related to the change name.
 * Returns {count, hasCommits, recentMessages: [...]}
 */
function collectGitCommits(cwd, changeName) {
  try {
    const output = execSync('git log --oneline -30', { cwd, encoding: 'utf-8', timeout: 3000 });
    const lines = output.trim().split('\n').filter(Boolean);
    // Look for commits whose message or file changes relate to the change name
    // Simple heuristic: count commits, also look for keywords from change name
    const keywords = changeName.split('-').filter(k => k.length > 2);
    const related = lines.filter(line => {
      const lower = line.toLowerCase();
      return keywords.some(kw => lower.includes(kw));
    });
    return {
      totalRecent: lines.length,
      relatedCount: related.length,
      hasCommits: lines.length > 0,
      hasRelatedCommits: related.length > 0,
      recentMessages: lines.slice(0, 5),
    };
  } catch {
    return { totalRecent: 0, relatedCount: 0, hasCommits: false, hasRelatedCommits: false, recentMessages: [] };
  }
}

/**
 * Extract file paths from plan-ready.md's "改动文件" fields.
 * Returns {found: string[], missing: string[], total: number, allFound: boolean}.
 */
function collectFileResolvability(cwd, changeDir) {
  const prPath = path.join(changeDir, 'plan-ready.md');
  const content = safeRead(prPath);
  if (!content) return null;

  // Extract file paths from "改动文件" or "文件" fields
  // Patterns: `path/to/file.py`, src/path/File.java, etc.
  const pathRe = /(?:改动文件|文件|路径)[：:]\s*(.+)/gi;
  const filePaths = [];
  for (const m of content.matchAll(pathRe)) {
    const entries = m[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    for (const entry of entries) {
      // Extract backtick-quoted path or unquoted path-like string.
      // Strip trailing certainty tags (spec.md 格式：`路径 [Verified]` / `[Assumption: 需确认路径]`),
      // 否则 `src/base.py [Verified]` 会被当作字面路径，导致解析失败并触发矛盾遮蔽路由。
      const btMatch = entry.match(/`([^`]+)`/);
      const raw = (btMatch ? btMatch[1] : entry).replace(/\s*\[(?:Verified|Inferred|Assumption[^\]]*)\]\s*$/i, '').trim();
      // Filter to likely file paths (containing / or .extension)
      if (raw.includes('/') || /\.[a-z]{2,6}$/i.test(raw)) {
        filePaths.push(raw);
      }
    }
  }

  // Also look for paths in backticks following common patterns
  const allBacktickPaths = [...content.matchAll(/`([^`]+\.[a-z]{2,6})`/gi)].map(m => m[1]);
  for (const p of allBacktickPaths) {
    if (p.includes('/') && !filePaths.includes(p)) {
      filePaths.push(p);
    }
  }

  if (filePaths.length === 0) return null;

  const found = [];
  const missing = [];
  for (const fp of filePaths) {
    const abs = path.join(cwd, fp);
    if (exists(abs)) found.push(fp);
    else missing.push(fp);
  }

  return { found, missing, total: filePaths.length, allFound: missing.length === 0 };
}

/**
 * Count unresolved markers in verify-issues.md content.
 * 与 gate.mjs checkVerifyIssues 同一模型：❌/⚠️ 开启条目，后续 ✅ 关闭最近一个未关闭条目。
 */
function countVerifyUnresolved(content) {
  const stack = [];
  for (const line of content.split('\n')) {
    if (/❌/.test(line)) stack.push('hard');
    else if (/⚠️/.test(line)) stack.push('soft');
    if (/✅/.test(line) && stack.length > 0) stack.pop();
  }
  return stack.length;
}

/**
 * Check if verify-issues.md exists and count unresolved markers.
 */
function collectVerifyIssues(changeDir) {
  const viPath = path.join(changeDir, 'verify-issues.md');
  if (!exists(viPath)) return null;
  const content = safeRead(viPath);
  return {
    exists: true,
    path: viPath,
    hasContent: content ? content.length > 50 : false,
    unresolved_count: content ? countVerifyUnresolved(content) : 0,
  };
}

/**
 * Check if lessons.md exists.
 */
function collectLessons(changeDir) {
  const lPath = path.join(changeDir, 'lessons.md');
  return exists(lPath) ? { exists: true, path: lPath } : null;
}

// ---- contradiction detector ----

const RELIABILITY = {
  active_changes: 'high',
  phase_state: 'high',
  verify_receipt: 'high',
  test_plan: 'high',
  test_plan_stats: 'high',
  plan_ready: 'high',
  plan_ready_tasks: 'high',
  superpowers_plan: 'medium',
  git_commits: 'high',
  building_marker: 'high',
  file_resolvability: 'low',
  verify_issues: 'medium',
  lessons: 'low',
};

// Phase-state contradictions that must block automatic routing (a valid
// `.openflow/phase` overrides mtime selection, but a contradictory phase /
// marker / receipt state requires explicit user resolution).
const BLOCKING_PHASE_IDS = new Set([
  'phase-state-invalid',
  'phase-target-missing',
  'phase-target-archived',
  'bootstrap-production-conflict',
  'task-build-missing-artifacts',
  'marker-mismatch',
  'close-without-current-receipt',
]);

/**
 * Detect contradictions between `.openflow/phase`, the building marker, and the
 * active change's verify receipt. Structured entries carry an `id` so consumers
 * can distinguish blocking phase problems from advisory receipt staleness.
 */
function detectPhaseContradictions(cwd, phaseState, signals) {
  const out = [];
  const st = phaseState && phaseState.state;

  // Invalid / missing / archived phase target.
  if (!st) {
    if (phaseState && phaseState.error) {
      const err = phaseState.error;
      let id = 'phase-state-invalid';
      if (err.includes('已归档')) id = 'phase-target-archived';
      else if (err.includes('目录缺失')) id = 'phase-target-missing';
      out.push({
        id,
        phase: null,
        change: null,
        detail: err,
        resolution: '修复或清除 .openflow/phase 后再继续。',
        positive: [],
        negative: [`phase_state: ${err}`],
      });
    }
    return out;
  }

  const markerRaw = safeRead(path.join(cwd, '.openflow', 'building'));
  const markerChange = markerRaw ? markerRaw.trim() : '';
  const markerExists = markerRaw !== null;

  // Marker / phase change mismatch.
  if (markerExists && markerChange.length > 0 && markerChange !== st.change) {
    out.push({
      id: 'marker-mismatch',
      phase: st.phase,
      change: st.change,
      detail: `.openflow/building 指向 "${markerChange}"，与 phase change "${st.change}" 不一致`,
      resolution: '修正 .openflow/building 使 marker 与 phase change 一致。',
      positive: [],
      negative: [`building_marker: ${markerChange}`],
    });
  }

  // Build mode requirements.
  if (st.phase === 'build' && st.mode === 'bootstrap' && !markerExists) {
    out.push({
      id: 'bootstrap-production-conflict',
      phase: 'build',
      mode: 'bootstrap',
      change: st.change,
      detail: 'bootstrap 阶段缺少 .openflow/building marker，生产态与 build 上下文冲突',
      resolution: '进入 build/bootstrap 需先写入 .openflow/building。',
      positive: [],
      negative: ['building_marker: missing'],
    });
  }
  if (st.phase === 'build' && st.mode === 'task-build') {
    const missing = [];
    if (!markerExists) missing.push('.openflow/building marker');
    if (!exists(path.join(cwd, 'openspec', 'changes', st.change, 'test-plan.md'))) missing.push('test-plan.md');
    if (!exists(path.join(cwd, 'openspec', 'changes', st.change, 'plan-ready.md'))) missing.push('plan-ready.md');
    if (missing.length > 0) {
      out.push({
        id: 'task-build-missing-artifacts',
        phase: 'build',
        mode: 'task-build',
        change: st.change,
        detail: `task-build 缺少: ${missing.join(', ')}`,
        resolution: '补齐 marker / test-plan.md / plan-ready.md 后再继续。',
        positive: [],
        negative: missing.map((m) => `missing: ${m}`),
      });
    }
  }

  // Verify receipt contradictions.
  const receipt = signals.verify_receipt && signals.verify_receipt.value;
  if (receipt && receipt.pass === false) {
    const blockers = receipt.blockers || [];
    const isStale = blockers.some((b) => b.includes('stale'));
    const isMalformed = blockers.some((b) => b.includes('invalid') || b.includes('mismatch'));
    if (isStale) {
      out.push({
        id: 'receipt-stale',
        phase: st.phase,
        change: st.change,
        detail: `verify receipt 已过期: ${blockers.join(', ')}`,
        resolution: '重新运行 /openflow verify 刷新 receipt。',
        positive: [],
        negative: [`verify_receipt: ${blockers.join(', ')}`],
      });
    } else if (isMalformed) {
      out.push({
        id: 'receipt-malformed',
        phase: st.phase,
        change: st.change,
        detail: `verify receipt 格式非法: ${blockers.join(', ')}`,
        resolution: '修复或删除 verify-result.json 后重新 verify。',
        positive: [],
        negative: [`verify_receipt: ${blockers.join(', ')}`],
      });
    }
    if (st.phase === 'close') {
      out.push({
        id: 'close-without-current-receipt',
        phase: 'close',
        change: st.change,
        detail: 'close 阶段缺少当前有效的 verify receipt',
        resolution: '先运行 /openflow verify 获得当前 receipt 再 close。',
        positive: [],
        negative: [`verify_receipt: ${blockers.join(', ')}`],
      });
    }
  }

  return out;
}

function detectContradictions(signals, changeName) {
  const contradictions = [];

  // Collect signals by reliability
  const positiveHigh = [];
  const positiveMedium = [];
  const negativeLow = [];

  for (const [key, sig] of Object.entries(signals)) {
    if (!sig) continue;
    const rel = RELIABILITY[key] || 'medium';
    const v = sig.value; // unwrap the actual value

    // Skip null/undefined values
    if (v === null || v === undefined) continue;

    // Determine if this signal is "positive" or "negative"
    let isNegative = false;
    let desc = '';

    if (key === 'test_plan_stats' && v.allPass) {
      desc = `test_plan_stats: ${v.pass}/${v.total} PASS`;
    } else if (key === 'test_plan_stats' && !v.allPass) {
      isNegative = true;
      desc = `test_plan_stats: ${v.pass}/${v.total} PASS (${v.todo} TODO, ${v.fail} FAIL)`;
    } else if (key === 'git_commits' && v.hasRelatedCommits) {
      desc = `git_commits: ${v.relatedCount} related commits`;
    } else if (key === 'git_commits' && !v.hasRelatedCommits) {
      isNegative = true;
      desc = `git_commits: no related commits found`;
    } else if (key === 'plan_ready_tasks' && v.allDone) {
      desc = `plan_ready_tasks: ${v.done}/${v.total} done`;
    } else if (key === 'plan_ready_tasks' && !v.allDone) {
      isNegative = true;
      desc = `plan_ready_tasks: ${v.done}/${v.total} done (${v.pending} pending)`;
    } else if (key === 'superpowers_plan') {
      desc = 'superpowers_plan: exists';
    } else if (key === 'file_resolvability' && !v.allFound) {
      isNegative = true;
      desc = `file_resolvability: ${v.missing.length} file(s) not found (${v.missing.slice(0, 3).join(', ')})`;
    } else if (key === 'file_resolvability' && v.allFound) {
      desc = `file_resolvability: ${v.total}/${v.total} files found`;
    } else if (key === 'building_marker') {
      desc = v ? 'building_marker: exists' : 'building_marker: not present';
    } else if (key === 'verify_issues') {
      desc = v && v.exists ? `verify_issues: exists${v.unresolved_count > 0 ? ` (${v.unresolved_count} unresolved)` : ''}` : null;
    } else if (key === 'active_changes') {
      desc = `active_changes: ${Array.isArray(v) ? v.length : 0} change(s)`;
    } else {
      continue;
    }

    if (!desc) continue;

    if (isNegative) {
      if (rel === 'low') negativeLow.push(desc);
    } else {
      if (rel === 'high') positiveHigh.push(desc);
      else if (rel === 'medium') positiveMedium.push(desc);
    }
  }

  // Rule 1: reliability=low negative signal + ≥2 reliability≥medium positive signals
  if (negativeLow.length > 0 && (positiveHigh.length + positiveMedium.length) >= 2) {
    contradictions.push({
      positive: [...positiveHigh, ...positiveMedium],
      negative: negativeLow,
      resolution: `Negative signal(s) from LOW reliability source vs ${positiveHigh.length + positiveMedium.length} HIGH/MEDIUM positive signals. Likely cross-repo paths or stale markers.`,
    });
  }

  // Rule 3: all PASS + all done but building marker still exists → stale marker
  const tpStats = signals.test_plan_stats?.value;
  const prTasks = signals.plan_ready_tasks?.value;
  const bMarkerExists = signals.building_marker?.value;
  if (tpStats?.allPass && prTasks?.allDone && bMarkerExists) {
    contradictions.push({
      positive: ['test_plan_stats: all PASS', 'plan_ready_tasks: all done'],
      negative: ['building_marker: still exists'],
      resolution: 'Building marker exists but all tests pass and all tasks done. Stale marker — should be cleaned up.',
    });
  }

  // Rule 4: building marker exists but no test-plan → anomaly
  if (bMarkerExists && !signals.test_plan?.value) {
    contradictions.push({
      positive: [],
      negative: ['building_marker: exists', 'test_plan: missing'],
      resolution: 'Building marker exists but no test-plan found. Anomalous state — manual check recommended.',
    });
  }

  return contradictions;
}

// ---- phase suggester ----

function suggestPhase(signals, contradictions, changeCount, phaseState, receipt) {
  // Phase-first routing: a valid `.openflow/phase` is authoritative. A stale
  // receipt routes to `verify` when the phase is otherwise routable; a phase
  // explicitly set to `close` with a stale/missing receipt blocks auto-close.
  if (phaseState && phaseState.state) {
    const st = phaseState.state;

    // Blocking phase/marker contradictions → no automatic routing.
    const blocking = contradictions.filter((c) => c.id && BLOCKING_PHASE_IDS.has(c.id));
    if (blocking.length > 0) {
      return {
        phase: null,
        reason: 'phase_state_conflict',
        note: `phase/marker 状态矛盾: ${blocking.map((b) => b.id).join(', ')}，需用户确认`,
      };
    }

    // close phase requires a current verify receipt.
    if (st.phase === 'close') {
      if (receipt && receipt.pass === true) {
        return { phase: 'close', reason: 'phase_close_receipt_current' };
      }
      return {
        phase: null,
        reason: 'phase_close_without_receipt',
        note: 'close 阶段需要当前 verify receipt，请先重新 verify',
      };
    }

    // stale receipt routes to verify when the phase is otherwise routable.
    if (
      receipt
      && receipt.pass === false
      && Array.isArray(receipt.blockers)
      && receipt.blockers.some((b) => b.includes('stale'))
    ) {
      return { phase: 'verify', reason: 'receipt_stale', note: 'verify receipt 已过期，需重新 verify' };
    }

    // valid current receipt → close.
    if (receipt && receipt.pass === true) {
      return { phase: 'close', reason: 'receipt_current' };
    }

    // otherwise route to the declared phase.
    return { phase: st.phase, reason: 'phase_state' };
  }

  // Invalid / missing / archived phase target → contradiction already reported,
  // no automatic routing.
  if (phaseState && phaseState.error) {
    return { phase: null, reason: 'phase_state_invalid', note: phaseState.error };
  }

  // ---- phase absent: original signal-based heuristic (preserved) ----

  // If contradictions exist, don't auto-route
  if (contradictions.length > 0) {
    return { phase: null, reason: 'signal_contradiction', note: 'Signals contradict — requires user confirmation.' };
  }

  if (changeCount === 0) {
    return { phase: 'proposal', reason: 'no_active_changes' };
  }

  if (changeCount > 1) {
    return { phase: null, reason: 'multiple_changes', note: `${changeCount} active changes — user must choose.` };
  }

  // Single change
  const hasTestPlan = signals.test_plan?.value;
  if (!hasTestPlan) {
    return { phase: 'spec', reason: 'test_plan_missing' };
  }

  const tpStats = signals.test_plan_stats?.value;
  const prTasks = signals.plan_ready_tasks?.value;

  if (!tpStats) {
    return { phase: 'spec', reason: 'test_plan_unparseable' };
  }

  if (tpStats.allPass) {
    const vi = signals.verify_issues?.value;
    if (vi?.exists && (vi.unresolved_count ?? 0) > 0) {
      return {
        phase: 'verify',
        reason: 'verify_issues_unresolved',
        note: `verify-issues.md 仍有 ${vi.unresolved_count} 项未解决，需重跑 /openflow verify 更新记录`,
      };
    }
    return { phase: 'verify', reason: 'all_tests_pass' };
  }

  if (tpStats.pass > 0 || prTasks?.done > 0) {
    return { phase: 'build', reason: 'implementation_in_progress', note: `${tpStats.pass}/${tpStats.total} PASS, ${prTasks?.done ?? 0}/${prTasks?.total ?? '?'} tasks done.` };
  }

  return { phase: 'build', reason: 'implementation_not_started', note: '0 tests pass, ready to start.' };
}

// ---- main ----

function main() {
  const cwd = process.cwd();
  const changes = collectActiveChanges(cwd);

  // Read and validate `.openflow/phase`.
  const phaseState = readPhaseState(cwd);

  // Build signal structure
  const signals = {
    active_changes: { value: changes.map(c => c.name), reliability: 'high' },
    phase_state: { value: phaseState.state, error: phaseState.error, reliability: 'high' },
    verify_receipt: { value: null, reliability: 'high' },
    test_plan: null,
    test_plan_stats: null,
    plan_ready: null,
    plan_ready_tasks: null,
    superpowers_plan: null,
    git_commits: null,
    building_marker: { value: exists(path.join(cwd, '.openflow', 'building')), reliability: 'high' },
    file_resolvability: null,
    verify_issues: null,
    lessons: null,
  };

  // Phase-first selection: a valid phase names an active change and wins over
  // mtime-derived candidates.
  let primaryChange = null;
  if (phaseState.state) {
    primaryChange = changes.find((c) => c.name === phaseState.state.change) || null;
  }
  if (!primaryChange) {
    if (changes.length === 1) {
      primaryChange = changes[0];
    } else if (changes.length > 1) {
      // Try to find the most recently modified change
      let latest = null;
      let latestTime = 0;
      for (const c of changes) {
        try {
          const stat = fs.statSync(c.path);
          if (stat.mtimeMs > latestTime) {
            latestTime = stat.mtimeMs;
            latest = c;
          }
        } catch {}
      }
      primaryChange = latest;
    }
  }

  if (primaryChange) {
    const cd = primaryChange.path;
    signals.test_plan = { value: exists(path.join(cd, 'test-plan.md')), reliability: 'high' };
    signals.plan_ready = { value: exists(path.join(cd, 'plan-ready.md')), reliability: 'high' };

    if (signals.test_plan.value) {
      signals.test_plan_stats = { value: collectTestPlanStats(cd), reliability: 'high' };
    }
    if (signals.plan_ready.value) {
      signals.plan_ready_tasks = { value: collectPlanReadyTasks(cd), reliability: 'high' };
      signals.file_resolvability = { value: collectFileResolvability(cwd, cd), reliability: 'low' };
    }

    signals.superpowers_plan = {
      value: collectSuperpowersPlan(cwd, primaryChange.name),
      reliability: 'medium',
    };
    signals.git_commits = {
      value: collectGitCommits(cwd, primaryChange.name),
      reliability: 'high',
    };
    signals.verify_issues = { value: collectVerifyIssues(cd), reliability: 'medium' };
    signals.lessons = { value: collectLessons(cd), reliability: 'low' };

    signals.verify_receipt = {
      value: validateVerifyReceipt(cwd, primaryChange.name),
      reliability: 'high',
    };
  }

  // Detect contradictions (signal-based + phase/marker/receipt based)
  const contradictions = detectContradictions(signals, primaryChange?.name ?? '');
  contradictions.push(...detectPhaseContradictions(cwd, phaseState, signals));

  // Suggest phase
  const suggestion = suggestPhase(
    signals,
    contradictions,
    changes.length,
    phaseState,
    signals.verify_receipt?.value
  );

  // Build human summary
  let humanSummary = '';
  const st = phaseState.state;
  if (st) {
    const parts = [`phase ${st.phase}${st.mode ? `/${st.mode}` : ''} @ ${st.change}`];
    const rv = signals.verify_receipt?.value;
    if (rv && rv.pass) parts.push('receipt 有效');
    else if (rv) parts.push('无有效 receipt');
    if (contradictions.length > 0) parts.push(`⚠️ ${contradictions.length} 项矛盾，需确认`);
    else parts.push(`建议 ${suggestion.phase}`);
    humanSummary = parts.join(', ') + '。';
  } else if (changes.length === 0) {
    humanSummary = '无活跃变更。建议 proposal 阶段。';
  } else if (changes.length > 1) {
    humanSummary = `${changes.length} 个活跃变更: ${changes.map(c => c.name).join(', ')}。请选择要操作的变更。`;
  } else if (primaryChange) {
    const tp = signals.test_plan_stats?.value;
    const pr = signals.plan_ready_tasks?.value;
    const git = signals.git_commits?.value;
    const parts = [`变更 ${primaryChange.name}`];
    if (tp) parts.push(`${tp.pass}/${tp.total} PASS`);
    if (pr) parts.push(`${pr.done}/${pr.total} tasks [x]`);
    if (git?.hasRelatedCommits) parts.push(`${git.relatedCount} git commits`);
    const vi = signals.verify_issues?.value;
    if (vi?.exists && (vi.unresolved_count ?? 0) > 0) parts.push(`⚠️ verify-issues ${vi.unresolved_count} 项未解决`);
    if (contradictions.length > 0) parts.push('⚠️ 信号矛盾，需确认');
    else parts.push(`建议 ${suggestion.phase}`);
    humanSummary = parts.join(', ') + '。';
  }

  // Available phases
  const allPhases = ['proposal', 'brainstorming', 'spec', 'amend', 'build', 'verify', 'close'];
  let availablePhases = [...allPhases];
  if (changes.length === 0) {
    availablePhases = ['proposal', 'brainstorming'];
  }

  // Output
  const result = {
    change_name: primaryChange?.name ?? null,
    change_count: changes.length,
    changes: changes.map(c => c.name),
    signals: Object.fromEntries(
      Object.entries(signals).map(([k, v]) => [k, v ?? { value: null, reliability: RELIABILITY[k] || 'medium' }])
    ),
    contradictions,
    suggested_phase: suggestion.phase,
    suggestion_reason: suggestion.reason,
    suggestion_note: suggestion.note ?? null,
    available_phases: availablePhases,
    human_summary: humanSummary,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
