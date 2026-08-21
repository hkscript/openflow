---
name: openflow-amend
description: "Quick start amend phase. Use /openflow-amend to revise requirements with test impact analysis, equivalent to /openflow amend. Triggers when user wants to modify existing requirements during build."
---

这是 `/openflow amend` 的快捷方式，等效于 `/openflow amend`。

**执行步骤**：

1. **读取主协调器**：`.claude/skills/openflow/SKILL.md`（项目本地安装）或 `~/.claude/skills/openflow/SKILL.md`（全局安装）
   - 协调器包含状态检测、前置条件检查、续接规则等核心逻辑
   - 必须遵循协调器的路由和阶段写入边界规则

2. **读取阶段参考文件**：`amend.md`（与主协调器同目录）
   - 包含 amend 阶段的详细指令和流程
   - 包含测试影响分析

3. **按指令执行**：先检查前置条件，再按 amend.md 的流程执行

4. **设置阶段状态**：确认 `.openflow/phase` 记录当前阶段（`{"version":1,"change":"<变更名>","phase":"amend"}`），缺失则写入（非 build 阶段不带 mode/task；`.openflow/building` 标记保留供 build 续接，见主协调器「阶段状态」节）。

**所有协调逻辑（状态检测、前置条件、续接规则）都在主 SKILL.md 中，必须遵循。**
