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
 *   check-proposal      — validate proposal.md format
 *   check-test-plan     — test-plan.md integrity
 *   check-cross-ref     — plan-ready ↔ test-plan cross-reference
 *   check-build-done    — build completion
 *   check-close-ready   — close pre-conditions
 *   check-amend-count   — amendment tracking
 *   check-writing-plans — writing-plans availability (no change name needed)
 *
 * Zero dependencies, pure Node 20+.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

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
    };
  }

  // Count test rows and statuses
  const lines = content.split('\n');
  let inTable = false, headerSkipped = false;
  let pass = 0, todo = 0, fail = 0, total = 0;

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
  }

  const issues = [];
  if (total === 0) issues.push({ type: 'empty', detail: 'No test rows found in table' });
  if (fail > 0) issues.push({ type: 'has_failures', detail: `${fail} test(s) marked FAIL` });

  return {
    pass: total > 0 && fail === 0,
    stats: { pass, todo, fail, total },
    issues,
    all_pass: total > 0 && pass === total,
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

// ---- check-close-ready ----

function checkCloseReady(cwd, changeName) {
  const propCheck = checkProposal(cwd, changeName);
  const bMarker = exists(path.join(cwd, '.openflow', 'building'));

  // Try openspec validate
  let openspecValid = null;
  let openspecError = null;
  try {
    execSync(`openspec validate ${changeName} --strict`, { cwd, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    openspecValid = true;
  } catch (e) {
    openspecValid = false;
    openspecError = e.stderr || e.message || 'openspec validate failed';
  }

  const blockers = [];
  if (!propCheck.pass) blockers.push('proposal format invalid');
  if (!openspecValid) blockers.push(`openspec validate failed: ${openspecError}`);
  if (bMarker) blockers.push('building marker still present (build phase not exited cleanly)');

  return {
    pass: blockers.length === 0,
    checks: {
      proposal_format: propCheck.pass,
      openspec_validate: openspecValid,
      building_marker_clean: !bMarker,
    },
    blockers,
  };
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

// ---- main ----

function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const changeName = args[1];

  // check-writing-plans doesn't need a change name
  if (subcommand === 'check-writing-plans') {
    process.stdout.write(JSON.stringify(checkWritingPlans(cwd), null, 2) + '\n');
    return;
  }

  if (!subcommand || !changeName) {
    process.stderr.write('Usage: openflow-gate.mjs <subcommand> <change-name>\n');
    process.stderr.write('Subcommands: check-proposal, check-test-plan, check-cross-ref, check-build-done, check-close-ready, check-amend-count, check-writing-plans\n');
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
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
      process.exit(1);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
