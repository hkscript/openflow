## Why

OpenFlow installs lifecycle enforcement for Claude Code and OpenCode, but the
Codex path is skills-only. Its generated skill location and invocation guidance
are also not aligned with the current Codex local-skill contract. This leaves
the same repository subject to different workflow guarantees depending on the
coding client.

## What Changes

- Install Codex skills in the documented `.agents/skills` locations and render
  Codex-specific skill invocation guidance.
- Install a Codex lifecycle runtime under `.codex/hooks` and register it in
  `.codex/hooks.json` without replacing unrelated hook configuration.
- Add a Codex `apply_patch` adapter that validates every target in a patch using
  the shared OpenFlow enforcement policy and blocks unsafe or unparseable
  patches.
- Install the existing detect, gate, and fingerprint helpers for Codex so
  receipt and archive verification are available in all supported runtimes.
- Extend dependency discovery, user documentation, and regression tests for
  Codex and OpenCode support.

## Impact

- Affected specs: `client-skill-installation`, `client-lifecycle-enforcement`
- Affected code: `src/core/constants.ts`, `src/core/skill-generator.ts`,
  `src/core/dependency-check.ts`, `src/enforce/`, `hooks/`, templates, tests,
  and README files.
- Migration: `openflow update` will create the new Codex skill location and
  leave existing `.codex/skills` directories untouched.
