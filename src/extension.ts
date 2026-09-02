/**
 * OpenSpec VSCode View - VSCode 扩展入口
 *
 * 激活时：
 * 1. 扫描候选根：工作区 folders、${HOME}/openspec、~/.sef/config.json 配置的额外路径
 * 2. 通过 `openspec status --all --json` 拉取全部变更状态
 * 3. 注册「OpenSpec 流程」树视图与流程可视化面板
 * 4. 监听 openspec/ 目录变化，自动刷新
 */

import * as os from 'node:os';
import * as vscode from 'vscode';
import { detectOpenspecModels, hasOpenspecLayout, type OpenSpecModel } from './openspec';
import { ChangesTreeProvider } from './tree';
import { ProcessViewCoordinator } from './webview';
import {
  ensureConfigFile,
  loadSefConfig,
  normalizeScanInput,
  pathKey,
  saveSefConfig,
  sefConfigFile,
  type SefConfig,
} from './scanConfig';

export function activate(context: vscode.ExtensionContext): void {
  let models: OpenSpecModel[] = [];

  const treeProvider = new ChangesTreeProvider(models);
  const treeView = vscode.window.createTreeView('openspec-vscode-view.changes', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  const coordinator = new ProcessViewCoordinator(models, context);

  const updateTreeMessage = (): void => {
    if (models.length === 0) {
      treeView.message =
        '未检测到 OpenSpec 项目。会扫描：工作区 folders、${HOME}/openspec、以及 ~/.sef/config.json 中配置的额外路径。' +
        '可点击标题栏 ⚙ 配置额外扫描路径。';
    } else {
      const cliMissing = models.some((m) => m.lastCliResult?.kind === 'cli-missing');
      treeView.message = cliMissing
        ? '未找到 openspec CLI：npm install -g @fission-ai/openspec，或在设置中配置 openspec-vscode-view.cliPath。'
        : undefined;
    }
  };

  /** 首次创建配置文件时，预置工作区与主目录绝对路径作为示例（用户可自由删改）。返回配置文件路径 */
  const ensureSeededConfig = (): string => {
    const seeds: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      seeds.push(folder.uri.fsPath);
    }
    seeds.push(os.homedir());
    return ensureConfigFile(seeds);
  };

  /** 重新探测全部项目根（工作区 + HOME + 配置路径）并刷新 */
  const rebuild = (): void => {
    for (const m of models) {
      m.dispose();
    }
    ensureSeededConfig();
    const cfg = loadSefConfig();
    models = detectOpenspecModels(cfg.scanPaths);
    treeProvider.setModels(models);
    coordinator.setModels(models);
    for (const m of models) {
      context.subscriptions.push(m.onDidChange(updateTreeMessage));
      m.watch(context);
      void m.refresh().catch(() => {});
    }
    updateTreeMessage();
  };

  const refreshAll = async (reason?: string): Promise<void> => {
    if (models.length === 0) {
      // 工作区可能刚建好 openspec/，或刚写好 ~/.sef/config.json —— 重新探测
      rebuild();
      return;
    }
    await Promise.all(models.map((m) => m.refresh().catch(() => {})));
    if (reason === 'manual') {
      vscode.window.setStatusBarMessage('OpenSpec VSCode View：已刷新', 2000);
    }
  };

  /** 配置额外扫描路径（保存在 ~/.sef/config.json） */
  const configureScanPaths = async (): Promise<void> => {
    const picked = await vscode.window.showQuickPick(buildScanPathItems(), {
      placeHolder: '扫描路径配置（额外路径与工作区、主目录一起参与 openspec 扫描）',
    });
    if (!picked) {
      return;
    }

    if (picked.action === 'edit') {
      const configFile = ensureSeededConfig();
      await vscode.window.showTextDocument(vscode.Uri.file(configFile));
      return;
    }

    if (picked.action === 'add') {
      await addScanPathFlow();
      return;
    }

    if (picked.removePath) {
      removeScanPath(picked.removePath);
    }
  };

  /** 构建 QuickPick 条目：添加 / 编辑配置文件 / 已配置路径（点击移除） */
  const buildScanPathItems = (): Array<vscode.QuickPickItem & { action?: 'add' | 'edit'; removePath?: string }> => {
    const cfg = loadSefConfig();
    return [
      {
        label: '$(add) 添加扫描路径…',
        action: 'add',
        detail: '输入包含 openspec/ 目录的项目根绝对路径',
      },
      {
        label: '$(go-to-file) 编辑配置文件',
        action: 'edit',
        description: sefConfigFile(),
      },
      { label: '已配置的路径（点击移除）', kind: vscode.QuickPickItemKind.Separator },
      ...cfg.scanPaths.map((p) => ({
        label: `$(close) ${p}`,
        removePath: p,
      })),
    ];
  };

  /** 添加流：输入 → 归一化 → 查重 → 确认 → 保存并重建 */
  const addScanPathFlow = async (): Promise<void> => {
    const input = await vscode.window.showInputBox({
      prompt: '输入要扫描的项目根路径（其下应有 openspec/ 目录）',
      placeHolder: '例如 D:\\work\\my-project 或 ~/my-project',
      validateInput: (v) => {
        if (!v || v.trim().length === 0) {
          return null;
        }
        return normalizeScanInput(v) ? null : '请输入绝对路径（支持 ~ 前缀）';
      },
    });
    if (!input || !input.trim()) {
      return;
    }
    const normalized = normalizeScanInput(input);
    if (!normalized) {
      return;
    }
    const cfg: SefConfig = loadSefConfig();
    if (cfg.scanPaths.some((p) => pathKey(p) === pathKey(normalized))) {
      vscode.window.showInformationMessage('该路径已在配置中');
      return;
    }
    if (!hasOpenspecLayout(normalized)) {
      const proceed = await vscode.window.showWarningMessage(
        `"${normalized}" 下未发现 openspec 目录（config.yaml / changes / schemas）。仍要添加吗？`,
        { modal: true },
        '仍要添加'
      );
      if (proceed !== '仍要添加') {
        return;
      }
    }
    saveSefConfig({ scanPaths: [...cfg.scanPaths, normalized] });
    rebuild();
    vscode.window.setStatusBarMessage(`OpenSpec VSCode View：已添加扫描路径 ${normalized}`, 3000);
  };

  /** 移除流：删除配置项并重建 */
  const removeScanPath = (removed: string): void => {
    const cfg = loadSefConfig();
    const next = cfg.scanPaths.filter((p) => pathKey(p) !== pathKey(removed));
    if (next.length === cfg.scanPaths.length) {
      return;
    }
    saveSefConfig({ scanPaths: next });
    rebuild();
    vscode.window.setStatusBarMessage(`OpenSpec VSCode View：已移除扫描路径 ${removed}`, 3000);
  };

  rebuild();

  // 工作区结构变化（打开/切换文件夹）时重新探测
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => rebuild()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('openspec-vscode-view')) {
        void refreshAll();
      }
    }),
    coordinator,

    // 扩展停用时释放当前模型（含 FileSystemWatcher 与事件订阅）
    {
      dispose: () => {
        for (const m of models) {
          m.dispose();
        }
      },
    },

    // ── 命令 ─────────────────────────────────────────────
    vscode.commands.registerCommand('openspec-vscode-view.refresh', () => refreshAll('manual')),

    vscode.commands.registerCommand('openspec-vscode-view.configure', () => configureScanPaths()),

    vscode.commands.registerCommand(
      'openspec-vscode-view.showProcessView',
      async (modelIndexOrName?: number | string, maybeName?: string) => {
        if (typeof modelIndexOrName === 'number' && typeof maybeName === 'string') {
          coordinator.show(modelIndexOrName, maybeName);
          return;
        }
        if (typeof modelIndexOrName === 'string' && models.length > 0) {
          coordinator.show(0, modelIndexOrName);
          return;
        }
        await coordinator.showPick();
      }
    ),

    vscode.commands.registerCommand(
      'openspec-vscode-view.openOutputFile',
      async (filePath?: string, beside?: boolean) => {
        if (!filePath) {
          return;
        }
        const useBeside = beside ?? vscode.workspace.getConfiguration('openspec-vscode-view').get<boolean>('openBeside', true);
        await vscode.commands.executeCommand(
          'vscode.open',
          vscode.Uri.file(filePath),
          useBeside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active
        );
      }
    ),

    treeView
  );

  updateTreeMessage();
}

export function deactivate(): void {
  // 订阅均已挂到 context.subscriptions，由 VSCode 统一释放
}
