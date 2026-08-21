# OpenFlow Phase Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an explicit, auditable OpenFlow lifecycle for Claude Code and OpenCode that scopes TDD to the active test case, requires a current verification receipt, and archives changes only through a verified transaction.

**Architecture:** `.openflow/phase` declares a validated active change and either `bootstrap` or `task-build` state. A shared zero-dependency fingerprint helper gives Gate and detect identical receipt freshness behavior. Rules, Claude’s standalone hook, and the OpenCode plugin independently implement the same normalized policy and are tested as a three-way observable contract; Gate owns receipt creation and the sole official verified-archive path.

**Tech Stack:** Node.js 20+ native ESM, TypeScript 5, pnpm, Claude Code PreToolUse hooks, OpenCode `tool.execute.before`, OpenSpec.

**Spec:** [2026-08-21-openflow-phase-lifecycle-design.md](docs/superpowers/specs/2026-08-21-openflow-phase-lifecycle-design.md)

## Global Constraints

- All `.mjs` runtime hooks and installed helpers are dependency-free Node.js 20+ scripts.
- Run project commands through `pnpm`; never run `openflow init` in this repository.
- Every test script that spawns Node must use `process.execPath` and assert `process.versions.node` major version is at least `20`; do not invoke bare `node` from a fixture subprocess.
- `.openflow/phase` is explicit routing state, not a user-approval or test-execution credential; invalid state fails closed for all writes except exact repair of `.openflow/phase`.
- A phase state names an active directory under `openspec/changes/<change>`; missing or archived-only targets are invalid.
- Build state uses `mode: "bootstrap"` or `mode: "task-build"`; only `task-build` has a required numeric-string `task`.
- New scenario IDs are stable `T-001` tokens and include deterministic test-case selectors in `relative/path.test.ts::testName` or documented marker-region form. Legacy `#N` references are accepted only if uniquely resolvable; mixed, duplicate, or ambiguous references fail closed.
- The test-framework exception is finite and auditable: only declared root configuration paths, only during `bootstrap`, and only when the active plan task explicitly labels the file as test-framework setup.
- The installed Claude hook, OpenCode plugin, and shared rules must produce the same complete normalized sorted `level:id` result vector, including warnings and simultaneous blocks, for the same fixture.
- Receipt freshness is a content-level, deterministic fingerprint of HEAD plus tracked, staged, and untracked worktree state. Fail closed on Git, hash, path, or file-read errors.
- Fingerprints exclude only `.openflow/phase`, `.openflow/building`, and the active change’s exact `verify-issues.md` / `verify-result.json`; never exclude `.openflow/**` broadly.
- `verify-result.json` must agree with its exact directory and CLI argument: `receipt.change === changeName`; disagreement produces `receipt-change-mismatch`.
- `archive-verified <change>` is the sole official OpenFlow archive path. It protects that installed path, not arbitrary direct shell use of `openspec archive`.
- Gate invokes OpenSpec only through a validated-name, no-shell, injectable runner. Tests set `OPENFLOW_OPENSPEC_BIN` to a temporary fake executable.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/enforce/rules.ts` | Typed reference contract: normalized host input, safe workspace paths, phase parsing, plan/task/selector resolution, phase boundary and TDD checks, and normalized check results. |
| `hooks/enforce.mjs` | Installed Claude Code PreToolUse adapter with dependency-free equivalents of shared policy and compatibility behavior. |
| `src/enforce/opencode.ts` | Installed OpenCode before-tool adapter with dependency-free equivalents of shared policy. |
| `hooks/lifecycle-fingerprint.mjs` **(new)** | Canonical NUL-framed fingerprint records plus receipt read, identity, and freshness validation used by Gate and detect. |
| `hooks/gate.mjs` | Safe runner, build/verify gates, atomic receipt writer, receipt-ready gate, and verified archive transaction. |
| `hooks/detect.mjs` | Phase-first active-change selection, lifecycle contradictions, and receipt state reporting using the shared helper. |
| `src/core/skill-generator.ts` | Installs/copies all Claude and OpenCode runtime artifacts; merges settings/plugin references idempotently for local and global installations. |
| `templates/SKILL.md` and `templates/{proposal,brainstorming,spec,amend,build,verify,close}.md` | Main generated lifecycle instructions and phase/Gate commands. |
| `templates/openflow-*/SKILL.md` | Generated shortcut-skill instruction sources; must remain aligned with their corresponding main phase template. |
| `scripts/test-enforce-rules.mjs` **(new)** | Typed rule contract, paths, phase modes, selectors, legacy migration, and OpenCode/shared parity fixtures. |
| `scripts/test-enforce.mjs` | Claude hook black-box tests and three-way Claude/shared/OpenCode conformance runner. |
| `scripts/test-gate.mjs` **(new)** | Temporary-Git fixture tests for fingerprint records, receipt writing/readiness, and archive transaction outcomes. |
| `scripts/test-detect.mjs` **(new)** | Temporary-workspace phase routing, marker, and receipt-expiry fixtures. |
| `scripts/test-install.mjs` **(new)** | Local/global Claude/OpenCode installation, config merge/idempotency, and installed-artifact execution tests. |
| `package.json` | One-build test chain. |

---

### Task 1: Define phase, selector, and path reference contracts

**Files:**
- Modify: `src/enforce/rules.ts`
- Create: `scripts/test-enforce-rules.mjs`

**Interfaces:**
- Produces:

```ts
export type PhaseName =
  | 'proposal' | 'brainstorming' | 'spec' | 'amend'
  | 'build' | 'verify' | 'close';
export type BuildMode = 'bootstrap' | 'task-build';
export interface PhaseState {
  version: 1;
  change: string;
  phase: PhaseName;
  mode?: BuildMode;
  task?: string;
}
export interface TestSelector {
  id: string;                 // T-001 or uniquely-resolved legacy #N
  file: string;               // workspace-relative path
  selector: string;           // file::test-name or file::@openflow(T-001)
}
export interface CurrentTask {
  id: string;
  declaredFiles: string[];
  testIds: string[];
  selectors: TestSelector[];
  frameworkSetupFiles: string[];
}
export interface NormalizedToolInput {
  operation: 'edit' | 'write';
  filePath: string;
  content: string;
  cwd: string;
}
export interface RuleResult {
  level: 'block' | 'warn';
  id: string;
  message: string;
  detail?: string;
}
export function normalizeToolInput(payload: unknown, cwd: string): NormalizedToolInput | null;
export function toWorkspaceRelativePath(path: string, cwd: string):
  | { ok: true; relative: string }
  | { ok: false; reason: 'empty' | 'outside-workspace' | 'traversal' | 'unsupported-path' };
export function readPhaseState(cwd: string):
  | { state: null; error: null }
  | { state: PhaseState; error: null }
  | { state: null; error: string };
export function resolveCurrentTask(cwd: string, state: PhaseState):
  | { task: CurrentTask; error: null }
  | { task: null; error: string };
export function runAllChecks(input: NormalizedToolInput): RuleResult[];
```

- Consumes: host payloads, active `openspec/changes/<change>` directories, phase state, `plan-ready.md`, and `test-plan.md`.

- [ ] **Step 1: Write failing contract fixtures**

Create `scripts/test-enforce-rules.mjs`. Assert Node 20+ immediately and import compiled `dist/enforce/rules.js` through `pathToFileURL`. In a temporary workspace, write explicit fixtures for:

```js
assert.deepEqual(rules.toWorkspaceRelativePath('packages\\app/src/a.ts', cwd), {
  ok: true, relative: 'packages/app/src/a.ts',
});
assert.deepEqual(rules.toWorkspaceRelativePath('../src/a.ts', cwd), {
  ok: false, reason: 'traversal',
});
assert.equal(rules.readPhaseState(cwd).error, null);
```

Add cases for malformed JSON, invalid version/change/phase, a missing active change, an archive-only change, `build` missing mode, `bootstrap` carrying `task`, `task-build` missing `task`, and a non-build phase carrying `mode` or `task`. Verify that only exact `.openflow/phase` remains writable for invalid state.

Add real-shape payload fixtures for Claude top-level fields, Claude nested `tool_input`, and OpenCode `call.input` field variants. Include absolute in-workspace paths, outside paths, `..`, `file://`, Windows drive/UNC input, nonexistent Write targets, and a symlink-parent escape.

- [ ] **Step 2: Run the contract fixture and confirm it fails**

Run: `pnpm run build && pnpm node scripts/test-enforce-rules.mjs`  
Expected: FAIL because phase modes, path normalization, selector parsing, and exported contract functions do not exist.

- [ ] **Step 3: Implement safe normalization and phase parsing**

In `src/enforce/rules.ts`, implement `normalizeToolInput`, `toWorkspaceRelativePath`, `readPhaseState`, `isWithin`, and exact change path checks. Normalize separators first; resolve existing targets through `realpath`; for a new Write target realpath its parent and verify lexical containment; reject unsupported remote/drive/UNC/file URL forms.

Require phase change names to match `^[a-z0-9]+(?:-[a-z0-9]+)*$`, require an active non-archive change directory, and implement these valid build shapes:

```json
{"version":1,"change":"add-widget","phase":"build","mode":"bootstrap"}
{"version":1,"change":"add-widget","phase":"build","mode":"task-build","task":"1"}
```

- [ ] **Step 4: Implement stable selector and legacy mapping resolution**

Parse `plan-ready.md` blocks headed `### Task N:`. Parse each new test-plan row as `T-001` plus a required selector in either `path::name` or `path::@openflow(T-001)` form. Permit a legacy `#N` reference only when it resolves to exactly one test-plan row and one selector; reject a task containing both reference forms, duplicated IDs, duplicate selector ownership that cannot be distinguished, or unmatched references with `tdd-task-unmapped`.

Return a `CurrentTask` only for `task-build`. Parse a finite `Test framework setup:` declaration in the task block and accept only declared root files from:

```ts
const TEST_FRAMEWORK_CONFIGS = new Set([
  'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'pyproject.toml', 'Cargo.toml',
]);
```

- [ ] **Step 5: Implement phase boundaries and selector-aware TDD checks**

Implement a phase policy that permits:

| State | Additional allowed writes |
|---|---|
| proposal / brainstorming | exact active `proposal.md` |
| spec | active change documents only |
| amend | active change documents and exact dated implementation plan |
| build/bootstrap | tests declared in any active test-plan selector and declared finite framework setup files; never production files |
| build/task-build | current task declared implementation/test files and its exact selector regions |
| verify | exact active `verify-issues.md` and `verify-result.json` |
| close | exact active `lessons.md` and `tasks.md` |

On candidate production writes in `task-build`, inspect only selectors owned by the current task. A future task’s TODO in the same test file must not block. Missing local current selector files return `tdd-test-file-missing`; an unfinished selected region returns `tdd-stub-check`; marker/change disagreement returns `change-state-conflict`.

Preserve compatibility only when phase is absent: retain existing no-read/certainty/writing-plan checks and run the old global TDD scan only if `.openflow/building` exists.

- [ ] **Step 6: Run the focused rule tests and confirm they pass**

Run: `pnpm run build && pnpm node scripts/test-enforce-rules.mjs`  
Expected: PASS for phase repair-only behavior, bootstrap restrictions, selector isolation, unique legacy compatibility, ambiguous legacy rejection, and path safety cases.

- [ ] **Step 7: Commit the reference contract**

```bash
git add src/enforce/rules.ts scripts/test-enforce-rules.mjs
git commit -m "feat(openflow): define phase modes and selector contracts"
```

### Task 2: Add canonical fingerprint and receipt primitives

**Files:**
- Create: `hooks/lifecycle-fingerprint.mjs`
- Modify: `scripts/test-gate.mjs`

**Interfaces:**
- Produces:

```js
export const FINGERPRINT_VERSION = 1;
export function collectWorktreeFingerprint(cwd, changeName) {
  // { ok: true, value: 'sha256:<hex>', records: Buffer[] }
  // | { ok: false, blocker: string }
}
export function readVerifyReceipt(cwd, changeName) {
  // { ok: true, receipt } | { ok: false, blocker: string }
}
export function validateVerifyReceipt(cwd, changeName) {
  // { pass: boolean, blockers: string[], receipt?: object }
}
```

- Consumes: Git HEAD, tracked/staged/untracked worktree data, exact self-pollution paths, and `verify-result.json`.

- [ ] **Step 1: Write failing canonical-record vectors**

Create the temporary Git fixture harness in `scripts/test-gate.mjs`, using `process.execPath` for every spawned Node executable. Add assertions that two worktrees with the same semantic record sequence yield the same `sha256:<hex>` and that each of these changes yields a different fingerprint from the receipt baseline: unstaged tracked edit, staged-only edit, untracked content change, deletion, rename, executable mode change, symlink target change, and submodule entry change when the platform supports it.

Add failure fixtures for a Git command failure and unreadable untracked path. Assert both return `pass: false` / a nonempty blocker rather than a partial fingerprint.

- [ ] **Step 2: Run the vector fixture and confirm it fails**

Run: `pnpm node scripts/test-gate.mjs`  
Expected: FAIL because `hooks/lifecycle-fingerprint.mjs` does not exist.

- [ ] **Step 3: Implement versioned NUL-framed records**

In `hooks/lifecycle-fingerprint.mjs`, use `execFileSync` only. Build the SHA-256 preimage as sorted `Buffer` records with this exact framing:

```text
OF-FP\0<version>\0
HEAD\0<40-byte-hex>\0
TRACKED\0<relative-path-utf8>\0<git-diff-binary-bytes>\0
STAGED\0<relative-path-utf8>\0<git-cached-diff-binary-bytes>\0
UNTRACKED\0<relative-path-utf8>\0<kind>\0<sha256-or-link-target>\0
ERROR\0<operation>\0<relative-path-utf8>\0<error-code>\0
```

Sort by bytewise UTF-8 relative path, then record tag. Represent deletion, rename, mode change, and submodule information through the corresponding byte-preserving Git binary diff record; preserve a deterministic `ERROR` record only long enough to surface a failed collection result, never to produce a successful fingerprint. Exclude only the four exact self-pollution paths named in Global Constraints.

- [ ] **Step 4: Implement receipt shape, identity, and freshness validation**

Require version `1`, an exact change match, a 40-hex `head`, nonempty `sha256:` fingerprint, at least one `testRuns` entry with `exitCode: 0`, `scenarioCoverage.mapped === scenarioCoverage.total > 0`, empty design blockers, and `userConfirmation.received === true`.

Make `validateVerifyReceipt` first verify the exact receipt path, then return `receipt-change-mismatch` if its JSON `change` differs from `changeName`, then compare HEAD and fingerprint. It must not throw on absent/malformed JSON.

- [ ] **Step 5: Run the fingerprint and receipt vector tests**

Run: `pnpm node scripts/test-gate.mjs`  
Expected: PASS for deterministic vectors, all stale cases, exact self-pollution exclusions, malformed receipt handling, and `receipt-change-mismatch`.

- [ ] **Step 6: Commit the reusable lifecycle helper**

```bash
git add hooks/lifecycle-fingerprint.mjs scripts/test-gate.mjs
git commit -m "feat(openflow): add canonical verification fingerprint"
```

### Task 3: Implement safe Gate receipt and verified archive commands

**Files:**
- Modify: `hooks/gate.mjs`
- Modify: `scripts/test-gate.mjs`

**Interfaces:**
- Produces CLI subcommands:

```text
check-build-done <change>
check-verify-prerequisites <change>
write-verify-receipt <change> <receipt-input-json-path>
check-verify-ready <change>
check-close-ready <change>
archive-verified <change>
```

- Consumes: Task 2 fingerprint helper, active change docs, Gate config, and `OPENFLOW_OPENSPEC_BIN`.

- [ ] **Step 1: Write failing Gate and archive fixtures**

In `scripts/test-gate.mjs`, generate a fake executable using `process.execPath`. It must log its argv and obey fixture environment variables for `validate` / `archive` success or failure.

Add fixtures asserting:

```js
assert.equal(runGate(dir, 'check-verify-prerequisites', 'add-widget').pass, true);
assert.equal(runGate(dir, 'check-verify-ready', 'add-widget').pass, false);
assert.match(runGate(dir, 'check-verify-ready', 'add-widget').blockers.join('\n'), /receipt/i);
```

Cover missing strict design sections (`## 现状与影响面`, `## 改动文件`), incomplete tests/plans, marker presence, unresolved issues, invalid OpenSpec input, receipt mismatch, and stale receipt after tracked/staged/untracked/config changes.

For `archive-verified`, cover mutation after readiness but before archive, failed runner, pre-existing expected archive directory, source still present after a reported success, multiple newly created archive directories, lost `tasks.md` / `lessons.md` / `verify-result.json`, and successful source removal plus exactly one retained archive directory.

- [ ] **Step 2: Run Gate fixtures and confirm failure**

Run: `pnpm node scripts/test-gate.mjs`  
Expected: FAIL because the required commands and archive postconditions do not exist.

- [ ] **Step 3: Add validated no-shell command dispatch**

Validate every change argument before path construction or subprocess use:

```js
const CHANGE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
```

Replace string `execSync` calls with a runner boundary that uses:

```js
execFileSync(process.env.OPENFLOW_OPENSPEC_BIN || 'openspec', argv, {
  cwd, encoding: 'utf8', stdio: 'pipe',
});
```

Reject `''`, `../x`, `x y`, and `x; touch pwned` before the runner. The injected binary may be used only for tests and retains the same fixed argv contract as production.

- [ ] **Step 4: Implement verify prerequisites and atomic receipt writer**

Implement `checkVerifyPrerequisites(cwd, changeName)` by composing build completion, unresolved issue check, strict design check, proposal format, and strict OpenSpec validation. It must not read the receipt.

Implement `write-verify-receipt <change> <receipt-input-json-path>` to parse a local JSON input containing `testRuns`, `scenarioCoverage`, `designConsistency`, and `userConfirmation`; call prerequisites; validate these fields; collect the final fingerprint only after all verify writes; write to a same-directory temporary file and `renameSync` it atomically to `verify-result.json`. Return JSON with `pass`, `blockers`, and receipt path.

- [ ] **Step 5: Implement ready gates and archive transaction**

Make `checkVerifyReady` compose `checkVerifyPrerequisites` and Task 2 receipt validation. Make `checkCloseReady` compose `checkVerifyReady` and any close-specific consistency check.

Implement `archive-verified` in this order:

1. list/archive snapshot before invoking OpenSpec;
2. run `checkVerifyReady` immediately before archive;
3. call `openspec archive <change> --yes` through the runner;
4. require runner success;
5. confirm `openspec/changes/<change>` no longer exists;
6. determine exactly one new `openspec/changes/archive/YYYY-MM-DD-<change>` directory from the before/after snapshots;
7. confirm it contains `tasks.md`, `lessons.md`, and `verify-result.json`;
8. remove exact `.openflow/phase` and `.openflow/building` only then.

If a postcondition fails, return failure and leave phase/marker intact for recovery.

- [ ] **Step 6: Run Gate fixtures and confirm passing results**

Run: `pnpm node scripts/test-gate.mjs`  
Expected: PASS for safe argv injection rejection, receipt writing, receipt freshness, archive error recovery, postconditions, and cleanup ordering.

- [ ] **Step 7: Commit Gate lifecycle behavior**

```bash
git add hooks/gate.mjs scripts/test-gate.mjs
git commit -m "feat(openflow): require receipt and verify archive transaction"
```

### Task 4: Align the three enforcement adapters

**Files:**
- Modify: `hooks/enforce.mjs`
- Modify: `src/enforce/opencode.ts`
- Modify: `scripts/test-enforce.mjs`
- Modify: `scripts/test-enforce-rules.mjs`

**Interfaces:**
- Consumes: Task 1 normalized policy and `RuleResult` IDs.
- Produces: Claude stdout and OpenCode abort/warning output equivalent to `rules.runAllChecks()`.

- [ ] **Step 1: Add failing three-way conformance matrix**

In `scripts/test-enforce.mjs`, construct named fixtures once, then run each through:

1. `rules.runAllChecks(normalizedInput)`;
2. `hooks/enforce.mjs` through stdin with both top-level and nested Claude payloads;
3. compiled OpenCode plugin’s actual `tool.execute.before` callback.

Extract **all** warning and block IDs, sort them, and compare exact equality:

```js
assert.deepEqual(claudeIds, expectedIds, fixture.name);
assert.deepEqual(openCodeIds, expectedIds, fixture.name);
```

Include invalid/missing/archived phase, phase repair, bootstrap declared/undeclared tests, framework setup allowed/disallowed files, task-build selector isolation in a shared file, marker conflict, legacy unique/ambiguous mappings, no-phase compatibility TDD, no-read Edit, certainty tags, and writing-plans behavior.

- [ ] **Step 2: Run the three-way fixture and confirm it fails**

Run: `pnpm run build && pnpm node scripts/test-enforce.mjs`  
Expected: FAIL because Claude and OpenCode lack phase-mode and selector behavior and do not expose complete comparable result vectors.

- [ ] **Step 3: Implement Claude hook parity**

In `hooks/enforce.mjs`, preserve zero dependencies and adapt actual Claude payloads. Recreate Task 1’s safe input/path/state/selector policy with identical `id`, `level`, and ordering semantics. Replace all-file TODO scanning with current selected-region checks. Continue exact file-existence validation for Edit, include `design.md` in certainty checks, and retain absent-phase + building-marker compatibility scanning.

Keep `OPENFLOW_NO_BUILD_GATE=1` limited to writing-plans and TDD checks; it must never bypass phase state or write boundary checks.

- [ ] **Step 4: Implement OpenCode plugin parity**

In `src/enforce/opencode.ts`, retain an installable single-file build artifact. Normalize `call.input.file_path`, `filePath`, `content`, and `new_string` variants. Implement the same policy independently, emitting all warning IDs and placing all block IDs in `output.abort`; use the same result ordering as Claude/shared rules.

- [ ] **Step 5: Run the conformance matrix and focused suites**

Run:

```bash
pnpm run build
pnpm node scripts/test-enforce-rules.mjs
pnpm node scripts/test-enforce.mjs
```

Expected: PASS; every fixture has identical complete sorted `level:id` vectors across shared rules, Claude, and OpenCode.

- [ ] **Step 6: Commit adapter equivalence**

```bash
git add hooks/enforce.mjs src/enforce/opencode.ts scripts/test-enforce.mjs scripts/test-enforce-rules.mjs
git commit -m "feat(openflow): align phase enforcement across clients"
```

### Task 5: Route detect from phase and verified receipt state

**Files:**
- Modify: `hooks/detect.mjs`
- Create: `scripts/test-detect.mjs`

**Interfaces:**
- Consumes: `.openflow/phase`, `.openflow/building`, active changes, and `lifecycle-fingerprint.mjs` receipt validation.
- Produces JSON fields `signals.phase_state`, `signals.verify_receipt`, `change_name`, `contradictions`, and `suggested_phase`.

- [ ] **Step 1: Write failing detect fixtures**

Create `scripts/test-detect.mjs` with temporary workspaces. Execute detect via `process.execPath` and assert JSON for:

```js
assert.equal(json.signals.phase_state.value.phase, 'build');
assert.equal(json.signals.phase_state.value.mode, 'task-build');
assert.equal(json.change_name, 'add-widget');
assert.equal(json.suggested_phase, 'build');
```

Cover absent phase, phase selection among multiple active changes, malformed/missing/archive-only state target, bootstrap with and without marker, task-build missing marker/plan artifacts, marker change mismatch, amend with and without marker, valid receipt → close, stale receipt → verify, and close phase with invalid receipt → contradiction plus no automatic close suggestion.

- [ ] **Step 2: Run detect tests and confirm failure**

Run: `pnpm node scripts/test-detect.mjs`  
Expected: FAIL because detect has no phase mode or shared receipt information.

- [ ] **Step 3: Implement phase-first selection and contradictions**

Import Task 2’s helper from `hooks/lifecycle-fingerprint.mjs`. When state is valid and names an active change, select it before mtime-derived candidates. Report structured contradictions for invalid/missing/archived phase target, bootstrap production-state conflict, task-build missing marker/test plan/plan-ready, marker mismatch, malformed receipt, stale receipt, and close without a current receipt.

A legal amend state does not require a marker. A stale receipt should route to `verify` when the phase is otherwise routable; a phase explicitly set to `close` with a stale receipt must have `suggested_phase: null` and a contradiction so a user must resolve it deliberately.

- [ ] **Step 4: Run detect fixtures and confirm passing results**

Run: `pnpm node scripts/test-detect.mjs`  
Expected: PASS for phase priority, allowed amend behavior, marker conflicts, and current/stale receipt routing.

- [ ] **Step 5: Commit routing changes**

```bash
git add hooks/detect.mjs scripts/test-detect.mjs
git commit -m "feat(openflow): route from phase and receipt state"
```

### Task 6: Install complete client runtime artifacts safely

**Files:**
- Modify: `src/core/skill-generator.ts`
- Create: `scripts/test-install.mjs`
- Modify: `scripts/test-enforce.mjs`

**Interfaces:**
- Produces local and global install outputs:

```text
Claude:   .claude/hooks/openflow-enforce.mjs
          .claude/hooks/openflow-detect.mjs
          .claude/hooks/openflow-gate.mjs
          .claude/hooks/lifecycle-fingerprint.mjs
OpenCode: .opencode/plugins/openflow-enforce.js
          .opencode/hooks/openflow-detect.mjs
          .opencode/hooks/openflow-gate.mjs
          .opencode/hooks/lifecycle-fingerprint.mjs
```

- Consumes: built OpenCode plugin, hook sources, source/destination install roots, existing Claude settings and OpenCode configs.

- [ ] **Step 1: Write failing local/global installation fixtures**

Create `scripts/test-install.mjs`. Use isolated temporary project roots and an isolated `HOME`; invoke the compiled CLI with `process.execPath` rather than direct `openflow init` in this repository.

Seed third-party Claude hooks and OpenCode plugin entries. Assert local and global installation copies all listed artifacts; keeps third-party settings/plugins; retains exactly one OpenFlow Edit/Write hook; and retains exactly one canonical OpenCode plugin URL equal to:

```js
pathToFileURL(pluginDest).href
```

Seed legacy `.py` hooks and legacy relative OpenFlow plugin URLs, then assert they are replaced/deduplicated without deleting unrelated entries. Run a second install and assert byte-stable idempotent config.

- [ ] **Step 2: Run installation tests and confirm failure**

Run: `pnpm run build && pnpm node scripts/test-install.mjs`  
Expected: FAIL because OpenCode does not receive Gate/detect/fingerprint artifacts and global registration does not use the actual copied plugin destination.

- [ ] **Step 3: Implement client-specific artifact copying and config merge**

In `src/core/skill-generator.ts`, register copying of `lifecycle-fingerprint.mjs` beside every installed gate/detect consumer. Install OpenCode Gate/detect helpers at the exact paths in this task’s interface. Make template path replacement select the proper Claude or OpenCode artifact root.

Pass `pluginDest` to OpenCode config merging. Register `pathToFileURL(pluginDest).href`, remove only OpenFlow legacy/canonical duplicates, preserve unrelated plugins, and maintain old Python hook cleanup. Keep Claude hook matcher registration limited to Edit and Write; do not add a Bash matcher.

- [ ] **Step 4: Execute installed artifact behavior checks**

Extend the installation fixture to run installed Claude hook, installed OpenCode plugin, installed Gate, and installed detect against a small phase fixture. Assert a spec production write returns `phase-write-boundary`; a missing selected test returns `tdd-test-file-missing`; an absent receipt makes `check-close-ready` fail; and a current receipt changes only permitted state without becoming stale from `.openflow/phase`.

- [ ] **Step 5: Run installation tests and confirm passing results**

Run: `pnpm run build && pnpm node scripts/test-install.mjs`  
Expected: PASS for local/global configuration, deduplication, third-party preservation, artifact existence, and installed runtime behavior.

- [ ] **Step 6: Commit installation behavior**

```bash
git add src/core/skill-generator.ts scripts/test-install.mjs scripts/test-enforce.mjs
git commit -m "feat(openflow): install complete client lifecycle runtime"
```

### Task 7: Update generated lifecycle templates and stable plan format

**Files:**
- Modify: `templates/SKILL.md`
- Modify: `templates/proposal.md`
- Modify: `templates/brainstorming.md`
- Modify: `templates/spec.md`
- Modify: `templates/amend.md`
- Modify: `templates/build.md`
- Modify: `templates/verify.md`
- Modify: `templates/close.md`
- Modify: `templates/openflow-proposal/SKILL.md`
- Modify: `templates/openflow-brainstorming/SKILL.md`
- Modify: `templates/openflow-spec/SKILL.md`
- Modify: `templates/openflow-amend/SKILL.md`
- Modify: `templates/openflow-build/SKILL.md`
- Modify: `templates/openflow-verify/SKILL.md`
- Modify: `templates/openflow-close/SKILL.md`
- Modify: `scripts/test-install.mjs`

**Interfaces:**
- Consumes: lifecycle commands and paths from Tasks 1–6.
- Produces: generated instructions that issue valid phase transitions and invoke client-correct lifecycle commands.

- [ ] **Step 1: Write failing static template checks**

Add static assertions to `scripts/test-install.mjs` for every main and shortcut template. Require each phase source to mention `.openflow/phase`; require spec instructions to generate `T-001` IDs plus selectors; require build instructions to enter bootstrap before task build; require verify instructions to run `write-verify-receipt`; and require close instructions to use `archive-verified` and not a raw `openspec archive` command.

Assert the build ending directs users to `/openflow verify`, not `/openflow close`, and assert no generated source says `openflow-enforce.py`.

- [ ] **Step 2: Run template checks and confirm failure**

Run: `pnpm node scripts/test-install.mjs`  
Expected: FAIL because current templates omit phase modes, receipt writing, selector format, and verified archive commands.

- [ ] **Step 3: Define phase lifecycle in template sources**

Update templates to emit the following representative states:

```bash
# bootstrap
printf '%s\n' '{"version":1,"change":"<change>","phase":"build","mode":"bootstrap"}' > .openflow/phase
printf '%s\n' '<change>' > .openflow/building

# task build
printf '%s\n' '{"version":1,"change":"<change>","phase":"build","mode":"task-build","task":"1"}' > .openflow/phase
```

Document that bootstrap writes declared test selectors and finite declared framework setup only; task build selects exactly one Task; amend may retain the marker; old unambiguous `#N` references work temporarily and must be converted during the next spec/amend edit.

Require spec output to give each test-plan mapping one `T-001` and selector; require plan-ready tasks to cite stable IDs. Proposal, brainstorming, spec, amend, verify, and close set their matching non-build phase values without `mode` or `task`.

- [ ] **Step 4: Document Gate/receipt/archive transitions by client**

Make verify instructions: complete verify writes and explicit user confirmation, write a receipt-input JSON file, then run the installed client’s `write-verify-receipt <change> <input>` command; only on success set phase `close`.

Make close instructions call only `archive-verified <change>`; explain its failures must be repaired/reverified rather than bypassed with a raw archive command. Ensure client-generated paths point to installed Claude or OpenCode helpers and no OpenCode template assumes `.claude/hooks`.

- [ ] **Step 5: Run template and install checks**

Run: `pnpm run build && pnpm node scripts/test-install.mjs`  
Expected: PASS for static format, client paths, phase lifecycle, receipt writer, and verified archive assertions.

- [ ] **Step 6: Commit template lifecycle documentation**

```bash
git add templates scripts/test-install.mjs
git commit -m "docs(openflow): document verified phase lifecycle"
```

### Task 8: Register the full test chain and run packaging verification

**Files:**
- Modify: `package.json`
- Modify: `scripts/test-enforce-rules.mjs`
- Modify: `scripts/test-enforce.mjs`
- Modify: `scripts/test-gate.mjs`
- Modify: `scripts/test-detect.mjs`
- Modify: `scripts/test-install.mjs`

**Interfaces:**
- Produces one build followed by repeatable, Node-20-safe lifecycle verification.

- [ ] **Step 1: Register a single-build test chain**

Set scripts to avoid rebuilding inside every fixture:

```json
{
  "build": "tsc",
  "test:enforce:unit": "pnpm node scripts/test-enforce-rules.mjs && pnpm node scripts/test-enforce.mjs && pnpm node scripts/test-gate.mjs && pnpm node scripts/test-detect.mjs && pnpm node scripts/test-install.mjs",
  "test:enforce": "pnpm run build && pnpm run test:enforce:unit",
  "test": "pnpm run test:enforce"
}
```

- [ ] **Step 2: Verify every fixture has a Node 20 guard and pinned subprocesses**

In each script, add:

```js
if (Number.parseInt(process.versions.node, 10) < 20) {
  throw new Error(`Node 20+ required; received ${process.version}`);
}
```

Replace every `spawnSync('node', ...)`, `execFileSync('node', ...)`, or shell node invocation with `process.execPath` and argument arrays.

- [ ] **Step 3: Run the complete project test chain**

Run: `pnpm test`  
Expected: TypeScript build and all five fixture suites exit `0`.

- [ ] **Step 4: Verify built and installed OpenCode artifacts load**

Run:

```bash
pnpm node -e "import('./dist/enforce/opencode.js').then(() => console.log('built OpenCode plugin loads'))"
pnpm node scripts/test-install.mjs
```

Expected: `built OpenCode plugin loads`; installation fixture verifies both local and isolated-HOME global installation plus installed Gate/detect/plugin operation.

- [ ] **Step 5: Run diff and source-consistency checks**

Run:

```bash
git diff --check
git diff -- hooks src/enforce src/core templates scripts package.json
```

Expected: no whitespace errors; no raw shell interpolation for OpenSpec; no raw archive template command; no `.py` hook references; no bare child `node` processes; and no broad `.openflow/**` fingerprint exclusion.

- [ ] **Step 6: Commit test and packaging verification**

```bash
git add package.json scripts
git commit -m "test(openflow): cover verified lifecycle end to end"
```

## Plan Self-Review

### Spec coverage

- Explicit state, safe path normalization, active-change validation, bootstrap/task-build modes, selector mapping, and gradual legacy compatibility are implemented in Task 1.
- Canonical versioned, deterministic fingerprinting plus receipt identity/freshness parsing are implemented in Task 2.
- A formal receipt creator, strict ready checks, and archive transaction with postconditions/cleanup ordering are implemented in Task 3.
- Shared/Claude/OpenCode parity and the complete three-way result-vector oracle are implemented in Task 4.
- Phase-first detect selection, phase/marker contradictions, and receipt routing are implemented in Task 5.
- Local/global client artifact installation, correct OpenCode file URL registration, and installed-runtime E2E are implemented in Task 6.
- Main and shortcut templates generate stable IDs/selectors and use the official receipt/archive paths in Task 7.
- One-build execution, Node-runtime pinning, packaging, and full regression validation are implemented in Task 8.

### Placeholder scan

The plan contains no deferred implementation markers. Every test step names fixture conditions and expected observable results; each production interface is introduced before later tasks consume it.

### Type and command consistency

- Build mode values are consistently `bootstrap` and `task-build`.
- Phase-state field names are consistently `version`, `change`, `phase`, `mode`, and `task`.
- Receipt validation uses `validateVerifyReceipt`; receipt writing uses `write-verify-receipt`; verified archive uses `archive-verified`.
- The shared result comparison key is always complete sorted `level:id` vectors.
- All Gate commands accept one validated change argument, except `write-verify-receipt`, which additionally accepts the explicit receipt-input JSON path.
