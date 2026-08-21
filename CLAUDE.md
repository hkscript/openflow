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

- **用 pnpm 执行**：`engines.node >=20`，系统 PATH 上的 `node` 可能是旧版（本项目环境为 v14，直接跑 `openflow init` 会因 `node:util.styleText` 缺失报错）。pnpm 自带 Node 20+（`pnpm node` / `pnpm run` 自动用正确版本），本项目命令一律走 pnpm。
- **改动模板/hook 后，测试方式**：
  ```bash
  REPO=$(pwd)                                  # 本仓库绝对路径
  N20=$(pnpm node -e 'process.stdout.write(process.execPath)')   # pnpm 管理的 Node 20+
  pnpm run build \
    && rm -rf /tmp/test-openflow && mkdir -p /tmp/test-openflow \
    && cd /tmp/test-openflow \
    && echo "n" | "$N20" "$REPO"/bin/openflow.js init --tools claude \
    && "$N20" .claude/hooks/openflow-detect.mjs        # 测试状态检测
  ```

  说明：- `echo "n"` 回答非交互 shell 里 init 的 "Run openspec init?" 确认（hook 安装不受影响）；- 空临时目录没有 `node_modules/.bin`，`pnpm exec openflow` 不可用，须用 pnpm 的 node 二进制跑 CLI 绝对路径；
  - 若要验证 `test_plan_stats` 计数，建一个 `openspec/changes/<名>/test-plan.md` 再跑 detect。
    在临时目录验证，不在本项目内吃狗粮（`.claude/` 已 gitignore）。
- **新增 hook 脚本时**：放 `hooks/` 目录，在 `src/core/skill-generator.ts` 的 `installHooks()` 中注册拷贝逻辑
- **脚本零依赖**：所有 `.mjs` 脚本必须是纯 Node 20+，不依赖 npm 包
- **TypeScript 构建**：`pnpm run build`（tsc），输出到 `dist/`


## 禁止事项

禁止在本项目中执行 openflow init 命令
