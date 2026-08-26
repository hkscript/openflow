export const PKG_NAME = '@lininn/openflow';
export const PKG_BIN = 'openflow';
export const SKILL_NAME = 'openflow';
export const COMMAND_PREFIX = '/openflow';

export const DEPS = {
  openspec: {
    name: 'OpenSpec',
    cliCmd: 'openspec',
    npmPkg: '@fission-ai/openspec',
    installHint: 'npm install -g @fission-ai/openspec@latest',
    autoInstallable: true,
  },
  superpowers: {
    name: 'Superpowers',
    checkPath: 'writing-plans/SKILL.md',
    // Claude Code 插件形式:writing-plans 作为 superpowers 插件的一部分安装。
    // installed_plugins.json 记录已装插件,键名形如 "superpowers@claude-plugins-official",
    // 每条目 installPath 指向缓存目录,其下 skills/writing-plans/SKILL.md 即目标文件。
    installedPluginsFile: '.claude/plugins/installed_plugins.json',
    pluginNamePrefix: 'superpowers@',
    pluginSkillPath: 'skills/writing-plans/SKILL.md',
    installHint: '请将 Superpowers writing-plans 安装到当前客户端可发现的 skills 目录（Claude Code 可用：/plugin install superpowers@claude-plugins-official）',
    autoInstallable: false,
  },
} as const;

export interface ToolPaths {
  skillsDir: string;
  globalSkillsDir?: string;
  commandsDir?: string;
  globalCommandsDir?: string;
  hooksDir?: string;
  globalHooksDir?: string;
  settingsFile?: string;
  globalSettingsFile?: string;
  hooksConfigFile?: string;
  globalHooksConfigFile?: string;
}

export const TOOL_PATHS: Record<string, ToolPaths> = {
  claude: {
    skillsDir: '.claude/skills',
    commandsDir: '.claude/commands',
    hooksDir: '.claude/hooks',
    settingsFile: '.claude/settings.json',
  },
  codex: {
    // Codex discovers standalone local skills through the agent-skills
    // standard. Runtime configuration remains under .codex.
    skillsDir: '.agents/skills',
    globalSkillsDir: '.agents/skills',
    hooksDir: '.codex/hooks',
    globalHooksDir: '.codex/hooks',
    hooksConfigFile: '.codex/hooks.json',
    globalHooksConfigFile: '.codex/hooks.json',
  },
  cursor: {
    skillsDir: '.cursor/skills',
  },
  opencode: {
    skillsDir: '.opencode/skills',
    globalSkillsDir: '.config/opencode/skills',
    commandsDir: '.opencode/commands',
    globalCommandsDir: '.config/opencode/commands',
  },
};
