## ADDED Requirements

### Requirement: Codex Skill Discovery Installation

The system SHALL install OpenFlow Codex skills in the documented agent-standard
skill locations: `.agents/skills/openflow` for a project installation and
`~/.agents/skills/openflow` for a global installation.

#### Scenario: Project Codex installation

- **WHEN** a user runs `openflow init --tools codex` in a project
- **THEN** the system SHALL generate the main OpenFlow skill, phase references,
  and phase shortcut skills beneath `.agents/skills`
- **AND THEN** it SHALL not delete an existing `.codex/skills` directory

#### Scenario: Global Codex installation

- **WHEN** a user runs `openflow init --tools codex --global`
- **THEN** the system SHALL generate Codex skills beneath `~/.agents/skills`
- **AND THEN** it SHALL not write project-local skill artifacts

### Requirement: Client-Accurate Invocation Guidance

The system SHALL render Codex skill documentation with documented Codex skill
invocation guidance and SHALL not claim that an OpenFlow slash command is a
native Codex command.

#### Scenario: Codex generated skill

- **WHEN** OpenFlow renders a skill for Codex
- **THEN** the instructions SHALL identify `$openflow` and `/skills` as
  supported explicit invocation paths
- **AND THEN** the instructions SHALL not require `/openflow` as the only
  invocation path

### Requirement: Agent-Standard Dependency Discovery

The system SHALL include project and user `.agents/skills` locations when
discovering loose `writing-plans` and `brainstorming` skills.

#### Scenario: Writing-plans installed as a Codex skill

- **WHEN** `writing-plans/SKILL.md` exists in an applicable `.agents/skills`
  directory
- **THEN** dependency checks and lifecycle gates SHALL treat it as installed
