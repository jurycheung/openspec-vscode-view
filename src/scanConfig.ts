/**
 * OpenSpec VSCode View - 扫描路径配置（${HOME}/.sef/config.json）
 *
 * 职责：
 * - 读写用户主目录下 .sef/config.json 的额外扫描路径
 * - 路径归一化（~ 展开、相对路径拒绝）
 * 所有函数接受 homeDir 参数以便测试；默认使用 os.homedir()。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SefConfig {
  /** 额外参与 openspec 扫描的项目根绝对路径（openspec/ 的父目录） */
  scanPaths: string[];
}

function sefDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.sef');
}

export function sefConfigFile(homeDir: string = os.homedir()): string {
  return path.join(sefDir(homeDir), 'config.json');
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim());
}

/** 读取配置；文件缺失或损坏时返回空配置（损坏不抛错，保持可用性） */
export function loadSefConfig(homeDir: string = os.homedir()): SefConfig {
  try {
    const file = sefConfigFile(homeDir);
    if (!fs.existsSync(file)) {
      return { scanPaths: [] };
    }
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') {
      return { scanPaths: [] };
    }
    return { scanPaths: asStringArray((raw as { scanPaths?: unknown }).scanPaths) };
  } catch {
    return { scanPaths: [] };
  }
}

/** 保存配置；自动创建 ~/.sef/ 目录 */
export function saveSefConfig(cfg: SefConfig, homeDir: string = os.homedir()): void {
  const dir = sefDir(homeDir);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    $comment: 'OpenSpec VSCode View 额外扫描路径：每项为包含 openspec/ 目录的项目根绝对路径',
    scanPaths: cfg.scanPaths,
  };
  fs.writeFileSync(sefConfigFile(homeDir), JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

/**
 * 配置文件缺失时创建默认骨架；seedPaths 会作为示例路径预置进去
 * （通常是工作区与主目录的绝对路径，供用户参考，可自由删改）。
 * 返回配置文件路径。
 */
export function ensureConfigFile(seedPaths: string[] = [], homeDir: string = os.homedir()): string {
  const file = sefConfigFile(homeDir);
  if (!fs.existsSync(file)) {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const p of seedPaths) {
      const key = pathKey(p);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(p);
      }
    }
    saveSefConfig({ scanPaths: deduped }, homeDir);
  }
  return file;
}

/**
 * 归一化用户输入的扫描路径：
 * - 去首尾空白；支持 ~/ 前缀展开到主目录
 * - 必须是绝对路径（Windows 盘符 / UNC / POSIX 绝对路径），否则返回 null
 */
export function normalizeScanInput(input: string, homeDir: string = os.homedir()): string | null {
  let p = input.trim();
  if (p.length === 0) {
    return null;
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(homeDir, p.slice(1));
  }
  const isWinAbsolute = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (!path.isAbsolute(p) && !isWinAbsolute) {
    return null;
  }
  return path.normalize(p);
}

/** 路径去重键：Windows 不区分大小写 */
export function pathKey(p: string): string {
  const norm = path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}
