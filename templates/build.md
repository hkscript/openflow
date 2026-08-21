---
name: openflow/build
description: Test-first implementation driven by test-plan.md — generate test stubs, then TDD each task with scenario traceability
---

# Build: 测试驱动的实现

## 目标

读取 test-plan.md 和 plan-ready.md，**先写测试桩再写实现**，以 TDD 方式逐 task 推进，每个 task 的测试通过即标记完成。

## 中断续接规则

如果用户在 build 阶段被打断后继续回复、说"继续"、或补充实现细节，保持 build 阶段并从实现计划/checkbox 状态恢复。

如果用户明确要求修改需求、补充 spec、改变验收条件、改变功能边界或重新生成规格，停止实现并切到 `/openflow amend`。amend 完成后再回到 `/openflow build`。

## 前置条件

- `openspec/changes/<变更名>/plan-ready.md` 存在
- `openspec/changes/<变更名>/test-plan.md` 存在

如果不满足，提示：
> "还没生成 plan-ready.md 或 test-plan.md。请先完成 /openflow spec。"

## 流程

### 0. 前置检查

#### 0.0 创建 build 阶段状态

进入 build 阶段时，立即写入阶段状态（bootstrap 模式）并创建 building 标记：

```bash
printf '%s\n' '{"version":1,"change":"<变更名>","phase":"build","mode":"bootstrap"}' > .openflow/phase
printf '%s\n' '<变更名>' > .openflow/building
```

若 `.openflow/phase` 已存在且是 build（断点恢复），跳过创建。

**bootstrap 写入边界**：bootstrap 是 build 的第一种受控模式，**只允许写 test-plan.md 声明的测试选择器对应文件（`T-00x` 选择器里的测试文件）与任务声明的有限测试框架配置**（plan-ready.md `Test framework setup:` 声明的框架根配置）。生产实现文件仍被 enforcement hook 阻断（phase-boundary）。

`.openflow/building` 标记启用 enforcement hook 的 writing-plans 闸门（见 0.1）：标记存在期间，若 writing-plans 不可用，实现类代码的 Edit/Write 会被阻断。标记在步骤 7 完成、close 或重新 build 时删除。

#### 0.1 Superpowers writing-plans（硬性依赖）

**必须可用**。运行 gate 脚本检测（同步检查 skill 文件和 Claude Code 插件）：

```bash
node <base>/.claude/hooks/openflow-gate.mjs check-writing-plans
```

该依赖由 enforcement hook 强制：`.openflow/building` 标记存在时，若 writing-plans 未检测到，实现类代码编辑会被阻断。

不满足则**删除 `.openflow/building` 标记后报错终止**：
> "❌ build 阶段需要 Superpowers writing-plans。请先安装：`/plugin install superpowers@claude-plugins-official`，然后重试。"

#### 0.2 测试框架（需确认）

**先运行脚本检测**：

```bash
node <base>/.claude/hooks/openflow-gate.mjs check-test-framework
```

输出包含 `language`、`framework`、`test_command`、`test_dir`。

**如果检测到测试框架**（`pass: true`）→ 继续流程。

**如果未检测到测试框架**（`pass: false`），按以下步骤处理：

1. **分析项目技术栈**：根据项目文件判断语言和项目类型
2. **给出推荐方案**：按技术栈推荐最合适的测试框架，附带理由和安装命令
3. **询问用户**：
   > "⚠️ 项目未检测到可运行的测试框架。
   > 技术栈：[检测到的语言/运行时]
   > 推荐引入：**[框架名]**
   > 理由：[一句话说明为什么这个框架适合当前项目]
   > 安装方式：[命令]
   > 是否同意引入此测试框架？"

4. **用户同意** → 安装并配置测试框架，确认可运行后继续流程
5. **用户不同意** → 中断流程：
   > "⏹️ 用户选择不引入测试框架，build 流程中断。如需恢复，请先配置测试框架后重新执行 `/openflow build`。"

#### 0.3 全栈覆盖检查

**同一工作区内，变更涉及的前后端代码必须全部修改完成。**

读取 plan-ready.md 中的"改动文件"列表，检查是否同时包含前端和后端代码：

| 信号 | 示例 |
|------|------|
| 前端代码 | `src/pages/`、`components/`、`*.tsx`、`*.vue`、`*.jsx`、`store/`、`api/`（前端调用层） |
| 后端代码 | `src/controller/`、`src/service/`、`*.go`（后端）、`routes/`、`models/` |

**如果变更跨前后端**：
1. 实现计划必须包含前端和后端的所有 task
2. 不能以"XX 是独立项目"为由跳过任一侧
3. 如果某一侧的代码在另一个仓库，明确告知用户需要切换到那个仓库操作，但**本工作区内的代码必须先改完**

**如果用户问"前端改了吗"而前端在本工作区但还没改**：直接回答"还没改，现在开始改"，而不是说"前端在别的项目里"——只要代码在同一工作区可见，就必须改。

#### 0.4 生成实现计划

前置检查全部通过后，调用 `writing-plans` skill 以 test-plan.md + plan-ready.md 为输入，生成符合本项目技术栈的详细步骤。

### 1. 检测状态

检查以下文件确定当前状态：

| 检查 | 怎么查 | 结果 |
|------|--------|------|
| 有活跃变更？ | `openspec/changes/` 下非 archive 子目录 | 找到变更名 |
| 有 test-plan.md？ | 变更目录下是否存在 | 不存在→提示先 spec |
| 有 plan-ready.md？ | 变更目录下是否存在 | 不存在→提示先 spec |
| 实现已开始？ | `docs/superpowers/plans/` 下是否有对应计划文件 | 已开始→断点恢复 |

### 2. 读取目标代码和现有测试（必做，写测试桩前）

**在生成任何测试文件之前，先理解你在改什么。**

1. **读 plan-ready.md 中列出的所有"改动文件"**：逐个打开将修改的文件，理解现有实现
2. **识别全栈范围**：明确标注哪些文件是前端、哪些是后端。如果变更同时涉及前后端，记录下来——后续实现计划必须覆盖所有侧
3. **读现有测试文件**：如果目标文件已有对应测试（如 `src/auth/login.py` → `tests/auth/test_login.py`），先读懂现有测试的模式——mock 方式、断言风格、fixture 约定
4. **读一个类似的完整测试用例**：如果项目已有类似功能的测试，挑一个完整的当模板——测试桩的风格必须和它一致
5. **设计行号防漂移**：design.md 若给出方法名 + 行号，先 grep 确认该行号属于哪个方法——**方法名与行号冲突时以 grep 结果为准**（design 说改 A 方法但行号落在 B 方法，说明 design 有误，退回 amend 澄清，不要照着行号插）；按行号落点后，回读 design 声称的方法名，核对插进的代码块确实属于设计说的那个方法

**未读不用检查（必做，进入步骤 3 前）：**
- plan-ready.md 中每个 task 的 `[Assumption]` 路径必须逐个 grep/Read 确认
- 无法确认的路径**不能**在测试桩中使用——先退回到 spec 或 amend
- 如果 task 的确定性标签是 `[Assumption]`，必须先消解为 `[Verified]` 或 `[Inferred]`

做完以上检查后，你写的测试桩才能和项目现有测试风格一致，不会产生"这个测试看起来像是另一个项目写的"的问题。

### 3. 生成测试桩（test stubs）

**这是最关键的一步——把 OpenSpec scenarios 变成可运行的测试骨架。**

读取 `test-plan.md`，为每个测试用例生成测试桩：

- 测试函数名从 test-plan.md 的"测试函数"列取
- 测试文件路径从 test-plan.md 的"测试文件"列取
- 测试桩内容：setup（从 scenario 的前提条件推导）、空 assertion（标记 TODO）、一个明确的 `fail()` 或等效标记

示例（pytest）：

```python
# tests/auth/test_login.py

def test_login_with_valid_credentials():
    """REQ-001 Scenario: 正确凭据登录成功"""
    # TODO: 实现测试 - 由 build task 1 完成
    assert False, "TODO: implement test_login_with_valid_credentials"

def test_login_with_wrong_password():
    """REQ-002 Scenario: 错误密码登录失败"""
    # TODO: 实现测试 - 由 build task 1 完成
    assert False, "TODO: implement test_login_with_wrong_password"
```

生成测试桩后运行一次测试套件，确认所有新测试都 FAIL（红），这验证测试基础设施是正常工作的。

### 4. 生成详细实现计划

调用 Superpowers 的 `writing-plans` skill，以 `test-plan.md` + `plan-ready.md` 为输入，生成详细实现步骤。

**关键约束传给 writing-plans：**
- 每个 task 必须先补全对应测试用例（不新建测试文件，只补全已有测试桩）
- 补全后运行测试确认 FAIL
- 然后写实现代码
- 运行测试确认 PASS
- 全部 PASS 后才能 commit

将实现计划保存到：
```
docs/superpowers/plans/YYYY-MM-DD-<变更名>.md
```

### 5. 执行 TDD（逐 task）

**进入每个 task 前，先把阶段状态切换为 task-build 并指定当前 task**：

```bash
printf '%s\n' '{"version":1,"change":"<变更名>","phase":"build","mode":"task-build","task":"1"}' > .openflow/phase
```

task-build 是 build 的第二种受控模式：**只允许修改当前 Task 声明的实现文件与测试选择器**（plan-ready 中该 task 的 `Files:` 与 `Test cases:` 对应文件）；TDD 校验只针对当前 task 的测试选择器。一个 task 完成后，进入下一个 task 前再次切换 `task` 编号。

每个 task 按以下铁律执行：

```
Step 1: 补全测试桩 → 写真正的测试断言
Step 2: 运行测试 → 确认 FAIL（红）
Step 3: 写最小实现代码
Step 4: 运行测试 → 确认 PASS（绿）
Step 5: 可选重构
Step 6: git commit（单 task）
Step 7: 更新 plan-ready.md 中该 task 的 checkbox 为 [x]
Step 8: 更新 test-plan.md 中对应测试行的状态为 ✅
```

**迁移期旧引用**：plan-ready/test-plan 中旧的唯一 `#N` 引用可临时使用；但下次 spec/amend 编辑时必须转为稳定 ID `T-00x`。**混合 `T-id` 与 `#N`、重复、歧义引用会导致 `tdd-task-unmapped` 报错（fail-closed）**，不要混用。

**并行优化：** 如果存在多个独立 task（不共享测试文件、不依赖彼此的代码），可派子代理并行执行（参见 subagent-driven-development skill）。

**每完成一个 task，同步更新：**
- `plan-ready.md` 中该 task checkbox → `[x]`
- `test-plan.md` 中对应行 → 追加状态列 `✅ PASS`
- `tasks.md` 会在 close 阶段从 plan-ready.md 自动重新生成，build 阶段无需手动维护

### 6. 全量回归

所有 task 完成后，运行**全量测试套件**（包括已有测试），确认：

- 所有新测试 PASS
- 没有已有测试被破坏（无回归）

如发现回归，优先修复后再继续。

### 7. 完成检查与提示

**在宣布完成之前，必须逐项确认：**

1. **全栈覆盖**：回顾 0.3 的全栈范围标记——前端和后端 task 是否全部 `[x]`？如果有任一侧未完成，不能宣布完成，继续执行剩余 task
2. **全量测试回归通过**：所有新老测试 PASS，无回归
3. **所有 task checkbox 已勾选**：plan-ready.md 中无未勾选的 task

**辅助脚本**：gate.mjs `check-build-done <变更名>` 可自动检测 task 完成状态、测试 PASS 情况和 building 标记。路径推导同上（`skills/openflow/SKILL.md` → `hooks/openflow-gate.mjs`）。

全部满足后，**删除 `.openflow/building` 标记文件**（退出 build 阶段），然后输出：
> "所有实现任务已完成，测试全部通过（N 个测试覆盖 M 个场景），[前端/后端/全栈] 均已修改完毕。
> 接下来用 `/openflow verify` 做归档前验证（全量测试 + 覆盖率 + 设计一致性）。"

## 关键原则

- **每个 task 必须先写测试再写代码** — 这不是建议，是铁律
- 测试桩在 Step 2 一次性全部生成，但**只补全当前 task 对应的测试**，其他保持 TODO/fail 状态
- **不允许在 build 阶段修改规格文档** — 发现需求遗漏或规格错误时切到 `/openflow amend`
- test-plan.md 是 build 阶段的执行清单——完成的测试从 `TODO` → `PASS`
- 断点恢复：从 test-plan.md 中第一个非 PASS 的测试对应 task 继续
- 如果在 task 执行过程中发现测试计划遗漏（某些边界情况在 test-plan.md 中没有对应测试），暂停并切到 amend
- **同一工作区前后端必须全部改完** — 如果变更涉及前端和后端，两边代码都在当前工作区，则两边都必须修改完成。不能说"XX 是独立项目还没改"就跳过——代码在工作区可见就必须改。
