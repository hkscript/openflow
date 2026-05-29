---
name: openflow-verify
description: "Quick start verify phase. Use /openflow-verify to run verification gate before close, equivalent to /openflow verify. Triggers when user wants to verify all tests pass and design is consistent."
---

这是 `/openflow verify` 的快捷方式，等效于 `/openflow verify`。

**执行步骤**：

1. **读取主协调器**：`~/.claude/skills/openflow/SKILL.md`
   - 协调器包含状态检测、前置条件检查、续接规则等核心逻辑
   - 必须遵循协调器的路由和阶段写入边界规则

2. **读取阶段参考文件**：`~/.claude/skills/openflow/verify.md`
   - 包含 verify 阶段的详细指令和流程
   - 包含验证闸门：全量测试 + 覆盖率 + 设计一致性

3. **按指令执行**：先检查前置条件，再按 verify.md 的流程执行

**所有协调逻辑（状态检测、前置条件、续接规则）都在主 SKILL.md 中，必须遵循。**
