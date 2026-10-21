import path from 'node:path';
import Mocha from 'mocha';

/** 在真实 VS Code 进程中运行测试，失败会传递给外层打包与验证流程。 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });
  mocha.addFile(path.join(__dirname, 'session.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures ? reject(new Error(`${failures} 项扩展宿主测试失败。`)) : resolve(),
    );
  });
}
