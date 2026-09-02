/**
 * 将运行时依赖 yaml vendor 到 dist/vendor/yaml，
 * 使 vsix 不依赖 node_modules 打包（vsce --no-dependencies 场景）。
 * 幂等：每次先清理目标目录。
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const srcPkg = path.join(root, 'node_modules', 'yaml');
const dest = path.join(root, 'dist', 'vendor', 'yaml');

if (!fs.existsSync(path.join(srcPkg, 'dist', 'index.js'))) {
  console.error('vendor: 未找到 node_modules/yaml/dist/index.js，请先 npm install');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(path.join(srcPkg, 'dist'), path.join(dest, 'dist'), { recursive: true });
for (const file of ['package.json', 'LICENSE']) {
  fs.copyFileSync(path.join(srcPkg, file), path.join(dest, file));
}
console.log('vendor: node_modules/yaml -> dist/vendor/yaml 已就绪');
