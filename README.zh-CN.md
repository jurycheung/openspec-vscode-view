# OpenSpec VSCode View

English | [简体中文](README.zh-CN.md)

一个面向 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 工作流的 VSCode 扩展：**自动检测（含自定义）schema 与变更，按 change 展示阶段与输出件，支持点击跳转文件，并在编辑区内对每个变更做过程可视化。**

## 功能

### 1. 自动检测
- 扫描**三类项目根**（自动去重）：
  1. 工作区 folders 的根目录（每个 folder 下直接查找 `openspec/`）
  2. **主目录 `${HOME}/openspec`**（默认扫描）
  3. `~/.sef/config.json` 中配置的**额外绝对路径**（树视图标题栏 ⚙ 按钮管理）
- 每个根下检查 `openspec/config.yaml`、`openspec/changes/`、`openspec/schemas/` 任一存在即识别
- 解析**项目本地自定义 schema**（`openspec/schemas/<name>/schema.yaml`），提取阶段定义与描述
- 监听 `openspec/` 目录变化，变更 / schema 文件一有改动即自动刷新（可配置关闭）

### 1.1 扫描路径配置（⚙ 按钮）
树视图标题栏的「刷新 ⟳」旁有「配置扫描路径 ⚙」按钮，交互流程：
- **添加扫描路径…**：输入项目根绝对路径（支持 `~` 前缀展开；相对路径被拒绝）。若该路径下未发现 openspec 结构会弹窗确认
- **编辑配置文件**：直接打开并创建 `~/.sef/config.json`
- **已配置路径**：点击即移除

配置文件格式（`${HOME}/.sef/config.json`）：
```json
{
  "$comment": "OpenSpec VSCode View 额外扫描路径：每项为包含 openspec/ 目录的项目根绝对路径",
  "scanPaths": ["D:\\work\\project-a", "~/work/project-b"]
}
```
首次创建配置文件时，会预置**当前工作区 folders 与主目录的绝对路径**作为示例，用户可自由删改（删除不影响默认扫描——工作区与主目录始终参与）。文件损坏或缺字段时自动容错为空配置。

### 2. 状态判定（CLI 权威数据源）
- 通过 `openspec status --all --json` 获取全部活动变更的状态
- 阶段状态四态：`done`（已完成）/ `ready`（当前可开始）/ `blocked`（被依赖阻塞）/ `skipped`（skip_specs 跳过）
- 每个 change 绑定的 schema 以 CLI 解析结果为准（支持 per-change schema 元数据）
- **当前阶段判定**：当前阶段 = schema 声明顺序中「最后一个已完成阶段」的下一个（自动跳过 skip_specs 跳过项）；若中间存在未完成但其后已有完成阶段的阶段（流程越过的空洞），该阶段显示为**跳过**
- **流程图头部**：不再笼统显示「规划进行中」，而是显示当前阶段 id 与其在 schema 中的描述（如 `▶ 当前阶段：review — 设计评审：由另一视角检查设计完整性与风险`）
- **扫描中状态**：首次加载完成前，树视图与面板显示「正在扫描中…」（旋转图标），而非「没有活动变更」

### 3. 目录树视图（活动栏 → OpenSpec 流程）
```
项目（多根工作区时显示）
└── ◆ add-auth                    spec-driven · 2/4 (50%)
    ├── ✓ proposal      已完成
    │   └── 📄 proposal.md          ← 点击打开文件
    ├── ✓ specs         已完成
    │   ├── 📄 specs/user-auth/spec.md
    │   └── 📄 specs/session/spec.md
    ├── ○ design        ▶ 当前阶段  ← 唯一边界点；其余就绪阶段显示「可开始」
    └── ⊘ tasks         被阻塞 · 等待 design
```
- 点击 **change** → 打开流程可视化面板
- 点击 **输出件** → 打开目标文件
- 标题栏刷新按钮手动刷新

### 4. 过程可视化面板（编辑区内）
- 垂直流水线展示一个变更的全部阶段：状态节点、阶段描述（来自 schema）、依赖链、输出件
- **当前阶段**高亮 + 呼吸动效，依赖缺失标红，skip_specs 标记为跳过
- 输出件以芯片按钮呈现，**点击即在旁侧编辑组打开对应文件**
- 顶部进度条 + schema 徽章 + 规划完成状态；底部可一键刷新 / 在资源管理器中显示
- 完全遵循 VSCode 主题变量（深色 / 浅色主题自适应）

## 使用

1. 安装（任选其一）：
   ```bash
   # 方式一：从 GitHub Releases 下载 vsix（推荐）
   code --install-extension openspec-vscode-view-0.1.2.vsix

   # 方式二：从源码构建
   npm install
   npm run package        # 生成 openspec-vscode-view-0.1.2.vsix
   code --install-extension openspec-vscode-view-0.1.2.vsix
   ```
2. 确保 `openspec` CLI 可用（`npm i -g @fission-ai/openspec`），或在设置中指定：
   - `openspec-vscode-view.cliPath`：CLI 可执行文件路径（默认 `openspec`）
   - `openspec-vscode-view.autoRefresh`：文件监听自动刷新（默认开）
   - `openspec-vscode-view.openBeside`：点击输出件在旁侧打开（默认开）
   - `openspec-vscode-view.reconcileInterval`：周期性状态对账间隔（秒，默认 15，0 关闭）——兜底文件监听漏报（如删除 change 目录）
3. 打开包含 `openspec/` 的项目，活动栏出现「OpenSpec 流程」图标；点击任意 change 或执行命令
   **`OpenSpec VSCode View：打开流程可视化`** 查看过程视图。

## 开发

```bash
npm install
npm run compile        # tsc 编译到 dist/
npm run watch          # 监视编译
npm run smoke          # 契约冒烟测试（fixture）
node dist/test/smoke.js <real-cli-output.json>   # 用真实 CLI 输出做端到端解析验证
```

## 架构

| 模块 | 职责 |
|---|---|
| `src/core.ts` | 纯逻辑：`status --all --json` 信封解析与归一化、schema.yaml 解析（无 vscode 依赖，可独立测试） |
| `src/cli.ts` | CLI 执行：`openspec status --all --json`，识别 CLI 未安装 / 解析失败 / 部分失败 |
| `src/scanConfig.ts` | `~/.sef/config.json` 读写、路径归一化（~ 展开 / 绝对路径校验） |
| `src/openspec.ts` | 项目根汇总（工作区 + HOME + 配置路径）、openspec 结构识别、schema 加载、刷新编排、FileSystemWatcher |
| `src/tree.ts` | 目录树：项目 → change → 阶段 → 输出件，点击跳转 |
| `src/webview.ts` | 过程可视化面板：流水线渲染、消息通信（openFile / refresh / reveal） |
| `src/extension.ts` | 激活入口、命令注册（含 ⚙ 扫描路径配置）、多根工作区支持 |
| `test/smoke.ts` | 冒烟测试：fixture 断言 + 真实 CLI 输出回放 + scanConfig 用例 |

数据契约（`ChangeStatus` / `ArtifactStatus`）对齐 OpenSpec `src/core/artifact-graph/instruction-loader.ts`；
schema 字段对齐 `src/core/artifact-graph/types.ts`（`SchemaYaml`）。

## License

[MIT](LICENSE)
