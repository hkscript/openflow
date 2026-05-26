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

### 6. 通过

> "✅ 验证通过：N/N 测试 PASS，M/M 场景覆盖（100%），设计无冲突。
> 接下来用 `/openflow close` 归档。"

## 关键原则

- verify 可以反复跑——不像 close 有"不能改代码"的限制
- 发现问题直接退回对应阶段修，不需要绕道 close-issues.md
- 测试必须真实运行并看到输出——不能用"应该都通过了"这种话
- 设计一致性是补充检查，以测试通过为主要判断依据
