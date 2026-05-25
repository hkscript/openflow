---
name: openflow/brainstorming
description: Deep design powered by Superpowers brainstorming — openflow sets up context, Superpowers explores, openflow formats into OpenSpec proposal.md
---

# Brainstorming: 深度设计

## 目标

**Superpowers 做核心探索，openflow 做上下文准备 + 格式化产出 + 流程衔接。**

这与 build 阶段的分工一致：Superpowers 负责方法论（多轮探索、方案取舍、设计决策），openflow 负责 OpenAI 集成（先读代码、写入 proposal.md、提示下一步）。

## 中断续接规则

如果用户在本阶段被打断后继续回复、补充范围、回答确认问题、或修正边界，仍然停留在 brainstorming 阶段。继续收敛设计并更新 `openspec/changes/**/proposal.md`，不要因为用户明确了范围就直接进入实现或修改任何代码。

## 流程

### 0. 依赖检测

| 依赖 | 检测方式 | 不可用时 |
|------|----------|----------|
| Superpowers brainstorming | 当前工具的本地或全局 skills 目录下是否存在 `brainstorming/SKILL.md` | 降级为手动多轮提问（见下方"手动降级模式"） |

Superpowers 不可用时，提示用户：
> "Superpowers brainstorming 未安装，将使用手动提问模式。安装后体验更佳。"

### 1. 读取上下文（openflow 负责，Superpowers 不做的事）

**在调用 Superpowers 之前，先帮它准备好战场。**

1. 搜索相关代码：根据用户描述的关键词定位相关模块和文件
2. 扫一眼核心文件：快速浏览入口文件和关键函数
3. 检查现有测试：测试目录结构、测试框架、现有测试覆盖情况
4. 检查 git 历史：最近的相关提交，了解模块最近的变更

### 2. 调用 Superpowers brainstorming（核心探索）

如果 Superpowers 可用，调用 `brainstorming` skill，并将步骤 1 收集的上下文传递给它：

> "项目上下文：[步骤 1 的发现]。用户需求：[用户描述]。请进行多轮探索，输出设计方向和方案取舍。"

Superpowers brainstorming 会进行：
- 逐个深入提问，探索用户意图
- 多轮方案取舍讨论
- 收敛到推荐方案

**openflow 在本步骤的职责：确保探索不偏离方向，引导 Superpowers 关注可测试性——每个关键行为是否有可观测的输出或副作用。**

如果 Superpowers 不可用，执行手动降级模式：

#### 手动降级模式

一次只问一个问题，逐步深入。问题类型：

- **目的** — "这个功能的核心用户场景是什么？"
- **取舍** — "A 方案更简单但扩展性差，B 方案更灵活但复杂。你倾向哪个？"
- **边界** — "如果 X 情况发生，期望的行为是什么？"（引导用户用"给定-当-那么"格式描述）
- **可测试性** — "这个行为怎么验证？有什么可观测的输出或副作用？"

基于讨论提出 2-3 种方案，附上取舍分析。推荐一种并说明理由和测试策略。

### 3. 确认设计方向

无论是 Superpowers 输出还是手动模式输出，与用户确认：

> "确认的设计方向：[方案名]。核心决策：[2-3 条]。测试策略：[如何验证] 这样对吗？"

### 4. 写入 OpenSpec proposal.md（openflow 负责，格式化）

按 OpenSpec 目录约定创建变更。`<变更名>` 使用 kebab-case、动词开头：

```bash
mkdir -p openspec/changes/<变更名>/specs
```

将设计结果写入 `openspec/changes/<变更名>/proposal.md`，包含：

- 需求描述（Superpowers 探索出的用户意图）
- 设计方向（推荐方案及核心决策）
- 方案取舍记录（为什么选 A 不选 B）
- 测试策略概述（哪些行为适合单元测试、哪些需要集成测试）
- 边界和约束

### 5. 提示下一步

> "需求已记录。接下来用 `/openflow spec` 生成完整规格——包括从场景自动生成测试计划。"

## 关键原则

- **openflow 不做 Superpowers 的事**：不替代 Superpowers 做设计探索，只做准备和收尾
- **openflow 做 Superpowers 不做的事**：读代码上下文、写入 OpenSpec 格式、流程衔接
- 本阶段只允许写 OpenSpec 需求文档，禁止修改任何代码或实现文件
- 在提问和探索中引导用户描述"可验证的行为"，这是后续自动生成测试计划的基础
- 如果项目很大，建议先拆分成独立的子项目
- 允许用户改变方向，不要过早锁定
