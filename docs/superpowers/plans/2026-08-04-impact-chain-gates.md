# openflow「现状与影响面」链路追踪 + 收尾对账闸门 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 openflow 在设计阶段强制「改动点 × 生产链路」影响面调查（design.md 含「现状与影响面」章节），并在 close 闸门机械对账 verify-issues 与 design 文件表，把三个真实项目坑（uniqueKey 粒度、verify-issues 陈旧、design.md 漂移）拦截在设计/收尾阶段。

**Architecture:** 三层防线。① 设计阶段：spec.md/brainstorming.md/amend.md 提示词强制链路追踪 + design.md「现状与影响面」章节；② 路由层：detect.mjs 暴露 `unresolved_count`，test-plan 全 PASS 但 verify-issues 未解决 → 建议重跑 verify；③ 收尾闸门：gate.mjs 新增 `check-verify-issues` / `check-design-consistency` 两个子命令，并入 `check-close-ready` 硬阻塞。

**Tech Stack:** 纯 Node 20+ `.mjs`（零依赖，与 hooks 现有风格一致）、Markdown 模板（templates/）。

**设计文档：** `docs/superpowers/specs/2026-08-04-openflow-impact-chain-design.md`

## Global Constraints

- **零依赖**：所有 `.mjs` 脚本必须是纯 Node 20+，不引入 npm 包（沿用 CLAUDE.md「脚本零依赖」）。
- **用 pnpm 执行**：所有构建/运行命令走 `pnpm`（系统 PATH 的 node 是 v14，`pnpm node` 才是 Node 20+）。
- **不改 enforce.mjs / src/enforce/***：本次只动 `hooks/gate.mjs`、`hooks/detect.mjs`、`templates/*.md`。src/enforce 是 OpenCode 插件的 enforce 副本，与 gate/detect 无关。
- **不改 src/core/skill-generator.ts**：不新增 hook 文件，无需注册拷贝逻辑。
- **提交消息用中文**，前缀沿用仓库惯例（`feat(openflow):` / `docs(openflow):`），结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **验证走 CLAUDE.md 的 /tmp 流程**：`pnpm run build` → 在 `/tmp/test-openflow` 跑 `init --tools claude` → 用 `$N20` 执行脚本。

---

### Task 1: gate.mjs — 新增 `check-verify-issues` 子命令

**Files:**
- Modify: `hooks/gate.mjs`（新增函数区 + dispatch 分支 + 子命令注释列表）

**Interfaces:**
- Produces: `checkVerifyIssues(cwd, changeName)` → `{ pass: boolean, exists: boolean, unresolved_count: number, blockers: string[] }`。Task 3 的 `checkCloseReady` 消费 `blockers`。

**判定规则（写死在代码里，不靠 AI）：**
- `❌` = 阻挡项，`⚠️` = 警告；`✅` = 已解决条目
- 逐行状态机：`❌`/`⚠️` 开启一个条目，后续 `✅` 关闭**最近一个**未关闭条目（这样 `#1 ✅ 断言匹配 / #2 ⚠️ 未匹配` 里的 ✅ 只抵消 #1，不会误吞 #2）
- `unresolved_count =` 结束时仍未关闭的条目数

> 实现说明：初版「全局计数相减」（❌数−✅数）在真实格式下会双重消耗 resolver 而漏报（见场景 4）。改为逐行栈模型后四种场景全对。

- [ ] **Step 1: 在 `check-close-ready` 函数区之前新增函数**

在 [hooks/gate.mjs](hooks/gate.mjs) 的 `// ---- check-close-ready ----` 注释块之前插入：

```js
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
```

- [ ] **Step 2: 在 `main()` 的 switch 中加分支**

在 [hooks/gate.mjs](hooks/gate.mjs) `case 'check-amend-count':` 之后、`default:` 之前插入：

```js
    case 'check-verify-issues':
      result = checkVerifyIssues(cwd, changeName);
      break;
```

- [ ] **Step 3: 更新文件顶部子命令注释列表**

在 [hooks/gate.mjs](hooks/gate.mjs) 第 16 行 `*   check-close-ready     — close pre-conditions` 后插入：

```
 *   check-verify-issues   — verify-issues.md 未解决项检查
```

- [ ] **Step 4: 手动验证（构造 fixture 跑三个场景）**

```bash
FIX=/tmp/flowfix-vi && rm -rf "$FIX" && mkdir -p "$FIX/openspec/changes/demo" && cd "$FIX"
GATE=/home/hk/github/openflow/hooks/gate.mjs
N20=$(pnpm node -e 'process.stdout.write(process.execPath)')

# 场景 1：无 verify-issues.md → pass
"$N20" "$GATE" check-verify-issues demo

# 场景 2：未解决 ❌ + 已解决 ⚠️ → 阻塞 1 项
printf '#1 ❌ 测试 check stdout 但 scenario 要求 stderr\n#2 ⚠️ 覆盖不足\n#2 ✅ 已解决：已补测试\n' > openspec/changes/demo/verify-issues.md
"$N20" "$GATE" check-verify-issues demo

# 场景 3：全部已解决 → pass
printf '#1 ❌ 测试错误\n#1 ✅ 已修复\n#2 ⚠️ 覆盖不足\n#2 ✅ 通过\n' > openspec/changes/demo/verify-issues.md
"$N20" "$GATE" check-verify-issues demo
```

Expected：场景 1 `pass: true`、`exists: false`；场景 2 `pass: false`、`unresolved_count: 1`、blockers 含「1 个 verify 阻挡项（❌）未解决」；场景 3 `pass: true`、`unresolved_count: 0`。

（补充真实格式场景：`#1 ✅ 断言匹配 / #2 ⚠️ 未匹配` 应报 `unresolved_count: 1`、blockers 含「1 个 verify 警告（⚠️）未解决」——✅ 只抵消 #1，不误吞 #2。）

- [ ] **Step 5: Commit**

```bash
git add hooks/gate.mjs
git commit -m "feat(openflow): gate 新增 check-verify-issues——解析 verify-issues.md 未解决项

close 前置条件从 AI 声称变闸门实测，修复坑 2（verify-issues 陈旧）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: gate.mjs — 新增 `check-design-consistency` 子命令

**Files:**
- Modify: `hooks/gate.mjs`（新增 helper + 函数 + dispatch 分支）

**Interfaces:**
- Produces: `checkDesignConsistency(cwd, changeName)` → `{ pass: boolean, design_exists: boolean, design_file_count: number, blockers: string[] }`。Task 3 的 `checkCloseReady` 消费 `blockers`。

**判定规则：**
- design.md 不存在 → pass
- design.md 存在但缺 `## 现状与影响面` 章节 → blocker（「所有变更强制」）
- 提取 design.md 中**带确定性标签行**的文件路径（`[Verified]`/`[Inferred]`/`[Assumption`），与 plan-ready.md 的改动文件 + 未提交 git 变更对账：design 列出但两者都没有 → blocker；未提交变更改了但 design 未列出 → blocker

- [ ] **Step 1: 在 `check-verify-issues` 函数区后新增 helper + 函数**

在 [hooks/gate.mjs](hooks/gate.mjs) 的 `checkVerifyIssues` 函数之后插入：

```js
// ---- check-design-consistency ----

const FILE_PATH_RE = /[A-Za-z0-9_@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|py|go|java|rs|c|cc|cpp|h|hpp|kt|swift|sql|sh|yml|yaml|json|css|scss|html)\b/g;
const CERTAINTY_TAG_RE = /\[(?:Verified|Inferred|Assumption)/;

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

function gitChangedFiles(cwd) {
  try {
    const out = execSync('git diff --name-only; git diff --cached --name-only', { cwd, encoding: 'utf-8', stdio: 'pipe' });
    return [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function checkDesignConsistency(cwd, changeName) {
  const cd = changeDir(cwd, changeName);
  const designContent = safeRead(path.join(cd, 'design.md'));
  if (!designContent) {
    return { pass: true, design_exists: false, design_file_count: 0, blockers: [] };
  }
  const blockers = [];
  if (!designContent.includes('现状与影响面')) {
    blockers.push('design.md 缺少「现状与影响面」章节（spec 阶段必填）');
  }
  const designPaths = extractFilePaths(designContent);
  const planContent = safeRead(path.join(cd, 'plan-ready.md'));
  const planPaths = planContent ? extractFilePaths(planContent) : [];
  const gitPaths = gitChangedFiles(cwd);
  const changedSet = new Set([...planPaths, ...gitPaths]);
  for (const p of designPaths) {
    if (!changedSet.has(p)) {
      blockers.push(`design.md 列出 ${p}，但 plan-ready 改动文件 / 未提交变更中都没有它`);
    }
  }
  for (const p of gitPaths) {
    if (!designPaths.includes(p)) {
      blockers.push(`未提交变更改动了 ${p}，但 design.md 现状影响面未列出`);
    }
  }
  return { pass: blockers.length === 0, design_exists: true, design_file_count: designPaths.length, blockers };
}
```

- [ ] **Step 2: 在 `main()` 的 switch 中加分支**

在 Task 1 加的 `case 'check-verify-issues':` 之后插入：

```js
    case 'check-design-consistency':
      result = checkDesignConsistency(cwd, changeName);
      break;
```

- [ ] **Step 3: 更新文件顶部子命令注释列表**

在 Task 1 加的行后插入：

```
 *   check-design-consistency — design.md 文件表/现状影响面 vs plan-ready + git
```

- [ ] **Step 4: 手动验证（三个场景）**

```bash
FIX=/tmp/flowfix-dc && rm -rf "$FIX" && mkdir -p "$FIX/openspec/changes/demo" && cd "$FIX"
git init -q && touch src/base.py && mkdir -p src && printf 'x\n' > src/base.py
GATE=/home/hk/github/openflow/hooks/gate.mjs
N20=$(pnpm node -e 'process.stdout.write(process.execPath)')

# 场景 1：无 design.md → pass
"$N20" "$GATE" check-design-consistency demo

# 场景 2：design.md 缺「现状与影响面」章节 → 阻塞
printf '## Decisions\n- 保留 src/base.py [Verified]\n' > openspec/changes/demo/design.md
"$N20" "$GATE" check-design-consistency demo

# 场景 3：章节齐全 + 路径与 plan-ready 对账 → pass
printf '## 现状与影响面\n\n### 改动点\n- src/base.py [Verified]\n' > openspec/changes/demo/design.md
printf '### Task 1\n- 改动文件：src/base.py [Verified]\n' > openspec/changes/demo/plan-ready.md
"$N20" "$GATE" check-design-consistency demo

# 场景 4：design 列出但 plan-ready 没有 → 阻塞
printf '## 现状与影响面\n\n### 改动点\n- src/ghost.py [Verified]\n- src/base.py [Verified]\n' > openspec/changes/demo/design.md
"$N20" "$GATE" check-design-consistency demo
```

Expected：场景 1 `pass: true`；场景 2 `pass: false` blockers 含「缺少「现状与影响面」章节」；场景 3 `pass: true`；场景 4 `pass: false` blockers 含「design.md 列出 src/ghost.py」。

- [ ] **Step 5: Commit**

```bash
git add hooks/gate.mjs
git commit -m "feat(openflow): gate 新增 check-design-consistency——design 文件表 vs plan-ready + git 对账

设计决策与实现漂移在 close 前被机械拦截，修复坑 3

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: gate.mjs — 两个新检查并入 `check-close-ready`

**Files:**
- Modify: `hooks/gate.mjs`（`checkCloseReady` 函数 + 用法输出字符串）

**Interfaces:**
- Consumes: Task 1 `checkVerifyIssues().blockers`、Task 2 `checkDesignConsistency().blockers`
- Produces: `checkCloseReady` 的 `blockers` 现在含 verify-issues 与 design 一致性项；`checks` 对象新增 `verify_issues_resolved`、`design_consistent` 两个字段

- [ ] **Step 1: 修改 `checkCloseReady`**

将 [hooks/gate.mjs](hooks/gate.mjs) 的 `checkCloseReady`（当前第 275-304 行）改为：

```js
function checkCloseReady(cwd, changeName) {
  const propCheck = checkProposal(cwd, changeName);
  const bMarker = exists(path.join(cwd, '.openflow', 'building'));
  const verifyIssues = checkVerifyIssues(cwd, changeName);
  const designConsistency = checkDesignConsistency(cwd, changeName);

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
  blockers.push(...verifyIssues.blockers);
  blockers.push(...designConsistency.blockers);

  return {
    pass: blockers.length === 0,
    checks: {
      proposal_format: propCheck.pass,
      openspec_validate: openspecValid,
      building_marker_clean: !bMarker,
      verify_issues_resolved: verifyIssues.pass,
      design_consistent: designConsistency.pass,
    },
    blockers,
  };
}
```

- [ ] **Step 2: 更新用法输出字符串**

将 [hooks/gate.mjs](hooks/gate.mjs) 第 544 行改为：

```js
    process.stderr.write('Subcommands: check-proposal, check-test-plan, check-cross-ref, check-build-done, check-close-ready, check-amend-count, check-writing-plans, check-brainstorming, check-test-framework, check-verify-issues, check-design-consistency\n');
```

- [ ] **Step 3: 手动验证**

```bash
FIX=/tmp/flowfix-cc && rm -rf "$FIX" && mkdir -p "$FIX/openspec/changes/demo" && cd "$FIX"
git init -q && mkdir -p src && printf 'x\n' > src/base.py
GATE=/home/hk/github/openflow/hooks/gate.mjs
N20=$(pnpm node -e 'process.stdout.write(process.execPath)')
printf '## Why\n[需求描述]\n## What Changes\n- x\n' > openspec/changes/demo/proposal.md
printf '## 现状与影响面\n\n### 改动点\n- src/base.py [Verified]\n' > openspec/changes/demo/design.md
printf '### Task 1\n- 改动文件：src/base.py [Verified]\n' > openspec/changes/demo/plan-ready.md

# 场景 1：verify-issues 干净 + design 一致 → pass 只受 openspec validate 影响（无 openspec CLI 时 openspecValid=false）
"$N20" "$GATE" check-close-ready demo

# 场景 2：verify-issues 有未解决 → blockers 含 verify 项
printf '#1 ❌ 未解决\n' > openspec/changes/demo/verify-issues.md
"$N20" "$GATE" check-close-ready demo
```

Expected：场景 2 的 `blockers` 含「1 个 verify 阻挡项（❌）未解决」，`checks.verify_issues_resolved: false`。（场景 1 中 `openspec_validate` 可能为 false——那是环境无 openspec CLI 所致，非本次改动引入。）

- [ ] **Step 4: Commit**

```bash
git add hooks/gate.mjs
git commit -m "feat(openflow): check-close-ready 并入 verify-issues + design 一致性检查

close 前置条件升级为闸门实测：verify-issues 无未解决项、design.md 文件表与实现一致

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: detect.mjs — 暴露 `unresolved_count` + 路由拦截陈旧记录

**Files:**
- Modify: `hooks/detect.mjs`（`countVerifyUnresolved` helper + `collectVerifyIssues` + `detectContradictions` 的 verify_issues 描述 + `suggestPhase` 的 allPass 分支 + `human_summary`）

**Interfaces:**
- Consumes: 现有 `safeRead`/`exists` helper（已存在）
- Produces: `collectVerifyIssues()` 返回值新增 `unresolved_count` 字段；`suggestPhase` 在 test-plan 全 PASS 且 verify-issues 未解决时返回 `{ phase: 'verify', reason: 'verify_issues_unresolved', note }`

- [ ] **Step 1: 修改 `collectVerifyIssues` 及新增 helper**

将 [hooks/detect.mjs](hooks/detect.mjs) 第 207-215 行的 `collectVerifyIssues` 替换为：

```js
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
```

- [ ] **Step 2: 更新 `detectContradictions` 中 verify_issues 的描述**

将 [hooks/detect.mjs](hooks/detect.mjs) 第 285-286 行改为：

```js
    } else if (key === 'verify_issues') {
      desc = v && v.exists ? `verify_issues: exists${v.unresolved_count > 0 ? ` (${v.unresolved_count} unresolved)` : ''}` : null;
    }
```

- [ ] **Step 3: 更新 `suggestPhase` 的 allPass 分支**

将 [hooks/detect.mjs](hooks/detect.mjs) 第 365-367 行改为：

```js
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
```

- [ ] **Step 4: 更新 `human_summary`**

在 [hooks/detect.mjs](hooks/detect.mjs) 的 `primaryChange` 分支里、`if (git?.hasRelatedCommits) parts.push(...)` 之后插入：

```js
    const vi = signals.verify_issues?.value;
    if (vi?.exists && (vi.unresolved_count ?? 0) > 0) parts.push(`⚠️ verify-issues ${vi.unresolved_count} 项未解决`);
```

- [ ] **Step 5: 手动验证**

```bash
FIX=/tmp/flowfix-dt && rm -rf "$FIX" && mkdir -p "$FIX/openspec/changes/demo" "$FIX/src" && cd "$FIX"
DETECT=/home/hk/github/openflow/hooks/detect.mjs
N20=$(pnpm node -e 'process.stdout.write(process.execPath)')
printf 'x\n' > "$FIX/src/base.py"   # 仓库根目录，必须存在——否则 file_resolvability 否定信号触发铁律5矛盾，不路由
printf '| # | Requirement | Scenario | 测试文件 | 测试函数 | 状态 |\n|---|---|---|---|---|---|\n| #1 | REQ-1 | 场景A | tests/test_a.py | test_a | ✅ PASS |\n' > openspec/changes/demo/test-plan.md
printf '### Task 1: x\n- [x] task\n- 改动文件：src/base.py\n' > openspec/changes/demo/plan-ready.md   # 不加 [Verified] 后缀，避免 collectFileResolvability 吞后缀导致解析失败
printf '## 现状与影响面\n\n### 改动点\n- src/base.py [Verified]\n' > openspec/changes/demo/design.md
printf '#1 ❌ 未解决\n' > openspec/changes/demo/verify-issues.md

"$N20" "$DETECT"
```

Expected：`signals.verify_issues.value.unresolved_count === 1`，`suggestion_reason === 'verify_issues_unresolved'`，`human_summary` 含「⚠️ verify-issues 1 项未解决」。删除 verify-issues.md 再跑：`suggestion_reason === 'all_tests_pass'`。

- [ ] **Step 6: Commit**

```bash
git add hooks/detect.mjs
git commit -m "feat(openflow): detect 暴露 verify_issues.unresolved_count 并在路由层拦截陈旧记录

test-plan 全 PASS 但 verify-issues 未解决 → 建议重跑 verify 而非 close

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 设计阶段模板 — spec.md / brainstorming.md / amend.md 强制「现状与影响面」

**Files:**
- Modify: `templates/spec.md`（步骤 2 加「现状与影响面调查」+ design.md 必填章节）
- Modify: `templates/brainstorming.md`（步骤 1 加链路追踪）
- Modify: `templates/amend.md`（步骤 4 design.md 必须同步）

**Interfaces:**
- Consumes: 无（纯文档）
- Produces: 目标项目 AI 生成的 design.md 必须含 `## 现状与影响面` 章节——Task 2 的 `checkDesignConsistency` 依赖该章节存在

- [ ] **Step 1: spec.md 步骤 2 插入「现状与影响面调查」**

在 [templates/spec.md](templates/spec.md) 第 48 行（`如果找到相关的 lessons.md...` 段落后）与第 50 行（`做完以上检查后再进入第 3 步生成 OpenSpec 文件。`）之间插入：

```markdown
5. **现状与影响面调查（必做）**：列出本方案的**改动点**（入口/处理/副作用），对每个改动点沿**生产链路**逐跳追踪：
   - **上游/调用方**：谁调用它、传什么（`grep` 调用方或 trace_path inbound）
   - **下游/消费方**：结果流向哪里、谁消费（trace_path outbound / data_flow / cross_service，含跨服务/跨仓库）
   - **链路末端**：存储键/提交状态/通知/下游服务的**粒度与状态隔离性**——重点核对链路末端与改动点粒度是否一致（例如进页从整批改单任务，链路末端的 localStorage key 粒度是否跟着改）
   - **10 类 checklist 逐类排查**：查询/数据加载粒度、本地状态/缓存键、状态隔离/并发、数据流/副作用、接口契约、数据结构/存储格式、依赖/调用方、性能/资源、错误/边界处理、兼容/迁移
   - 结果写入 design.md 的「现状与影响面」章节，每条带 `[Verified]` 证据
```

然后紧接 `做完以上检查后再进入第 3 步生成 OpenSpec 文件。` 之后插入：

```markdown
**design.md 必填章节**：生成 design.md 时**必须**包含 `## 现状与影响面` 章节（改动点、生产链路影响表、10 类分类排查表）。缺失即视为设计未完成，close 闸门（check-design-consistency）会阻塞。
```

- [ ] **Step 2: brainstorming.md 步骤 1 加链路追踪**

在 [templates/brainstorming.md](templates/brainstorming.md) 第 41 行（`5. 检索沉淀经验...`）之后插入：

```markdown
6. **追踪改动点生产链路**：若需求涉及查询/进页粒度、批量、状态、数据流变化，先沿链路追踪改动点影响面（上游调用方、下游消费方、链路末端存储/提交状态）——方案取舍前就要知道改动点会碰什么，避免设计遗漏
```

- [ ] **Step 3: amend.md 步骤 4 design.md 必须同步**

将 [templates/amend.md](templates/amend.md) 第 85 行的 `- **design.md**：仅当技术方案变化时修改` 替换为：

```markdown
- **design.md**：**必须同步**——更新「现状与影响面」章节（改动点、链路影响、10 类排查）和改动文件表，新增/删除/修改的文件跟着改；若改动点粒度或生产链路变化，重跑链路追踪
```

- [ ] **Step 4: 验证模板文本**

```bash
grep -n "现状与影响面调查\|design.md 必填章节" templates/spec.md
grep -n "追踪改动点生产链路" templates/brainstorming.md
grep -n "必须同步" templates/amend.md
```

Expected：三处各命中 1 行。

- [ ] **Step 5: Commit**

```bash
git add templates/spec.md templates/brainstorming.md templates/amend.md
git commit -m "feat(openflow): 设计阶段强制「现状与影响面」——spec/brainstorming 加链路追踪、amend 强制同步 design.md

设计阶段拦截坑 1（改动点×生产链路影响，不只缓存键）与坑 3（文件表漂移）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 收尾模板 — verify.md / close.md / SKILL.md 对账闸门文档

**Files:**
- Modify: `templates/verify.md`（闸门 3 加文件表对账）
- Modify: `templates/close.md`（前置条件加 check-close-ready 实测）
- Modify: `templates/SKILL.md`（状态检测表 verify_issues 行 + 判定结果加陈旧记录规则）

**Interfaces:**
- Consumes: Task 1/2/3 的 gate 子命令（close.md 已调用 `check-close-ready`，无需改命令）
- Produces: 文档与机械闸门一致

- [ ] **Step 1: verify.md 闸门 3 加文件表/现状影响面对账**

在 [templates/verify.md](templates/verify.md) 第 55-57 行（`读取 design.md 的关键决策...` 列表）之后、第 65 行表格之前插入：

```markdown
- **「现状与影响面」/文件表对账**：design.md 中带 `[Verified]` 标记的文件路径 vs `git diff --name-only` 与实际代码——表里有但没改、或改了但不在表 → 文档漂移，退回 `/openflow amend` 同步
- **design.md 是否含「现状与影响面」章节**：缺失 → 退回 amend 补
```

- [ ] **Step 2: close.md 前置条件加 check-close-ready 实测**

将 [templates/close.md](templates/close.md) 第 22-25 行改为：

```markdown
- `/openflow verify` 已通过（测试全绿、覆盖率 100%、设计一致）
- `plan-ready.md` 和 `test-plan.md` 存在
- `check-close-ready` 通过：verify-issues.md 无未解决项、design.md 文件表与实现一致

不满足时提示：
> "请先完成 /openflow verify 验证（check-close-ready 会实测 verify-issues 与 design 一致性）。"
```

- [ ] **Step 3: SKILL.md 状态检测表 + 判定结果**

将 [templates/SKILL.md](templates/SKILL.md) 第 188 行的 `| verify_issues | verify-issues.md | medium | verify 阶段产物 |` 替换为：

```markdown
| verify_issues | verify-issues.md | medium | verify 阶段产物；unresolved_count 未解决项计数 |
```

在第 207 行（`- verify 已通过 → close 阶段`）之后追加：

```markdown
- **test-plan 全 PASS 但 verify-issues.md 仍有未解决项 → 建议「重跑 verify」而非 close**（记录陈旧）
```

- [ ] **Step 4: 验证模板文本**

```bash
grep -n "文件表对账\|现状与影响面」章节" templates/verify.md
grep -n "check-close-ready 通过" templates/close.md
grep -n "unresolved_count 未解决项计数\|重跑 verify」而非 close" templates/SKILL.md
```

Expected：各命中。

- [ ] **Step 5: Commit**

```bash
git add templates/verify.md templates/close.md templates/SKILL.md
git commit -m "docs(openflow): 收尾模板对齐对账闸门——verify 加文件表对账、close 前置条件实测、SKILL 加陈旧记录规则

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 全量验证（CLAUDE.md /tmp 流程）

**Files:**
- 无改动，纯验证

- [ ] **Step 1: 构建 + 完整 init 冒烟**

按 CLAUDE.md 的测试方式：

```bash
REPO=$(pwd)
N20=$(pnpm node -e 'process.stdout.write(process.execPath)')
pnpm run build \
  && rm -rf /tmp/test-openflow && mkdir -p /tmp/test-openflow \
  && cd /tmp/test-openflow \
  && echo "n" | "$N20" "$REPO"/bin/openflow.js init --tools claude \
  && "$N20" .claude/hooks/openflow-detect.mjs
```

Expected：`init` 成功，`detect` 输出合法 JSON（无活跃变更 → proposal）。

- [ ] **Step 2: 验证安装的 hook 含新子命令**

```bash
"$N20" /tmp/test-openflow/.claude/hooks/openflow-gate.mjs 2>&1 | head -2
grep -c "check-verify-issues\|check-design-consistency" /tmp/test-openflow/.claude/hooks/openflow-gate.mjs
```

Expected：用法输出含两个新子命令；grep 计数 ≥ 2。

- [ ] **Step 3: 验证安装的模板含新章节要求**

```bash
grep -l "现状与影响面" /tmp/test-openflow/.claude/skills/openflow/*.md
grep -c "现状与影响面" /tmp/test-openflow/.claude/skills/openflow/spec.md
```

Expected：spec.md（及 SKILL.md）含「现状与影响面」。

- [ ] **Step 4: 交叉验证 detect 路由（test-plan 全 PASS + verify-issues 未解决）**

```bash
cd /tmp/test-openflow
mkdir -p openspec/changes/demo
printf '| #1 | REQ-1 | 场景A | tests/test_a.py | test_a | ✅ PASS |\n' > openspec/changes/demo/test-plan.md
printf '### Task 1: x\n- [x] task\n- 改动文件：src/base.py [Verified]\n' > openspec/changes/demo/plan-ready.md
printf '## 现状与影响面\n\n### 改动点\n- src/base.py [Verified]\n' > openspec/changes/demo/design.md
printf '#1 ❌ 未解决\n' > openspec/changes/demo/verify-issues.md
"$N20" .claude/hooks/openflow-detect.mjs | grep -o '"suggestion_reason": "[^"]*"'
```

Expected：`"suggestion_reason": "verify_issues_unresolved"`。

- [ ] **Step 5: 无改动，无需 commit**

**Task 7 附注（验证时发现的既有 bug 及修复）：**

`detect.mjs collectFileResolvability` 在解析 plan-ready 真实格式 `- 改动文件：src/base.py [Verified]` 时会把 `[Verified]` 后缀吞进路径 → 找不到文件 → 触发「否定低可信信号 + ≥2 肯定信号」矛盾 → 路由被 `signal_contradiction` 遮蔽，Task 4 的 `verify_issues_unresolved` 在真实格式下不生效。已修复：提取路径时剥掉 `[Verified]`/`[Inferred]`/`[Assumption...]` 后缀（与 gate 的提取规则对齐）。这是 pre-existing bug，因与本次路由改进直接冲突而顺手修掉。

---

## Self-Review

**Spec coverage：**
- 「现状与影响面」章节（改动点/链路/10 类）→ Task 5（spec.md/brainstorming.md）+ Task 6（verify.md 对账）
- check-verify-issues（❌/⚠️ 解析，硬阻塞）→ Task 1 + Task 3（并入 check-close-ready）
- check-design-consistency（design 文件表 vs plan-ready + git，硬阻塞）→ Task 2 + Task 3
- detect 路由拦截陈旧 verify-issues → Task 4
- 全部硬阻塞 → Task 3 的 `blockers` 合并
- 验证方式（/tmp 流程）→ Task 7

**Placeholder scan：** 所有代码步骤含完整代码与断言；测试步骤含可运行命令。无 "TBD/TODO/appropriate handling" 类占位。

**Type consistency：** `checkVerifyIssues`/`checkDesignConsistency` 在 Task 1/2 定义、Task 3 消费，返回结构 `{ pass, blockers, ... }` 一致。`collectVerifyIssues` 新增 `unresolved_count`，Task 4 的 `suggestPhase`/`human_summary`/`detectContradictions` 均读取同一字段。

**已知取舍：** `check-design-consistency` 用「带确定性标签行」提取路径（`[Verified]`/`[Inferred]`/`[Assumption`），避免误抓现状影响面里"受影响但未修改"的只读文件；主对账源是 plan-ready.md（close 时 git 改动已提交、`git diff` 为空，plan-ready 是变更自身 ground truth）。这是对设计文档「git diff 对账」的增强，理由：纯 git 对账在 close 时（已提交）会完全失效。
