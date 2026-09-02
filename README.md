# OpenSpec VSCode View

English | [简体中文](README.zh-CN.md)

A VSCode extension for the [OpenSpec](https://github.com/Fission-AI/OpenSpec) workflow: **it automatically detects (custom) schemas and changes, presents each change as stages and output files with click-to-jump, and visualizes the delivery process of every change right in the editor area.**

> The extension's UI strings are currently in Chinese; command IDs and settings keys are in English.

## Features

### 1. Automatic detection
- Scans **three kinds of project roots** (deduplicated automatically):
  1. Workspace folder roots (looks for `openspec/` directly under each folder)
  2. **`${HOME}/openspec`** (scanned by default)
  3. **Extra absolute paths** configured in `~/.sef/config.json` (managed via the ⚙ button in the tree view title bar)
- A root is recognized when any of `openspec/config.yaml`, `openspec/changes/`, or `openspec/schemas/` exists
- Parses **project-local custom schemas** (`openspec/schemas/<name>/schema.yaml`) to extract stage definitions and descriptions
- Watches the `openspec/` directory: any change or schema file edit triggers an automatic refresh (can be disabled)

### 1.1 Scan path configuration (⚙ button)
Next to the "refresh ⟳" button in the tree view title bar there is a "configure scan paths ⚙" button:
- **Add scan path…**: enter an absolute project root path (`~` prefix supported; relative paths are rejected). A confirmation dialog appears if no openspec layout is found under the path
- **Edit config file**: opens (and creates) `~/.sef/config.json` directly
- **Configured paths**: click to remove

Config file format (`${HOME}/.sef/config.json`):
```json
{
  "$comment": "Extra scan paths for OpenSpec VSCode View: each entry is an absolute project root that contains an openspec/ directory",
  "scanPaths": ["D:\\work\\project-a", "~/work/project-b"]
}
```
When the config file is first created, the **absolute paths of the current workspace folders and the home directory** are seeded as editable examples (removing them does not affect the default scan — workspace folders and the home directory always participate). A corrupted or incomplete file falls back to an empty config.

### 2. Status resolution (the CLI is the source of truth)
- Fetches the status of all active changes via `openspec status --all --json`
- Four stage states: `done` / `ready` (up next) / `blocked` (waiting on dependencies) / `skipped` (via skip_specs)
- Each change's schema follows the CLI's resolution result (per-change schema metadata is supported)
- **Current stage rule**: the current stage is the successor of the last completed stage in schema declaration order (CLI-skipped stages are hopped over); a stage that is unfinished while later stages are already done (a "hole" the process jumped over) is displayed as **skipped**
- **Pipeline header**: instead of a generic "planning in progress", it shows the current stage id with its schema description (e.g. `▶ Current stage: review — Design review: verify completeness and risks from another perspective`)
- **Scanning state**: until the first load finishes, the tree view and panel show "scanning…" (spinning icon) rather than "no active changes"

### 3. Tree view (Activity bar → OpenSpec pipeline)
```
Project (shown with multi-root workspaces)
└── ◆ add-auth                    spec-driven · 2/4 (50%)
    ├── ✓ proposal      done
    │   └── 📄 proposal.md          ← click to open
    ├── ✓ specs         done
    │   ├── 📄 specs/user-auth/spec.md
    │   └── 📄 specs/session/spec.md
    ├── ○ design        ▶ current  ← the single frontier; other ready stages read "ready"
    └── ⊘ tasks         blocked · waiting on design
```
- Click a **change** → opens the process visualization panel
- Click an **output file** → opens the target file
- The title-bar refresh button refreshes manually

### 4. Process visualization panel (in the editor area)
- Renders all stages of a change as a vertical pipeline: status node, stage description (from the schema), dependency chain, output files
- The **current stage** is highlighted with a breathing animation; missing dependencies turn red; skip_specs stages render as skipped
- Output files appear as chip buttons — **clicking opens the file in the beside editor group**
- Progress bar, schema badge and planning-complete state on top; one-click refresh / reveal in Explorer at the bottom
- Fully theme-aware via VSCode theme variables (dark / light)

## Usage

1. Install (either way):
   ```bash
   # Option 1: download the vsix from GitHub Releases (recommended)
   code --install-extension openspec-vscode-view-0.1.1.vsix

   # Option 2: build from source
   npm install
   npm run package        # produces openspec-vscode-view-0.1.1.vsix
   code --install-extension openspec-vscode-view-0.1.1.vsix
   ```
2. Make sure the `openspec` CLI is available (`npm i -g @fission-ai/openspec`), or configure:
   - `openspec-vscode-view.cliPath`: path to the CLI executable (default `openspec`)
   - `openspec-vscode-view.autoRefresh`: auto refresh via file watching (default on)
   - `openspec-vscode-view.openBeside`: open output files in the beside editor group (default on)
   - `openspec-vscode-view.reconcileInterval`: periodic state reconciliation interval in seconds (default 15, 0 disables) — a safety net for missed watch events (e.g. deleting a change directory)
3. Open a project containing `openspec/`; the "OpenSpec pipeline" icon appears in the Activity bar. Click any change or run the command
   **`OpenSpec VSCode View：打开流程可视化`** (id: `openspec-vscode-view.showProcessView`) to open the process view.

## Development

```bash
npm install
npm run compile        # tsc compile to dist/
npm run watch          # watch compile
npm run smoke          # contract smoke tests (fixtures)
node dist/test/smoke.js <real-cli-output.json>   # end-to-end parse check against real CLI output
```

## Architecture

| Module | Responsibility |
|---|---|
| `src/core.ts` | Pure logic: `status --all --json` envelope parsing & normalization, schema.yaml parsing (no vscode dependency, independently testable) |
| `src/cli.ts` | CLI execution: `openspec status --all --json`; detects CLI missing / parse failure / partial failure |
| `src/scanConfig.ts` | `~/.sef/config.json` read/write, path normalization (~ expansion / absolute-path validation) |
| `src/openspec.ts` | Root aggregation (workspace + HOME + configured paths), openspec layout detection, schema loading, refresh orchestration, FileSystemWatcher |
| `src/tree.ts` | Tree view: project → change → stage → output file, click-to-jump |
| `src/webview.ts` | Process visualization panel: pipeline rendering, message passing (openFile / refresh / reveal) |
| `src/extension.ts` | Activation entry, command registration (incl. ⚙ scan path configuration), multi-root workspace support |
| `test/smoke.ts` | Smoke tests: fixture assertions + real CLI output replay + scanConfig cases |

The data contract (`ChangeStatus` / `ArtifactStatus`) follows OpenSpec `src/core/artifact-graph/instruction-loader.ts`;
schema fields follow `src/core/artifact-graph/types.ts` (`SchemaYaml`).

## License

[MIT](LICENSE)
