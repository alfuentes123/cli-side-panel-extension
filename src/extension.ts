import * as vscode from 'vscode';
import { TerminalViewProvider } from './terminalViewProvider';

let activeProvider: TerminalViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const provider = new TerminalViewProvider(context.extensionUri);
	activeProvider = provider;

	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(TerminalViewProvider.viewType, provider, {
			webviewOptions: {
				retainContextWhenHidden: true,
			},
		}),
		vscode.commands.registerCommand('cli-side-panel.newTerminal', () => provider.newTerminal()),
		vscode.commands.registerCommand('cli-side-panel.focus', () => provider.focus()),
		vscode.commands.registerCommand('cli-side-panel.restart', () => provider.restartActive()),
		vscode.commands.registerCommand('cli-side-panel.clear', () => provider.clearActive())
	);
}

export function deactivate(): void {
	activeProvider?.dispose();
	activeProvider = undefined;
}
