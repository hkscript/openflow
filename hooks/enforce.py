#!/usr/bin/env python3
"""openflow enforcement hooks — 三道硬防火墙
用法: 由 Claude Code hooks 机制自动调用（PreToolUse），stdin 接收工具调用的 JSON
返回值: 0 = 放行, 非0 = 拦截
"""

import json
import os
import sys


# ============================================================
# 防火墙 1: 未读不用 — Edit 的对象必须存在
# ============================================================
def check_file_exists(tool_name, file_path, cwd):
    if tool_name != "Edit":
        return True

    if "openspec/" not in file_path:
        return True

    absolute_path = os.path.join(cwd, file_path)
    if not os.path.isfile(absolute_path):
        print(f"❌ [openflow 防火墙 1: 未读不用] Edit 的目标文件不存在: {file_path}")
        print("   你可能在编造一个不存在的文件路径。请先用 ls/grep 确认文件存在。")
        return False
    return True


# ============================================================
# 防火墙 2: 不确定就说 — [Assumption] 标签警告
# ============================================================
def check_certainty_tags(file_path, content):
    if not content:
        return True

    fname = os.path.basename(file_path)
    if "plan-ready" not in fname and "test-plan" not in fname:
        return True

    count = content.count("[Assumption]")
    if count > 0:
        print(f"⚠️  [openflow 防火墙 2: 不确定就说] {file_path} 包含 {count} 个 [Assumption] 标签")
        print("   build 阶段执行前必须消解为 [Verified] 或 [Inferred]")
        if count >= 2:
            print("   ❌ 超过 1 个 [Assumption]，建议拆分 task 或回到 spec 阶段补读代码")
    return True


# ============================================================
# 防火墙 3: 阶段写入边界 — build 阶段不能改规格文档
# ============================================================
def check_phase_boundary(file_path, cwd):
    if "openspec/changes/" not in file_path:
        return True

    parts = file_path.split("openspec/changes/")
    if len(parts) < 2:
        return True

    change_name = parts[1].split("/")[0]
    if not change_name:
        return True

    change_dir = os.path.join(cwd, "openspec", "changes", change_name)
    test_plan = os.path.join(change_dir, "test-plan.md")

    if not os.path.isfile(test_plan):
        return True

    try:
        with open(test_plan) as f:
            tp_content = f.read()
    except Exception:
        return True

    has_pending = "TODO" in tp_content or "FAIL" in tp_content
    if not has_pending:
        return True

    # build 阶段的规格文件写保护
    protected_patterns = ["/specs/", "/proposal.md", "/design.md"]
    for pat in protected_patterns:
        if pat in file_path:
            print(f"❌ [openflow 防火墙 3: 阶段写入边界] build 阶段不允许修改规格文档: {file_path}")
            print("   如果确实需要修改需求，请用 /openflow amend")
            return False

    return True


# ============================================================
# 防火墙 4: tasks.md 同步提醒
# ============================================================
def check_tasks_sync(file_path, content, cwd):
    """plan-ready.md 更新时提醒同步 tasks.md。"""
    if "plan-ready.md" not in file_path:
        return True

    parent = os.path.dirname(os.path.join(cwd, file_path))
    tasks_file = os.path.join(parent, "tasks.md")

    if not os.path.isfile(tasks_file):
        return True

    # 检查是否是 checkbox 变更
    if "[x]" not in content and "[ ]" not in content:
        return True

    print("💡 [openflow 防火墙 4: 状态同步] plan-ready.md checkbox 变化，请同步更新 tasks.md")
    print(f"   tasks.md 路径: {tasks_file}")
    print("   提示: close 阶段会从 plan-ready.md 自动重新生成 tasks.md，现在可以跳过手动同步。")
    return True


# ============================================================
# 主逻辑
# ============================================================
def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    file_path = data.get("file_path", "")
    content = data.get("content", data.get("new_string", ""))
    cwd = os.getcwd()

    if tool_name not in ("Edit", "Write"):
        sys.exit(0)

    # 防火墙 1: 文件存在性（阻断）
    if not check_file_exists(tool_name, file_path, cwd):
        sys.exit(1)

    # 防火墙 2: 确定性标签（警告，不阻断）
    check_certainty_tags(file_path, content)

    # 防火墙 3: 阶段边界（阻断）
    if not check_phase_boundary(file_path, cwd):
        sys.exit(1)

    # 防火墙 4: tasks.md 同步提醒（提醒，不阻断）
    check_tasks_sync(file_path, content, cwd)

    sys.exit(0)


if __name__ == "__main__":
    main()
