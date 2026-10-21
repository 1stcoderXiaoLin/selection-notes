# 首次公开发布

## 准备公开源码

1. 当前公开源码仓库为 [1stcoderXiaoLin/selection-notes](https://github.com/1stcoderXiaoLin/selection-notes)，README 已附演示视频。
2. 保留根目录的 MIT 许可证，提交源码、锁文件、文档和图标，不提交 `node_modules`、测试运行时、认证信息。
3. 将 `package.json` 的 `repository` 设置为真实的公开仓库地址，例如 `{ "type": "git", "url": "https://你的托管服务/你的账号/selection-notes.git" }`；按实际仓库补充 `homepage` 和 `bugs.url`。

## 注册扩展发布者

1. 使用自己的 Microsoft 账号进入 [Marketplace 发布管理页](https://marketplace.visualstudio.com/manage)。
2. 创建 Publisher，记录真实的 publisher ID；在 `package.json` 中替换 `selection-notes-local`。
3. 按 [VS Code 官方发布说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) 完成当前账号的发布认证。令牌只在自己的终端或 CI 密钥中配置，不写入源码。

Publisher ID 是公开扩展标识的一部分，应在第一次正式发布前确定；之后改变 publisher 会被视为另一个扩展。显示名称默认保留 `Selection Notes（选中批注）`。

## 检查并发布

```sh
npm ci
npm run check
npm run test:unit
npm run test:integration
npm run package
npm run publish
```

Linux 没有桌面时为集成测试加 `xvfb-run -a`。发布脚本会检查真实 publisher、公开源码地址与 MIT 声明，再调用 `vsce publish`。也可以在管理页上传经过测试的 VSIX。

## 市场介绍

标题：Selection Notes（选中批注）

简述：选中文字后右键添加批注，将整个项目的原文与批注汇总复制。

主要能力：

- 文本选区旁的原生批注框，支持多行输入。
- 不限文本语言，适合代码审查与文档校对。
- 批注在工作区本地保存，不上传，不修改源文件。
- 一键复制所有批注，附带文件路径、原始行号和选中文字快照。
- 清空前明确确认，避免误删。

## 截图与人工验收

截图必须来自真实安装后的 VS Code，不使用示意图冒充截图。发布前完成以下检查，并将截图加入 README：

1. 在 TypeScript、Markdown、TXT 中分别用鼠标和键盘选择，确认默认不自动弹出；右键选择“Selection Notes: 添加批注”后，原文下方出现输入框。
2. 在框中输入两行中文批注，分别检查按钮保存、按钮取消和空白输入；确认保存后收起，取消后再次右键添加可重新打开，已有意见保留；截取原文、批注框及保存按钮同屏的画面。
3. 保存两个不同文件的批注，检查编辑器右键菜单和右上角复制按钮；粘贴到空白文本文件，截取带文件路径、原文、批注的结果。
4. 点击“清空项目全部批注”，检查确认框包含工作区、数量及不可撤销提示；先取消，再确认，检查对应结果。
5. 关闭重开工作区，检查保存过的批注仍在；原文变化后不再贴到错误的选区。
6. 将 `selectionNotes.triggerMode` 改为 `automatic`，再将 `selectionNotes.popupDelay` 改为 `400`，确认新选区稳定约 0.4 秒后弹出；等待改回 `200` 后约 0.2 秒弹出。持续拖选时重新计时，但不把暂停拖选等同于松开鼠标；最后恢复右键模式。
7. 在输出面板、调试控制台和批注输入框中选择文字，确认不会创建批注；主编辑区中的日志文件、无标题和只读文本仍可添加。
8. 同一选区保存两条相同文字，点击其中一条的垃圾桶，只删除这一条，复制也只含剩余一条；删除最后一条时，展开的输入框保留为空草稿。

自动化宿主测试覆盖主要数据与命令路径，但不能替代对按钮点击、按钮位置、原生确认框和视觉效果的人工验收。
