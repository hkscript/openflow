---
name: openflow
description: "OpenSpec + Superpowers workflow orchestrator. Bridges requirements and implementation via test-first traceability: scenarios → test stubs → TDD → passing tests = requirements met. Use /openflow proposal for quick capture, /openflow brainstorming for deep design, /openflow spec to generate specs + test-plan.md + plan-ready.md, /openflow amend to revise requirements with test impact analysis, /openflow build to execute with TDD, /openflow close to verify test coverage and archive."
---

# openflow - 工作流协调器

根据用户调用的子命令和项目当前状态，路由到对应阶段。

## 反幻觉铁律

**所有阶段都必须遵守的四条铁律。** 违反了这些，OpenSpec 和 Superpowers 的流程再严谨也没用——因为输入本身就是编的。

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

## 核心设计理念

```
                        ┌── Compound 闭环 ──────────────────────┐
                        │                                        │
OpenSpec scenarios ──→ test-plan.md (场景→测试映射) ──→ Superpowers TDD 执行
       ↑                                                       │
       │                                                       ↓
       ├──────────── close: 测试全部 PASS = 需求满足 ────────────┤
       │                                                       │
       └──────────── lessons.md ← 提取经验 ← 每个变更完成后 ────┘
                  (下次 proposal/spec 自动检索)
```

**test-plan.md 是执行期桥梁**（scenario → TDD），**lessons.md 是积累期桥梁**（让每次变更产生复利）。这也是 openflow 让 OpenSpec 和 Superpowers 产生真正互补的关键：测试确保当前变更正确，经验积累确保下次变更更快。

## 关键产物

| 产物 | 生成阶段 | 作用 |
|------|----------|------|
| `proposal.md` | proposal / brainstorming | 需求描述 |
| `design.md` | spec | 技术方案 |
| `specs/*.md` | spec | 结构化规格（requirement + scenario） |
| `tasks.md` | spec | OpenSpec 任务清单 |
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

## 阶段写入边界

| 阶段 | 允许写入 | 禁止写入 |
|------|----------|----------|
| proposal | `openspec/changes/**/proposal.md` | 任何代码或实现文件 |
| brainstorming | `openspec/changes/**/proposal.md` | 任何代码或实现文件 |
| spec | `openspec/changes/**`、`test-plan.md`、`plan-ready.md` | 任何代码或实现文件 |
| amend | `openspec/changes/**`、`test-plan.md`、`plan-ready.md`、`docs/superpowers/plans/*.md` | 代码、测试、其他实现文件 |
| build | 代码、测试、实现计划状态 | 规格文档（除非另开变更） |
| close | 归档、验证记录、`close-issues.md`、**`lessons.md`** | 代码、测试、其他实现文件 |

## 子命令

| 命令 | 阶段 | 说明 |
|------|------|------|
| `/openflow proposal` | proposal | 轻量提问，快速收敛需求 |
| `/openflow brainstorming` | brainstorming | Superpowers 深度探索 + openflow 格式化写入 proposal.md |
| `/openflow spec` | spec | OpenSpec 生成规格 + 自动生成 test-plan.md + 翻译 plan-ready.md |
| `/openflow amend` | amend | 受控修订需求，含测试影响分析 |
| `/openflow build` | build | 测试桩生成 → TDD 执行，每 task 绑定测试 |
| `/openflow close` | close | 验证测试覆盖率 → 提取经验(lessons.md) → 归档（Compound 闭环） |

## 状态检测

当用户调用 `/openflow` 不带子命令，或调用某个子命令需要确认前置条件时，执行以下状态检测：

| 检查项 | 怎么查 | 结果 |
|--------|--------|------|
| 有活跃变更？ | `openspec/changes/` 下是否有非 archive 子目录 | 有→继续 |
| 有 test-plan.md？ | 变更目录下是否有 `test-plan.md` | 有→看测试状态 |
| 有 plan-ready.md？ | 变更目录下是否有 `plan-ready.md` | 有→看实现状态 |
| 实现已开始？ | `docs/superpowers/plans/` 下是否有计划文件 | 有→看是否完成 |
| 测试全部通过？ | test-plan.md 中所有测试是否标记 PASS | 是→close 阶段 |

判定结果：
- 无活跃变更 → proposal 阶段
- 有活跃变更但无 test-plan.md → spec 阶段（补生成）
- 有 test-plan.md 但实现未开始 → build 阶段
- 实现进行中（部分测试 PASS） → 继续 build 阶段（断点恢复）
- 实现已完成（所有测试 PASS） → close 阶段

## 路由

根据子命令或状态检测结果，读取对应阶段文件并执行：

1. 如果这是上一 openflow 阶段的续接回复，先按"续接与中断恢复"保持阶段
2. 如果用户在 build 中明确提出需求变更、补充 spec、修改验收条件或重新生成规格，路由到 amend
3. 如果用户指定了子命令，优先按指定阶段执行，但检查前置条件
4. 如果用户只输入 `/openflow`，执行状态检测，自动路由到对应阶段
5. 读取当前 openflow skill 目录下的阶段文件：`<阶段>.md`
6. 按阶段文件中的流程执行，并遵守阶段写入边界

### 前置条件检查

| 阶段 | 前置条件 | 不满足时提示 |
|------|----------|-------------|
| proposal | 无 | — |
| brainstorming | 无 | — |
| spec | 需要有活跃变更目录或有用户需求 | "请先用 /openflow proposal 或 /openflow brainstorming 描述需求" |
| amend | 需要有活跃变更目录 | "还没有可修订的活跃变更，请先完成 /openflow spec" |
| build | 需要存在 test-plan.md 和 plan-ready.md | "请先完成 /openflow spec 生成规格和测试计划" |
| close | 需要所有测试 PASS | "测试尚未全部通过（test-plan.md 中 N 个测试未完成），请先用 /openflow build 执行" |
