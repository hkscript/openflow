<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

## 项目结构

```
src/               TypeScript 源码（CLI + skill-generator）
  cli/             CLI 命令（init, status, update）
  core/            核心逻辑（dependency-check, skill-generator, constants）
  enforce/         OpenCode 插件
  utils/           工具函数
hooks/             脚本源码（init 时拷贝到目标项目 .claude/hooks/）
  enforce.mjs      PreToolUse 防火墙 hook（5 道检查）
  detect.mjs       状态检测脚本（11 个信号源 → JSON 路由建议）
  gate.mjs         阶段闸门脚本（6 个子命令：check-proposal 等）
templates/         技能模板（init 时拷贝到目标项目 .claude/skills/openflow/）
  SKILL.md         主协调器（状态检测、路由、铁律）
  *.md             各阶段参考文件（proposal/brainstorming/spec/amend/build/verify/close）
scripts/           构建/安装脚本
bin/openflow.js    CLI 入口
```

## 开发约定

- **改动模板/hook 后，测试方式**：
  ```bash
  npm run build && cd /tmp/test-openflow && mkdir -p openspec \
    && openflow init --tools claude \
    && node .claude/hooks/openflow-detect.mjs        # 测试状态检测
  ```
  在临时目录验证，不在本项目内吃狗粮（`.claude/` 已 gitignore）。
- **新增 hook 脚本时**：放 `hooks/` 目录，在 `src/core/skill-generator.ts` 的 `installHooks()` 中注册拷贝逻辑
- **脚本零依赖**：所有 `.mjs` 脚本必须是纯 Node 20+，不依赖 npm 包
- **TypeScript 构建**：`npm run build`（tsc），输出到 `dist/`