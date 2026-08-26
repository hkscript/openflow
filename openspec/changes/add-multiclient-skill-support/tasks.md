## 1. Codex Skill Installation

- [x] 1.1 Update tool path metadata for documented Codex `.agents/skills`
      project and global locations while retaining `.codex` for hook artifacts.
- [x] 1.2 Render Codex-specific invocation and helper-path guidance without
      claiming `/openflow` is a native Codex command.
- [x] 1.3 Extend dependency discovery for agent-standard loose skills.

## 2. Codex Lifecycle Runtime

- [x] 2.1 Implement a Codex `apply_patch` parser and adapter over the shared
      enforcement rules.
- [x] 2.2 Emit valid Codex deny and warning responses, including exit code 2
      for blocked tool calls.
- [x] 2.3 Install Codex enforcement, detect, gate, and fingerprint helpers.
- [x] 2.4 Merge `.codex/hooks.json` safely, preserving third-party entries and
      making repeated installation byte-stable.

## 3. Documentation And Tests

- [x] 3.1 Update English and Chinese documentation to list all supported
      clients, their paths, and their invocation/trust requirements.
- [x] 3.2 Add unit tests for single- and multi-target Codex patches, including
      malformed, unsupported, traversal, Add, Update, Delete, and Rename forms.
- [x] 3.3 Extend installer tests for local/global Codex artifacts, hooks.json
      merge, idempotency, and installed runtime execution.
- [x] 3.4 Extend policy conformance tests to compare shared rules, Claude,
      OpenCode, and Codex outcomes where their event models are equivalent.
- [x] 3.5 Run `pnpm test` and record the result.
