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
  enforce/         强制层实现（codex.ts / opencode.ts / rules.ts）
  utils/           工具函数（logger, shell）
hooks/             脚本源码（init/update 时拷贝到目标项目或全局工具目录）
  enforce.mjs      PreToolUse 防火墙 hook
  detect.mjs       状态检测脚本（信号源 → JSON 路由建议）
  gate.mjs         阶段闸门脚本（12 个子命令：check-proposal / check-design-consistency …）
  lifecycle-fingerprint.mjs  工作树指纹与 verify receipt 校验（gate 依赖）
templates/         技能模板（init 时拷贝到目标项目的 skills 目录）
  SKILL.md         主协调器（状态检测、路由、铁律）
  *.md             各阶段参考文件（proposal/brainstorming/spec/amend/build/verify/close）
  openflow-*/      子命令快捷 skill
scripts/           构建/安装脚本 + 回归测试（test-*.mjs）
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

## 改完 hook / 模板：只提醒重装，不要改已安装副本

本仓库的 `hooks/*.mjs`、`templates/**`、`src/**` 是唯一真源。各客户端目录下的
`openflow-gate.mjs` / `openflow-detect.mjs` / `openflow-enforce.mjs`（`~/.codex/hooks/`、
`~/.claude/hooks/`、目标项目的 `.claude/hooks/`、`.opencode/`）都只是 `openflow init`
拷贝出来的安装产物。

- **不要直接修改已安装的副本**（包括 `~/.codex/hooks/`）：改动不落到源码，下一次安装会被覆盖，
  还会让不同仓库/会话跑在不同版本的 gate 上。
- 改完源码并跑完回归测试后，**提醒用户自己重新编译安装**，由用户决定何时刷新全局副本。
- 安装命令（全局，覆盖各客户端；`pnpm run build` 仅改了 `src/` 时必需，纯 hooks/templates 可跳过）：
  ```bash
  cd /home/hk/github/openflow && pnpm run build
  cd /tmp && openflow init -g --tools claude,codex,opencode
  ```
  `openflow init -g` 不写项目状态、不动项目文件，所以**在仓库外的目录执行**（本项目禁止在仓库内跑 init）。
- 注意：`openflow update` 只重装**当前项目**的副本（不传 global），刷新全局副本必须用上面的 `init -g`。
- 本机全局包装的是软链（`~/.local/share/pnpm/global/.../@lininn/openflow -> /home/hk/github/openflow`），
  所以 `init -g` 直接取本仓库的 `hooks/`、`templates/`、`dist/`。

## 禁止事项

禁止在本项目中执行 openflow init 命令
