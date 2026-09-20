import { Command } from 'commander';
import inquirer from 'inquirer';
import path from 'path';
import { checkDependencies, tryAutoInstall, checkOpenSpecInitialized, writeState } from '../core/dependency-check.js';
import { generateSkills } from '../core/skill-generator.js';
import { TOOL_PATHS, DEPS } from '../core/constants.js';
import { logger } from '../utils/logger.js';
import { exec, dirExists } from '../utils/shell.js';

const SUPPORTED_TOOLS = Object.keys(TOOL_PATHS);

export const initCommand = new Command('init')
  .description('Initialize openflow skills in the current project')
  .option('-t, --tools <tools>', 'Target tools, comma-separated', 'claude')
  .option('-g, --global', 'Install skills globally under home tool directories')
  .action(async (options) => {
    const cwd = process.cwd();
    const tools = options.tools.split(',').map((t: string) => t.trim());
    const installGlobally = Boolean(options.global);

    // Reject unsupported clients before touching the filesystem. OpenFlow only
    // supports clients that can run the lifecycle enforcement runtime; a
    // skills-only install would look enforced without being enforced.
    const unsupported = tools.filter((t: string) => !SUPPORTED_TOOLS.includes(t));
    if (unsupported.length > 0) {
      logger.blank();
      logger.error(`Unsupported tool(s): ${unsupported.join(', ')}`);
      logger.info(`Supported: ${SUPPORTED_TOOLS.join(', ')}`);
      logger.info('Cursor is not supported: it has no hook or plugin mechanism, so the phase gates,');
      logger.info('verify receipt and verified archive cannot be enforced there.');
      logger.blank();
      process.exit(1);
    }

    logger.blank();
    logger.info(`openflow init — ${installGlobally ? 'global skill setup' : 'workflow orchestrator setup'}`);
    logger.blank();

    // Step 1: Check OpenSpec
    logger.step('Checking OpenSpec ...');
    let depStatus = checkDependencies({ cwd, tools });

    if (!depStatus.openspec.installed) {
      logger.warn('OpenSpec CLI not installed');
      const { installOpenSpec } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'installOpenSpec',
          message: `Auto-install? (npm install -g ${DEPS.openspec.npmPkg}@latest)`,
          default: true,
        },
      ]);

      if (installOpenSpec) {
        const ok = tryAutoInstall(DEPS.openspec.npmPkg);
        depStatus = checkDependencies({ cwd, tools }); // recheck
        if (ok) depStatus.openspec.autoInstalled = true;
      }

      // spec/amend/close all shell out to the openspec CLI. Installing without
      // it produces a workflow that fails halfway through a phase instead of
      // at setup time.
      if (!depStatus.openspec.installed) {
        logger.blank();
        logger.error('OpenSpec CLI is required and was not installed.');
        logger.info(`  Install: ${DEPS.openspec.installHint}`);
        logger.info('  Then re-run: openflow init');
        logger.blank();
        process.exit(1);
      }
    } else {
      logger.success(`OpenSpec CLI installed${depStatus.openspec.version ? ` (v${depStatus.openspec.version})` : ''}`);
    }

    // Step 2: Check Superpowers
    logger.step('Checking Superpowers ...');

    if (!depStatus.superpowers.installed) {
      // build hard-depends on writing-plans, and the enforcement hook blocks
      // implementation edits while it is missing. Installing anyway ships a
      // workflow whose build phase cannot run.
      logger.blank();
      logger.error('Superpowers (writing-plans) is required and was not found.');
      logger.info(`  Install: ${DEPS.superpowers.installHint}`);
      logger.info('  Then re-run: openflow init');
      logger.blank();
      process.exit(1);
    } else {
      logger.success(`Superpowers installed${depStatus.superpowers.path ? ` (${depStatus.superpowers.path})` : ''}`);
    }

    if (installGlobally) {
      logger.step('Skipping project OpenSpec initialization for global install');
    } else {
      // Step 3: Check if OpenSpec is initialized in project
      logger.step('Checking project OpenSpec initialization ...');
      if (!checkOpenSpecInitialized(cwd)) {
        const { initOpenSpec } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'initOpenSpec',
            message: 'OpenSpec not initialized in this project. Run openspec init?',
            default: true,
          },
        ]);

        if (!initOpenSpec) {
          // Every phase reads and writes under openspec/. Without it the
          // workflow fails at the first gate instead of here.
          logger.blank();
          logger.error('OpenSpec is not initialized in this project — openflow cannot run without it.');
          logger.info('  Run `openspec init` yourself, then re-run: openflow init');
          logger.blank();
          process.exit(1);
        }

        const toolsFlag = tools.map((t: string) => t).join(',');
        exec(`openspec init --tools ${toolsFlag}`, { stdio: 'inherit' });
        if (!checkOpenSpecInitialized(cwd)) {
          logger.blank();
          logger.error('`openspec init` did not produce an initialized openspec/ directory.');
          logger.info('  Fix the OpenSpec install, then re-run: openflow init');
          logger.blank();
          process.exit(1);
        }
        logger.success('OpenSpec project initialized');
      } else {
        logger.success('OpenSpec project initialized');
      }
    }

    // Step 4: Generate skills
    logger.step('Generating openflow skills ...');
    generateSkills({ cwd, tools, depStatus, global: installGlobally });

    if (!installGlobally) {
      // Step 5: Write state
      writeState(cwd, {
        openspec: depStatus.openspec.installed,
        superpowers: depStatus.superpowers.installed,
        openspecProjectInitialized: checkOpenSpecInitialized(cwd),
        createdAt: new Date().toISOString(),
        tools,
      });
    }

    logger.blank();
    logger.success('openflow initialized!');
    logger.blank();

    logger.info('Available commands (两种格式等效):');
    logger.info('  /openflow proposal      /openflow-proposal');
    logger.info('  /openflow brainstorming  /openflow-brainstorming');
    logger.info('  /openflow spec           /openflow-spec');
    logger.info('  /openflow amend          /openflow-amend');
    logger.info('  /openflow build          /openflow-build');
    logger.info('  /openflow verify         /openflow-verify');
    logger.info('  /openflow close          /openflow-close');
    logger.blank();
  });
