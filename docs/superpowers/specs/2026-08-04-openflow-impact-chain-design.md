# openflow「现状与影响面」链路追踪 + 收尾对账闸门

日期：2026-08-04

## 背景：三个真实项目的坑

在真实项目（改进页/查询粒度：GoodList 整批进页 → 单任务进页）中踩到三类坑：

1. **唯一键粒度没跟着进页粒度走**：查询/进页粒度从「整批」改「单任务」，但 `PlatformGoods` 的 localStorage `uniqueKey` 仍是批级（`sceneId-batchId-opponentPlatformId-时间`，且 `ruleGoodsOptId` 创建时恒 0 → batchId 恒 0），同场景所有任务共享同一 key → 提交任务 A 后任务 B 被误标「已提交」。根因是**设计阶段没调查改动点沿生产链路的末端（存储键）粒度**——只看了入口查询改动，没追到链路末端的提交状态存储。
2. **verify-issues 记录陈旧，close 前置条件失真**：verify 发现阻挡项 → build/amend 已修复 → 但 verify-issues.md 未重跑更新 → close 时才发现「verify 已通过」的前置条件没被正式满足。根因是 **close 闸门不读 verify-issues.md，前置条件是 AI 口头断言**。
3. **design.md 文件表与实现漂移**：设计决策改了（PlatformGoods 保留），文件表还是旧稿（删除/废弃），直到 verify 闸门 3 才暴露。根因是 **amend 多次后 design.md 文件表没同步，verify 也不对账**。

## 目标

- **坑 1 在写 design.md 之前拦截**：设计阶段强制「改动点 × 生产链路」追踪，链路末端与改动点粒度/状态一致性必须显式核对。
- **坑 2/3 在 close 之前机械拦截**：close 前置条件从「AI 声称」变成「闸门实测」。

## 核心方法论：改动点 × 生产链路

**「不要只看局部」** —— 影响面分析不是静态分类清单，而是对每个改动点沿生产链路逐跳追踪：

```
改动点（入口/处理/副作用）
  ├─ 上游/调用方：谁调它、传什么      → trace_path(inbound) / grep 调用方
  ├─ 处理内部：逻辑、状态、副作用     → 读代码
  └─ 下游/消费方：结果流向、谁消费    → trace_path(outbound / data_flow / cross_service)
       └─ 链路末端：存储键 / 提交状态 / 通知 / 下游服务
             └─ 一致性核对：末端粒度 == 改动点粒度？状态是否隔离？
```

每个改动点沿链路逐跳用 10 类 checklist 排查，**重点核对链路末端与改动点的粒度/状态一致性**。坑 1 正是「入口查询粒度改了、链路末端 localStorage 键没跟」——只看局部抓不到，追到链路末端才暴露。

## design.md「现状与影响面」章节（强制，所有变更）

design.md 必须包含以下章节（缺失 = spec 阶段未完成）：

```markdown
## 现状与影响面

### 改动点
- 改动点 1：<描述>（[Verified] 代码位置）
- 改动点 2：<描述>

### 生产链路影响（每改动点一行）
| 改动点 | 链路位置 | 上游/调用方 | 下游/消费方 | 链路末端副作用 | 端到端一致性风险 |

### 影响点分类排查（每改动点 10 行）
| 类别 | 现状 | 影响 | 证据(验证方式) | 状态 |
|------|------|------|---------------|------|
| 查询/数据加载粒度 | ... | ... | grep / trace | ✅ 已排查 / ⚠️ 需处理 / ➖ 不适用 |
| 本地状态/缓存键 | ... | ... | grep localStorage | ... |
| 状态隔离/并发 | ... | ... | ... | ... |
| 数据流/副作用 | ... | ... | ... | ... |
| 接口契约 | ... | ... | ... | ... |
| 数据结构/存储格式 | ... | ... | ... | ... |
| 依赖/调用方 | ... | ... | ... | ... |
| 性能/资源 | ... | ... | ... | ... |
| 错误/边界处理 | ... | ... | ... | ... |
| 兼容/迁移 | ... | ... | ... | ... |
```

**状态取值**：`✅ 已排查（附证据）` / `⚠️ 需处理（改动点带来的影响）` / `➖ 不适用`。不允许留空。

## 设计阶段强制点（模板改动）

- **spec.md 步骤 2「理解现有代码」**：新增「现状与影响面调查」——列出改动点 → 链路追踪（trace_path / grep 调用方）→ 10 类逐类排查 → 写入 design.md。
- **brainstorming.md 步骤 1**：探索阶段先追链路（方案取舍前就要知道改动点会碰什么）。
- **amend.md**：每次 amend 必须**同步 design.md 文件表和现状影响面**；若改动点粒度/链路变化，重跑链路追踪。

## 收尾对账闸门（机械）

### gate.mjs

- 新增子命令 `check-verify-issues`：解析 verify-issues.md，统计未解决标记，> 0 进 blockers。**未解决定义**：行内含 `❌`；或行内含 `⚠️` 且该条目后续没有 `✅ 已解决`/`✅ 已修复` 标记（按条目分组判断）。`✅ 通过` / `✅ 已解决` 视为已解决，不计。
- 新增子命令 `check-design-consistency`：提取 design.md 中出现的文件路径（「现状与影响面」章节的改动点 `[Verified]` 位置，以及文件表中显式列出的路径），与 `git diff --name-only` 对账；**表里有但没改 / 改了但不在表** → 进 blockers。design.md 无任何文件路径时跳过（视为无文件表）。
- 两者都并入 `check-close-ready`（与 proposal 格式、openspec validate、building 标记并列），**全部硬阻塞**。

### detect.mjs

- `collectVerifyIssues` 返回 `unresolved_count`（未解决标记计数）。
- 路由规则：test-plan 全 PASS + plan-ready 全 `[x]` + `unresolved_count > 0` → 建议「重跑 verify」而非 close，在路由层拦截陈旧记录。

### 模板

- **close.md**：前置条件改为「`check-close-ready` 通过（含 verify-issues 无未解决 + design 文件表一致）」。
- **verify.md 闸门 3**：对账 design.md 的现状影响面/文件表 vs 实际代码 + git，文件表漂移当场暴露并退回 amend。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `templates/spec.md` | 步骤 2 加「现状与影响面调查」；design.md 章节要求 |
| `templates/brainstorming.md` | 步骤 1 加链路追踪 |
| `templates/amend.md` | 强制同步 design.md 文件表/现状影响面；粒度变化重跑链路 |
| `templates/verify.md` | 闸门 3 对账文件表/现状影响面 vs 实际代码 + git |
| `templates/close.md` | 前置条件改为 check-close-ready 实测 |
| `hooks/gate.mjs` | 新增 `check-verify-issues`、`check-design-consistency`，并入 `check-close-ready` |
| `hooks/detect.mjs` | `collectVerifyIssues` 返回 `unresolved_count`；路由规则扩展 |

不改：`hooks/enforce.mjs`、`src/enforce/*`（OpenCode 插件，与本次无关）、`src/core/skill-generator.ts`（不新增 hook 文件，无需注册）。

## 验证方式

按 CLAUDE.md 的 /tmp 流程：`pnpm run build` → /tmp 目录 `init --tools claude` → 运行 `openflow-gate.mjs` 两个新子命令（构造含未解决 ❌ 的 verify-issues.md / 文件表漂移的 design.md 验证阻塞）、运行 `openflow-detect.mjs` 验证 `unresolved_count` 与路由。

## 不做的事（Scope 边界）

- 不做「设计阶段链路分析质量」的机械校验——闸门只能查结构/文件表/未解决标记，推理质量靠提示词强制（设计阶段拦截点已是最便宜的位置）。
- 不改 enforce.mjs 的 5 道检查（本次不涉及）。
- 不为 gate/detect 引入测试框架（项目当前无测试文件，沿用 CLAUDE.md 手动验证）。
- 不把「现状与影响面」做成独立模板文件——它作为 design.md 的一个章节，由 spec.md 指令生成。
