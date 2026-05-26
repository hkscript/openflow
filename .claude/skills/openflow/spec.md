---
name: openflow/spec
description: Call OpenSpec to generate specs + translate to plan-ready.md, auto-generate test-plan.md from scenarios
---

# Spec: 生成规格、测试计划、实现计划

## 目标

调用 OpenSpec 生成完整规格文档，然后做两件事：
1. 从 scenarios 自动生成 `test-plan.md`（这是 OpenSpec → Superpowers TDD 的桥梁）
2. 将规格翻译为 `plan-ready.md`（这是 Superpowers 执行的输入）

## 中断续接规则

如果用户在本阶段被打断后继续回复、补充范围、要求调整规格、或确认规格摘要，仍然停留在 spec 阶段。只更新 `openspec/changes/**`、`test-plan.md` 与 `plan-ready.md`，不要修改任何代码或实现文件。

## 前置条件

- `openspec/changes/` 下存在活跃变更目录（由 proposal 或 brainstorming 阶段创建）
- 变更目录下至少有 `proposal.md`

## 流程

### 1. 确认活跃变更

检查 `openspec/changes/` 下是否有活跃变更（非 archive 子目录）。

如果没有，提示用户：
> "还没有活跃变更。请先用 /openflow proposal 或 /openflow brainstorming 创建需求。"

如果有多个，列出并让用户选择：
> "检测到多个活跃变更：[列表]。要对哪个生成规格？"

### 2. 理解现有代码（必做，生成设计前）

**设计不能悬空——必须先读懂现有架构再写 design.md。**

1. **读相关模块的入口文件**：根据 proposal 中描述的功能范围，找到涉及的模块/组件，读入口文件和核心函数
2. **读现有测试**：了解测试目录结构、测试框架、测试模式（怎么 mock、怎么 setup），这是后续生成 test-plan.md 的基础
3. **读相似功能的已有实现**：如果项目中有类似功能的实现，读它的 design.md（如果有）或代码结构——保持设计语言一致
4. **检索沉淀经验（Compound 闭环）**：
   ```bash
   grep -r "<关键词>" openspec/changes/archive/ --include="lessons.md" -l
   grep -r "<关键词>" openspec/changes/archive/ --include="design.md" -l
   openspec list --specs 2>/dev/null | grep -i "<关键词>"
   ```
   如果找到相关的 lessons.md，重点关注"设计决策"表中的 ❌ 决策和"踩过的坑"——不要在新的设计里重蹈覆辙。如果找到相关的 design.md，关注它的架构选型理由——你的设计应该和它保持一致或明确说明为什么不同。

做完以上检查后再进入第 3 步生成 OpenSpec 文件。

**确定性检查（必做，进入步骤 3 之前）：** 汇总所有 `[Assumption]` 和 `[Unknown]` 标签的条目，逐条消解或标记。对于 design.md 中将引用的任何文件路径/模块名/函数名，必须确认其存在（未读不用铁律）。

### 3. 生成 OpenSpec 规格文件

根据 proposal.md 的内容生成或补齐以下文件：

- `openspec/changes/<变更名>/proposal.md` — 已存在，可补充
- `openspec/changes/<变更名>/design.md` — 技术方案
- `openspec/changes/<变更名>/specs/` — 具体规格变更（标记新增/修改/删除）
- `openspec/changes/<变更名>/tasks.md` — 占位，close 阶段从 plan-ready.md 自动生成，无需手动维护

**关键要求**：specs/ 中每个 requirement 必须至少有一个 `#### Scenario:`，且 scenario 描述必须包含**可验证的预期行为**（给定-当-那么 或 输入-输出 格式）。这是后续自动生成测试计划的输入源。

如果 OpenSpec CLI 可用，生成后运行校验：

```bash

> **OpenSpec 检测**：根据 proposal.md 生成 design.md + specs/ + tasks.md；如果 `openspec` CLI 可用，生成后运行 `openspec validate <变更名> --strict` 校验。specs/ 中每个 requirement 必须包含至少一个 `#### Scenario:`（可验证的预期行为），这是自动生成 test-plan.md（场景→测试映射）的输入源。

openspec validate <变更名> --strict
```

如果校验失败，根据错误修正上述文件后重新校验。

### 4. 与用户确认规格

展示规格摘要，逐项确认：

> "以下是规格摘要：
> - **提案**：[proposal.md 核心内容]
> - **设计**：[design.md 核心决策]
> - **任务**：[tasks.md 任务列表]
> - **场景覆盖**：[共 N 个 scenario]
>
> 有需要调整的地方吗？"

用户确认后才进入后续步骤。

### 5. 自动生成 test-plan.md（场景→测试映射，桥梁层）

这是 OpenSpec 和 Superpowers 产生真正互补的关键步骤。

遍历 `specs/` 目录下所有文件，提取每个 `#### Scenario:` 及其所属 requirement，生成测试计划。

**生成规则：**
1. 每个 scenario 对应 1 个测试用例（函数/方法）
2. 测试用例名称从 scenario 标题派生（snake_case）
3. 测试内容从 scenario 描述推导（给定条件 → test setup，期望结果 → assertion）
4. 测试文件路径根据项目约定自动推断（见下方）

`openspec/changes/<变更名>/test-plan.md` 格式：

```markdown
# 测试计划：<变更名>

## 测试映射

<!--
  每一行 = 一个场景 → 一个测试用例
  build 阶段严格按此映射执行 TDD，不得跳过或合并
-->

| # | 来源 Requirement | Scenario | 测试文件 | 测试函数 | 类型 |
|---|-----------------|----------|----------|----------|------|
| 1 | REQ-001: 用户登录 | 正确凭据登录成功 | `tests/auth/test_login.py::test_login_with_valid_credentials` | `test_login_with_valid_credentials` | 功能 |
| 2 | REQ-001: 用户登录 | 错误密码登录失败 | `tests/auth/test_login.py::test_login_with_wrong_password` | `test_login_with_wrong_password` | 功能 |
| 3 | REQ-002: 会话管理 | Token过期自动刷新 | `tests/auth/test_session.py::test_token_expiry_triggers_refresh` | `test_token_expiry_triggers_refresh` | 集成 |

## 统计

- 总场景数：N
- 单元测试：M
- 集成测试：K
- 测试文件数：J
```

**测试文件路径推断规则：**
- 检查项目现有测试目录结构（`tests/`、`__tests__/`、`spec/` 等）
- 检查项目使用的测试框架（pytest、jest、go test 等）
- 根据变更涉及的文件路径推导对应的测试文件路径
- 如果不确定，在 test-plan.md 顶部加 `<!-- TEST_DIR_HINT: tests/ -->` 标记

### 6. 生成 plan-ready.md（实现计划）

以 test-plan.md 和 OpenSpec 文档为输入，生成可执行的实现计划。

**格式要求（与旧版的关键区别——每个 task 带追溯信息）：**

```markdown
# 实现计划：<变更名>

## 来源
- 提案：openspec/changes/<变更名>/proposal.md
- 设计：openspec/changes/<变更名>/design.md
- 规格：openspec/changes/<变更名>/specs/
- 任务：openspec/changes/<变更名>/tasks.md
- 测试计划：openspec/changes/<变更名>/test-plan.md
```

每个 task 必须包含以下字段：

```markdown
### Task 1: <任务名>
- 目标：<做什么>
- 改动文件：<文件路径 [Verified] 或 [Assumption: 需确认路径]>
- 覆盖场景：<test-plan.md 中的 #编号，如 #1, #2>
- 测试先行：<先写哪个测试，在哪个文件 [Verified]>
- 验证方式：<运行什么测试命令，预期结果>
- 确定性：<[Verified] / [Inferred] / [Assumption] — 本 task 的整体确定性>
```

**确定性标签规则：**
- `[Verified]` = 所有改动文件和测试文件路径均已通过 grep/Read 确认存在
- `[Inferred]` = 路径从现有代码模式推导，但未逐文件确认
- `[Assumption]` = 至少一个文件路径是猜测的——build 阶段执行前必须先确认
- 如果 task 有 ≥2 个 `[Assumption]`，应拆分或回到步骤 2 补读代码

**翻译规则：**
1. 每个 task 必须绑定至少 1 个 test-plan 场景编号
2. 每个 task 必须在"测试先行"字段指明先写哪个测试
3. 按执行依赖排序，不按功能模块排序
4. 同一个测试文件里的测试尽量归到同一个 task

### 7. 提示下一步

> "规格已确认，test-plan.md（N 个场景映射到 M 个测试用例）和 plan-ready.md 已生成。"
> 
> **审批门（不可跳过）：** 在用户明确批准 design.md 和 plan-ready.md 之前，**不得进入 build 阶段**。即使用户说"开始写代码"或"就这样做"，也必须先把规格摘要展示给用户并等待确认。
>
> 审批确认后提示："> 接下来用 `/openflow build` 开始 TDD 实现——每个 task 都会先写测试再写代码。"

## 关键原则

- **一条代码都不许写** — spec 阶段只产出文档和测试计划
- test-plan.md 是本阶段最重要的产出：它是 OpenSpec scenarios 和 Superpowers TDD 之间的**可验证桥梁**
- 每个 scenario 必须有对应测试——如果某个 scenario 无法映射到测试，回到步骤 3 修正 scenario 描述
- plan-ready.md 中每个 task 的"覆盖场景"字段是 close 阶段验证追溯的锚点
- 按执行依赖排序是翻译的关键步骤：先依赖后依赖方
