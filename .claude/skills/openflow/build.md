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

**以下依赖必须全部满足，缺一不可：**

1. **Superpowers writing-plans** — skills 目录下必须存在 `writing-plans/SKILL.md`
2. **测试框架** — 项目必须有可运行的测试框架（pytest/jest/go test/cargo test）

任一不满足，报错终止：
> "❌ build 阶段需要 Superpowers writing-plans 和项目测试框架。缺失: [列表]。请先安装缺失的依赖，然后重试。"

调用 `writing-plans` skill 以 test-plan.md + plan-ready.md 为输入，生成符合本项目技术栈的详细步骤。

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
2. **读现有测试文件**：如果目标文件已有对应测试（如 `src/auth/login.py` → `tests/auth/test_login.py`），先读懂现有测试的模式——mock 方式、断言风格、fixture 约定
3. **读一个类似的完整测试用例**：如果项目已有类似功能的测试，挑一个完整的当模板——测试桩的风格必须和它一致

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

### 7. 完成提示

> "所有实现任务已完成，测试全部通过（N 个测试覆盖 M 个场景）。
> 接下来用 `/openflow close` 验证测试覆盖度并归档。"

## 关键原则

- **每个 task 必须先写测试再写代码** — 这不是建议，是铁律
- 测试桩在 Step 2 一次性全部生成，但**只补全当前 task 对应的测试**，其他保持 TODO/fail 状态
- **不允许在 build 阶段修改规格文档** — 发现需求遗漏或规格错误时切到 `/openflow amend`
- test-plan.md 是 build 阶段的执行清单——完成的测试从 `TODO` → `PASS`
- 断点恢复：从 test-plan.md 中第一个非 PASS 的测试对应 task 继续
- 如果在 task 执行过程中发现测试计划遗漏（某些边界情况在 test-plan.md 中没有对应测试），暂停并切到 amend
