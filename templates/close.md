---
name: openflow/close
description: Verify test coverage against spec scenarios and archive — tests passing = requirements met
---

# Close: 测试覆盖验证 + 归档

## 目标

以测试为证——验证每个 scenario 都有对应的 PASS 测试，确认实现与规格一致，然后归档。

## 中断续接规则

close 阶段不允许顺手修代码。发现差异只记录到 `close-issues.md`，不开新的实现分支。

## 前置条件

- `docs/superpowers/plans/` 下的实现计划全部 checkbox 已勾选
- `openspec/changes/<变更名>/test-plan.md` 存在且所有测试标记为 PASS
- `openspec/changes/<变更名>/plan-ready.md` 存在

## 流程

### 1. 确认测试状态

读取 `test-plan.md`，检查所有测试行状态：

- 全部 `✅ PASS` → 继续验证
- 有未完成测试 → 提示：
  > "test-plan.md 中还有 N 个测试未标记完成。请先用 /openflow build 完成实现。"

### 2. 运行全量测试（自动化验证，不可跳过）

**这是 close 阶段最重要的步骤。** 不是检查 test-plan.md 的 PASS 标记，而是**真的在终端里跑命令看输出**。

```bash
# 根据项目类型自动选择命令
npm test          # Node
pytest -v         # Python
go test ./...     # Go
cargo test        # Rust
```

**必须把命令的实际输出贴出来。** 不能用 "应该都通过了" 这种话——看到哪里 FAIL 就是 FAIL，看到全部 PASS 才算通过。

检查输出：
- 全部测试 PASS → ✅
- 有一个 FAIL → ❌，记录到 close-issues.md，**停止归档**
- 测试没跑（环境问题）→ ❌，修复环境后重跑，不能跳过

### 3. 验证场景覆盖率

对比 `test-plan.md` 的映射表和 specs/ 中的 scenario 总数：

```
覆盖率 = test-plan.md 中的测试数 / specs/ 中的 scenario 总数
```

如果覆盖率 < 100%，列出缺失的场景并记录到 close-issues.md。

如果覆盖率 = 100% 且全部 PASS，在宣布完成之前先做反幻觉检查：

> "测试全部通过了。但——有没有可能测试测了错误的场景？有没有 scenario 的验收条件实际上没有被测试覆盖到，只是形式上 PASS 了？有没有边界条件在 specs/ 里写了但 test-plan.md 漏了？"

如果以上任何问题的答案是"有可能"，回到 amend 补充测试或修改 scenario，不能直接归档。

如果确认无误：

> "✅ 所有 N 个 scenario 均有对应测试且全部通过——实现与需求一致。"

### 4. 验证设计一致性（补充检查）

虽然测试通过是主要验证手段，仍做轻量设计一致性检查：

先读关键代码文件，再对比 `design.md`：

1. **读取 design.md 中提到的关键文件**：设计文档中标注的核心模块、接口文件，打开快速浏览
2. **对比关键决策**：
   - 模块划分是否与设计一致？
   - 关键接口是否符合 design.md 约定？
3. **不一致的处理**：记录到 close-issues.md，不阻塞归档（以测试通过为准）

不一致项记录到 close-issues.md，不阻塞归档（以测试通过为准）。

### 5. 处理不一致

如果有不一致或未覆盖：
- **不在 close 阶段改代码**
- 写入 `openspec/changes/<变更名>/close-issues.md`

根据问题类型选择恢复路径：

| 问题 | 下一步 |
|------|--------|
| 测试 FAIL（实现 bug） | 回到 `/openflow build` — 从 test-plan.md 中第一个 FAIL 的测试继续 |
| 覆盖率 < 100%（遗漏 scenario） | 回到 `/openflow amend` — 补充 scenario，重新生成 test-plan.md |
| 设计不一致（代码偏离 design.md） | 回到 `/openflow amend` — 更新 design.md 并追加 task |
| 测试本身有问题（测错了东西） | 回到 `/openflow build` — 修正测试，重新验证 |

提示用户：
> "发现 N 个问题，已记录到 close-issues.md。建议：<上述对应恢复路径>。"

### 6. Compound：提取可复用经验（知识沉淀）

**这是让每个变更产生复利的关键步骤。** 不能只归档文档——要把这次踩的坑、验证有效的模式提取出来，让下一次 proposal/spec 阶段自动检索到。

回顾本次变更，写 `openspec/changes/<变更名>/lessons.md`：

```markdown
# 经验记录：<变更名>

## 设计决策

<!-- 哪些设计选择被验证是正确的？哪些需要重新考虑？ -->

| 决策 | 结果 | 说明 |
|------|------|------|
| 使用 Redis 缓存 session | ✅ 正确 | 命中率 95%，延迟降低 80% |
| 前端直接调用第三方 API | ❌ 应在后端代理 | 暴露了 API key，下次需要改 |

## 测试模式

<!-- 哪些测试模式有效？哪些不够？ -->

| 模式 | 效果 | 代码位置 |
|------|------|----------|
| fixture 预填充测试数据 | ✅ 有效 | tests/conftest.py |
| mock 外部 API 调用 | ✅ 有效 | tests/test_auth.py |

## 踩过的坑

<!-- 下次做类似变更时，应该避免什么？ -->

1. **数据库迁移与代码部署顺序**：先加列（允许 NULL），部署代码，再回填数据，最后加 NOT NULL。本次先加了 NOT NULL 导致部署失败。
2. **测试中时区问题**：CI 服务器 UTC 与本机时区不一致，测试断言用绝对时间会 flaky。应使用相对时间或 freeze time。

## 可复用代码模式

<!-- 有没有值得后续参考的通用模式？ -->

- `src/utils/retry.py`：带指数退避的重试装饰器，适合所有外部 API 调用
```

**写 lessons.md 的原则：**
- 不要流水账——只记对下一次有指导意义的
- 每条记录要具体到文件路径、代码行、数字
- 用表格和列表，方便 grep 和 AI 解析
- 如果本次变更规模很小、没有可提取的，可以写 "无特别经验"

### 7. 同步 tasks.md

tasks.md 是 OpenSpec 的格式约定，内容从 plan-ready.md 派生。一行搞定：

```bash
grep -oP '### Task \d+: .+' openspec/changes/<变更名>/plan-ready.md \
  | sed 's/### /- [x] /' \
  > openspec/changes/<变更名>/tasks.md
```

### 8. 归档

全部通过后，先校验：

```bash
openspec validate <变更名> --strict
```

校验通过后归档：

```bash
openspec archive <变更名> --yes
```

如果 OpenSpec CLI 不可用，手动归档：

```bash
mkdir -p openspec/changes/archive
mv openspec/changes/<变更名> openspec/changes/archive/$(date +%Y-%m-%d)-<变更名>/
```

### 9. 完成提示

> "变更 '<变更名>' 已验证（N/N 测试通过，100% 场景覆盖），经验已提取到 lessons.md，已归档。下次类似变更将自动检索到这些经验。"

## 关键原则

- **测试通过 = 需求满足** — 这是 close 验证的核心理念。不必猜测代码是否实现了规格，测试结果说明一切
- close 阶段不做代码修改，只做验证和归档
- 不一致先记录到 close-issues.md，不现场修复
- test-plan.md 是 close 验证的 checklist——每行对应一个可验证的事实
