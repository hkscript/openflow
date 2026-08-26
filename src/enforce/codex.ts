/**
 * Codex PreToolUse adapter for OpenFlow lifecycle enforcement.
 *
 * Codex reports edits through one `apply_patch` call whose command can affect
 * several files. This adapter parses each target and delegates policy checks
 * to the shared rules module. Unsupported patches fail closed.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { runAllChecks, type NormalizedToolInput, type RuleResult } from './rules.js';

type PatchOperation = 'add' | 'update' | 'delete' | 'rename-from' | 'rename-to';

export interface PatchTarget {
  operation: PatchOperation;
  filePath: string;
  content: string;
}

export type CodexPatchParseResult =
  | { kind: 'ignored' }
  | { kind: 'ok'; targets: PatchTarget[] }
  | { kind: 'error'; message: string };

export interface CodexHookEvaluation {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
  results: RuleResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readApplyPatchCommand(payload: unknown): string | null {
  if (!isRecord(payload) || payload.tool_name !== 'apply_patch') return null;
  if (!isRecord(payload.tool_input) || typeof payload.tool_input.command !== 'string') return null;
  return payload.tool_input.command;
}

function readPath(raw: string): string | null {
  const value = raw.trim();
  return value && value !== '/dev/null' ? value : null;
}

function addedContent(lines: string[]): string {
  return lines
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

function target(operation: PatchOperation, rawPath: string, content = ''): PatchTarget | null {
  const filePath = readPath(rawPath);
  return filePath === null ? null : { operation, filePath, content };
}

/**
 * Parse the documented apply_patch envelope plus the rename forms used by the
 * Codex patch tool. Every header must be understood, otherwise enforcement
 * denies the call rather than silently skipping a changed target.
 */
export function parseCodexApplyPatch(payload: unknown): CodexPatchParseResult {
  const command = readApplyPatchCommand(payload);
  if (command === null) return { kind: 'ignored' };

  const lines = command.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') {
    return { kind: 'error', message: 'Codex apply_patch must use a complete Begin Patch / End Patch envelope' };
  }

  const targets: PatchTarget[] = [];
  let index = 1;
  const endIndex = lines.length - 1;

  while (index < endIndex) {
    const header = lines[index];
    const renameFile = header.match(/^\*\*\* Rename File: (.+?) -> (.+)$/);
    if (renameFile) {
      const from = target('rename-from', renameFile[1]);
      const to = target('rename-to', renameFile[2]);
      if (from === null || to === null) return { kind: 'error', message: 'Codex rename has an empty path' };
      targets.push(from, to);
      index++;
      continue;
    }

    const renameFrom = header.match(/^\*\*\* Rename From: (.+)$/);
    if (renameFrom) {
      const next = lines[index + 1]?.match(/^\*\*\* Rename To: (.+)$/);
      if (!next) return { kind: 'error', message: 'Codex Rename From must be followed by Rename To' };
      const from = target('rename-from', renameFrom[1]);
      const to = target('rename-to', next[1]);
      if (from === null || to === null) return { kind: 'error', message: 'Codex rename has an empty path' };
      targets.push(from, to);
      index += 2;
      continue;
    }

    const fileHeader = header.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (!fileHeader) {
      return { kind: 'error', message: `Unsupported Codex patch header: ${header || '<empty>'}` };
    }

    const kind = fileHeader[1].toLowerCase() as 'add' | 'update' | 'delete';
    const source = target(kind, fileHeader[2]);
    if (source === null) return { kind: 'error', message: 'Codex patch has an empty file path' };
    index++;

    const body: string[] = [];
    let moveTo: string | null = null;
    while (index < endIndex) {
      const line = lines[index];
      const move = line.match(/^\*\*\* Move to: (.+)$/);
      if (move) {
        if (kind !== 'update' || moveTo !== null) {
          return { kind: 'error', message: 'Move to is only valid once after Update File' };
        }
        moveTo = move[1];
        index++;
        continue;
      }
      if (line.startsWith('*** ')) break;
      body.push(line);
      index++;
    }

    if (kind === 'add' && body.some((line) => line !== '' && !line.startsWith('+'))) {
      return { kind: 'error', message: `Add File contains a non-addition line: ${source.filePath}` };
    }
    if (kind === 'delete' && body.some((line) => line !== '')) {
      return { kind: 'error', message: `Delete File contains an unexpected body: ${source.filePath}` };
    }

    if (moveTo !== null) {
      const destination = target('rename-to', moveTo, addedContent(body));
      if (destination === null) return { kind: 'error', message: 'Move to has an empty destination path' };
      targets.push({ ...source, operation: 'rename-from', content: '' }, destination);
    } else {
      targets.push({ ...source, content: addedContent(body) });
    }
  }

  return targets.length === 0
    ? { kind: 'error', message: 'Codex apply_patch contains no file targets' }
    : { kind: 'ok', targets };
}

function targetToRuleInput(targetValue: PatchTarget, cwd: string): NormalizedToolInput {
  return {
    operation: targetValue.operation === 'add' || targetValue.operation === 'rename-to' ? 'write' : 'edit',
    filePath: targetValue.filePath,
    content: targetValue.content,
    cwd,
  };
}

function sortAndDeduplicate(results: RuleResult[]): RuleResult[] {
  const unique = new Map<string, RuleResult>();
  for (const result of results) {
    unique.set(JSON.stringify(result), result);
  }
  return [...unique.values()].sort((a, b) => {
    if (a.level !== b.level) return a.level === 'block' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function formatResults(results: RuleResult[]): string {
  return results.map((result) => {
    const detail = result.detail ? `\n${result.detail}` : '';
    return `[openflow ${result.level}: ${result.id}] ${result.message}${detail}`;
  }).join('\n');
}

export function evaluateCodexHook(payload: unknown, cwd: string): CodexHookEvaluation {
  const parsed = parseCodexApplyPatch(payload);
  if (parsed.kind === 'ignored') return { exitCode: 0, stdout: '', stderr: '', results: [] };

  const results = parsed.kind === 'error'
    ? [{
      level: 'block' as const,
      id: 'codex-patch-parse',
      message: parsed.message,
      detail: 'OpenFlow denies patches it cannot map to safe workspace targets.',
    }]
    : sortAndDeduplicate(parsed.targets.flatMap((entry) => runAllChecks(targetToRuleInput(entry, cwd))));

  const message = formatResults(results);
  if (results.some((result) => result.level === 'block')) {
    return { exitCode: 2, stdout: '', stderr: message ? `${message}\n` : '', results };
  }
  if (message) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: message,
        },
      })}\n`,
      stderr: '',
      results,
    };
  }
  return { exitCode: 0, stdout: '', stderr: '', results: [] };
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
    const outcome = evaluateCodexHook(payload, process.cwd());
    if (outcome.stdout) process.stdout.write(outcome.stdout);
    if (outcome.stderr) process.stderr.write(outcome.stderr);
    process.exit(outcome.exitCode);
  });
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (executedPath === fileURLToPath(import.meta.url)) runFromStdin();
