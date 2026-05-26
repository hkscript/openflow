---
name: openflow/proposal
description: Lightweight requirement capture — 3-5 questions to quickly converge on requirements
---

# Proposal: 轻量需求捕获

## 目标

用最少的提问，把用户脑子里的需求变成可执行的变更描述。不做深度设计，不生成代码。

## 中断续接规则

如果用户在本阶段被打断后继续回复、补充范围、回答确认问题、或修正边界，仍然停留在 proposal 阶段。继续更新 `openspec/changes/**/proposal.md`，不要因为用户说"就这样做""继续""范围改成 X"而写任何代码或实现文件。

## 流程

### 0. 快速了解上下文（必做）

**在提问之前，先理解现状。** 不要凭空提问题——用户说"改登录"时，你必须知道现在的登录是什么样的。

花 2-3 分钟做以下检查：

1. **定位相关代码**：根据用户描述的关键词，搜索相关文件和模块。用户说"登录"，搜 `login`、`auth`；用户说"支付"，搜 `payment`、`order`
2. **扫一眼核心文件**：快速浏览入口文件和关键函数（50-100 行即可，不用读完）
3. **检查现有测试**：相关模块有没有已有测试？测试文件在哪？用什么框架？
4. **检索沉淀经验**：搜存档中有没有类似变更的经验：
   ```bash
   grep -r "<关键词>" openspec/changes/archive/ --include="lessons.md" -l
   grep -r "<关键词>" openspec/changes/archive/ --include="design.md" -l
   grep -r "<关键词>" openspec/specs/ -l
   ```
   如果找到相关的 lessons.md 或 design.md，快速读一下——这里可能有前人的设计决策、踩过的坑、验证有效的测试模式。这些能让接下来的提问少走弯路。

这些信息让你接下来的提问有的放矢——你知道现有实现的边界在哪里，能识别用户说的是"新增"还是"改造"，还能从历史经验中借力。

### 1. 提出关键问题

一次性提出以下 3-5 个核心问题（根据上下文调整措辞）：

1. **做什么** — 你想实现什么功能/变更？
2. **为什么** — 解决什么问题？给谁用的？
3. **成功标准** — 怎样算做完了？验收条件是什么？（尽量引导用户给出可验证的成功标准，后续 spec 阶段会将其转化为 scenario 和测试）
4. **边界** — 什么不在范围内？
5. **现有约束** — 有没有技术栈、兼容性、时间上的限制？

### 2. 确认需求

用户回答后，整理成一段简洁的需求描述，与用户确认：

> "我理解的需求是：[一句话概括]。具体来说：[2-3 条要点]。这样理解对吗？"

### 3. 创建 OpenSpec 变更目录

用户确认后，按 OpenSpec 目录约定创建变更。`<变更名>` 使用 kebab-case、动词开头（如 `add-user-login`）：

```bash
mkdir -p openspec/changes/<变更名>/specs
```

将确认的需求描述写入 `openspec/changes/<变更名>/proposal.md`。

**proposal.md 格式要求（OpenSpec CLI 校验规则）：**

```markdown
## Why

[1-2 句话说明问题/机会，至少 50 字符]

## What Changes

- [变更列表，用 bullet 列出]
- [如有 breaking change，标记 **BREAKING**]

## Impact

- Affected specs: [涉及的 capability 列表]
- Affected code: [关键文件/系统]
```

**必须使用英文标题**：`## Why` 和 `## What Changes`，不是中文 "为什么" 和 "做什么"。这是 openspec validate 和 openspec archive 的校验要求。

### 4. 提示下一步

> "需求已记录。接下来可以用 `/openflow spec` 生成完整规格（包括测试计划和实现计划），或 `/openflow brainstorming` 进行深度设计。"

## 注意

- 不要做技术设计，那是 spec 和 brainstorming 的事
- 不要写代码
- 本阶段只允许写 OpenSpec 需求文档，禁止修改任何代码或实现文件
- 问题要具体，不要泛泛而谈
- 如果用户的需求很大（跨多个独立子系统），建议拆分
- 引导用户给出"可验证"的成功标准——能写成测试的那种
