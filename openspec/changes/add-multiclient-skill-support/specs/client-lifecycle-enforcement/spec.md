## ADDED Requirements

### Requirement: Codex Lifecycle Runtime Installation

The system SHALL install Codex lifecycle artifacts and register a `PreToolUse`
hook without replacing unrelated Codex hook configuration.

#### Scenario: Project runtime installation

- **WHEN** a user runs `openflow init --tools codex` in a project
- **THEN** the system SHALL install enforcement, detect, gate, and fingerprint
  helpers under `.codex/hooks`
- **AND THEN** it SHALL register an `apply_patch` `PreToolUse` hook in
  `.codex/hooks.json`

#### Scenario: Existing hook configuration

- **WHEN** `.codex/hooks.json` already contains third-party hook entries
- **THEN** installation SHALL preserve those entries
- **AND THEN** it SHALL register exactly one OpenFlow hook after repeated
  installation

### Requirement: Codex Apply-Patch Enforcement

The system SHALL validate every file target in a Codex `apply_patch` tool call
against the shared OpenFlow lifecycle policy.

#### Scenario: Patch contains a forbidden target

- **WHEN** an `apply_patch` request targets a file disallowed by the current
  OpenFlow phase
- **THEN** the system SHALL deny the complete patch before it is applied
- **AND THEN** it SHALL return a Codex-compatible denial with the relevant rule
  identifier

#### Scenario: Multi-file patch mixes allowed and forbidden targets

- **WHEN** an `apply_patch` request changes both an allowed file and a
  forbidden file
- **THEN** the system SHALL deny the complete patch

#### Scenario: Patch target cannot be parsed safely

- **WHEN** an `apply_patch` request has malformed, unsupported, or unsafe path
  information
- **THEN** the system SHALL deny the patch

### Requirement: Codex Runtime Helper Availability

The system SHALL make detect, gate, receipt, and archive verification helpers
available to Codex-rendered OpenFlow skills.

#### Scenario: Codex verification workflow

- **WHEN** a Codex-rendered OpenFlow verification or close workflow requires a
  gate helper
- **THEN** the rendered instruction SHALL resolve to the installed
  `.codex/hooks/openflow-gate.mjs` helper
- **AND THEN** it SHALL not declare the lifecycle runtime unavailable
