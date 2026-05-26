---
name: openflow/close
description: Compound lessons + archive — close only runs after verify passes, no testing here
---

# Close: 经验沉淀 + 归档

## 重要提醒

**close 阶段不可自动续接**。如果上一轮 close 被中断，本轮必须：
- 等待用户显式调用 `/openflow close`
- 或按状态检测结果路由（弹出 AskUserQuestion 让用户选择阶段）

不能因为用户说"继续"或其他回复而自动进入 close。归档是不可逆操作，每次都需要用户确认。

## 目标

verify 已经通过，这一步只做三件事：提取经验 → 同步 tasks.md → 归档。不再做任何测试或验证。

## 前置条件

- `/openflow verify` 已通过（测试全绿、覆盖率 100%、设计一致）
- `plan-ready.md` 和 `test-plan.md` 存在

不满足时提示：
> "请先完成 /openflow verify 验证。"

## 执行要求

**必须按顺序完成以下三个步骤，使用 TodoWrite 跟踪进度，每完成一步立即标记为 completed。**

步骤标记格式：
```
activeForm: "生成 lessons.md"  → 完成后标记 completed
activeForm: "同步 tasks.md"    → 完成后标记 completed
activeForm: "执行归档命令"     → 完成后标记 completed
```

**绝对不能只生成 lessons.md 就结束。归档命令必须执行。**

## 流程

### 步骤 1：Compound — 提取可复用经验

**必须使用 TodoWrite 标记此步骤为 in_progress，完成后标记为 completed。**

回顾本次变更，写 `openspec/changes/<变更名>/lessons.md`：

```markdown
# 经验记录：<变更名>

## 设计决策

| 决策 | 结果 | 说明 |
|------|------|------|
| ... | ✅/❌ | ... |

## 测试模式

| 模式 | 效果 | 代码位置 |
|------|------|----------|
| ... | ✅/❌ | tests/... |

## 踩过的坑

1. **...**：...。解决方案：...

## 可复用代码模式

- `src/...`：...
```

**质量检查（写入前必须确认）：**

- [ ] "设计决策"表至少有一行
- [ ] "踩过的坑"至少有一条——如果没有，确认：这次真的没有任何意外发现？
- [ ] 每条坑附带了**解决方案**（不只是"X 出了问题"，而是"怎么解决的"）
- [ ] 可复用代码模式附带了**具体文件路径**
- [ ] 没有流水账（"创建了项目"、"写了测试"这种不算经验）

如果本次变更规模很小、没有可提取的，可以写 "无特别经验"。

**完成后立即 TodoWrite 标记此步骤 completed，然后继续步骤 2。**

### 步骤 2：同步 tasks.md

**必须使用 TodoWrite 标记此步骤为 in_progress，完成后标记为 completed。**

执行以下命令（用 Bash 工具）：

```bash
grep -oP '### Task \d+: .+' openspec/changes/<变更名>/plan-ready.md \
  | sed 's/### /- [x] /' \
  > openspec/changes/<变更名>/tasks.md
```

**完成后立即 TodoWrite 标记此步骤 completed，然后继续步骤 3。**

### 步骤 3：归档

**必须使用 TodoWrite 标记此步骤为 in_progress。这是最关键的一步，绝对不能跳过。**

执行归档命令（用 Bash 工具）：

```bash
openspec validate <变更名> --strict
openspec archive <变更名> --yes
```

**验证归档成功：**

```bash
ls openspec/changes/archive/ | grep <变更名>
```

如果归档目录不存在，说明归档失败，必须排查原因后重试。

**完成后立即 TodoWrite 标记此步骤 completed。**

### 步骤 4：完成确认

**TodoWrite 全部三个步骤都标记为 completed 后，输出完成消息：**

> "变更 '<变更名>' 已归档到 `openspec/changes/archive/YYYY-MM-DD-<变更名>/`。经验已提取到 lessons.md，下次类似变更将自动检索到这些经验。"

**如果任何步骤未标记 completed，不能输出完成消息，必须继续执行未完成的步骤。**

## 关键原则

- close 不做测试、不做验证——那些是 verify 的事
- close 不复核代码——verify 已经通过了
- close 只做沉淀 + 归档，职责单一
- close 不可逆——归档后就只能开新 change