---
name: openflow/close
description: Compound lessons + archive — close only runs after verify passes, no testing here
---

# Close: 经验沉淀 + 归档

## 目标

verify 已经通过，这一步只做三件事：提取经验 → 同步 tasks.md → 归档。不再做任何测试或验证。

## 前置条件

- `/openflow verify` 已通过（测试全绿、覆盖率 100%、设计一致）
- `plan-ready.md` 和 `test-plan.md` 存在

不满足时提示：
> "请先完成 /openflow verify 验证。"

## 流程

### 1. Compound：提取可复用经验

**这是让每个变更产生复利的关键步骤。** 不能只归档文档——要把这次踩的坑、验证有效的模式提取出来，让下一次 proposal/spec 阶段自动检索到。

回顾本次变更，写 `openspec/changes/<变更名>/lessons.md`：

```markdown
# 经验记录：<变更名>

## 设计决策

<!-- 哪些设计选择被验证是正确的？哪些需要重新考虑？ -->

| 决策 | 结果 | 说明 |
|------|------|------|
| ... | ✅/❌ | ... |

## 测试模式

<!-- 哪些测试模式有效？哪些不够？ -->

| 模式 | 效果 | 代码位置 |
|------|------|----------|
| ... | ✅/❌ | tests/... |

## 踩过的坑

<!-- 下次做类似变更时，应该避免什么？ -->

1. **...**：...。

## 可复用代码模式

<!-- 有没有值得后续参考的通用模式？ -->

- `src/...`：...。
```

**质量检查：**

- [ ] "设计决策"表至少有一行
- [ ] "踩过的坑"至少有一条——如果没有，确认：这次真的没有任何意外发现？
- [ ] 每条坑附带了**解决方案**（不只是"X 出了问题"，而是"怎么解决的"）
- [ ] 可复用代码模式附带了**具体文件路径**
- [ ] 没有流水账（"创建了项目"、"写了测试"这种不算经验）

如果本次变更规模很小、没有可提取的，可以写 "无特别经验"。

### 2. 同步 tasks.md

```bash
grep -oP '### Task \d+: .+' openspec/changes/<变更名>/plan-ready.md \
  | sed 's/### /- [x] /' \
  > openspec/changes/<变更名>/tasks.md
```

### 3. 归档

```bash
openspec validate <变更名> --strict
openspec archive <变更名> --yes
```

### 4. 完成

> "变更 '<变更名>' 已归档。经验已提取到 lessons.md，下次类似变更将自动检索到这些经验。"

## 关键原则

- close 不做测试、不做验证——那些是 verify 的事
- close 不复核代码——verify 已经通过了
- close 只做沉淀 + 归档，职责单一
- close 不可逆——归档后就只能开新 change
