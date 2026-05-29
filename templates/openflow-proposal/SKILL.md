---
name: openflow-proposal
description: "Quick start proposal phase. Use /openflow-proposal to create a change proposal, equivalent to /openflow proposal. Triggers when user wants to plan, propose, or start a new change."
---

这是 `/openflow proposal` 的快捷方式，等效于 `/openflow proposal`。

**执行步骤**：

1. **读取主协调器**：`~/.claude/skills/openflow/SKILL.md`
   - 协调器包含状态检测、前置条件检查、续接规则等核心逻辑
   - 必须遵循协调器的路由和阶段写入边界规则

2. **读取阶段参考文件**：`~/.claude/skills/openflow/proposal.md`
   - 包含 proposal 阶段的详细指令和流程

3. **按指令执行**：先检查前置条件，再按 proposal.md 的流程执行

**所有协调逻辑（状态检测、前置条件、续接规则）都在主 SKILL.md 中，必须遵循。**
