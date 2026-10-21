import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

/** 用真实扩展宿主重启窗口，验证 workspaceState，而不是用内存替身冒充持久化。 */
async function main(): Promise<void> {
  const project = path.resolve(__dirname, '../..');
  const root = await mkdtemp(path.join(tmpdir(), 'selection-notes-host-'));
  const app = path.join(root, 'app');
  const docs = path.join(root, 'docs');
  await mkdir(path.join(app, 'src'), { recursive: true });
  await mkdir(docs);
  const workspace = path.join(root, 'notes.code-workspace');
  const isolatedWorkspace = path.join(root, 'isolated.code-workspace');
  const configuration = JSON.stringify({
    folders: [
      { name: 'app', path: app },
      { name: 'docs', path: docs },
    ],
    settings: {
      'workbench.startupEditor': 'none',
      'window.restoreWindows': 'none',
      'security.workspace.trust.enabled': false,
    },
  });
  await writeFile(workspace, configuration);
  await writeFile(isolatedWorkspace, configuration);
  for (const phase of ['main', 'restart', 'isolated']) {
    await runTests({
      version: '1.100.3',
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionDevelopmentPath: project,
      extensionTestsPath: path.join(project, 'out/test/integration/index.js'),
      extensionTestsEnv: { SELECTION_NOTES_PHASE: phase, SELECTION_NOTES_FIXTURES: root },
      launchArgs: [
        phase === 'isolated' ? isolatedWorkspace : workspace,
        `--user-data-dir=${path.join(root, 'user-data')}`,
        `--extensions-dir=${path.join(root, 'extensions')}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-updates',
      ],
    });
  }
  console.log('扩展宿主验证通过：主流程、真实重启恢复、工作区隔离。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
