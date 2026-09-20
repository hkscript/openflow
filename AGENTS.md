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
  enforce/                    强制层
    rules.ts                  ★ 策略唯一真源（16 条规则；改规则只改这里）
    claude.ts                 Claude PreToolUse 适配器（stdin JSON → stdout，exit 1 = block）
    codex.ts                  Codex apply_patch 适配器（多文件补丁拆解，exit 2 = block）
    opencode.ts               OpenCode 插件适配器（output.abort = block）
  utils/                      logger / shell
hooks/                        .mjs 脚本源码（唯一真源；init 时拷贝到各客户端目录）
  gate.mjs                    阶段闸门（12 个子命令：check-proposal / check-design-consistency / archive-verified …）
  detect.mjs                  状态检测（扫描信号 → JSON 路由建议）
  lifecycle-fingerprint.mjs   工作树指纹 + verify receipt 校验（gate 依赖，必须一起安装）
templates/                    技能模板
  SKILL.md                    主协调器（状态检测、路由、铁律）
  {proposal,brainstorming,spec,amend,build,verify,close}.md   各阶段参考
  references/                 按需读取的长清单（code-verification.md 等），不进每次加载
  openflow-*/                 子命令快捷 skill（redirect 到主 SKILL.md）
scripts/                      postinstall + build-opencode-plugin + 5 个回归测试（test-*.mjs）
bin/openflow.js               CLI 入口（加载 dist/）
dist/                         构建产物，gitignore，不要手改
```

### 强制层为什么是「一份策略 + 三个适配器」

三端曾各有一份手抄的完整策略（~2700 行），改一条规则要改三处、维护两套 fixture，且出过跨端漂移。现在策略只有 `src/enforce/rules.ts` 一份，适配器只负责各自客户端的 I/O 契约：

- **Claude / Codex**：适配器与 `rules.js` 一起装到 hooks 目录，安装时把 `./rules.js` 重写为 `./openflow-rules.mjs`（`installEnforcementAdapter()`）。
- **OpenCode**：`scripts/build-opencode-plugin.mjs` 在构建期把策略**内联**成自包含单文件 `dist/enforce/opencode-plugin.mjs`。插件由 OpenCode 自己的 Bun 运行时加载，同目录 import 若解析失败会**静默**丢掉强制层——所以这里不赌运行时解析。

`test-enforce.mjs` 的四向矩阵对每个 fixture 比对 rules / 三个适配器的 `level:id` 向量，验证适配器没有偷偷改变语义；OpenCode 那路测的是**发布产物**，不是 tsc 中间产物。

**改规则的正确姿势**：只改 `rules.ts` → `pnpm run build` → `pnpm test`。适配器里出现 `if` 判断业务规则，就是放错地方了。

### 改动点对账：声明式，不是推断式

`check-design-consistency` 的改动点归属对账以 design.md 的**声明**为准，语法与 test-plan 稳定行同源：

```markdown
### 改动点 1：进页加载粒度从整批改为单任务
- 目标：`src/pages/task/index.tsx::loadTaskList`
- 并行路径：`src/pages/task/index.tsx::loadTaskListNew` → 随改
- 并行路径：`src/pages/legacy.tsx::fetchAll` → 不随改（已废弃）
```

解析在 `parseChangePointDeclarations()`；声明缺失或格式错是 **blocker**，gate 不去猜。

这替换掉了原来从 design 全文正则抓裸方法名的做法。旧做法没有文件归属，必须靠一堆启发式补偿——猜某个 backtick 是"改动目标"还是"引用锚点"、跨文件同名只能整体放过（`landedNamesGlobal`）、用 `/无代码改动|复用|同构/` 扫正文推断豁免。这些连同 `KEYWORD_STOPWORDS` 关键词嗅探一起删掉了：

| 方向 | 之前 | 现在 |
| --- | --- | --- |
| 归属漂移 | 方法名全局集合比对 | 按 (文件, 方法) 精确比对 |
| 声称未落地 | 裸名反查 + 同名放过 | 按声明的文件 + 方法体行区间 |
| 豁免 | 正则扫"无代码改动/复用/同构" | `→ 不随改（理由）` 显式声明 |
| 机械判定 | 抽罕见标识符当关键词嗅探 | 声明方法体 vs hunk 行区间重叠 |
| 完整性 | 跨文件下游链路推导（误报主源） | 同文件同前缀兄弟方法（仍是启发式） |

**只有完整性那一项还是启发式**——发现"未声明的并行路径"本质是探索，不可能精确。所以 verify 模板里「warning 为 0 不代表改动点都落地了」仍然成立，人工逐条核验仍是承重的。

### 测试证据：`🔴 RED` 与 `INV-00x`

改动点对账管的是「改动落在声明的方法里」，它管不了「测试有没有失败能力」——这是另一条轴，而且原来整条轴是空的。原来判定"测试写完了没有"的两处实现都是纯负空间：`checkTestPlan()` 扫文件里有没有 TODO 桩、`isSelectorRegionUnfinished()` 扫选择器区间有没有 `TODO|FAIL|assert false`。**一个只有 `verify(..., never())` 的测试体通过，一条断言都没有的空测试体同样通过**——和它要防的 bug 是同一个形状：什么都没有，满足了"没有坏东西"的检查。

test-plan 稳定行因此长出两个语法：

```markdown
T-001: `tests/auth/test_login.py::test_login_valid` 🔴 RED ✅ PASS
INV-001: `tests/price/test_apply.py::test_always_acts` covers T-001, T-003 🔴 RED ✅ PASS
```

- **`🔴 RED`**：build Step 2 观察到该断言失败后追加。`✅ PASS` 行缺它 → `check-test-plan` / `check-build-done` 判 `red_evidence_missing`（连带 `check-verify-prerequisites`，所以拿不到 receipt），detect 路由回 build。legacy 表格行把标记写进状态格同样生效。TDD 的 RED 步以前只写在模板里、没有任何机器凭据，这是把它从口头变成账本
- **`INV-00x` + `covers`**：跨组合的正向不变量行。与 T 行同权（计入统计、要被 task 的 `Test cases:` 引用、选择器唯一归属、需要 RED），额外校验 `covers` 指向的 ID 必须存在。存在的理由是 `1 scenario = 1 test` 的映射在 test-plan 里**没有位置**放一条横跨整张状态矩阵的断言，而守卫回归恰恰藏在没人写下来的组合里

解析在三处同源：`gate.mjs` / `detect.mjs` 的 `parseCanonicalTestRows()` 与 `rules.ts` 的 `parseTestPlanRows()`（rules 只用选择器，不读状态）。改语法要同时改三处。

配套的模板侧（不是 gate 能判的，靠人）：`references/code-verification.md` 的「状态叉乘矩阵」要求守卫/枚举改动展开组合、每格填覆盖它的 T-id 或空白理由；verify 闸门 4 加了 GIVEN 对齐、断言失败能力、跨用例委托三项必查。

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
- **不许降级**：任何「找不到就跳过 / 坏了就用空配置 / 脚本不可用就手动检查」的分支一律禁止——安装期 `throw`，运行期让模板要求用户重装。降级会让未验证的改动看起来像验证过了，这是 openflow 存在的理由本身。测试同理：构建产物缺失必须判失败，不能 skip。
- **新增 hook 脚本**：放 `hooks/`，并在 `src/core/skill-generator.ts` 的 `installHooks()` / `installCodexRuntime()` / `installOpencodeRuntime()` 里注册拷贝，否则用户装不上。
- **模板锚点**：`replaceToolPaths()` 里按客户端改写模板文字，锚点用 `mustReplace()` 断言；改了 SKILL.md 对应句子就要同步改锚点，否则构建直接报错（以前是静默不替换）。
- **改 hook 后先装到临时目录再跑**，不在本仓库吃狗粮：

  ```bash
  REPO=$(pwd)
  N20=$(pnpm node -e 'process.stdout.write(process.execPath)')
  pnpm run build
  rm -rf /tmp/test-openflow && mkdir -p /tmp/test-openflow/home/.claude/skills/writing-plans /tmp/test-openflow/proj/openspec
  echo '---' > /tmp/test-openflow/home/.claude/skills/writing-plans/SKILL.md
  cd /tmp/test-openflow/proj
  HOME=/tmp/test-openflow/home "$N20" "$REPO/bin/openflow.js" init --tools claude,codex
  "$N20" .claude/hooks/openflow-detect.mjs        # 冒烟：状态检测
  ```

  - init 现在**硬要求** openspec CLI、Superpowers writing-plans、已初始化的 `openspec/`——所以夹具要预置 `openspec/` 目录和一个假的 writing-plans skill，否则 init 会（正确地）退出码 1。
  - 隔离 `HOME` 是必须的：不隔离会读到你本机真实的 Superpowers 安装，测不出缺依赖的行为。
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
