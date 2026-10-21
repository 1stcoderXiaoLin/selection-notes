const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** 本地调试身份不能用于正式上架，先确认公开身份和源码归属，再交给官方发布工具。 */
function main() {
  const project = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  if (!manifest.publisher || manifest.publisher === 'selection-notes-local') {
    throw new Error('请先注册 Marketplace 发布者，并在 package.json 填写真实 publisher ID。');
  }
  if (!manifest.repository || !/^https:\/\//.test(manifest.repository.url || '')) {
    throw new Error('请先公开源码，并在 package.json 的 repository.url 填写真实 HTTPS 仓库地址。');
  }
  if (manifest.license !== 'MIT' || !fs.existsSync(path.join(project, 'LICENSE'))) {
    throw new Error('发布前必须保留约定的 MIT 开源许可证。');
  }
  const vscePackage = require.resolve('@vscode/vsce/package.json');
  const binary = path.join(path.dirname(vscePackage), require(vscePackage).bin.vsce);
  const result = spawnSync(process.execPath, [binary, 'publish', ...process.argv.slice(2)], {
    cwd: project,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
