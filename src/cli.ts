/**
 * OpenSpec VSCode View - OpenSpec CLI 执行层（不依赖 vscode）
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractJson, type StatusEnvelope } from './core';

const execFileAsync = promisify(execFile);

export interface CliRunResult {
  kind: 'ok' | 'cli-missing' | 'parse-error' | 'run-error';
  /** kind=ok 时可用；部分 change 失败时 envelope 里带诊断条目 */
  envelope?: StatusEnvelope;
  message?: string;
  /** CLI 退出码非 0 但 JSON 信封可用（批量部分失败） */
  partialFailure?: boolean;
}

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

async function runCapture(
  cliPath: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout } = await execFileAsync(cliPath, args, {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      // Windows 下全局安装的 openspec 通常是 openspec.cmd，需要经 shell 解析
      shell: process.platform === 'win32',
      encoding: 'utf-8',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean };
    if (e.code === 'ENOENT') {
      throw err;
    }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(err),
    };
  }
}

function hasCode(err: unknown, code: string): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.code === code;
}

/**
 * 运行 `openspec status --all --json` 并解析为信封对象。
 * - CLI 未安装 → cli-missing
 * - 退出码非 0：若 stdout 仍可解析出 {changes:[]} 信封（OpenSpec 批量失败时的 null-shape 契约），按 ok+partialFailure 处理
 * - 其他解析失败 → parse-error / run-error
 */
export async function runStatusAll(cliPath: string, cwd: string): Promise<CliRunResult> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await runCapture(cliPath, ['status', '--all', '--json'], cwd);
  } catch (err) {
    if (hasCode(err, 'ENOENT')) {
      return {
        kind: 'cli-missing',
        message:
          '未找到 openspec CLI。请先安装：npm install -g @fission-ai/openspec，' +
          '或在设置 openspec-vscode-view.cliPath 中指定可执行文件完整路径。',
      };
    }
    return { kind: 'run-error', message: (err as Error).message };
  }

  const stdout = result.stdout ?? '';

  // Windows 下经 shell 调用时，命令不存在不会抛 ENOENT，而是返回 9009/1 退出码
  if (result.code === 9009 || isCommandNotFound(result.stderr)) {
    return {
      kind: 'cli-missing',
      message:
        '未找到 openspec CLI。请先安装：npm install -g @fission-ai/openspec，' +
        '或在设置 openspec-vscode-view.cliPath 中指定可执行文件完整路径。',
    };
  }

  if (!stdout.trim()) {
    return {
      kind: 'run-error',
      message: `openspec status 未产生输出（exit ${result.code}）${result.stderr ? `：${firstLine(result.stderr)}` : ''}`,
    };
  }

  try {
    const parsed = extractJson(stdout) as StatusEnvelope;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.changes)) {
      return { kind: 'parse-error', message: 'status --json 输出结构不符合预期（缺少 changes 数组）' };
    }
    return { kind: 'ok', envelope: parsed, partialFailure: result.code !== 0 };
  } catch (err) {
    return {
      kind: 'parse-error',
      message: `解析 status --json 输出失败：${(err as Error).message}`,
    };
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? '';
}

function isCommandNotFound(stderr: string): boolean {
  const s = (stderr ?? '').toLowerCase();
  return (
    s.includes('is not recognized') ||
    s.includes('不是内部或外部命令') ||
    s.includes('command not found') ||
    s.includes('no such file or directory')
  );
}
