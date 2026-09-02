/**
 * OpenSpec VSCode View - OpenSpec 检测与状态模型
 *
 * 职责：
 * - 检测工作区中的 openspec 项目（config.yaml / schemas / changes）
 * - 解析项目本地自定义 schema（openspec/schemas/<name>/schema.yaml）
 * - 通过 `openspec status --all --json` 获取全部变更状态
 * - 监听 openspec/ 目录变化，防抖触发自动刷新
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  normalizeEnvelope,
  parseSchemaYaml,
  type ChangeView,
  type LoadedSchema,
  type OpenSpecStatusView,
} from './core';
import { runStatusAll, type CliRunResult } from './cli';
import { pathKey } from './scanConfig';

/** 一个 openspec 项目的根描述（openspec/ 的父目录） */
export interface OpenspecRoot {
  /** 绝对路径 */
  fsPath: string;
  /** 树视图中显示的项目名 */
  label: string;
  /** 根来源 */
  source: 'workspace' | 'home' | 'extra';
}

/** 工作区 OpenSpec 检测与状态模型 */
export class OpenSpecModel {
  readonly root: OpenspecRoot;
  readonly openspecDir: string;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private status: OpenSpecStatusView = { changes: [], warnings: [] };
  private cliResult: CliRunResult | null = null;
  private schemas: Map<string, LoadedSchema> = new Map();
  /** 是否完成过至少一次状态加载（含失败），用于“正在扫描中”展示 */
  private loaded = false;
  private watchers: vscode.FileSystemWatcher[] = [];
  private disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private dirtyAfterRefresh = false;
  private seq = 0;

  constructor(root: OpenspecRoot) {
    this.root = root;
    this.openspecDir = path.join(root.fsPath, 'openspec');
  }

  get projectLabel(): string {
    return this.root.label;
  }

  get sourceLabel(): string {
    switch (this.root.source) {
      case 'workspace':
        return '工作区';
      case 'home':
        return '主目录';
      case 'extra':
        return '配置路径';
    }
  }

  /** 项目是否具备 openspec 结构（config.yaml 或 changes/schemas 目录任一存在） */
  get isOpenspecProject(): boolean {
    return hasOpenspecLayout(this.root.fsPath);
  }

  get changes(): ChangeView[] {
    return this.status.changes;
  }

  get warnings(): string[] {
    return this.status.warnings;
  }

  get lastCliResult(): CliRunResult | null {
    return this.cliResult;
  }

  /** 是否完成过至少一次状态加载（含失败） */
  get hasLoaded(): boolean {
    return this.loaded;
  }

  getSchema(name: string): LoadedSchema | undefined {
    return this.schemas.get(name);
  }

  getChange(name: string): ChangeView | undefined {
    return this.status.changes.find((c) => c.name === name);
  }

  // -------------------------------------------------------------------------
  // 数据加载
  // -------------------------------------------------------------------------

  async refresh(): Promise<void> {
    const mySeq = ++this.seq;
    this.refreshing = true;
    try {
      this.loadSchemas();
      const cliPath = vscode.workspace
        .getConfiguration('openspec-vscode-view')
        .get<string>('cliPath', 'openspec');
      const result = await runStatusAll(cliPath, this.root.fsPath);
      if (mySeq !== this.seq) {
        return; // 已有更新的刷新在后面排队
      }
      this.cliResult = result;
      if (result.kind === 'ok' && result.envelope) {
        this.status = normalizeEnvelope(result.envelope, this.schemas);
      } else {
        this.status = { changes: [], warnings: [result.message ?? '未知错误'] };
      }
    } finally {
      this.loaded = true;
      this.refreshing = false;
      this._onDidChange.fire();
      if (this.dirtyAfterRefresh) {
        this.dirtyAfterRefresh = false;
        this.scheduleRefresh(0);
      }
    }
  }

  /** 防抖触发刷新；刷新进行中的请求合并为一次补刷 */
  scheduleRefresh(delayMs = 500): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.refreshing) {
        this.dirtyAfterRefresh = true;
        return;
      }
      void this.refresh().catch(() => {/* refresh 内部已兜底 */});
    }, delayMs);
  }

  /** 读取项目本地自定义 schema：openspec/schemas/<name>/schema.yaml */
  private loadSchemas(): void {
    const next = new Map<string, LoadedSchema>();
    const schemasDir = path.join(this.openspecDir, 'schemas');
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(schemasDir, { withFileTypes: true });
    } catch {
      this.schemas = next;
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const schemaFile = path.join(schemasDir, entry.name, 'schema.yaml');
      if (!fs.existsSync(schemaFile)) {
        continue;
      }
      try {
        const content = fs.readFileSync(schemaFile, 'utf-8');
        const parsed = parseSchemaYaml(entry.name, entry.name, content);
        if (parsed) {
          next.set(entry.name, parsed);
        }
      } catch {
        // 读取失败忽略；CLI 侧会在状态里报错
      }
    }
    this.schemas = next;
  }

  // -------------------------------------------------------------------------
  // 文件监听
  // -------------------------------------------------------------------------

  watch(context: vscode.ExtensionContext): void {
    const autoRefresh = () =>
      vscode.workspace.getConfiguration('openspec-vscode-view').get<boolean>('autoRefresh', true);
    if (!autoRefresh()) {
      return;
    }
    const base = vscode.Uri.file(this.root.fsPath);
    // 多模式叠加：不同 watcher 后端对「目录删除」的上报行为不一致，
    // 组合 精确路径 / 单层子项 / 递归通配 以最大化事件覆盖面；重复事件由防抖合并
    const patterns = [
      new vscode.RelativePattern(base, 'openspec/config.yaml'),
      new vscode.RelativePattern(base, 'openspec/changes'),
      new vscode.RelativePattern(base, 'openspec/changes/*'),
      new vscode.RelativePattern(base, 'openspec/changes/**'),
      new vscode.RelativePattern(base, 'openspec/schemas/*'),
      new vscode.RelativePattern(base, 'openspec/schemas/**'),
    ];
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onChange = () => {
        if (autoRefresh()) {
          this.scheduleRefresh();
        }
      };
      this.disposables.push(
        watcher.onDidCreate(onChange),
        watcher.onDidChange(onChange),
        watcher.onDidDelete(onChange),
        watcher
      );
      this.watchers.push(watcher);
    }
    context.subscriptions.push(...this.disposables);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.watchers = [];
    this._onDidChange.dispose();
  }
}

/** 判断目录下是否具备 openspec 结构（openspec/config.yaml 或 changes/、schemas/ 任一存在） */
export function hasOpenspecLayout(fsPath: string): boolean {
  const dir = path.join(fsPath, 'openspec');
  return (
    fs.existsSync(path.join(dir, 'config.yaml')) ||
    fs.existsSync(path.join(dir, 'changes')) ||
    fs.existsSync(path.join(dir, 'schemas'))
  );
}

/**
 * 汇总所有待检测的项目根：
 * 1. 工作区 folders（每个 folder 根）
 * 2. 主目录 ${HOME}（扫描 ${HOME}/openspec）
 * 3. 配置的额外绝对路径（~/.sef/config.json 的 scanPaths）
 * 按路径去重（工作区优先），再过滤出具备 openspec 结构的根。
 */
export function detectOpenspecRoots(scanPaths: string[]): OpenspecRoot[] {
  const candidates: OpenspecRoot[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push({ fsPath: folder.uri.fsPath, label: folder.name, source: 'workspace' });
  }
  const home = os.homedir();
  candidates.push({ fsPath: home, label: '~（主目录）', source: 'home' });
  for (const p of scanPaths) {
    candidates.push({ fsPath: p, label: p, source: 'extra' });
  }

  const seen = new Set<string>();
  const roots: OpenspecRoot[] = [];
  for (const candidate of candidates) {
    const key = pathKey(candidate.fsPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    roots.push(candidate);
  }
  return roots;
}

/**
 * 扫描全部候选根（工作区 + ${HOME} + 配置路径），返回包含 openspec 结构的项目模型。
 */
export function detectOpenspecModels(scanPaths: string[]): OpenSpecModel[] {
  const models: OpenSpecModel[] = [];
  for (const root of detectOpenspecRoots(scanPaths)) {
    const model = new OpenSpecModel(root);
    if (model.isOpenspecProject) {
      models.push(model);
    } else {
      model.dispose();
    }
  }
  return models;
}
