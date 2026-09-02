/**
 * OpenSpec VSCode View - 目录树视图
 *
 * 层级：项目(多根工作区) → 变更(change) → 阶段(artifact) → 输出件(文件)
 * - 点击 change  → 打开流程可视化面板
 * - 点击输出件  → 打开目标文件
 * - 无输出件的阶段被点击 → 同样打开可视化面板
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ArtifactView, ChangeView } from './core';
import type { OpenSpecModel } from './openspec';

export type TreeNode =
  | InfoNode
  | ProjectNode
  | ChangeNode
  | ArtifactNode
  | FileNode;

export interface InfoNode {
  kind: 'info';
  severity: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
  /** 覆盖默认图标的 ThemeIcon id（如 'sync~spin'） */
  icon?: string;
}

export interface ProjectNode {
  kind: 'project';
  model: OpenSpecModel;
}

export interface ChangeNode {
  kind: 'change';
  modelIndex: number;
  change: ChangeView;
}

export interface ArtifactNode {
  kind: 'artifact';
  node: ChangeNode;
  artifact: ArtifactView;
}

export interface FileNode {
  kind: 'file';
  node: ChangeNode;
  artifact: ArtifactView;
  filePath: string;
  displayPath: string;
}

const STATUS_LABEL: Record<ArtifactView['status'], string> = {
  done: '已完成',
  ready: '可开始',
  blocked: '被阻塞',
  skipped: '已跳过',
};

function statusIcon(status: ArtifactView['status']): vscode.ThemeIcon {
  switch (status) {
    case 'done':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
    case 'ready':
      return new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('charts.blue'));
    case 'blocked':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red'));
    case 'skipped':
      return new vscode.ThemeIcon('eye-closed', new vscode.ThemeColor('charts.orange'));
  }
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private models: OpenSpecModel[] = [];
  private modelSubscriptions: vscode.Disposable[] = [];
  private lastFingerprint = '';

  constructor(models: OpenSpecModel[]) {
    this.setModels(models);
  }

  setModels(models: OpenSpecModel[]): void {
    for (const d of this.modelSubscriptions) {
      d.dispose();
    }
    this.modelSubscriptions = [];
    this.models = models;
    for (const m of models) {
      this.modelSubscriptions.push(m.onDidChange(this.onModelChanged, this));
    }
    this.onModelChanged();
  }

  /**
   * 只有视图数据真正变化时才 fire：
   * 树 refresh 会销毁并重建全部节点，高频 fire（如周期对账但数据未变）会不断
   * 打断展开状态并制造「点击撞上刷新」的竞态窗口。
   */
  private onModelChanged(): void {
    const fp = this.fingerprint();
    if (fp === this.lastFingerprint) {
      return;
    }
    this.lastFingerprint = fp;
    this._onDidChangeTreeData.fire();
  }

  /** 渲染所依赖的全部数据指纹：加载态 + CLI 结果类型 + 变更视图模型 */
  private fingerprint(): string {
    return this.models
      .map((m) => `${m.hasLoaded ? 1 : 0}|${m.lastCliResult?.kind ?? ''}|${JSON.stringify(m.changes)}`)
      .join('||');
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'info':
        return this.toInfoItem(element);
      case 'project':
        return this.toProjectItem(element);
      case 'change':
        return this.toChangeItem(element);
      case 'artifact':
        return this.toArtifactItem(element);
      case 'file':
        return this.toFileItem(element);
    }
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.getRoots();
    }
    switch (element.kind) {
      case 'info':
      case 'file':
        return [];
      case 'project':
        return this.projectChildren(element.model);
      case 'change':
        return this.changeChildren(element);
      case 'artifact':
        return element.artifact.files.map(
          (filePath, i): FileNode => ({
            kind: 'file',
            node: element.node,
            artifact: element.artifact,
            filePath,
            displayPath: element.artifact.displayFiles[i] ?? filePath,
          })
        );
    }
  }

  private getRoots(): TreeNode[] {
    if (this.models.length === 0) {
      return [
        {
          kind: 'info',
          severity: 'info',
          message: '未检测到 OpenSpec 项目',
          detail: '当前工作区中没有找到 openspec/ 目录（config.yaml、changes/ 或 schemas/）',
        },
      ];
    }
    if (this.models.length === 1) {
      return this.projectChildren(this.models[0]);
    }
    return this.models.map((model): ProjectNode => ({ kind: 'project', model }));
  }

  private projectChildren(model: OpenSpecModel): TreeNode[] {
    if (!model.hasLoaded) {
      return [{
        kind: 'info',
        severity: 'info',
        message: '正在扫描中…',
        detail: '正在通过 openspec status --all --json 获取变更状态',
        icon: 'sync~spin',
      }];
    }
    const cli = model.lastCliResult;
    if (cli && cli.kind === 'cli-missing') {
      return [{ kind: 'info', severity: 'error', message: 'openspec CLI 未找到', detail: cli.message }];
    }
    if (cli && (cli.kind === 'parse-error' || cli.kind === 'run-error')) {
      return [{ kind: 'info', severity: 'error', message: 'openspec status 执行失败', detail: cli.message }];
    }
    const changes = model.changes;
    if (changes.length === 0) {
      if (cli?.partialFailure) {
        return [{ kind: 'info', severity: 'warning', message: '无活动变更（CLI 报告部分失败）' }];
      }
      return [
        {
          kind: 'info',
          severity: 'info',
          message: '没有活动变更',
          detail: '使用 openspec new change <name> 创建变更，或等待变更创建后自动出现',
        },
      ];
    }
    return changes.map((change): ChangeNode => ({
      kind: 'change',
      modelIndex: this.models.indexOf(model),
      change,
    }));
  }

  private changeChildren(node: ChangeNode): TreeNode[] {
    if (node.change.loadError) {
      return [{
        kind: 'info',
        severity: 'error',
        message: '变更加载失败',
        detail: node.change.loadError,
      }];
    }
    return node.change.artifacts.map((artifact): ArtifactNode => ({
      kind: 'artifact',
      node,
      artifact,
    }));
  }

  private toInfoItem(node: InfoNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = node.icon
      ? new vscode.ThemeIcon(node.icon)
      : new vscode.ThemeIcon(
          node.severity === 'error' ? 'error' : node.severity === 'warning' ? 'warning' : 'info'
        );
    if (node.detail) {
      item.tooltip = node.detail;
      item.description = node.detail;
    }
    item.contextValue = 'info';
    return item;
  }

  private toProjectItem(node: ProjectNode): vscode.TreeItem {
    const done = node.model.changes.filter((c) => c.isPlanningComplete).length;
    const item = new vscode.TreeItem(node.model.projectLabel, vscode.TreeItemCollapsibleState.Expanded);
    item.description = `${node.model.sourceLabel} · ${node.model.changes.length} 变更 · ${done} 已完成规划`;
    item.iconPath = new vscode.ThemeIcon(
      node.model.root.source === 'home' ? 'home' : node.model.root.source === 'extra' ? 'link-external' : 'folder-library'
    );
    item.contextValue = 'project';
    return item;
  }

  private toChangeItem(node: ChangeNode): vscode.TreeItem {
    const c = node.change;
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
    if (c.loadError) {
      item.description = '加载失败';
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    } else {
      const progress = c.totalCount > 0 ? Math.round((c.doneCount / c.totalCount) * 100) : 0;
      item.description = `${c.schemaName} · ${c.doneCount}/${c.totalCount} (${progress}%)`;
      item.iconPath = c.isPlanningComplete
        ? new vscode.ThemeIcon('check-all', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('source-control', new vscode.ThemeColor('charts.blue'));
      item.tooltip = new vscode.MarkdownString(
        `**${c.name}**\n\n` +
        `- schema：\`${c.schemaName}\`\n` +
        `- 进度：${c.doneCount}/${c.totalCount}${c.skippedCount > 0 ? `（另有 ${c.skippedCount} 阶段跳过）` : ''}\n` +
        `- 状态：${c.isPlanningComplete ? '规划完成，可进入 apply' : '规划进行中'}\n` +
        `\n点击打开流程可视化`
      );
    }
    // 点击 change 直接打开流程可视化。
    // 注意：TreeItem 命令不能带 arguments —— 带参数的命令会被 VSCode 转为
    // 「委托命令 + 参数缓存」，而缓存随树 refresh 全量销毁，点击撞上刷新即报
    // “Actual command not found”。上下文由命令处理器从 treeView.selection 解析。
    item.command = {
      command: 'openspec-vscode-view.showProcessView',
      title: '打开流程可视化',
    };
    item.contextValue = 'change';
    return item;
  }

  private toArtifactItem(node: ArtifactNode): vscode.TreeItem {
    const a = node.artifact;
    const hasFiles = a.files.length > 0;
    const item = new vscode.TreeItem(a.id, hasFiles ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    // 「当前阶段」标签只给唯一的边界点；其余 ready 显示「可开始」
    const isCurrent = node.node.change.currentArtifactId === a.id;
    const statusText = isCurrent ? '▶ 当前阶段' : STATUS_LABEL[a.status];
    const depText = a.status === 'blocked' && a.missingDeps.length > 0
      ? ` · 等待 ${a.missingDeps.join(', ')}`
      : '';
    item.description = `${statusText}${depText}`;
    item.iconPath = statusIcon(a.status);
    item.tooltip = new vscode.MarkdownString(
      `**${a.id}**（${isCurrent ? '▶ 当前阶段' : STATUS_LABEL[a.status]}）\n\n` +
      (a.description ? `${a.description}\n\n` : '') +
      (a.requires.length > 0 ? `依赖：${a.requires.join('、')}\n\n` : '') +
      (hasFiles ? `输出件：${a.displayFiles.join('、')}` : '尚无输出件')
    );
    if (!hasFiles) {
      // 无参数（原因见 toChangeItem），处理器从 treeView.selection 解析所属 change
      item.command = {
        command: 'openspec-vscode-view.showProcessView',
        title: '打开流程可视化',
      };
    }
    item.contextValue = hasFiles ? 'artifact-with-files' : 'artifact';
    return item;
  }

  private toFileItem(node: FileNode): vscode.TreeItem {
    const uri = vscode.Uri.file(node.filePath);
    const item = new vscode.TreeItem(path.basename(node.displayPath), vscode.TreeItemCollapsibleState.None);
    const dir = path.dirname(node.displayPath);
    item.description = dir === '.' ? '' : dir;
    item.resourceUri = uri;
    item.tooltip = node.filePath;
    item.command = {
      command: 'openspec-vscode-view.openOutputFile',
      title: '打开输出件',
    };
    item.contextValue = 'outputFile';
    return item;
  }
}
