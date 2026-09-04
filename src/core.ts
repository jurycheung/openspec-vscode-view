/**
 * OpenSpec VSCode View - 纯逻辑层（不依赖 vscode，可独立测试）
 *
 * 数据契约来自 OpenSpec CLI：
 *   openspec status --all --json
 * 输出结构（见 OpenSpec src/core/artifact-graph/instruction-loader.ts）：
 *   { changes: ChangeStatus[] | { changeName, status: Diagnostic[] }[], root }
 */

// ---------------------------------------------------------------------------
// CLI JSON 契约类型
// ---------------------------------------------------------------------------

export interface ArtifactPathSummary {
  outputPath: string;
  resolvedOutputPath: string;
  existingOutputPaths: string[];
}

export type ArtifactState = 'done' | 'skipped' | 'ready' | 'blocked';

/** 阶段状态的统一中文标签（树视图与 Webview 共用，避免两处文案漂移） */
export const STATUS_LABEL: Record<ArtifactState, string> = {
  done: '已完成',
  ready: '可开始',
  blocked: '被阻塞',
  skipped: '已跳过',
};

export interface ArtifactStatusJson {
  id: string;
  outputPath: string;
  status: ArtifactState;
  requires: string[];
  missingDeps?: string[];
}

export interface ChangeStatusJson {
  changeName: string;
  schemaName: string;
  changeRoot: string;
  artifactPaths: Record<string, ArtifactPathSummary>;
  nextSteps?: string[];
  isPlanningComplete?: boolean;
  isComplete?: boolean;
  applyRequires?: string[];
  artifacts: ArtifactStatusJson[];
}

/** 批量加载中单个 change 加载失败的诊断条目 */
export interface FailedChangeJson {
  changeName: string;
  status: Array<{ code?: string; message?: string }>;
}

export type BatchEntryJson = ChangeStatusJson | FailedChangeJson;

export interface StatusEnvelope {
  changes?: BatchEntryJson[];
  root?: unknown;
  message?: string;
}

// ---------------------------------------------------------------------------
// schema.yaml 契约类型（OpenSpec src/core/artifact-graph/types.ts 的子集）
// ---------------------------------------------------------------------------

export interface SchemaArtifact {
  id: string;
  generates: string;
  description?: string;
  template?: string;
  instruction?: string;
  requires?: string[];
}

export interface SchemaDef {
  name: string;
  version?: number;
  description?: string;
  artifacts: SchemaArtifact[];
  apply?: {
    requires?: string[];
    tracks?: string | null;
    instruction?: string;
  };
}

/** 供 UI 使用的 schema 信息（来自项目本地 schema.yaml，或内置兜底） */
export interface LoadedSchema {
  name: string;
  source: 'project' | 'builtin-fallback';
  description: string;
  artifacts: Map<string, SchemaArtifact>;
  broken?: string;
}

// ---------------------------------------------------------------------------
// 归一化后的视图模型（树 / Webview 共用）
// ---------------------------------------------------------------------------

export interface ArtifactView {
  id: string;
  status: ArtifactState;
  requires: string[];
  missingDeps: string[];
  /** 已生成的输出文件绝对路径 */
  files: string[];
  /** 相对 changeRoot 的显示路径 */
  displayFiles: string[];
  description: string;
}

export interface ChangeView {
  name: string;
  schemaName: string;
  changeRoot: string;
  artifacts: ArtifactView[];
  doneCount: number;
  /** 排除 skipped 后的总阶段数（与 CLI 文本输出口径一致） */
  totalCount: number;
  skippedCount: number;
  isPlanningComplete: boolean;
  /** 第一个 ready 阶段 id；全部完成时为 null */
  currentArtifactId: string | null;
  /** 该 change 加载失败时的错误信息（此时 artifacts 为空） */
  loadError?: string;
}

export interface OpenSpecStatusView {
  changes: ChangeView[];
  /** 全部 change 一次性归一化完成的剩余警告 */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// JSON 解析与归一化
// ---------------------------------------------------------------------------

/**
 * 从 CLI stdout 中稳健地提取第一个 JSON 对象。
 * 正常情况下 stdout 就是纯 JSON，但这里做防御：忽略可能混入的前导非 JSON 行。
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) {
    throw new Error('输出中未找到 JSON 对象');
  }
  return JSON.parse(text.slice(start));
}

function isFailedChangeEntry(entry: BatchEntryJson): entry is FailedChangeJson {
  return typeof (entry as FailedChangeJson).status === 'object' &&
    Array.isArray((entry as FailedChangeJson).status) &&
    !Array.isArray((entry as ChangeStatusJson).artifacts);
}

function normalizeChange(entry: ChangeStatusJson, schema?: LoadedSchema): ChangeView {
  const artifacts: ArtifactView[] = (entry.artifacts ?? []).map((a) => {
    const paths = entry.artifactPaths?.[a.id];
    const files = [...(paths?.existingOutputPaths ?? [])];
    const changeRoot = entry.changeRoot ?? '';
    const displayFiles = files.map((f) => toDisplayPath(f, changeRoot));
    return {
      id: a.id,
      status: a.status,
      requires: a.requires ?? [],
      missingDeps: a.missingDeps ?? [],
      files,
      displayFiles,
      description: schema?.artifacts.get(a.id)?.description ?? fallbackArtifactDescription(a.id),
    };
  });

  const skippedCount = artifacts.filter((a) => a.status === 'skipped').length;
  const doneCount = artifacts.filter((a) => a.status === 'done').length;
  // 流程越过推导：中间未完成但后面已有完成阶段的阶段显示为跳过（仅影响展示）
  deriveSkips(artifacts);

  return {
    name: entry.changeName,
    schemaName: entry.schemaName || 'spec-driven',
    changeRoot: entry.changeRoot ?? '',
    artifacts,
    doneCount,
    totalCount: artifacts.length - skippedCount,
    skippedCount,
    isPlanningComplete: Boolean(entry.isPlanningComplete ?? entry.isComplete),
    currentArtifactId: findCurrentArtifactId(artifacts),
  };
}

export function normalizeEnvelope(envelope: StatusEnvelope, schemas: Map<string, LoadedSchema>): OpenSpecStatusView {
  const warnings: string[] = [];
  const changes: ChangeView[] = [];

  for (const entry of envelope.changes ?? []) {
    if (isFailedChangeEntry(entry)) {
      const diag = entry.status?.[0];
      changes.push({
        name: entry.changeName,
        schemaName: '',
        changeRoot: '',
        artifacts: [],
        doneCount: 0,
        totalCount: 0,
        skippedCount: 0,
        isPlanningComplete: false,
        currentArtifactId: null,
        loadError: diag?.message ?? diag?.code ?? '变更加载失败',
      });
      continue;
    }
    if (!entry.changeName) {
      continue;
    }
    const schema = schemas.get(entry.schemaName);
    if (!schema && entry.schemaName) {
      warnings.push(`未在项目本地 schemas 中找到 schema "${entry.schemaName}"，阶段描述使用内置兜底`);
    }
    changes.push(normalizeChange(entry, schema));
  }

  return { changes, warnings };
}

// ---------------------------------------------------------------------------
// schema.yaml 解析（宽松：仅提取 UI 需要的字段，错误不致命）
// ---------------------------------------------------------------------------

export function parseSchemaYaml(name: string, dirName: string, content: string): LoadedSchema | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const YAML = require('../vendor/yaml/dist/index.js') as typeof import('yaml');
  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (err) {
    return {
      name,
      source: 'project',
      description: '',
      artifacts: new Map(),
      broken: `schema.yaml 解析失败：${(err as Error).message}`,
    };
  }
  if (!raw || typeof raw !== 'object') {
    return {
      name,
      source: 'project',
      description: '',
      artifacts: new Map(),
      broken: 'schema.yaml 顶层不是对象',
    };
  }
  const def = raw as Partial<SchemaDef>;
  if (!Array.isArray(def.artifacts)) {
    return {
      name,
      source: 'project',
      description: '',
      artifacts: new Map(),
      broken: 'schema.yaml 缺少 artifacts 列表',
    };
  }
  const artifacts = new Map<string, SchemaArtifact>();
  for (const a of def.artifacts) {
    if (a && typeof a.id === 'string' && a.id.length > 0) {
      artifacts.set(a.id, a);
    }
  }
  return {
    name,
    source: 'project',
    description: typeof def.description === 'string' ? def.description : '',
    artifacts,
    // 目录名与 schema.yaml 里的 name 不一致时以目录名为准（OpenSpec 按目录名解析）
    broken: def.name && def.name !== dirName ? `注意：schema.yaml name="${def.name}" 与目录名 "${dirName}" 不一致` : undefined,
  };
}

/** 内置 spec-driven 四件套的阶段描述兜底（schema.yaml 不可用时使用） */
function fallbackArtifactDescription(id: string): string {
  const known: Record<string, string> = {
    proposal: '提案：说明变更的动机（Why）、范围与影响',
    specs: '规格：以 delta 形式描述需求与可验证场景',
    design: '设计：技术决策、权衡与实现方案',
    tasks: '任务：可勾选的实施清单',
    apply: '实施：按任务清单逐项执行并勾选进度',
  };
  return known[id] ?? '';
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function toDisplayPath(absolutePath: string, root: string): string {
  if (!root) {
    return absolutePath;
  }
  const normRoot = root.replace(/[\\/]+$/, '');
  let p = absolutePath;
  if (p.startsWith(normRoot)) {
    p = p.slice(normRoot.length);
    p = p.replace(/^[\\/]+/, '');
    return p.length > 0 ? p : '.';
  }
  return absolutePath;
}

/**
 * 推导跳过：按 schema 声明顺序，某阶段未完成（ready/blocked）但其后存在已完成阶段，
 * 说明流程已越过它 → 显示为 skipped。
 * 仅影响展示状态；doneCount / totalCount 仍保持 CLI 口径不变。
 */
function deriveSkips(artifacts: ArtifactView[]): void {
  let lastDoneIdx = -1;
  for (let i = artifacts.length - 1; i >= 0; i--) {
    if (artifacts[i].status === 'done') {
      lastDoneIdx = i;
      break;
    }
  }
  if (lastDoneIdx < 0) {
    return;
  }
  for (let i = 0; i < lastDoneIdx; i++) {
    const a = artifacts[i];
    if (a.status === 'ready' || a.status === 'blocked') {
      a.status = 'skipped';
      a.missingDeps = [];
    }
  }
}

/**
 * 当前阶段 = 声明顺序中「最后一个已完成阶段」的下一个（跳过 skipped 项）；
 * 尚无已完成阶段时取第一个 ready。
 */
function findCurrentArtifactId(artifacts: ArtifactView[]): string | null {
  let lastDoneIdx = -1;
  for (let i = 0; i < artifacts.length; i++) {
    if (artifacts[i].status === 'done') {
      lastDoneIdx = i;
    }
  }
  if (lastDoneIdx < 0) {
    return artifacts.find((a) => a.status === 'ready')?.id ?? null;
  }
  for (let i = lastDoneIdx + 1; i < artifacts.length; i++) {
    if (artifacts[i].status === 'skipped') {
      continue;
    }
    return artifacts[i].id;
  }
  return null;
}
