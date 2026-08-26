## Context

OpenFlow currently has a shared TypeScript rule implementation, a standalone
Claude hook, and an OpenCode plugin. Codex has compatible lifecycle hooks, but
its patch tool reports a single `apply_patch` operation whose command can
modify multiple files. Its documented local skill directories are `.agents`
directories, while lifecycle configuration lives under `.codex`.

## Goals / Non-Goals

- Goals:
  - Give Codex the same lifecycle helpers and phase-boundary enforcement as
    Claude Code and OpenCode.
  - Preserve third-party hook configuration and make repeated installation
    idempotent.
  - Keep shared policy decisions in `src/enforce/rules.ts`.
  - Use officially documented Codex skill, hook, and invocation mechanisms.
- Non-Goals:
  - Support Cursor lifecycle enforcement in this change.
  - Bypass Codex hook trust, approvals, or sandbox policies.
  - Add an unverified custom-command format for Codex.

## Decisions

### Codex skill locations

Codex skills will be generated under `.agents/skills` for project installation
and `~/.agents/skills` for global installation. Existing `.codex/skills`
installations will not be deleted. Codex-specific templates will direct users
to invoke a skill with `$openflow` or select it through `/skills`; they will not
claim that `/openflow` is a native Codex command.

### Codex lifecycle installation

The installer will copy the enforcement adapter and shared helpers to
`.codex/hooks` (or `~/.codex/hooks` globally). It will merge a dedicated
`.codex/hooks.json` instead of editing `config.toml`. JSON is already handled
safely by the installer and is an official alternative hook configuration
format. The registration will run a synchronous `PreToolUse` command hook for
`apply_patch` and use a stable absolute script path for its installation scope.

Codex requires repository hooks to be trusted. Generated documentation will
instruct users to review and trust the hook through `/hooks`; the installer will
not add a bypass flag.

### Patch adapter

A Codex-specific adapter will parse `tool_name = apply_patch` and
`tool_input.command`. It will extract all Add, Update, Delete, and Rename
targets from the supported patch syntax. For each target it will invoke the
shared rule engine. A block for any target denies the whole patch. A malformed
patch, an unsupported operation, or an unresolvable target also denies the
patch, preventing a policy bypass.

The adapter will emit the Codex `PreToolUse` deny response and exit with status
2 for a block. It will preserve warning messages as model-visible context.

Checks that need post-write content will use the parsed new content when the
patch format provides it. When that content cannot be reconstructed, the
adapter must not silently treat a block-capable check as successful.

### Shared helper and dependency discovery

Detect, gate, and fingerprint helpers remain plain Node scripts and will be
installed for Codex. Loose-skill discovery for `writing-plans` and
`brainstorming` will include the `.agents/skills` local and global locations;
the Claude plugin lookup remains a supplemental compatibility source.

## Risks / Trade-offs

- Codex patch syntax can evolve or contain multiple targets. The parser is
  deliberately fail-closed and needs fixture coverage for all supported forms.
- A global hook command must not resolve relative to a repository. Installer
  tests will assert the generated absolute command path.
- `.agents/skills` can be shared by other compatible clients. Generation must
  produce valid generic skill frontmatter and avoid duplicate output when a
  destination is selected more than once.

## Migration Plan

1. Ship the updated installer and documentation.
2. Users run `openflow update` or `openflow init --tools codex`.
3. Codex users review the newly discovered hook with `/hooks` before it runs.
4. Leave legacy `.codex/skills` content in place so rollback is a package
   downgrade followed by disabling/removing the new hook configuration.

## Open Questions

- None. The implementation will target the documented `apply_patch` hook
  contract and treat unsupported patch representations as denied.
