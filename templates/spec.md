---
name: openflow/spec
description: Call OpenSpec to generate specs + translate to plan-ready.md, auto-generate test-plan.md from scenarios
---

# Spec: 生成规格、测试计划、实现计划

## 目标

调用 OpenSpec 生成完整规格文档，然后做两件事：
1. 从 scenarios 自动生成 `test-plan.md`（这是 OpenSpec → Superpowers TDD 的桥梁）
2. 将规格翻译为 `plan-ready.md`（这是 Superpowers 执行的输入）

## 中断续接规则

如果用户在本阶段被打断后继续回复、补充范围、要求调整规格、或确认规格摘要，仍然停留在 spec 阶段。只更新 `openspec/changes/**`、`test-plan.md` 与 `plan-ready.md`，不要修改任何代码或实现文件。

## 前置条件

- `openspec/changes/` 下存在活跃变更目录（由 proposal 或 brainstorming 阶段创建）
- 变更目录下至少有 `proposal.md`

## 流程

### 1. 确认活跃变更

检查 `openspec/changes/` 下是否有活跃变更（非 archive 子目录）。

如果没有，提示用户：
> "还没有活跃变更。请先用 /openflow proposal 或 /openflow brainstorming 创建需求。"

如果有多个，列出并让用户选择：
> "检测到多个活跃变更：[列表]。要对哪个生成规格？"

### 2. 理解现有代码（必做，生成设计前）

**设计不能悬空——必须先读懂现有架构再写 design.md。**

1. **读相关模块的入口文件**：根据 proposal 中描述的功能范围，找到涉及的模块/组件，读入口文件和核心函数
2. **读现有测试**：了解测试目录结构、测试框架、测试模式（怎么 mock、怎么 setup），这是后续生成 test-plan.md 的基础
3. **读相似功能的已有实现**：如果项目中有类似功能的实现，读它的 design.md（如果有）或代码结构——保持设计语言一致
4. **检索沉淀经验（Compound 闭环）**：
   ```bash
   grep -r "<关键词>" openspec/changes/archive/ --include="lessons.md" -l
   grep -r "<关键词>" openspec/changes/archive/ --include="design.md" -l
   openspec list --specs 2>/dev/null | grep -i "<关键词>"
   ```
   如果找到相关的 lessons.md，重点关注"设计决策"表中的 ❌ 决策和"踩过的坑"——不要在新的设计里重蹈覆辙。如果找到相关的 design.md，关注它的架构选型理由——你的设计应该和它保持一致或明确说明为什么不同。

做完以上检查后再进入第 3 步生成 OpenSpec 文件。

**确定性检查（必做，进入步骤 3 之前）：** 汇总所有 `[Assumption]` 和 `[Unknown]` 标签的条目，逐条消解或标记。对于 design.md 中将引用的任何文件路径/模块名/函数名，必须确认其存在（未读不用铁律）。

### 3. 生成 OpenSpec 规格文件

根据 proposal.md 的内容生成或补齐以下文件：

- `openspec/changes/<变更名>/proposal.md` — 已存在，可补充
- `openspec/changes/<变更名>/design.md` — 技术方案
- `openspec/changes/<变更名>/specs/` — 具体规格变更（标记新增/修改/删除）
- `openspec/changes/<变更名>/tasks.md` — 占位，close 阶段从 plan-ready.md 自动生成，无需手动维护

**Delta 操作类型选择规则：**

在 `specs/<capability>/spec.md` 中使用 `## ADDED Requirements`、`## MODIFIED Requirements` 等操作头。选择规则：

| 操作 | 使用条件 | 示例 |
|------|----------|------|
| `## ADDED` | 主 specs 目录中不存在该 capability | 新功能、新模块 |
| `## MODIFIED` | 主 specs 目录中已存在该 capability，修改现有 requirement | 改现有功能行为 |
| `## REMOVED` | 删除已有的 requirement | 废弃功能 |
| `## RENAMED` | 仅改名，行为不变 | requirement 名称调整 |

**判断方法**：生成前先检查 `openspec/specs/<capability>/spec.md` 是否存在：
```bash
ls openspec/specs/<capability>/spec.md 2>/dev/null && echo "存在，可 MODIFIED" || echo "不存在，必须 ADDED"
```

如果不确定是否存在，**默认用 ADDED**——openspec archive 会校验，MODIFIED 要求 target spec 必须存在。

**关键要求**：specs/ 中每个 requirement 必须至少有一个 `#### Scenario:`，且 scenario 描述必须包含**可验证的预期行为**（给定-当-那么 或 输入-输出 格式）。这是后续自动生成测试计划的输入源。

如果 OpenSpec CLI 可用，生成后运行校验：

```bash
openspec validate <变更名> --strict
```

如果校验失败，根据错误修正上述文件后重新校验。

### 4. 与用户确认规格（快速对齐）

展示规格摘要，让用户快速确认方向正确：

> "以下是规格摘要：
> - **提案**：[proposal.md 核心内容]
> - **设计**：[design.md 核心决策]
> - **任务**：[tasks.md 任务列表]
> - **场景覆盖**：[共 N 个 scenario]
>
> 方向是否正确？有需要调整的地方吗？"

**注意**：这只是快速对齐，后续步骤 7 会进行详细的代码逻辑核对。如果用户在此步骤提出修改，修正后继续流程。

### 5. 自动生成 test-plan.md（场景→测试映射，桥梁层）

这是 OpenSpec 和 Superpowers 产生真正互补的关键步骤。

遍历 `specs/` 目录下所有文件，提取每个 `#### Scenario:` 及其所属 requirement，生成测试计划。

**生成规则：**
1. 每个 scenario 对应 1 个测试用例（函数/方法）
2. 测试用例名称从 scenario 标题派生（snake_case）
3. 测试内容从 scenario 描述推导（给定条件 → test setup，期望结果 → assertion）
4. 测试文件路径根据项目约定自动推断（见下方）

`openspec/changes/<变更名>/test-plan.md` 格式：

```markdown
# 测试计划：<变更名>

## 测试映射

<!--
  每一行 = 一个场景 → 一个测试用例
  build 阶段严格按此映射执行 TDD，不得跳过或合并
-->

| # | 来源 Requirement | Scenario | 测试文件 | 测试函数 | 类型 |
|---|-----------------|----------|----------|----------|------|
| 1 | REQ-001: 用户登录 | 正确凭据登录成功 | `tests/auth/test_login.py::test_login_with_valid_credentials` | `test_login_with_valid_credentials` | 功能 |
| 2 | REQ-001: 用户登录 | 错误密码登录失败 | `tests/auth/test_login.py::test_login_with_wrong_password` | `test_login_with_wrong_password` | 功能 |
| 3 | REQ-002: 会话管理 | Token过期自动刷新 | `tests/auth/test_session.py::test_token_expiry_triggers_refresh` | `test_token_expiry_triggers_refresh` | 集成 |

## 统计

- 总场景数：N
- 单元测试：M
- 集成测试：K
- 测试文件数：J
```

**测试文件路径推断规则：**
- 检查项目现有测试目录结构（`tests/`、`__tests__/`、`spec/` 等）
- 检查项目使用的测试框架（pytest、jest、go test 等）
- 根据变更涉及的文件路径推导对应的测试文件路径
- 如果不确定，在 test-plan.md 顶部加 `<!-- TEST_DIR_HINT: tests/ -->` 标记

### 6. 生成 plan-ready.md（实现计划）

以 test-plan.md 和 OpenSpec 文档为输入，生成可执行的实现计划。

**格式要求（与旧版的关键区别——每个 task 带追溯信息）：**

```markdown
# 实现计划：<变更名>

## 来源
- 提案：openspec/changes/<变更名>/proposal.md
- 设计：openspec/changes/<变更名>/design.md
- 规格：openspec/changes/<变更名>/specs/
- 任务：openspec/changes/<变更名>/tasks.md
- 测试计划：openspec/changes/<变更名>/test-plan.md
```

每个 task 必须包含以下字段：

```markdown
### Task 1: <任务名>
- 目标：<做什么>
- 改动文件：<文件路径 [Verified] 或 [Assumption: 需确认路径]>
- 覆盖场景：<test-plan.md 中的 #编号，如 #1, #2>
- 测试先行：<先写哪个测试，在哪个文件 [Verified]>
- 验证方式：<运行什么测试命令，预期结果>
- 确定性：<[Verified] / [Inferred] / [Assumption] — 本 task 的整体确定性>
```

**确定性标签规则：**
- `[Verified]` = 所有改动文件和测试文件路径均已通过 grep/Read 确认存在
- `[Inferred]` = 路径从现有代码模式推导，但未逐文件确认
- `[Assumption]` = 至少一个文件路径是猜测的——build 阶段执行前必须先确认
- 如果 task 有 ≥2 个 `[Assumption]`，应拆分或回到步骤 2 补读代码

**翻译规则：**
1. 每个 task 必须绑定至少 1 个 test-plan 场景编号
2. 每个 task 必须在"测试先行"字段指明先写哪个测试
3. 按执行依赖排序，不按功能模块排序
4. 同一个测试文件里的测试尽量归到同一个 task

### 7. 代码逻辑深度核对与修正（循环直到无问题）

**这是 spec 阶段最关键的关口。步骤 2 已经理解了架构，这一步要深度验证生成的文档与实际代码逻辑是否完全匹配。**

**态度要求**：
- **慢下来**——不要快速扫过，逐行比对 spec 描述与代码实现
- **怀疑一切**——假设每个方法都可能有 bug，直到你用 grep/Read 证明它正确
- **推演边界**——正常路径容易对，边界值（0、null、跨天、并发）才是 bug 藏身之处
- **记录证据**——每个结论都要有 grep/Read 的输出作为证据，不能凭印象

#### 7.1 逻辑正确性深度验证

**必须读取实际代码，逐方法验证 spec 中描述的逻辑是否正确。**

| 检查项 | 方法 | 示例 |
|--------|------|------|
| 方法行为与 spec 一致 | 读取方法实现，逐行对比 spec 的 WHEN/THEN | spec 说"targetHour=10 时删除窗口为 10:00-11:00"，代码是否真的用 targetHour 计算？ |
| 参数传递正确 | 追踪参数从调用方到被调用方的完整链路 | 调用方传的是 currentHour 还是 targetHour？中间有没有被覆盖？ |
| 计算逻辑正确 | 手动推演边界值，写下来对比 | getCurrentHourStartSeconds() 在 9:50 运行时返回几点？ |
| 状态转换正确 | 检查状态机或条件分支的每个出口 | 从状态 A 到状态 B 的条件是否完整？有没有遗漏的 else？ |
| 返回值正确 | 检查每个 return 语句 | 返回的是新值还是旧值？单位是秒还是毫秒？ |

**必须执行的验证步骤：**

```bash
# 1. 读取要修改的方法完整实现（不要只看签名）
grep -n "methodName" path/to/file.java -A 30

# 2. 追踪参数来源——从调用方一路追到被调用方
grep -rn "methodName" src/ --include="*.java" -B 5

# 3. 对于时间/数值相关逻辑，手动推演边界值并记录
# 例如：9:50 运行，targetHour=10
# getCurrentHourStartSeconds() → Calendar.getInstance() → 9:00 ❌ 错误！
# getTargetHourStartSeconds(10) → 10:00 ✅ 正确
```

#### 7.2 调用关系深度验证

| 检查项 | 方法 | 判定标准 |
|--------|------|----------|
| 方法被谁调用 | `grep -rn "methodName" src/` | 列出**所有**调用方，不能遗漏 |
| 调用方是否安全 | 读取每个调用方的上下文（前后 10 行） | 不会因为改动导致其他调用方出问题 |
| 是否有隐藏调用 | 检查反射、动态调用、接口实现、Spring 注入 | 不能遗漏 |
| 调用链路完整 | 追踪 A→B→C 的完整调用链 | 中间环节有没有转换参数？ |

**输出格式：**

```markdown
#### 调用关系分析

`checkSend(ResTaskSceneEntity)` 调用方：
- ResTaskSendVersion4Scheduler.process() ✅ 唯一调用方
  - 上下文：在 for 循环中调用，传入 scene 对象
  - 改动影响：仅影响该调度器，安全

`triggerWithNow` 执行条件：
- 仅在"所有场景"分支执行 ✅
- 手动指定 confId/sceneId 时不触发 ✅
- 验证方式：grep "triggerWithNow" 确认只有 1 处调用
```

#### 7.3 边界条件深度验证

| 检查项 | 方法 | 示例 |
|--------|------|------|
| 时间边界 | 手动推演 23:59、00:00、跨天、跨月、闰年 | 23:50 运行 targetHour=0 时行为正确？ |
| 数值边界 | 检查 < vs <=、> vs >=、溢出 | targetHour >= beginHour && targetHour < endHour（左闭右开） |
| 空值/缺失 | 检查 null/undefined/空集合处理 | 配置不存在时是否有默认值？会不会 NPE？ |
| 并发边界 | 检查锁、竞态条件、幂等性 | 两个实例同时运行会怎样？会不会重复处理？ |
| 类型边界 | 检查类型转换、精度丢失 | long 转 int 会不会溢出？浮点数比较用 ==？ |

**边界条件推演表（必须手写，不能跳过）：**

```markdown
| 场景 | 输入 | 预期行为 | 代码实际行为 | 验证方式 | 匹配 |
|------|------|----------|-------------|----------|------|
| 正常时间 | 9:50, targetHour=10 | 窗口 10:00-11:00 | getTargetHourStartSeconds(10) → 10:00 | grep + 推演 | ✅ |
| 跨天 | 23:50, targetHour=0 | 窗口 0:00-1:00 | getTargetHourStartSeconds(0) → 0:00 | grep + 推演 | ✅ |
| 边界包含 | 10:00:00 | 包含在窗口内 | >= start && < end | 读代码确认 | ✅ |
| 边界排除 | 11:00:00 | 不包含在窗口内 | >= start && < end | 读代码确认 | ✅ |
| 空配置 | 配置不存在 | 不抛异常 | 检查 null 处理 | grep "null" | ✅ |
```

#### 7.4 完整性与一致性验证

| 检查项 | 方法 | 判定标准 |
|--------|------|----------|
| proposal 需求覆盖 | 逐条对比 proposal.md 的"变更内容"与 specs/ | 每条变更都有对应 requirement |
| requirement 有 scenario | 检查 specs/ 中每个 requirement | 每个都有 `#### Scenario:` |
| scenario 可测试 | 检查每个 scenario 是否有明确的 WHEN/THEN | 不能模糊描述 |
| test-plan 覆盖 | 对比 specs/ 中的 scenario 与 test-plan.md | 每个 scenario 都有对应测试行 |
| plan-ready 覆盖 | 对比 test-plan.md 与 plan-ready.md 的 task | 每个测试行都被某个 task 覆盖 |
| design 与 specs 一致 | 对比 design.md 的技术决策与 specs 的 requirement | 不能矛盾 |
| 测试类型匹配 | 检查 test-plan.md 的"类型"列与测试文件位置 | 单元测试不在集成目录 |
| 任务顺序合理 | 检查 plan-ready.md 的 task 依赖关系 | 被依赖方排在前面 |

#### 7.5 依赖注入验证

| 检查项 | 方法 | 判定标准 |
|--------|------|----------|
| 依赖已注入 | 检查 @Autowired/@Inject/@Resource | 所有需要的依赖都已注入 |
| 注入方式正确 | 检查构造器注入 vs 字段注入 | 符合项目约定 |
| 无需新增依赖 | 对比 design.md 与实际代码 | 不需要额外注入 |

#### 7.6 修正循环

```mermaid
开始检查
    ↓
发现问题？ ──否──→ 输出核对报告，进入步骤 8
    │
   是
    ↓
记录问题（含问题描述、影响范围、修复方案）
    ↓
修正对应文档（specs/、design.md、test-plan.md、plan-ready.md）
    ↓
回到 7.1 重新检查（必须完整重新检查，不能只检查修改部分）
```

**修正规则：**
- 发现逻辑错误 → 修正 design.md 和 plan-ready.md，更新描述，记录修复原因
- 发现调用关系遗漏 → 更新 design.md 影响范围分析
- 发现边界条件遗漏 → 更新 specs/ 补充 scenario，更新 test-plan.md
- 发现需求遗漏 → 回到步骤 3 补充 requirement/scenario
- **每次修正后必须重新运行完整检查，不能只检查修改部分**
- **同一个问题最多修正 2 次，第 3 次必须换思路（铁律 4）**

**检查输出格式（必须完整输出，不能省略）：**

```markdown
## 核对报告

### 代码逻辑 ✅/❌
- [ ] 方法行为与 spec 一致
  - methodA: [验证结果 + 证据]
  - methodB: [验证结果 + 证据]
- [ ] 参数传递正确
  - paramX: 从 callerA 传入，经 methodB 处理，最终... [证据]
- [ ] 调用关系安全
  - methodA: 被 callerX 调用，改动影响范围... [证据]
- [ ] 边界条件正确
  | 场景 | 输入 | 预期 | 实际 | 匹配 |
  |------|------|------|------|------|
  | ... | ... | ... | ... | ✅/❌ |
- [ ] 依赖注入完整

### 完整性 ✅/❌
- [ ] proposal 需求 N/N 覆盖
- [ ] requirement 全部有 scenario
- [ ] scenario 全部可测试
- [ ] test-plan 覆盖全部 scenario
- [ ] plan-ready 覆盖全部测试

### 一致性 ✅/❌
- [ ] design 与 specs 一致
- [ ] 测试类型匹配
- [ ] 任务顺序合理

### 修复记录
（如有修复，列出：问题描述 → 影响范围 → 修复内容 → 重新验证结果）

**结论**：全部通过 / 发现 N 个问题（已修正并重新检查通过）
```

**只有核对报告全部通过后，才能进入步骤 8。**

### 8. 提示下一步

> "规格已确认，test-plan.md（N 个场景映射到 M 个测试用例）和 plan-ready.md 已生成。"
> 
> **审批门（不可跳过）：** 在用户明确批准 design.md 和 plan-ready.md 之前，**不得进入 build 阶段**。即使用户说"开始写代码"或"就这样做"，也必须先把规格摘要展示给用户并等待确认。
>
> 审批确认后提示："> 接下来用 `/openflow build` 开始 TDD 实现——每个 task 都会先写测试再写代码。"

## 关键原则

- **一条代码都不许写** — spec 阶段只产出文档和测试计划
- test-plan.md 是本阶段最重要的产出：它是 OpenSpec scenarios 和 Superpowers TDD 之间的**可验证桥梁**
- 每个 scenario 必须有对应测试——如果某个 scenario 无法映射到测试，回到步骤 3 修正 scenario 描述
- plan-ready.md 中每个 task 的"覆盖场景"字段是 close 阶段验证追溯的锚点
- 按执行依赖排序是翻译的关键步骤：先依赖后依赖方
- **步骤 7 代码核对不可跳过** — 所有文档生成后必须与实际代码逻辑核对，发现问题是常态，修正后重新检查是正常流程
