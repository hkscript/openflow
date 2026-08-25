# OpenFlow Phase Lifecycle Design

## Purpose

Strengthen OpenFlow's phase-aware enforcement so Claude Code and OpenCode share an explicit, auditable lifecycle from proposal through verified archive. The design prevents unverified archival through a current verify receipt, keeps TDD enforcement scoped to a current task and test case, and makes client adapters observably equivalent.

## Scope

This design covers phase state, build bootstrap, test-case selectors, legacy plan compatibility, verify receipts, verified archive, fingerprinting, Claude/OpenCode adapters, generated templates, installation, and end-to-end fixtures. It does not claim to prevent someone from directly bypassing the installed OpenFlow command path with arbitrary shell commands.

## State Model

`.openflow/phase` is UTF-8 JSON and is the routing declaration, not an authorization credential. It includes a version, active change, phase, and—during ordinary build—the current task.

Build has two controlled modes:

- **Bootstrap:** permits only tests declared by the active change's test plan and finite, task-declared test-framework configuration. Production files remain blocked.
- **Task build:** requires a current task and permits only its declared implementation files and declared test files. TDD validation applies only to the current task's test-case selectors.

A phase referring to a missing or archived change is invalid and blocks all writes except repairing `.openflow/phase`. The building marker represents lifecycle context only and may remain during amend; it is never the sole source of the current phase.

## Test Mapping and Compatibility

New test-plan rows receive stable identifiers (`T-001`) and map each case to a deterministic selector, e.g. `path/to/test.ts::testName` or a documented marker region. Plan-ready task sections cite the same IDs.

During migration, a build can consume legacy `#N` references only when they resolve uniquely. A next spec or amend write converts the linked plan and test-plan entries to stable IDs. Mixed, duplicate, or ambiguous references fail closed with an actionable migration error.

## Receipt Contract

`verify-result.json` is evidence from the verify process. A production `write-verify-receipt <change>` command:

1. validates the change name and verify prerequisites;
2. validates recorded successful test runs, full scenario mapping, design result, and explicit user confirmation;
3. computes the final worktree fingerprint after all verify-side writes;
4. atomically writes a receipt bound to the exact change name and receipt directory.

The receipt parser requires the argument change, receipt path, and receipt JSON `change` field to agree. It checks HEAD and fingerprint freshness. It returns `receipt-change-mismatch` for identity disagreement.

## Receipt-driven Routing (deliberate deviation from plan wording)

Receipt state drives detect routing **only for declared `verify` and `close` phases** (commit b901045): `verify` with a current receipt routes to `close`; `verify`/`close` with a stale receipt stays at `verify` or blocks, respectively. Every other declared phase (`proposal`/`brainstorming`/`spec`/`amend`/`build`) is phase-authoritative: it returns its declared phase regardless of receipt validity, and a stale receipt surfaces only as a non-blocking `receipt-stale` contradiction. This supersedes the plan's literal "stale receipt routes to verify when the phase is otherwise routable" (plan.md Task 5) and is locked by tests.

For those non-routing phases, detect validates the receipt **cheaply** — shape plus a single HEAD compare, no worktree fingerprint — since receipt state cannot affect their routing. Full fingerprint-based staleness remains authoritative in `verify`/`close`, where the full worktree fingerprint is always computed.

## Canonical Fingerprint

Gate and detect use a shared, dependency-free fingerprint helper. The helper defines a versioned NUL-framed record preimage with explicit tags and field ordering for HEAD, tracked unstaged changes, staged changes, untracked paths/types/content, deletions, renames, mode changes, symlink targets, submodules, and read/Git failures. Inputs are sorted deterministically. Only exact self-pollution paths are omitted: phase state, build marker, and the active change's receipt and verify-issues files. A failure to collect a record fails closed.

## Verified Archive Transaction

`archive-verified <change>` is the official OpenFlow archive path:

1. validate the change name and current receipt immediately before archive;
2. invoke OpenSpec archive through an injected, no-shell runner;
3. require a successful runner result;
4. verify exact source removal, exactly one expected new archive destination, and preservation of `tasks.md`, `lessons.md`, and `verify-result.json`;
5. remove phase and residual marker state only after all checks pass.

The command provides a safe official path, not an assertion that arbitrary direct `openspec archive` invocations are technically impossible.

## Cross-client Enforcement and Installation

Shared rules, Claude's hook, and OpenCode's plugin normalize real host payloads and are tested through a three-way conformance matrix comparing the complete sorted `level:id` warning/block set.

OpenCode receives runnable detect and gate artifacts at documented install destinations, so generated templates do not point at Claude-only paths. Global plugin registration uses `pathToFileURL(actualPluginDestination)` and deduplicates legacy and canonical OpenFlow references while preserving third-party plugins.

## Validation

Fixtures cover state parsing and boundaries, build bootstrap, task selector behavior, legacy migration, receipt production and expiry, archive transaction failures, canonical fingerprint vectors, three-way adapter parity, detect routing, local and global client installation, and installed artifact execution. All Node child processes use `process.execPath` and assert Node 20+.
