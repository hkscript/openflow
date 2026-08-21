---
name: openflow-build
description: "Quick start build phase. Use /openflow-build to execute TDD implementation, equivalent to /openflow build. Triggers when user wants to start coding with test-driven development."
---

这是 `/openflow build` 的快捷方式，等效于 `/openflow build`。

**执行步骤**：

1. **读取主协调器**：`.claude/skills/openflow/SKILL.md`（项目本地安装）或 `~/.claude/skills/openflow/SKILL.md`（全局安装）
   - 协调器包含状态检测、前置条件检查、续接规则等核心逻辑
   - 必须遵循协调器的路由和阶段写入边界规则

2. **读取阶段参考文件**：`build.md`（与主协调器同目录）
   - 包含 build 阶段的详细指令和流程
   - 包含 TDD 执行规则

3. **按指令执行**：先检查前置条件，再按 build.md 的流程执行

4. **设置阶段状态**：按 build.md 步骤 0 写入 `.openflow/phase`（`{"version":1,"change":"<变更名>","phase":"build","mode":"bootstrap"}`）并创建 `.openflow/building` 标记；进入每个 task 前切到 `mode:"task-build"` + `task:"<编号>"`（见主协调器「阶段状态」节）。

**所有协调逻辑（状态检测、前置条件、续接规则）都在主 SKILL.md 中，必须遵循。**
