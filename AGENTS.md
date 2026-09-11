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

> `CLAUDE.md` 是指向本文件的软链，两者同一份内容。只维护本文件，不要再建 CLAUDE.md。

## 项目结构

```
src/                          TypeScript 源码
  cli/                        CLI 命令（init / update / status）
  core/                       constants / dependency-check / skill-generator
  enforce/                    强制层实现（codex.ts / opencode.ts / rules.ts）
  utils/                      logger / shell
hooks/                        脚本源码（唯一真源；init 时拷贝到各客户端目录）
  gate.mjs                    阶段闸门（15 个子命令：check-proposal / check-design-consistency / check-verify-ready …）
  detect.mjs                  状态检测（扫描信号 → JSON 路由建议）
  enforce.mjs                 PreToolUse 防火墙（读 tool-call JSON，按阶段/选择器/路径策略拦截，exit 1 = block）
  lifecycle-fingerprint.mjs   工作树指纹 + verify receipt 校验（gate 依赖，必须一起安装）
templates/                    技能模板
  SKILL.md                    主协调器（状态检测、路由、铁律）
  {proposal,brainstorming,spec,amend,build,verify,close}.md   各阶段参考
  openflow-*/                 子命令快捷 skill（redirect 到主 SKILL.md）
scripts/                      postinstall + 5 个回归测试（test-*.mjs）
bin/openflow.js               CLI 入口（加载 dist/）
dist/                         tsc 产物，gitignore，不要手改
```

## 常用命令

一律走 pnpm，别直接调 PATH 上的 `node`：

| 目的 | 命令 |
| --- | --- |
| 全量回归（build + 5 个测试脚本） | `pnpm test` |
| 只跑测试，不重新 build | `pnpm run test:enforce:unit` |
| 构建（tsc → `dist/`） | `pnpm run build` |

`pnpm test` 依次跑 `test-enforce-rules` / `test-enforce` / `test-gate` / `test-detect` / `test-install` 五个脚本，**全绿才算过**；有失败或静默跳过都算不通过。

## 开发约定

- **命令走 pnpm**：`engines.node >= 20`。pnpm 自带的 Node 是确定版本，PATH 上的 `node` 不保证（历史上这里是 v14，`node:util.styleText` 缺失会让 CLI 直接崩）。
- **`.mjs` 零依赖**：`hooks/*.mjs` 只允许 Node 20+ 内置模块 + 同目录 `./lifecycle-fingerprint.mjs`，不许引 npm 包。
- **新增 hook 脚本**：放 `hooks/`，并在 `src/core/skill-generator.ts` 的 `installHooks()` / `installCodexRuntime()` / `installOpencodeRuntime()` 里注册拷贝，否则用户装不上。
- **改 hook 后先装到临时目录再跑**，不在本仓库吃狗粮：

  ```bash
  REPO=$(pwd)
  N20=$(pnpm node -e 'process.stdout.write(process.execPath)')
  pnpm run build
  rm -rf /tmp/test-openflow && mkdir -p /tmp/test-openflow
  cd /tmp/test-openflow
  echo "n" | "$N20" "$REPO/bin/openflow.js" init --tools claude,codex
  "$N20" .claude/hooks/openflow-detect.mjs        # 冒烟：状态检测
  ```

  - `echo "n"` 回答非交互 shell 里 init 的 "Run openspec init?" 确认，hook 安装不受影响。
  - 空临时目录里没有 `node_modules/.bin`，`pnpm exec openflow` 不可用 → 必须用 pnpm 的 node 跑 CLI 绝对路径。
  - 想验证 `test_plan_stats` 计数：先建 `openspec/changes/<名>/test-plan.md` 再跑 detect。

## 改动 hooks / templates / src 之后

本仓库是**唯一真源**。`~/.codex/hooks/`、`~/.claude/hooks/`、`~/.agents/skills/` 以及目标项目里的 `.claude/hooks/`、`.opencode/`，都只是 `openflow init` 拷出来的安装产物。

- **不要直接改已安装的副本**（包括 `~/.codex/hooks/`）：改动不落到源码，下次安装被覆盖，还会让不同仓库/会话跑在不同版本上。
- 改完源码、跑完回归后，**提醒用户自己重新编译安装**，由用户决定何时刷新；不要代为执行安装命令。
- 用户侧刷新全局副本（已验证：只写 `$HOME`，不写项目状态、不动项目文件）：

  ```bash
  cd /home/hk/github/openflow && pnpm run build    # 只有改了 src/ 才需要
  cd /tmp && openflow init -g --tools claude,codex,opencode
  ```

- 本机全局包是软链回本仓库（`~/.local/share/pnpm/global/.../@lininn/openflow -> /home/hk/github/openflow`），所以 `init -g` 取的就是本仓库的 `hooks/`、`templates/`、`dist/`。
- ⚠️ `openflow update` 只重装**当前项目**的副本（源码里没传 global），刷新全局副本只能用上面的 `init -g`。

## 禁止事项

禁止在本项目中执行 openflow init 命令。它会往仓库写安装产物（`--tools codex` 的 `.agents/skills/`、`.codex/hooks/` 等不在 `.gitignore` 内）并写 `.openflow/state.json`，污染工作区；需要装全局副本时，按上一节在仓库外用 `init -g`。
