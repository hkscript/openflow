/**
 * OpenCode enforcement plugin adapter.
 *
 * OpenCode calls `tool.execute.before` with `{ call: { name, input } }`; that
 * shape is already handled by the shared `normalizeToolInput`, so this adapter
 * only owns OpenCode's I/O contract: warnings to console, `output.abort` to
 * block.
 *
 * All policy lives in ./rules.ts — this file must stay free of rule logic.
 * `pnpm run build` inlines rules.js into a self-contained single-file plugin
 * (dist/enforce/opencode-plugin.mjs) via scripts/build-opencode-plugin.mjs;
 * that generated file is what `openflow init` installs. The plugin is never
 * loaded with a sibling import, so it cannot silently fail to resolve at load.
 */
import { normalizeToolInput, runAllChecks } from './rules.js';

interface OpencodeToolInput {
  call: {
    name: string;
    input: Record<string, unknown>;
  };
}

interface OpencodeOutput {
  abort?: string;
}

export default {
  'tool.execute.before': async (input: OpencodeToolInput, output: OpencodeOutput) => {
    const normalized = normalizeToolInput(input, process.cwd());
    if (normalized === null) return;

    const results = runAllChecks(normalized);

    const blocks = results.filter((r) => r.level === 'block');
    const warns = results.filter((r) => r.level === 'warn');

    for (const w of warns) {
      console.warn(`⚠️ [openflow 防火墙: ${w.id}] ${w.message}`);
      if (w.detail) console.warn(`   ${w.detail}`);
    }

    if (blocks.length > 0) {
      const msg = blocks.map((b) => `[${b.id}] ${b.message}`).join('; ');
      output.abort = msg;
    }
  },
};
