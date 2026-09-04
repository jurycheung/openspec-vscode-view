/**
 * OpenSpec VSCode VSCode View - 阶段依赖 DAG 布局（纯函数，无 vscode 依赖）
 *
 * 输入 artifact 列表（schema 声明顺序），输出分层布局：
 * - 层级 = 最长路径（max(依赖层)+1），同层阶段即"可并行"的一批
 * - 环路：引用自身/互相依赖的畸形 schema 不死循环，打断环按近似层级渲染并标记 hasCycle
 * - 未知依赖 id（requires 指向不存在的阶段）不参与布局，不产生连线
 */

export type DagStatus = 'done' | 'ready' | 'blocked' | 'skipped';

export interface DagNodeInput {
  id: string;
  requires: string[];
  status: DagStatus;
  isCurrent: boolean;
}

export interface DagNode extends DagNodeInput {
  /** 分层号（0 = 无依赖） */
  level: number;
  /** 同层内的行号（保持 schema 声明顺序） */
  row: number;
  /** SVG 画布坐标 */
  x: number;
  y: number;
}

export interface DagEdge {
  from: string;
  to: string;
  /** ok = 依赖已完成；miss = 目标被阻塞且此依赖缺失；pending = 依赖未完成 */
  cls: 'ok' | 'pending' | 'miss';
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
  hasCycle: boolean;
}

export const DAG_NODE_W = 170;
export const DAG_NODE_H = 44;
export const DAG_GAP_X = 64;
export const DAG_GAP_Y = 16;
export const DAG_PAD = 10;

/**
 * 最长路径分层 + 环检测：level = max(依赖层)+1。
 * 环上分支按 0 层贡献打断（不死循环），其余部分正常布局。
 */
function computeLevels(
  items: DagNodeInput[],
  byId: Map<string, DagNodeInput>
): { levels: Map<string, number>; hasCycle: boolean } {
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  let hasCycle = false;

  const levelOf = (id: string): number => {
    const memo = levels.get(id);
    if (memo !== undefined) {
      return memo;
    }
    if (visiting.has(id)) {
      // 环：打断该分支（按 0 层贡献），继续布局其余部分
      hasCycle = true;
      return 0;
    }
    visiting.add(id);
    const item = byId.get(id);
    let level = 0;
    if (item) {
      for (const dep of new Set(item.requires)) {
        if (!byId.has(dep)) {
          continue;
        }
        const cand = levelOf(dep) + 1;
        if (cand > level) {
          level = cand;
        }
      }
    }
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  for (const it of items) {
    levelOf(it.id);
  }
  return { levels, hasCycle };
}

/** 连线着色：依赖已完成 → ok；目标被阻塞且缺失 → miss；其余 → pending */
function edgeClass(fromStatus: DagStatus, toStatus: DagStatus): DagEdge['cls'] {
  if (fromStatus === 'done') {
    return 'ok';
  }
  return toStatus === 'blocked' ? 'miss' : 'pending';
}

export function computeDagLayout(items: DagNodeInput[]): DagLayout {
  const byId = new Map(items.map((it) => [it.id, it]));
  const { levels, hasCycle } = computeLevels(items, byId);

  const byLevel = new Map<number, DagNode[]>();
  const nodes: DagNode[] = [];
  for (const it of items) {
    const level = levels.get(it.id) ?? 0;
    let col = byLevel.get(level);
    if (!col) {
      col = [];
      byLevel.set(level, col);
    }
    const node: DagNode = { ...it, level, row: col.length, x: 0, y: 0 };
    col.push(node);
    nodes.push(node);
  }

  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  let maxRows = 1;
  sortedLevels.forEach((lv, colIdx) => {
    const col = byLevel.get(lv) ?? [];
    for (const node of col) {
      node.x = DAG_PAD + colIdx * (DAG_NODE_W + DAG_GAP_X);
      node.y = DAG_PAD + node.row * (DAG_NODE_H + DAG_GAP_Y);
    }
    if (col.length > maxRows) {
      maxRows = col.length;
    }
  });

  const edges: DagEdge[] = [];
  for (const it of items) {
    for (const dep of new Set(it.requires)) {
      if (!byId.has(dep)) {
        continue;
      }
      const from = byId.get(dep);
      if (!from) {
        continue;
      }
      edges.push({
        from: dep,
        to: it.id,
        cls: edgeClass(from.status, it.status),
      });
    }
  }

  const width =
    DAG_PAD * 2 + sortedLevels.length * DAG_NODE_W + Math.max(0, sortedLevels.length - 1) * DAG_GAP_X;
  const height = DAG_PAD * 2 + maxRows * DAG_NODE_H + Math.max(0, maxRows - 1) * DAG_GAP_Y;
  return { nodes, edges, width, height, hasCycle };
}
