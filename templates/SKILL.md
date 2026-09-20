---
name: openflow
description: "OpenSpec + Superpowers workflow orchestrator. Bridges requirements and implementation via test-first traceability: scenarios → test stubs → TDD → passing tests = requirements met. Use /openflow proposal for quick capture, /openflow brainstorming for deep design, /openflow spec to generate specs + test-plan.md + plan-ready.md, /openflow amend to revise requirements with test impact analysis, /openflow build to execute with TDD, /openflow verify as gate before close, /openflow close to compound lessons and archive."
---

# openflow - 工作流协调器

根据用户调用的子命令和项目当前状态，路由到对应阶段。

## 触发方式

**两种触发方式等效**：

| 方式 | 示例 | 说明 |
|------|------|------|
| 空格分隔 | `/openflow proposal` | 主 skill 触发，AI 读取主 SKILL.md + 子命令参考文件 |
| 连字符快捷 | `/openflow-proposal` | 子 skill 触发，AI 读取子 skill 的 SKILL.md（内含 redirect 到主 SKILL.md） |

两种方式都会加载主协调器的完整逻辑（状态检测、前置条件、续接规则），确保协调能力不丢失。

## 反幻觉铁律

**所有阶段都必须遵守的五条铁律。** 违反了这些，OpenSpec 和 Superpowers 的流程再严谨也没用——因为输入本身就是编的。

### 铁律 1：未读不用（No-Read-No-Use）

引用任何文件路径、函数名、类名、API 端点、环境变量之前，**必须能用 grep/Read 证明它真的存在**。

- 在 design.md 写 "使用 `src/utils/cache.py` 中的 LRU 缓存" → 先 `grep "cache\|lru" src/` 确认
- 在 plan-ready.md 写 "改动文件：`src/auth/login.py`" → 先 `ls` 或 `grep` 确认路径存在
- 在 test-plan.md 写测试文件路径 → 先检查项目测试目录结构

如果 grep 返回 0 结果，**必须说 "X 不存在" 而不是假设它存在**。

### 铁律 2：不确定就说（Certainty Tags）

每一条技术判断必须标注确定性：

| 标签 | 含义 | 示例 |
|------|------|------|
| `[Verified]` | 通过 grep/Read 确认过 | `[Verified] src/auth/login.py:42 使用了 bcrypt` |
| `[Inferred]` | 从现有代码逻辑推导 | `[Inferred] 根据 config.py 的模式，新配置应放在 config/auth.py` |
| `[Assumption]` | 基于常识推测，未验证 | `[Assumption] pytest 已安装在开发环境` |
| `[Unknown]` | 无法确定，需要用户输入 | `[Unknown] 项目用的是哪个 ORM？` |

`[Assumption]` 和 `[Unknown]` 标签的条目是**高风险区**——在 build 阶段执行前必须尽可能消解。

### 铁律 3：反对自己（Devil's Advocate）

在以下节点，必须先提出最强反方论点再继续：
- 确认设计方案前（brainstorming/spec）：**"这个方案最大的风险是什么？什么情况下会失败？"**
- 用户说"就这样做"时（proposal）：**"有没有可能是另一种情况？"**
- 测试全部通过时（close）：**"有没有可能测试覆盖了错误的场景？"**

### 铁律 4：重复即错误（Sunk-Cost Detector）

同一个问题尝试了 2 次还没解决：
- 第 3 次尝试**必须换一种完全不同的方法**
- 不能只是微调参数或换措辞重试
- 先退一步质疑自己的假设：**"我对这个问题的理解有没有可能从根上就错了？"**

### 铁律 5：否定即暂停（Negative-Means-Pause）

当某个检查返回"不存在/未找到"但其他 ≥2 个独立信号返回"存在/已完成"时：
- **禁止**基于单点否定直接跳到结论
- **必须**列出所有矛盾的信号源（形成信号矩阵）
- **必须**暂停并用 AskUserQuestion 让用户确认实际状态

"找不到文件"不能直接等于"代码没写"——可能是跨仓库引用、路径写错、或文件在非标准位置。

典型误判场景：
- test-plan.md 全 PASS 但某测试文件磁盘上找不到 → 可能是跨仓库路径
- git log 有实现 commit 但 plan 文件不存在 → 可能是手动实现（没走 superpowers）
- plan-ready.md 列出的文件在当前工作区找不到 → 路径写错或跨仓库

## 核心设计理念

```
                        ┌── Compound 闭环 ──────────────────────┐
                        │                                        │
OpenSpec scenarios ──→ test-plan.md (场景→测试映射) ──→ Superpowers TDD 执行
       ↑                                                       │
       │                                                       ↓
       ├──── verify: 测试闸门 + 覆盖率 + 设计一致性 ─────────────┤
       │                                                       │
       └──────────── close: lessons.md + archive ───────────────┘
                  (下次 proposal/spec 自动检索)
```

**test-plan.md 是执行期桥梁**（scenario → TDD），**lessons.md 是积累期桥梁**（让每次变更产生复利）。这也是 openflow 让 OpenSpec 和 Superpowers 产生真正互补的关键：测试确保当前变更正确，经验积累确保下次变更更快。

## 关键产物

| 产物 | 生成阶段 | 作用 |
|------|----------|------|
| `proposal.md` | proposal / brainstorming | 需求描述 |
| `design.md` | spec | 技术方案 |
| `specs/*.md` | spec | 结构化规格（requirement + scenario） |
| `tasks.md` | close (自动派生) | OpenSpec 格式约定，从 plan-ready.md 一行 grep+sed 生成 |
| **`test-plan.md`** | **spec** | **场景→测试映射表（执行期桥梁）** |
| `plan-ready.md` | spec | 实现计划（每 task 绑定测试编号） |
| `docs/superpowers/plans/*.md` | build | Superpowers 详细执行计划 |
| **`lessons.md`** | **close** | **经验记录（积累期桥梁，Compound 闭环）** |

## 续接与中断恢复

如果本轮没有显式 `/openflow ...` 子命令，但上一轮已经进入 openflow 任一阶段，并且用户是在补充范围、回答确认问题、说"继续"、修正需求、或说明新增/移除边界：

1. 默认继续上一 openflow 阶段，不把该回复当作普通编码请求
2. 如果上一阶段是 proposal、brainstorming、spec 或 amend，只能继续产出/更新文档，不得修改任何代码或实现文件
3. 如果上一阶段是 build，但用户补充的是需求、验收条件或规格边界变更，切到 `/openflow amend`，不要直接改代码
4. 只有用户显式调用 `/openflow build`，或状态检测明确进入 build 阶段后，才允许修改代码或实现文件
5. 中断后恢复时，先重新读取当前阶段文件、`openspec/changes/` 状态和 `test-plan.md`，再继续执行

**close 阶段不可自动续接**：
- close 是归档操作，不可逆，归档后变更就结束了
- **close 阶段中断后，必须等待用户显式调用 `/openflow close` 才能继续**
- 不能因为用户说"继续"或任何其他回复而自动进入 close 阶段
- 如果上一轮在 close 阶段中断，本轮应按状态检测结果路由（可能回到 verify 或其他阶段），或弹出阶段选择让用户确认

## 阶段写入边界（提示词 + Hook 双重保障）

以下写入规则有**两道防线**：
1. **提示词层面**：AI 按要求自我约束
2. **Hook 层面**：`openflow init` 安装的 PreToolUse hook 会在 Edit/Write 时自动拦截违规操作

已安装的 enforcement 产物（Claude hook / OpenCode plugin，路径随客户端安装自动替换）会拦截：编造不存在的文件路径、build 阶段修改规格文档。非阻断性警告：plan-ready.md 中出现 [Assumption] 标签、tasks.md 需要同步。

| 阶段 | 允许写入 | 禁止写入 |
|------|----------|----------|
| proposal | `openspec/changes/**/proposal.md` | 任何代码或实现文件 |
| brainstorming | `openspec/changes/**/proposal.md` | 任何代码或实现文件 |
| spec | `openspec/changes/**`、`test-plan.md`、`plan-ready.md` | 任何代码或实现文件 |
| amend | `openspec/changes/**`、`test-plan.md`、`plan-ready.md`、`docs/superpowers/plans/*.md` | 代码、测试、其他实现文件 |
| build | 代码、测试、实现计划状态 | 规格文档（除非另开变更） |
| verify | 验证记录、`verify-issues.md` | 代码、测试、规格文档 |
| close | 归档、`lessons.md` | 代码、测试、其它实现文件 |

## 阶段状态（`.openflow/phase`）

每个 openflow 阶段都要把当前阶段状态写入 `.openflow/phase`（UTF-8 JSON）。这是**路由声明**，不是授权凭证。格式：

```bash
# 非 build 阶段（proposal / brainstorming / spec / amend / verify / close）：不带 mode/task
printf '%s\n' '{"version":1,"change":"<变更名>","phase":"<phase>"}' > .openflow/phase
```

build 阶段有两种受控模式，必须显式写入 `mode`：

```bash
# bootstrap：进入 build，只允许写 test-plan.md 声明的测试选择器 + 有限的任务声明框架配置
printf '%s\n' '{"version":1,"change":"<变更名>","phase":"build","mode":"bootstrap"}' > .openflow/phase
printf '%s\n' '<变更名>' > .openflow/building

# task-build：进入具体任务，只允许改该任务声明的实现文件/测试选择器，TDD 校验针对当前任务
printf '%s\n' '{"version":1,"change":"<变更名>","phase":"build","mode":"task-build","task":"1"}' > .openflow/phase
```

规则：

- `.openflow/building` 是生命周期上下文标记，仅 build 阶段创建；amend 可保留它（build 续接）；`archive-verified` 通过后才清理
- 非 build 阶段**不允许携带 `mode`/`task`**；build 必须有 `mode`；`task-build` 必须有数字 `task`
- phase 指向缺失或已归档的 change 时视为无效，除修复 `.openflow/phase` 外禁止写入
- 测试计划每行给出稳定 ID `T-001` 与确定性选择器（`tests/auth/test_login.py::test_login_with_valid_credentials`）；plan-ready 任务绑定同一稳定 ID（`Test cases: T-001`）
- **test-plan 稳定行是可选的带状态语法**：`T-001: \`<测试文件>::<测试函数>\``（可加后缀 `🔴 RED` / `✅ PASS` / `⬜ TODO` / `❌ FAIL`）。enforcement / Gate / detect 都解析同一语法；build 更新状态只在行尾追加后缀，不改选择器
- **`✅ PASS` 必须同时带 `🔴 RED`**：RED 是 build Step 2「见过它失败」的凭据，缺了 gate 判 `red_evidence_missing`、detect 路由回 build。没见过红的测试不证明任何事——只钉负空间的断言（`never()`/`assertNull`/"不抛异常"）在实现前就是绿的，零副作用的回归照样让它绿
- **不变量行 `INV-001: \`<选择器>\` covers T-003, T-007`**：跨组合的正向不变量，与 T 行同权（要被 task 引用、要有 RED）。守卫/状态机改动必写——`1 scenario = 1 test` 只覆盖写下来的那几格，组合空白格正是回归藏身处
- 迁移期旧的唯一 `#N` 引用可临时使用，但下次 spec/amend 编辑时必须转为稳定 ID；混合 / 重复 / 歧义引用会 fail-closed 报错

## 客户端支持（生命周期运行时）

openflow 只支持能运行强制层的客户端：**Claude Code、Codex、OpenCode**。每个客户端都装完整生命周期运行时——enforcement、gate、detect、receipt、archive 一个不少。Cursor 没有 hook/plugin 机制，无法运行强制层，因此**不支持**，`openflow init --tools cursor` 会直接报错退出。

**没有降级模式。** 如果 gate/detect 脚本找不到、或运行报错，说明安装损坏或版本不匹配——**立即停止当前阶段并告知用户重装**，不要改用手动检查凑合过去：

> "❌ 找不到 `<path>/openflow-gate.mjs`（或执行失败）。openflow 的阶段闸门依赖它，没有它无法保证规格与实现一致。请重新安装：`openflow init --tools <客户端>`，然后重试。"

手动 grep 替代不了闸门：它不校验 receipt 指纹、不做改动点归属对账、不阻断越界写入。用手动检查"通过"一个阶段，等于把未验证的改动当成已验证——这正是 openflow 要消灭的失败模式。

## 子命令路由（必须读取对应参考文件）

**当用户调用 `/openflow <子命令>` 时，必须先读取对应的参考文件，然后按其中的指令执行。**

| 命令 | 参考文件 | 关键提示 |
|------|----------|----------|
| `/openflow proposal` | `proposal.md` | 轻量提问，快速收敛需求 |
| `/openflow brainstorming` | `brainstorming.md` | Superpowers 深度探索 + openflow 格式化写入 |
| `/openflow spec` | `spec.md` | OpenSpec 生成规格 + test-plan.md + plan-ready.md |
| `/openflow amend` | `amend.md` | 受控修订需求，含测试影响分析 |
| `/openflow build` | `build.md` | 测试桩生成 → TDD 执行 |
| `/openflow verify` | `verify.md` | 验证闸门：全量测试 + 覆盖率 |
| `/openflow close` | `close.md` | **⚠️ 必须使用 `archive-verified <变更名>`，禁止使用 mv 或原始 `openspec archive` 命令** |

**归档铁律**：`/openflow close` 的归档步骤**必须**使用 `archive-verified <变更名>` 命令（gate 子命令），不能使用 `mv` 或原始 `openspec archive` 绕过。原因：
- `archive-verified` 会在归档前**立即复核 verify receipt**（`check-verify-ready`），receipt 过期/缺失则拒绝归档
- 通过注入 runner 调用 OpenSpec 归档并校验：源目录移除、恰好一个新归档目录、`tasks.md`/`lessons.md`/`verify-result.json` 保留
- 全部校验通过后才清理 `.openflow/phase` 与 `.openflow/building`
- 使用 `mv` 或原始 `openspec archive` 会导致无验证归档、规格不更新、归档格式错误——`archive-verified` 失败必须修复后重新 verify，不能绕过

## 当前工作区

**必须先确认主项目**——所有 OpenSpec 规格文件和 `openspec/changes/` 必须在主项目中。

## 状态检测

当用户调用 `/openflow` 不带子命令，或调用某个子命令需要确认前置条件时，**先运行状态检测脚本**：

### Helpers 定位（先验证，再运行）

主 SKILL.md 与 helpers 安装在同一个**安装根 `<base>`** 下，但 skills 与 hooks 的目录名可以不同（如 Codex：skills 在 `.agents/skills`、hooks 在 `.codex/hooks`），**不要用"把 `skills/openflow/SKILL.md` 替换成 `hooks/…`"这类字符串替换推导路径**：

- 本文件：`<base>/.claude/skills/openflow/SKILL.md`
- helpers 目录：`<base>/.claude/hooks/`（`openflow-detect.mjs`、`openflow-gate.mjs` 等）

`<base>` 由**你实际读取的本文件绝对路径**决定：全局安装为 `~`，项目安装为项目根目录——**不是 shell 当前目录**。运行前先用 `ls` 确认文件存在（铁律 1）：

```bash
# 项目本地安装：<base> = 项目根
node <base>/.claude/hooks/openflow-detect.mjs
# 全局安装：<base> = ~
ls ~/.claude/hooks/openflow-detect.mjs && node ~/.claude/hooks/openflow-detect.mjs
```

以上位置都没有该脚本时，**停止并要求用户重装**（见「客户端支持」），不要臆造路径、也不要改用手动检查继续。

脚本输出 JSON：每个信号自带 `reliability`（high/medium/low），交叉验证规则写死在脚本里，不依赖 AI 推理。**你只需遵守两条**：

1. **`contradictions` 非空** → 不同信号源给出相反结论。禁止基于单点否定跳到结论，必须展示信号矩阵并用 AskUserQuestion 让用户确认。
2. **`contradictions` 为空** → 按 `suggested_phase` 路由。

不要在 JSON 之外自行推断状态——脚本看到的信号比你多（git log、building 标记、receipt 指纹）。

`suggested_phase` 的取值含义：
- **信号矛盾**（contradictions 非空）→ 展示信号矩阵 + AskUserQuestion 确认，不自动路由
- 无活跃变更 → proposal 阶段
- **有 2+ 个活跃变更 → 列出所有变更让用户选择，然后根据选中变更的状态继续路由**
- 有 1 个活跃变更但无 test-plan.md → spec 阶段（补生成）
- 有 test-plan.md 但实现未开始 → build 阶段
- 实现进行中（部分测试 PASS） → 继续 build 阶段（断点恢复）
- 实现已完成（所有测试 PASS） → verify 阶段
- verify 已通过 → close 阶段
- **test-plan 全 PASS 但 verify-issues.md 仍有未解决项 → 建议「重跑 verify」而非 close**（记录陈旧）

## 路由

根据子命令或状态检测结果，**先读取对应阶段文件**，然后执行：

1. 如果这是上一 openflow 阶段的续接回复，先按"续接与中断恢复"保持阶段
2. 如果用户在 build 中明确提出需求变更、补充 spec、修改验收条件或重新生成规格，路由到 amend
3. **如果用户指定了子命令（如 `/openflow close`）：**
   - **先读取对应的参考文件（见上方"子命令路由"表格）**
   - 检查前置条件，通过后按参考文件指令执行
4. **如果用户只输入 `/openflow` 不带子命令：执行状态检测，展示结果，弹出确认让用户选择，不自动进入任何阶段**

**执行子命令的标准流程：**
```
用户输入: /openflow close
      ↓
1. 读取 close.md（包含完整指令）
      ↓
2. 检查前置条件（verify 已通过）
      ↓
3. 按 close.md 步骤执行（lessons → tasks.md → `archive-verified`）
      ↓
4. 禁止跳过读取参考文件的步骤
```

### 状态检测与确认

当用户输入 `/openflow` 不带子命令时：
1. 执行状态检测（见上方状态检测表）
2. 使用 `AskUserQuestion` 弹出选择框，展示当前状态和建议阶段：

```
header: "选择阶段"
question: "检测结果：变更 `<变更名>`，N/M 测试 PASS。当前建议：verify。你想执行哪个？"
options:
  - label: "verify（建议）"  description: "验证闸门——全量测试+覆盖率+设计一致性"
  - label: "build"           description: "继续实现"
  - label: "amend"           description: "修改需求"
  - label: "spec"            description: "生成规格"
  - label: "close"           description: "归档"
```

3. 根据用户选择执行对应阶段，不自动路由

### 前置条件检查

| 阶段 | 前置条件 | 不满足时提示 |
|------|----------|-------------|
| proposal | 无 | — |
| brainstorming | 无 | — |
| spec | 需要有活跃变更目录或有用户需求 | "请先用 /openflow proposal 或 /openflow brainstorming 描述需求" |
| amend | 需要有活跃变更目录 | "还没有可修订的活跃变更，请先完成 /openflow spec" |
| build | 需要存在 test-plan.md 和 plan-ready.md | "请先完成 /openflow spec 生成规格和测试计划" |
| verify | 需要所有测试 PASS | "测试尚未全部通过，请先用 /openflow build 执行" |
| close | 需要 verify 已通过 | "请先完成 /openflow verify 验证" |
