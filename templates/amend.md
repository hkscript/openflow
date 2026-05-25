---
name: openflow/amend
description: Revise requirements during build — delta to OpenSpec docs, impact analysis on tests, regenerate test-plan.md and plan-ready.md
---

# Amend: 需求变更修订（带测试影响分析）

## 目标

在 build 阶段发现需求遗漏或规格需要改变时，受控修改 OpenSpec 文档，分析对已有测试的影响，重新生成 test-plan.md 和 plan-ready.md，然后继续 build。

## 适用场景

- build 过程中发现原需求漏了一个功能、边界或验收条件
- 用户明确说"修改需求""补充 spec""重新生成规格""需求变更"
- close 前发现规格本身不完整

不适用：
- 只是代码没有实现现有 spec → 继续 `/openflow build`
- 变更已经 close/archive → 开新的 `/openflow proposal`

## 前置条件

- `openspec/changes/<变更名>/` 下存在 active change
- 至少存在 `proposal.md`
- 通常应已存在 `test-plan.md` 和 `plan-ready.md`

## 流程

### 1. 确认当前变更

检查 `openspec/changes/` 下的 active change。如有多个列出让用户选择。

读取当前文档：
- `proposal.md`、`design.md`、`specs/**/spec.md`、`tasks.md`
- `test-plan.md`（关键——用来做影响分析）
- `plan-ready.md`
- `docs/superpowers/plans/` 下对应实现计划

### 2. 判断修订类别

| 情况 | 处理 |
|------|------|
| 现有 spec 已覆盖，只是代码未完成 | 回到 `/openflow build` |
| 新增 scenario（同一 requirement 下） | 继续 amend |
| 新增 requirement | 继续 amend |
| 修改已有 scenario 的预期行为 | 继续 amend，标记为 BREAKING |
| 删除已有 requirement/scenario | 继续 amend，标记为 BREAKING |
| 技术方案变更 | 继续 amend，更新 design.md |

### 3. 测试影响分析（关键步骤）

**在修改任何文档之前，先理解改了什么代码、分析对已有测试的影响。**

先做两件事：

1. **读已实现的代码**：读取 build 阶段已修改但尚未 commit 或已 commit 但受变更影响的文件，了解当前代码的实际状态
2. **读已完成的测试**：读取 test-plan.md 中标记为 PASS 的测试文件，了解这些测试的断言逻辑——如果后续修改 scenario 行为，这些测试的断言可能需要调整

然后读取 `test-plan.md`，逐行标记影响：

```markdown
## 测试影响分析 (YYYY-MM-DD)

| 测试编号 | 所属 Requirement | 影响 | 说明 |
|----------|-----------------|------|------|
| #1 | REQ-001: 用户登录 | 无影响 | 未修改此 scenario |
| #2 | REQ-002: 会话管理 | 🔄 需修改 | scenario 预期行为变更 |
| #3 | REQ-003: 权限校验 | ➕ 新增 | 新 scenario |
| #4 | REQ-001: 用户登录 | ❌ 废弃 | 删除的 scenario |
```

将此分析展示给用户确认：
> "本次修订影响 M 个已有测试（N 个需修改，K 个需废弃），新增 X 个测试。确认继续？"

用户确认后才进入修改步骤。

### 4. 修改 OpenSpec 文档

按影响范围更新：

- **proposal.md**：追加 `## Amendments`，记录日期、原因、摘要
- **design.md**：仅当技术方案变化时修改
- **specs/<capability>/spec.md**：使用 `ADDED`、`MODIFIED`、`REMOVED` 表达 delta。每个新增/修改的 requirement 必须至少有一个 `#### Scenario:`
- **tasks.md**：追加新任务；保留已完成任务的 checkbox 状态

### 5. 校验 OpenSpec

```bash
openspec validate <变更名> --strict
```

### 6. 更新测试计划

根据影响分析更新 `test-plan.md`：

- 标记为 `🔄 需修改` 的行：保留编号，追加 `⚠️ 待更新: <变更说明>`
- 标记为 `➕ 新增` 的行：追加新行到映射表
- 标记为 `❌ 废弃` 的行：保留编号但标记 `❌ 已废弃: <原因>`

追加 `## Amendments` 记录本次变更。

### 7. 更新 plan-ready.md

- 保留 `## 来源` 和 `## Amendments`
- 保留已完成 task 的 checkbox 状态
- 追加新 task（绑定 test-plan.md 中的新测试编号）
- 标记受影响但未修改的 task（如 "⚠️ 测试 #3 预期行为变更，需调整此 task"）

### 8. 同步详细实现计划

如果有 `docs/superpowers/plans/YYYY-MM-DD-<变更名>.md`：
- 已勾选 task 保留
- 受影响的未完成 task：标记需调整
- 追加新 task

### 9. 提示下一步

> "需求变更已写入 OpenSpec，test-plan.md 和 plan-ready.md 已更新。
> 受影响测试：M 个需修改，K 个需废弃，X 个新增。接下来继续 `/openflow build`。"

## Amend 次数跟踪

如果这是第 3 次或更多 amend，显示警告：

> "⚠️ 此变更已修订 N 次。频繁的 amend 可能意味着原始 proposal 范围不够清晰。建议本次完成、close 归档后，剩余调整开新的 proposal。"

## 沉没成本检测（Sunk-Cost Detector）

如果同一个问题（同一个 bug / 同一个失败的测试 / 同一个设计死结）在 amend + build 循环中反复出现：

- 第 2 次出现：**"这个问题第 2 次出现了。我们的假设有没有可能不对？"** 列出当前假设并逐条质疑
- 第 3 次出现：**必须换一种完全不同的方法**。不能只是微调参数或换措辞重试。回到 brainstorming 阶段重新审视方案，或切开新 change 用不同架构

## 关键原则

- amend 阶段只修改文档和计划，不直接改代码
- **测试影响分析必须在修改文档之前做**——先看清影响面再动手
- 不做静默覆盖——修改已有 scenario 时必须标记为 BREAKING
- 不得删除 test-plan.md 中已完成的行（保留审计轨迹）
- 已归档变更不可 amend，必须开新 change
