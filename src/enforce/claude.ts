/**
 * Claude Code PreToolUse adapter for OpenFlow lifecycle enforcement.
 *
 * Claude reports one Edit/Write per call, either at the payload top level or
 * nested under `tool_input`. Both shapes are already handled by the shared
 * `normalizeToolInput`, so this adapter only owns Claude's I/O contract:
 * stdin JSON in, human-readable findings on stdout, exit 1 to block.
 *
 * All policy lives in ./rules.ts — this file must stay free of rule logic.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeToolInput, runAllChecks, type RuleResult } from './rules.js';

export interface ClaudeHookEvaluation {
  exitCode: number;
  stdout: string;
  results: RuleResult[];
}

function formatResults(results: RuleResult[]): string {
  let out = '';
  for (const result of results) {
    const prefix = result.level === 'block' ? '❌' : '⚠️';
    out += `${prefix} [openflow 防火墙: ${result.id}] ${result.message}\n`;
    if (result.detail) {
      for (const line of result.detail.split('\n')) {
        out += `   ${line}\n`;
      }
    }
  }
  return out;
}

export function evaluateClaudeHook(payload: unknown, cwd: string): ClaudeHookEvaluation {
  const input = normalizeToolInput(payload, cwd);
  if (input === null) return { exitCode: 0, stdout: '', results: [] };

  const results = runAllChecks(input);
  const blocked = results.some((result) => result.level === 'block');
  return { exitCode: blocked ? 1 : 0, stdout: formatResults(results), results };
}

function runFromStdin(): void {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('end', () => {
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      process.exit(0);
      return;
    }
    const outcome = evaluateClaudeHook(payload, process.cwd());
    if (outcome.stdout) process.stdout.write(outcome.stdout);
    process.exit(outcome.exitCode);
  });
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (executedPath === fileURLToPath(import.meta.url)) runFromStdin();
