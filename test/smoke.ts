/**
 * 冒烟测试：验证核心解析逻辑与 openspec status --all --json 的契约。
 *
 * 无参数：使用内置 fixture 断言归一化行为。
 * 传参数：smoke.js <real-cli-output.json> —— 用真实 CLI 输出做端到端解析验证。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractJson,
  normalizeEnvelope,
  parseSchemaYaml,
  toDisplayPath,
  type LoadedSchema,
  type StatusEnvelope,
} from '../src/core';
import {
  ensureConfigFile,
  loadSefConfig,
  normalizeScanInput,
  samePathSet,
  saveSefConfig,
  sefConfigFile,
} from '../src/scanConfig';

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture：模拟 CLI 信封
// ---------------------------------------------------------------------------

const FIXTURE: StatusEnvelope = {
  changes: [
    {
      changeName: 'add-auth',
      schemaName: 'spec-driven',
      changeRoot: '/repo/openspec/changes/add-auth',
      artifactPaths: {
        proposal: {
          outputPath: 'proposal.md',
          resolvedOutputPath: '/repo/openspec/changes/add-auth/proposal.md',
          existingOutputPaths: ['/repo/openspec/changes/add-auth/proposal.md'],
        },
        specs: {
          outputPath: 'specs/**/*.md',
          resolvedOutputPath: '/repo/openspec/changes/add-auth/specs/**/*.md',
          existingOutputPaths: [
            '/repo/openspec/changes/add-auth/specs/user-auth/spec.md',
            '/repo/openspec/changes/add-auth/specs/session/spec.md',
          ],
        },
        design: {
          outputPath: 'design.md',
          resolvedOutputPath: '/repo/openspec/changes/add-auth/design.md',
          existingOutputPaths: [],
        },
        tasks: {
          outputPath: 'tasks.md',
          resolvedOutputPath: '/repo/openspec/changes/add-auth/tasks.md',
          existingOutputPaths: [],
        },
      },
      isPlanningComplete: false,
      isComplete: false,
      applyRequires: ['tasks'],
      artifacts: [
        { id: 'proposal', outputPath: 'proposal.md', status: 'done', requires: [] },
        { id: 'specs', outputPath: 'specs/**/*.md', status: 'done', requires: ['proposal'] },
        { id: 'design', outputPath: 'design.md', status: 'ready', requires: ['specs'] },
        { id: 'tasks', outputPath: 'tasks.md', status: 'blocked', requires: ['design'], missingDeps: ['design'] },
      ],
    },
    {
      changeName: 'broken-change',
      status: [{ code: 'change_error', message: 'Invalid schema at ...: boom' }],
    },
  ] as StatusEnvelope['changes'],
  root: { path: '/repo' },
};

const SCHEMA_YAML = `
name: spec-driven
version: 1
description: Default OpenSpec workflow - proposal → specs → design → tasks
artifacts:
  - id: proposal
    generates: proposal.md
    description: Initial proposal document outlining the change
    template: proposal.md
    requires: []
  - id: specs
    generates: "specs/**/*.md"
    description: Detailed specifications for the change
    template: spec.md
    requires:
      - proposal
apply:
  requires: [tasks]
  tracks: tasks.md
`;

function runFixtures(): void {
  console.log('— fixture 归一化 —');
  const schemas = new Map<string, LoadedSchema>();
  const parsed = parseSchemaYaml('spec-driven', 'spec-driven', SCHEMA_YAML);
  assert(parsed !== null, 'schema.yaml 解析成功');
  if (parsed) {
    schemas.set(parsed.name, parsed);
    assertEq([...parsed.artifacts.keys()].sort(), ['proposal', 'specs'], 'schema artifacts 提取正确');
    assert(parsed.artifacts.get('specs')?.description?.includes('Detailed') === true, 'artifact 描述提取正确');
  }

  const view = normalizeEnvelope(FIXTURE, schemas);
  assertEq(view.changes.length, 2, 'change 数量正确');
  const first = view.changes[0];
  assertEq(first.name, 'add-auth', 'change 名称正确');
  assertEq(first.schemaName, 'spec-driven', 'schema 名称正确');
  assertEq(first.doneCount, 2, 'done 计数正确');
  assertEq(first.totalCount, 4, 'totalCount 排除 skipped 正确');
  assertEq(first.currentArtifactId, 'design', '当前阶段识别正确');
  assertEq(first.artifacts[1].files.length, 2, 'glob 输出件映射正确');
  assertEq(first.artifacts[1].displayFiles[0], 'specs/user-auth/spec.md', 'displayPath 相对化正确');
  assertEq(
    first.artifacts[2].description,
    '设计：技术决策、权衡与实现方案',
    'schema 中不存在的阶段使用内置兜底描述'
  );

  const failed = view.changes[1];
  assertEq(failed.loadError, 'Invalid schema at ...: boom', '失败 change 带诊断信息');
  assertEq(failed.artifacts.length, 0, '失败 change 无阶段');

  assertEq(toDisplayPath('/repo/openspec/changes/add-auth/tasks.md', '/repo/openspec/changes/add-auth'), 'tasks.md', 'toDisplayPath 正确');

  console.log('— 畸形输入防御 —');
  let threw = false;
  try {
    extractJson('not json at all');
  } catch {
    threw = true;
  }
  assert(threw, '无 JSON 输入时 extractJson 抛错');
  const broken = parseSchemaYaml('bad', 'bad', 'artifacts: [::::');
  assert(broken?.broken !== undefined, '损坏 schema.yaml 标记 broken 而不抛出');
  const noArtifacts = parseSchemaYaml('bad2', 'bad2', 'name: bad2\n');
  assert(noArtifacts?.broken !== undefined, '缺 artifacts 的 schema 标记 broken');
}

function runRealOutput(file: string): void {
  console.log(`— 真实 CLI 输出解析：${file} —`);
  const text = fs.readFileSync(file, 'utf-8');
  const envelope = extractJson(text) as StatusEnvelope;
  assert(Array.isArray(envelope.changes), '信封包含 changes 数组');
  const view = normalizeEnvelope(envelope, new Map());
  console.log(`    共 ${view.changes.length} 个变更`);
  for (const c of view.changes.slice(0, 5)) {
    console.log(
      `    · ${c.name} [${c.schemaName || '-'}] ${c.doneCount}/${c.totalCount}` +
        `${c.currentArtifactId ? ` 当前: ${c.currentArtifactId}` : ''}${c.loadError ? ` 错误: ${c.loadError}` : ''}`
    );
  }
  assert(view.changes.length >= 0, '归一化成功');
}

function runScanConfigTests(): void {
  console.log('— scanConfig（~/.sef/config.json）—');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sef-smoke-home-'));
  try {
    assertEq(loadSefConfig(home).scanPaths.length, 0, '无配置文件时返回空配置');
    saveSefConfig({ scanPaths: ['D:\\work\\a', 'D:/work/b'] }, home);
    assert(fs.existsSync(sefConfigFile(home)), '保存后配置文件存在');
    assertEq(loadSefConfig(home).scanPaths.length, 2, '保存后读取路径数一致');

    fs.writeFileSync(sefConfigFile(home), '{"scanPaths": "not-an-array"', 'utf-8');
    assertEq(loadSefConfig(home).scanPaths.length, 0, '畸形配置容错为空数组');
    fs.writeFileSync(sefConfigFile(home), '{broken json', 'utf-8');
    assertEq(loadSefConfig(home).scanPaths.length, 0, '损坏 JSON 容错为空数组');
    ensureConfigFile([], home);
    assert(fs.existsSync(sefConfigFile(home)), 'ensureConfigFile 修复损坏配置');

    assertEq(normalizeScanInput('~/proj', home), path.join(home, 'proj'), '~ 前缀展开到主目录');
    assertEq(normalizeScanInput('relative/path', home), null, '相对路径被拒绝');
    assertEq(normalizeScanInput('   ', home), null, '空白输入被拒绝');
    assert(normalizeScanInput('D:\\work\\a', home) !== null, 'Windows 盘符绝对路径接受');
    assert(normalizeScanInput('D:/work/a', home) !== null, 'Windows 正斜杠绝对路径接受');
    assert(normalizeScanInput('/usr/local/x', home) !== null, 'POSIX 绝对路径接受');

    // 根集合对账（samePathSet）：顺序无关，跨平台大小写行为随 pathKey
    assert(samePathSet(['D:\\work\\a', 'D:/work/b'], ['D:/work/b', 'D:\\work\\a']), '路径集合相等（顺序无关）');
    assert(!samePathSet(['D:\\work\\a'], ['D:\\work\\a', 'D:\\work\\c']), '路径集合不等（数量不同）');
    assert(!samePathSet(['D:\\work\\a'], ['D:\\work\\c']), '路径集合不等（元素不同）');
    assert(samePathSet([], []), '空集合相等');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** 构造最小 ChangeStatusJson（无输出件映射） */
function miniChange(
  name: string,
  stages: Array<{ id: string; status: 'done' | 'skipped' | 'ready' | 'blocked'; missingDeps?: string[] }>,
  isPlanningComplete = false
): StatusEnvelope {
  return {
    changes: [
      {
        changeName: name,
        schemaName: 's',
        changeRoot: '/r/' + name,
        artifactPaths: {},
        artifacts: stages.map((s) => ({
          id: s.id,
          outputPath: s.id + '.md',
          status: s.status,
          requires: [],
          missingDeps: s.missingDeps ?? [],
        })),
        isPlanningComplete,
        isComplete: isPlanningComplete,
      } as StatusEnvelope['changes'] extends (infer T)[] | undefined ? T : never,
    ],
  };
}

function runCurrentRulesTests(): void {
  console.log('— 当前阶段判定与跳过推导 —');
  const empty = new Map<string, LoadedSchema>();

  // 场景 1：中间空洞（specs 未标记，但其后 design/review/tasks 已完成）→ specs 显示为跳过
  const hole = normalizeEnvelope(
    miniChange('hole', [
      { id: 'intent', status: 'done' },
      { id: 'specs', status: 'ready' },
      { id: 'design', status: 'done' },
      { id: 'review', status: 'done' },
      { id: 'tasks', status: 'done' },
    ]),
    empty
  ).changes[0];
  assertEq(hole.artifacts[1].status, 'skipped', '空洞阶段被推导为跳过');
  assertEq(hole.currentArtifactId, null, '全部完成（除空洞）时无当前阶段');
  assertEq(hole.doneCount, 4, 'done 计数保持 CLI 口径');
  assertEq(hole.totalCount, 5, 'totalCount 保持 CLI 口径（推导跳过不计入）');

  // 场景 2：并行 ready（intent 完成后 specs 与 design 同时就绪）→ 当前 = 最后完成阶段的下一个（specs）
  const parallel = normalizeEnvelope(
    miniChange('parallel', [
      { id: 'intent', status: 'done' },
      { id: 'specs', status: 'ready' },
      { id: 'design', status: 'ready' },
      { id: 'review', status: 'blocked', missingDeps: ['design'] },
      { id: 'tasks', status: 'blocked', missingDeps: ['design', 'review'] },
    ]),
    empty
  ).changes[0];
  assertEq(parallel.currentArtifactId, 'specs', '并行就绪时当前 = 边界点后继（声明序首个）');

  // 场景 3：CLI skip_specs 跳过项参与“跳过”跳跃
  const hop = normalizeEnvelope(
    miniChange('hop', [
      { id: 'intent', status: 'done' },
      { id: 'specs', status: 'skipped' },
      { id: 'design', status: 'ready' },
      { id: 'review', status: 'blocked', missingDeps: ['design'] },
    ]),
    empty
  ).changes[0];
  assertEq(hop.currentArtifactId, 'design', '当前阶段跳过 CLI 跳过项');

  // 场景 4：全新变更（无任何完成）→ 当前 = 第一个 ready
  const fresh = normalizeEnvelope(
    miniChange('fresh', [
      { id: 'a', status: 'ready' },
      { id: 'b', status: 'ready' },
    ]),
    empty
  ).changes[0];
  assertEq(fresh.currentArtifactId, 'a', '无完成阶段时当前 = 第一个 ready');
}

function main(): void {
  const arg = process.argv[2];
  if (arg) {
    runRealOutput(arg);
  } else {
    runFixtures();
    runScanConfigTests();
    runCurrentRulesTests();
  }
  if (failures > 0) {
    console.error(`\n冒烟测试失败：${failures} 项`);
    process.exit(1);
  }
  console.log('\n冒烟测试全部通过');
}

main();
