---
name: openflow-spec
description: "Quick start spec phase. Use /openflow-spec to generate specs, test-plan, and plan-ready, equivalent to /openflow spec. Triggers when user wants to generate specifications from a proposal."
---

这是 `/openflow spec` 的快捷方式，等效于 `/openflow spec`。

**执行步骤**：

1. **读取主协调器**：`~/.claude/skills/openflow/SKILL.md`
   - 协调器包含状态检测、前置条件检查、续接规则等核心逻辑
   - 必须遵循协调器的路由和阶段写入边界规则

2. **读取阶段参考文件**：`~/.claude/skills/openflow/spec.md`
   - 包含 spec 阶段的详细指令和流程
   - 包含代码逻辑深度核验（步骤 7）

3. **按指令执行**：先检查前置条件，再按 spec.md 的流程执行

**所有协调逻辑（状态检测、前置条件、续接规则）都在主 SKILL.md 中，必须遵循。**
