import * as vscode from 'vscode';
import { AnnotationController } from './annotationController';
import { NoteStore } from './noteStore';

/** 为当前工作区安装批注能力；不加载网络服务，也不改写用户的源文件。 */
export function activate(context: vscode.ExtensionContext): AnnotationController {
  const service = new AnnotationController(new NoteStore(context.workspaceState));
  context.subscriptions.push(service);
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('selectionNotes.addComment', (editor) => {
      service.addComment(editor);
    }),
    vscode.commands.registerCommand('selectionNotes.deleteComment', (comment: vscode.Comment) =>
      service.deleteComment(comment),
    ),
    vscode.commands.registerCommand('selectionNotes.copyAll', () => service.copyAll()),
    vscode.commands.registerCommand('selectionNotes.clearAll', () => service.clearAll()),
    vscode.commands.registerCommand('selectionNotes.saveComment', (reply: vscode.CommentReply) =>
      service.saveComment(reply),
    ),
    vscode.commands.registerCommand('selectionNotes.cancelDraft', (reply: vscode.CommentReply) =>
      service.cancelDraft(reply),
    ),
  );
  service.start();
  return service;
}
