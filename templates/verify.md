---
name: openflow/verify
description: Verification gate before close — run tests, check coverage, validate design consistency
---

# Verify: 验证闸门

## 目标

在归档前做最终验证——不是 AI 肉眼对比，而是真实运行测试、核查覆盖率、确认设计与代码一致。**可以反复跑**（修完 build 回来再 verify），不像 close 只能跑一次。

## 中断续接规则

verify 发现的问题可以当场修：回到 build 修 bug、回到 amend 补 spec、修完再来 verify。不阻塞、不卡住。

## 前置条件

- `openspec/changes/<变更名>/plan-ready.md` 存在
- `openspec/changes/<变更名>/test-plan.md` 存在

## 流程

**进入 verify 阶段时，先设置阶段状态**：

```bash
printf '%s\n' '{"version":1,"change":"<变更名>","phase":"verify"}' > .openflow/phase
```

verify 是非 build 阶段，`phase` 不带 `mode`/`task`。若 `.openflow/phase` 已存在（续接），跳过创建。

### 1. 确认测试状态

读取 `test-plan.md`，检查所有测试行状态：
- 全部 `✅ PASS` → 继续
- 有未完成 → 提示 "还有 N 个测试未完成，请先 /openflow build"

### 2. 全量测试（闸门 1）

**必须真实运行命令并贴出输出。**

```bash
npm test          # Node
pytest -v         # Python
go test ./...     # Go
cargo test        # Rust
```

| 结果 | 处理 |
|------|------|
| 全部 PASS | ✅ 继续 |
| 有 FAIL | ❌ 回到 `/openflow build` 修复，修完重新 verify |
| 测试没法跑（环境问题） | ❌ 先修复环境，重跑后才能继续 |

### 3. 场景覆盖率（闸门 2）

读取 `test-plan.md` 的映射表，数测试函数个数，对比 `specs/` 中的 scenario 总数：

| 结果 | 处理 |
|------|------|
| 100% 覆盖 | ✅ 继续 |
| < 100% | ❌ 列出缺失场景 → 回到 `/openflow amend` 补充，修完重新 verify |

### 4. 设计一致性（闸门 3）

读取 `design.md` 的关键决策，与代码结构对比：
- 模块划分是否与设计一致？
- 关键接口是否符合约定？
- 依赖是否符合设计约束？
- **「改动文件」/文件表对账**：design.md `## 改动文件` 节中列出的路径 vs `git diff <base>...HEAD --name-only`（整个变更分支的累计改动，**不只是未提交**——已提交的改动 `git diff` 默认看不到）与实际代码——表里有但没改、或改了但不在表 → 文档漂移，退回 `/openflow amend` 同步。跨仓库路径（顶层目录不在当前工作区）不参与对账，人工核对
- **改动点归属对账（闸门 3 扩展，`check-design-consistency` 自动扫，含已提交的 base diff）**：
  - **必须先跑**：`node <base>/.claude/hooks/openflow-gate.mjs check-design-consistency <变更名>`（无本地 gate 脚本时用已安装 openflow 的全局 helpers，或退回手动对账），把输出的 warnings **逐条对到改动点上**，确认是"改动落错方法"还是"误报"后才放行——**不跑 gate 直接判通过 = 闸门 3 未执行**
  - "归属漂移" warning：design 声称的方法 vs diff 实际落点方法不一致（插错方法）——**改了没声称的方法，就是"改动落错了方法"的信号，必须追查它改了什么、design 声称的那个方法有没有**
  - "声称未落地" warning：design backtick 声称的改动目标方法，其文件有改动却无任何落点 → 未实现或已在上游提交
  - "完整性" warning：未覆盖的方法调用 design 点名的下游链路方法（命名不限同前缀）、或同前缀兄弟（带 `New`/`Old`/`V2` 后缀）共享下游调用但未覆盖
  - warning 为 0 不代表改动点都落地了（自动检测有启发式上限），逐条核验必须继续
- **改动点逐条核验（必做，最后兜底，输出固定格式）**：对 design「现状与影响面」**每一个**改动点，读对应方法的**当前代码**（读文件本身，不能只看 git diff——已提交的改动 diff 看不到），**必须输出**：
  ```
  改动点 N（design 声称改 {方法名}）：代码落点 = {实际方法名}@{行号} → ✅/❌
  ```
  格式硬约束（违反即重做）：
  - **声称改 列必须填 design 改动点里点名的具体方法名**（现状/插入点里 backtick 的方法），禁止用功能描述（"填充 XX 字段"这种不算方法名）
  - **代码落点 列必须填调用点**（`this.xxx(...)` / `xxx(...)` 的调用行），禁止填方法定义（`void xxx(...)` 那行是定义不是落点）
  硬规则：
  1. **代码落点方法 ≠ design 声称的方法名 → 判「未按设计落地」，直接退回**。反例：design 改动点说改 A 方法，但改动只接进了并行方法 ANew——填"存在"不算数，要填"在哪方法"，方法对不上就是失败
  2. design 声称改**多条路径**（含并行路径）时，**每条路径都单独输出一行落点记录**，且每条都要方法名匹配——只核验一条、或只核验"两条路径状态一致"都不算数
  3. 每个改动点涉及的并行路径（同前缀兄弟 + 命名不同但逻辑对等）逐一决定"随改"或"废弃不随改"——"随改"的给出落点记录（方法名+行号），"不随改"的在 verify-issues.md 记一句理由
- **用户确认清单（必做，verify 通过的前提）**：逐条核验完成后，把**每一个改动点**整理成清单**展示给用户**，**用户显式确认后才算闸门 3 通过**——AI 不能自判"验证通过"：
  | 改动点 | design 声称改 | 代码落点 | 方法匹配 | **AI 判断依据** | 备注 |
  |--------|--------------|---------|---------|---------|------|
  | 改动点 3 | `` `A` `` | `` `ANew` ``@行号 | ⚠️ 不匹配 | 声称方法无该改动，改动在并行路径 | gate 判定 ⚠️ |
  硬规则：
  1. **任一行 ⚠️**（方法不匹配 / 声称未落地 / 归属漂移 warning 未解释 / **gate 的 `change_point_verdicts` 判 ⚠️**）→ **不得判通过**，退回 `/openflow build` 或 `/openflow amend`，或等用户明确决定后再定
  2. **全部 ✅ 也要展示清单要用户确认**——确认是硬前提，AI 不能代替用户说"验证通过"
  3. 确认方式：展示清单后问用户"以上改动点是否全部按设计落地？"，用户明确回答"是/确认"后才算通过
  4. **「AI 判断依据」列必填**——每一行都必须给出该判定的**代码依据**（引用具体代码：方法名+行号+关键调用），不能写"实现正确""已核对"这类空话；判断依据充分到**用户能独立复核**
  5. **`check-design-consistency` 输出的 `change_point_verdicts` 必须原样展示给用户，不得改写**——其中 ⚠️ 的改动点必须逐条给判断依据（解释为何是误报，或确认为缺陷）；AI 不能用"启发式误报"一句话带过，也不能把 ⚠️ 改成 ✅
  6. **gate 的每条归属漂移/声称未落地 warning 都必须作为清单里的 ⚠️ 行出现并归属到对应改动点**——AI 不得把它们解释成 ✅、不得删除、不得只说"启发式误报"；要解除 ⚠️ 必须给出**代码证据**（调用点方法名+行号）证明该方法确属另一个已声称的改动点，否则保持 ⚠️。改动点 3 的归属漂移若指向并行路径（声称 `A`、落点 `ANew`），必须标 ⚠️ 而不是 ✅
- **design.md 是否含「现状与影响面」章节**：缺失 → 退回 amend 补

| 结果 | 处理 |
|------|------|
| 一致 | ✅ 继续 |
| 不一致 | ⚠️ 记录到 `verify-issues.md`，根据严重程度决定是否阻塞 |

设计不一致不一定阻塞归档——如果实现比设计更好，可以 amend 更新 design.md 后重来。如果是实现偏离设计且更差，回到 build 修复。

### 5. 场景断言核对（闸门 4）

覆盖率 100% 不代表测试写对了——例如 scenario 说"错误写入 stderr"但测试检查的是 stdout。

这一步逐条核对：读取 test-plan.md 中每个场景的原始 scenario 文本（来自 `specs/`），再读取对应测试函数，确认断言方向和验收条件一致。

- 挑 1-2 个最关键的 scenario 做深度核对（不用全部，但关键路径必须查）
- 核对结果写在 verify-issues.md 中：`#1 ✅ 断言匹配 / #2 ⚠️ 测试 check stdout 但 scenario 要求 stderr`
- 发现不匹配 → 回到 build 修正测试

### 6. 写入验证凭据（write-verify-receipt）

闸门全部通过、**改动点确认清单已展示给用户并获显式确认**后，把验证结果写入 receipt（`verify-result.json`）：

1. 把验证结果**直接写入 `openspec/changes/<变更名>/verify-result.json`**——这是 verify 阶段的允许写入路径（见阶段写入边界），也是指纹的自污染排除路径（receipt 前的写入不会让指纹变 stale），字段与 gate 校验严格对应：

   ```bash
   cat > openspec/changes/<变更名>/verify-result.json <<'EOF'
   {
     "testRuns": [{ "name": "full-suite", "exitCode": 0 }],
     "scenarioCoverage": { "mapped": 3, "total": 3 },
     "designConsistency": { "pass": true, "blockers": [] },
     "userConfirmation": { "received": true }
   }
   EOF
   ```

   规则：
   - `testRuns`：必须 ≥1 个 `exitCode: 0` 的真实测试运行记录
   - `scenarioCoverage`：`mapped === total` 且 ≥1（全场景覆盖）
   - `designConsistency`：`blockers` 必须为空
   - `userConfirmation`：`received` 必须为 true——**用户显式确认改动点清单后**才填，AI 不能自填

2. 运行已安装客户端的 `write-verify-receipt` 子命令（路径推导：把 SKILL.md 路径中的 `skills/openflow/SKILL.md` 替换为 `hooks/openflow-gate.mjs`，无本地 hook 时用已安装 openflow 的全局 helpers），**input 路径就是上面的 `verify-result.json`**：

   ```bash
   node <base>/.claude/hooks/openflow-gate.mjs write-verify-receipt <变更名> openspec/changes/<变更名>/verify-result.json
   ```

   gate 会：读取该 JSON 校验四个字段 → 复核 verify 前置条件（含 building 标记残留检查）→ 收集最终工作区指纹 → **原子替换**同一 `verify-result.json` 路径。输出 JSON 的 `pass` 指示是否成功。

3. **只有 `pass: true` 才切换阶段为 close**：

   ```bash
   printf '%s\n' '{"version":1,"change":"<变更名>","phase":"close"}' > .openflow/phase
   ```

   失败则回到对应闸门修复后重跑 verify（verify 可反复跑），不要硬写 phase。receipt 绑定当前工作区指纹，receipt 后任何代码改动都会使 `check-verify-ready` 失败（stale）——归档前若有改动需重新 verify。

### 7. 通过

**前提：`write-verify-receipt` 已成功（receipt 有效）且 phase 已切到 close。**

> "✅ 验证通过：N/N 测试 PASS，M/M 场景覆盖（100%），改动点清单已确认，verify-result.json 已写入。
> 接下来用 `/openflow close` 归档（close 阶段执行 `archive-verified`，不再做测试）。"

## 关键原则

- verify 可以反复跑——不像 close 有"不能改代码"的限制
- 发现问题直接退回对应阶段修，不需要绕道 close-issues.md
- 测试必须真实运行并看到输出——不能用"应该都通过了"这种话
- **改动点落地核验与测试同等重要**——测试可能全量全绿但改动落在错误方法（改动点声称改 A、代码在 ANew，而测试只直测 helper）；这是真实事故，不是理论
- **AI 不能代替用户判"验证通过"**——改动点清单必须展示给用户、用户显式确认后才是通过；AI 判"误报"不作数，用户确认才算数
