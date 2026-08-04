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
 *   check-amend-count     — amendment tracking
 *   check-writing-plans   — writing-plans availability
 *   check-brainstorming   — brainstorming availability
 *   check-test-framework  — detect language + test framework + command
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
    const testContent = safeRead(path.join(cwd, tf));
    if (!testContent) {
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
  ];

  for (const { file, lang, parse } of configs) {
    const content = safeRead(path.join(cwd, file));
    if (!content) continue;
    const result = parse(content);
    if (result) {
      // Detect test directory
      let testDir = null;
      const candidates = ['tests', '__tests__', 'test', 'spec', 'e2e'];
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
    hint: 'No test framework detected. Check package.json, pyproject.toml, go.mod, Cargo.toml, or Makefile.',
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

  if (!subcommand || !changeName) {
    process.stderr.write('Usage: openflow-gate.mjs <subcommand> <change-name>\n');
    process.stderr.write('Subcommands: check-proposal, check-test-plan, check-cross-ref, check-build-done, check-close-ready, check-amend-count, check-writing-plans, check-brainstorming, check-test-framework\n');
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
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
      process.exit(1);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
