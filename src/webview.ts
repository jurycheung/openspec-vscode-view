/**
 * OpenSpec VSCode View - 流程可视化面板（Webview）
 *
 * 每个变更一个面板；在编辑区内以垂直流水线展示：
 *   阶段卡片（状态、描述、依赖、输出件）→ 输出件可点击跳转文件
 * 面板随状态模型变化自动重渲染。
 */

import * as vscode from 'vscode';
import type { ArtifactView, ChangeView, LoadedSchema } from './core';
import type { OpenSpecModel } from './openspec';

// ---------------------------------------------------------------------------
// 面板协调器
// ---------------------------------------------------------------------------

export class ProcessViewCoordinator {
  private panels = new Map<string, ProcessViewPanel>();
  private listeners: vscode.Disposable[] = [];

  constructor(
    private models: OpenSpecModel[],
    private context: vscode.ExtensionContext
  ) {
    this.setModels(models);
  }

  setModels(models: OpenSpecModel[]): void {
    for (const d of this.listeners) {
      d.dispose();
    }
    this.models = models;
    this.listeners = models.map((m) => m.onDidChange(this.onModelChange, this));
  }

  private onModelChange(): void {
    for (const panel of this.panels.values()) {
      panel.rerender();
    }
  }

  /** 打开（或聚焦）某变更的可视化面板 */
  show(modelIndex: number, changeName: string): void {
    const key = `${modelIndex}:${changeName}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const model = this.models[modelIndex];
    if (!model) {
      vscode.window.showErrorMessage('OpenSpec VSCode View：项目不存在，请刷新后重试');
      return;
    }
    const panel = new ProcessViewPanel(this, this.context, model, modelIndex, changeName, key);
    this.panels.set(key, panel);
    panel.render();
  }

  /** 从命令面板打开：无参数时弹出快速选择 */
  async showPick(): Promise<void> {
    const items: Array<vscode.QuickPickItem & { modelIndex: number; changeName: string }> = [];
    this.models.forEach((model, modelIndex) => {
      for (const change of model.changes) {
        const progress = change.totalCount > 0 ? `${change.doneCount}/${change.totalCount}` : '加载失败';
        items.push({
          label: change.name,
          description: `${model.projectLabel} · ${change.schemaName} · ${progress}`,
          modelIndex,
          changeName: change.name,
        });
      }
    });
    if (items.length === 0) {
      vscode.window.showInformationMessage('OpenSpec VSCode View：当前没有可展示的变更');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要可视化查看的变更',
      matchOnDescription: true,
    });
    if (picked) {
      this.show(picked.modelIndex, picked.changeName);
    }
  }

  disposePanel(key: string): void {
    this.panels.delete(key);
  }

  dispose(): void {
    for (const d of this.listeners) {
      d.dispose();
    }
    for (const panel of this.panels.values()) {
      panel.disposePanelOnly();
    }
    this.panels.clear();
  }
}

// ---------------------------------------------------------------------------
// 单个变更面板
// ---------------------------------------------------------------------------

export class ProcessViewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private modelListener: vscode.Disposable;

  constructor(
    private coordinator: ProcessViewCoordinator,
    private context: vscode.ExtensionContext,
    private model: OpenSpecModel,
    readonly modelIndex: number,
    private changeName: string,
    private key: string
  ) {
    this.modelListener = model.onDidChange(() => this.rerender());
    context.subscriptions.push(this);
  }

  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.render();
    }
  }

  rerender(): void {
    if (this.panel && this.panel.visible) {
      this.render();
    }
  }

  render(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'openspec-vscode-view.process',
        `流程 · ${this.changeName}`,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [],
        }
      );
      this.panel.webview.onDidReceiveMessage(
        (msg) => this.onMessage(msg),
        undefined,
        this.context.subscriptions
      );
      this.panel.onDidDispose(() => {
        this.coordinator.disposePanel(this.key);
        this.panel = undefined;
      }, undefined, this.context.subscriptions);
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.render();
        }
      }, undefined, this.context.subscriptions);
    } else {
      this.panel.title = `流程 · ${this.changeName}`;
    }
    this.panel.webview.html = this.buildHtml();
  }

  private async onMessage(msg: { type?: string; path?: string }): Promise<void> {
    switch (msg.type) {
      case 'openFile': {
        if (!msg.path) {
          return;
        }
        // beside 与否由 openOutputFile 命令统一决定（单处维护 openBeside 逻辑）
        await vscode.commands.executeCommand('openspec-vscode-view.openOutputFile', msg.path);
        break;
      }
      case 'requestRefresh':
        await this.model.refresh().catch(() => {});
        break;
      case 'revealChange': {
        const change = this.model.getChange(this.changeName);
        if (change?.changeRoot) {
          await vscode.commands.executeCommand(
            'revealInExplorer',
            vscode.Uri.file(change.changeRoot)
          );
        }
        break;
      }
    }
  }

  private buildHtml(): string {
    const change = this.model.getChange(this.changeName);
    const cli = this.model.lastCliResult;
    if (!change) {
      if (!this.model.hasLoaded) {
        return renderProblemHtml(
          '正在扫描中…',
          '正在通过 openspec status --all --json 获取变更状态，请稍候。'
        );
      }
      if (cli && cli.kind !== 'ok') {
        return renderProblemHtml('无法获取状态', cli.message ?? '未知错误');
      }
      return renderEmptyHtml(this.changeName);
    }
    if (change.loadError) {
      return renderProblemHtml(`变更 ${change.name} 加载失败`, change.loadError);
    }
    const schema = this.model.getSchema(change.schemaName);
    return renderChangeHtml(change, schema, this.model);
  }

  disposePanelOnly(): void {
    this.modelListener.dispose();
    this.panel?.dispose();
    this.panel = undefined;
  }

  dispose(): void {
    this.disposePanelOnly();
  }
}

// ---------------------------------------------------------------------------
// HTML 渲染
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_META: Record<ArtifactView['status'], { label: string; cls: string; icon: string }> = {
  done: { label: '已完成', cls: 'done', icon: '✓' },
  ready: { label: '可开始', cls: 'ready', icon: '●' },
  blocked: { label: '被阻塞', cls: 'blocked', icon: '!' },
  skipped: { label: '已跳过', cls: 'skipped', icon: '⊘' },
};

function fileIconSvg(): string {
  return (
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
    '<path d="M4 1.5h5l3 3v10H4z" stroke-linejoin="round"/><path d="M9 1.5v3h3" stroke-linejoin="round"/></svg>'
  );
}

/** 面板页面的全局样式（抽取为常量，保持 pageChrome 结构清晰） */
const PAGE_STYLES = `
  :root {
    --accent: var(--vscode-focusBorder, #4c8dff);
    --ok: var(--vscode-testing-iconPassed, #2da44e);
    --warn: var(--vscode-editorWarning-foreground, #d29922);
    --err: var(--vscode-errorForeground, #f14c4c);
    --muted: var(--vscode-descriptionForeground, #9d9d9d);
    --border: var(--vscode-panel-border, rgba(128,128,128,.32));
    --chip-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14));
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 28px 34px 48px;
    font-size: 13px;
    line-height: 1.55;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  h1 .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .badges { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 14px; align-items: center; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--vscode-badge-background, rgba(128,128,128,.25));
    color: var(--vscode-badge-foreground, inherit);
    border-radius: 999px; padding: 2px 10px; font-size: 11.5px;
  }
  .badge.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
  .badge.accent { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  .progress { height: 7px; border-radius: 999px; background: var(--chip-bg); overflow: hidden; margin: 6px 0 22px; }
  .progress > div { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--ok)); transition: width .35s ease; }
  .stepper { list-style: none; margin: 0; padding: 0; }
  .card {
    position: relative;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--vscode-editor-background);
    padding: 13px 18px 12px 58px;
    margin: 0 0 14px;
  }
  .card + .card::before {
    content: '';
    position: absolute;
    left: 24px; top: -15px;
    width: 2px; height: 15px;
    background: var(--border);
  }
  .card.current { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .dot {
    position: absolute; left: 15px; top: 14px;
    width: 19px; height: 19px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700;
  }
  .dot.done { background: var(--ok); color: #fff; }
  .dot.ready { border: 2px solid var(--accent); color: var(--accent); animation: pulse 2s ease-in-out infinite; }
  .dot.blocked { border: 2px solid var(--err); color: var(--err); }
  .dot.skipped { border: 2px dashed var(--warn); color: var(--warn); }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 35%, transparent); }
    50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 12%, transparent); }
  }
  .card-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .card-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
  .pill {
    font-size: 11px; border-radius: 999px; padding: 1px 9px; font-weight: 600;
    border: 1px solid transparent;
  }
  .pill.done { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
  .pill.ready { color: var(--accent); border-color: var(--accent); }
  .pill.blocked { color: var(--err); border-color: color-mix(in srgb, var(--err) 45%, transparent); }
  .pill.skipped { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
  .now-tag {
    margin-left: auto; font-size: 11px; color: var(--accent);
    border: 1px solid var(--accent); border-radius: 999px; padding: 1px 9px; font-weight: 600;
  }
  .card .desc { color: var(--muted); margin: 3px 0 0; }
  .deps { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
  .deps .lbl { font-size: 11px; color: var(--muted); }
  .dep {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; background: var(--chip-bg); border-radius: 5px; padding: 1px 7px;
  }
  .dep.miss { color: var(--err); }
  .dep.ok { color: var(--ok); }
  .files { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
  .filechip {
    display: inline-flex; align-items: center; gap: 7px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    background: var(--chip-bg);
    border: 1px solid transparent; border-radius: 6px;
    padding: 4px 10px;
    color: var(--vscode-foreground);
    cursor: pointer; text-align: left;
    width: fit-content; max-width: 100%;
  }
  .filechip:hover { border-color: var(--accent); color: var(--vscode-textLink-activeForeground, var(--accent)); }
  .filechip:focus-visible { outline: 1px solid var(--accent); }
  .filechip svg { flex: none; opacity: .75; }
  .nofile { font-size: 12px; color: var(--muted); margin-top: 10px; font-style: italic; }
  .actions { display: flex; gap: 10px; margin-top: 26px; align-items: center; flex-wrap: wrap; }
  button.vsc {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 3px; padding: 5px 13px;
    font-size: 12.5px; font-family: var(--vscode-font-family); cursor: pointer;
  }
  button.vsc:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .foot { margin-top: 18px; color: var(--muted); font-size: 11.5px; }
  .foot code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .warnlist { margin: 10px 0 0; padding-left: 18px; color: var(--warn); font-size: 12px; }
  .hero { text-align: center; margin-top: 12vh; }
  .hero h2 { font-weight: 400; color: var(--muted); }
  .error-box {
    border: 1px solid color-mix(in srgb, var(--err) 55%, transparent);
    background: color-mix(in srgb, var(--err) 8%, transparent);
    border-radius: 10px; padding: 18px 22px; margin-top: 20px; white-space: pre-wrap;
  }
  .schema-desc { color: var(--muted); margin: 0 0 16px; }
`;

function pageChrome(nonce: string, body: string, extraScript = ''): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<style>${PAGE_STYLES}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const fileBtn = e.target.closest('[data-file]');
    if (fileBtn) {
      vscode.postMessage({ type: 'openFile', path: fileBtn.getAttribute('data-file') });
      return;
    }
    if (e.target.closest('[data-action="refresh"]')) {
      vscode.postMessage({ type: 'requestRefresh' });
      return;
    }
    if (e.target.closest('[data-action="reveal"]')) {
      vscode.postMessage({ type: 'revealChange' });
    }
  });
  ${extraScript}
</script>
</body>
</html>`;
}

function headerHtml(change: ChangeView): string {
  const pct = change.totalCount > 0 ? Math.round((change.doneCount / change.totalCount) * 100) : 0;
  const current = change.currentArtifactId
    ? change.artifacts.find((a) => a.id === change.currentArtifactId)
    : undefined;

  let stateBadge: string;
  if (change.isPlanningComplete) {
    stateBadge = '<span class="badge ok">✓ 规划完成，可进入 apply</span>';
  } else if (current) {
    const desc = current.description ? ` — ${escapeHtml(current.description)}` : '';
    stateBadge = `<span class="badge accent">▶ 当前阶段：${escapeHtml(current.id)}${desc}</span>`;
  } else {
    const hasBlocked = change.artifacts.some((a) => a.status === 'blocked');
    stateBadge = hasBlocked
      ? '<span class="badge">⛔ 存在被阻塞的阶段，依赖完成后继续</span>'
      : '<span class="badge ok">✓ 除跳过阶段外均已完成</span>';
  }

  return `
  <h1><span class="mono">${escapeHtml(change.name)}</span></h1>
  <div class="badges">
    <span class="badge">schema：${escapeHtml(change.schemaName)}</span>
    <span class="badge">阶段 ${change.doneCount}/${change.totalCount}${change.skippedCount > 0 ? ` · 另有 ${change.skippedCount} 项跳过` : ''}</span>
    ${stateBadge}
  </div>
  <div class="progress"><div style="width:${pct}%"></div></div>`;
}

function artifactCardHtml(
  artifact: ArtifactView,
  index: number,
  change: ChangeView,
  schema: LoadedSchema | undefined
): string {
  const meta = STATUS_META[artifact.status];
  const isCurrent = change.currentArtifactId === artifact.id;
  const missing = new Set(artifact.missingDeps);
  const depChips = artifact.requires.length
    ? `<div class="deps"><span class="lbl">依赖</span>${artifact.requires
        .map((dep) => {
          const cls = missing.has(dep) ? 'miss' : 'ok';
          const mark = missing.has(dep) ? '✕' : '✓';
          return `<span class="dep ${cls}">${mark} ${escapeHtml(dep)}</span>`;
        })
        .join('')}</div>`
    : '';
  const filesHtml = artifact.files.length
    ? `<div class="files">${artifact.files
        .map(
          (f, i) =>
            `<button class="filechip" data-file="${escapeHtml(f)}" title="点击打开：${escapeHtml(artifact.displayFiles[i] ?? f)}">${fileIconSvg()}<span>${escapeHtml(artifact.displayFiles[i] ?? f)}</span></button>`
        )
        .join('')}</div>`
    : `<div class="nofile">${
        artifact.status === 'done' ? '（已完成但未找到输出文件）' : '尚无输出件'
      }</div>`;
  const schemaDesc = schema?.artifacts.get(artifact.id)?.description ?? artifact.description;

  return `
  <li class="card ${meta.cls}${isCurrent ? ' current' : ''}">
    <span class="dot ${meta.cls}">${meta.icon}</span>
    <div class="card-head">
      <h3>${index + 1}. ${escapeHtml(artifact.id)}</h3>
      <span class="pill ${meta.cls}">${meta.label}</span>
      ${isCurrent ? '<span class="now-tag">▶ 当前阶段</span>' : ''}
    </div>
    ${schemaDesc ? `<p class="desc">${escapeHtml(schemaDesc)}</p>` : ''}
    ${depChips}
    ${filesHtml}
  </li>`;
}

function renderChangeHtml(
  change: ChangeView,
  schema: LoadedSchema | undefined,
  model: OpenSpecModel
): string {
  const nonce = getNonce();
  const warnings = [
    ...(schema?.broken ? [`schema "${schema.name}"：${schema.broken}`] : []),
    ...model.warnings,
  ];
  const schemaLine = schema
    ? `<p class="schema-desc">${escapeHtml(schema.description || '（schema 未提供描述）')}${
        schema.source === 'project' ? ' · <span title="来自 openspec/schemas">项目自定义</span>' : ''
      }</p>`
    : '';

  const body = `
  ${headerHtml(change)}
  ${schemaLine}
  <ul class="stepper">
    ${change.artifacts.map((a, i) => artifactCardHtml(a, i, change, schema)).join('\n')}
  </ul>
  ${warnings.length ? `<ul class="warnlist">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
  <div class="actions">
    <button class="vsc" data-action="refresh">刷新状态</button>
    <button class="vsc" data-action="reveal" style="background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#fff)">在资源管理器中显示</button>
  </div>
  <p class="foot">数据来源：<code>openspec status --all --json</code> · 项目 ${escapeHtml(model.projectLabel)} · change 目录 <code>${escapeHtml(change.changeRoot)}</code></p>`;

  return pageChrome(nonce, body);
}

function renderProblemHtml(title: string, message: string): string {
  const nonce = getNonce();
  const body = `
  <h1>${escapeHtml(title)}</h1>
  <div class="error-box">${escapeHtml(message)}</div>
  <div class="actions">
    <button class="vsc" data-action="refresh">重新扫描</button>
  </div>
  <p class="foot">数据来源：<code>openspec status --all --json</code></p>`;
  return pageChrome(nonce, body);
}

function renderEmptyHtml(changeName: string): string {
  const nonce = getNonce();
  const body = `
  <div class="hero">
    <h2>变更 <span class="mono">${escapeHtml(changeName)}</span> 不存在或已被归档</h2>
    <div class="actions" style="justify-content:center">
      <button class="vsc" data-action="refresh">刷新状态</button>
    </div>
  </div>`;
  return pageChrome(nonce, body);
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
