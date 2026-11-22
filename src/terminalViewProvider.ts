import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type {
	ExtensionToWebviewMessage,
	LaunchOption,
	TerminalAppearanceConfig,
	WebviewToExtensionMessage,
} from './protocol';
import { loadNodePty, type PtyDisposable, type PtyProcess } from './pty/ptyLoader';
import {
	buildTerminalEnv,
	resolveShell,
	resolveTabCwd,
	resolveWorkspaceCwd,
	sanitizeLaunchOptions,
} from './pty/terminalEnvironment';

const FLUSH_DELAY_MS = 5;
const MAX_BUFFER_CHARS = 65536;
const STARTUP_SETTLE_MS = 100;
const STARTUP_FALLBACK_MS = 500;

interface TerminalSession {
	readonly tabId: string;
	readonly launchOption?: LaunchOption;
	pty?: PtyProcess;
	dataDisposable?: PtyDisposable;
	exitDisposable?: PtyDisposable;
	outputBuffer: string;
	flushTimer?: ReturnType<typeof setTimeout>;
	startupTimer?: ReturnType<typeof setTimeout>;
	startupFallbackTimer?: ReturnType<typeof setTimeout>;
	exited: boolean;
}

export class TerminalViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'cli-side-panel.terminalView';

	private view: vscode.WebviewView | undefined;
	private webviewReady = false;
	private activeTabId: string | undefined;
	private readonly sessions = new Map<string, TerminalSession>();
	private readonly pendingMessages: ExtensionToWebviewMessage[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri) {
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('terminal.integrated') ||
					event.affectsConfiguration('editor.fontFamily') ||
					event.affectsConfiguration('editor.fontSize')
				) {
					this.postMessage({ type: 'config', config: this.readAppearanceConfig() });
				}
				if (event.affectsConfiguration('cliSidePanel.launchOptions')) {
					this.postMessage({ type: 'launchOptions', launchOptions: this.readLaunchOptions() });
				}
			})
		);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.view = webviewView;
		this.webviewReady = false;

		const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [distUri],
		};

		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

		const messageListener = webviewView.webview.onDidReceiveMessage((raw: WebviewToExtensionMessage) => {
			void this.handleWebviewMessage(raw);
		});

		const visibilityListener = webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible && this.webviewReady) {
				this.postMessage({ type: 'focus' });
			}
		});

		webviewView.onDidDispose(() => {
			messageListener.dispose();
			visibilityListener.dispose();
			this.killAllSessions();
			this.view = undefined;
			this.webviewReady = false;
			this.activeTabId = undefined;
			this.pendingMessages.length = 0;
		});
	}

	public async focus(): Promise<void> {
		await vscode.commands.executeCommand('cli-side-panel.terminalView.focus');
		if (this.webviewReady) {
			this.postMessage({ type: 'focus' });
		}
	}

	public async newTerminal(): Promise<void> {
		const launchOptions = this.readLaunchOptions();

		type LaunchPickItem = vscode.QuickPickItem & { launchOptionIndex?: number };
		const items: LaunchPickItem[] = [
			{
				label: '$(terminal) Empty terminal',
				description: 'Default shell in current workspace',
			},
			...launchOptions.map((opt, index) => ({
				label: `$(play) ${opt.name}`,
				description: opt.command,
				detail: opt.cwd ? `cwd: ${opt.cwd}` : undefined,
				launchOptionIndex: index,
			})),
		];

		const picked = await vscode.window.showQuickPick(items, {
			title: 'New CLI Side Panel Terminal',
			placeHolder: 'Select terminal type or configured launch option',
		});

		if (!picked) {
			return;
		}

		await vscode.commands.executeCommand('cli-side-panel.terminalView.focus');
		this.postOrQueueMessage({
			type: 'requestNewTab',
			launchOptionIndex: picked.launchOptionIndex,
		});
	}

	public restartActive(): void {
		if (!this.webviewReady) {
			return;
		}
		this.postMessage({ type: 'requestRestartActive' });
	}

	public clearActive(): void {
		if (!this.webviewReady || !this.activeTabId) {
			return;
		}
		this.postMessage({ type: 'clear', tabId: this.activeTabId });
	}

	public dispose(): void {
		this.killAllSessions();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
		switch (message.type) {
			case 'ready': {
				this.webviewReady = true;
				this.postMessage({
					type: 'init',
					config: this.readAppearanceConfig(),
					launchOptions: this.readLaunchOptions(),
				});
				while (this.pendingMessages.length > 0) {
					const queued = this.pendingMessages.shift();
					if (queued) {
						this.postMessage(queued);
					}
				}
				return;
			}
			case 'createTab': {
				const launchOptions = this.readLaunchOptions();
				const launchOption =
					typeof message.launchOptionIndex === 'number'
						? launchOptions[message.launchOptionIndex]
						: undefined;
				this.activeTabId = message.tabId;
				this.spawnSession(message.tabId, message.cols, message.rows, launchOption);
				return;
			}
			case 'closeTab': {
				this.destroySession(message.tabId);
				if (this.activeTabId === message.tabId) {
					this.activeTabId = undefined;
				}
				return;
			}
			case 'restartTab': {
				const existing = this.sessions.get(message.tabId);
				const launchOption = existing?.launchOption;
				this.destroySession(message.tabId);
				this.spawnSession(message.tabId, message.cols, message.rows, launchOption);
				return;
			}
			case 'setActiveTab': {
				this.activeTabId = message.tabId;
				return;
			}
			case 'input': {
				const session = this.sessions.get(message.tabId);
				if (session?.pty && !session.exited) {
					try {
						session.pty.write(message.data);
					} catch {
						// PTY may have exited concurrently; ignore write errors.
					}
				}
				return;
			}
			case 'resize': {
				const session = this.sessions.get(message.tabId);
				if (session?.pty && !session.exited) {
					const cols = Math.floor(message.cols);
					const rows = Math.floor(message.rows);
					if (cols >= 2 && rows >= 1) {
						try {
							session.pty.resize(cols, rows);
						} catch {
							// Ignore resize races during PTY teardown.
						}
					}
				}
				return;
			}
			case 'copy': {
				await vscode.env.clipboard.writeText(message.text);
				return;
			}
			case 'pasteRequest': {
				const text = await vscode.env.clipboard.readText();
				if (text.length > 0) {
					this.postMessage({ type: 'paste', tabId: message.tabId, text });
				}
				return;
			}
			case 'openSettings': {
				await vscode.commands.executeCommand('workbench.action.openSettings', 'cliSidePanel.launchOptions');
				return;
			}
		}
	}

	private spawnSession(
		tabId: string,
		rawCols: number,
		rawRows: number,
		launchOption?: LaunchOption
	): void {
		const session: TerminalSession = {
			tabId,
			launchOption,
			outputBuffer: '',
			exited: false,
		};
		this.sessions.set(tabId, session);

		const cols = Math.max(2, Math.floor(rawCols || 80));
		const rows = Math.max(1, Math.floor(rawRows || 24));

		const extConfig = vscode.workspace.getConfiguration('cliSidePanel');
		const defaultShellSetting = extConfig.get<string>('shell', '');
		const defaultArgsSetting = extConfig.get<string[]>('shellArgs', []);

		const resolvedShell = resolveShell({
			configuredShell: launchOption?.shell ?? defaultShellSetting,
			configuredArgs: launchOption?.shellArgs ?? defaultArgsSetting,
			vscodeEnvShell: vscode.env.shell,
		});

		const baseCwd = this.getCurrentWorkspaceCwd();
		const targetCwd = resolveTabCwd(baseCwd, launchOption?.cwd);
		const cwd = fs.existsSync(targetCwd) ? targetCwd : baseCwd;

		let pty: PtyProcess;
		try {
			const nodePty = loadNodePty(vscode.env.appRoot);
			pty = nodePty.spawn(resolvedShell.shell, resolvedShell.args, {
				name: 'xterm-256color',
				cols,
				rows,
				cwd,
				env: buildTerminalEnv(process.env),
			});
		} catch (err) {
			session.exited = true;
			const message = err instanceof Error ? err.message : String(err);
			this.postMessage({
				type: 'error',
				tabId,
				message: `Failed to start terminal (${resolvedShell.shell}): ${message}`,
			});
			return;
		}

		session.pty = pty;

		const startupCommand = launchOption?.command?.trim();
		let startupSent = false;
		const sendStartupCommand = () => {
			if (startupSent || !startupCommand || session.exited || !session.pty) {
				return;
			}
			startupSent = true;
			this.clearStartupTimers(session);
			try {
				session.pty.write(`${startupCommand}\r`);
			} catch {
				// Ignore write failure if process exited early.
			}
		};

		if (startupCommand) {
			session.startupFallbackTimer = setTimeout(sendStartupCommand, STARTUP_FALLBACK_MS);
		}

		session.dataDisposable = pty.onData((chunk) => {
			if (startupCommand && !startupSent && !session.startupTimer) {
				session.startupTimer = setTimeout(sendStartupCommand, STARTUP_SETTLE_MS);
			}
			this.enqueueOutput(session, chunk);
		});

		session.exitDisposable = pty.onExit(({ exitCode, signal }) => {
			this.clearStartupTimers(session);
			this.flushOutput(session);
			session.exited = true;
			session.dataDisposable?.dispose();
			session.exitDisposable?.dispose();
			session.dataDisposable = undefined;
			session.exitDisposable = undefined;
			session.pty = undefined;
			this.postMessage({ type: 'exit', tabId, exitCode, signal });
		});
	}

	private enqueueOutput(session: TerminalSession, chunk: string): void {
		session.outputBuffer += chunk;
		if (session.outputBuffer.length >= MAX_BUFFER_CHARS) {
			this.flushOutput(session);
			return;
		}
		if (!session.flushTimer) {
			session.flushTimer = setTimeout(() => {
				this.flushOutput(session);
			}, FLUSH_DELAY_MS);
		}
	}

	private flushOutput(session: TerminalSession): void {
		if (session.flushTimer) {
			clearTimeout(session.flushTimer);
			session.flushTimer = undefined;
		}
		if (session.outputBuffer.length === 0) {
			return;
		}
		const data = session.outputBuffer;
		session.outputBuffer = '';
		this.postMessage({ type: 'output', tabId: session.tabId, data });
	}

	private clearStartupTimers(session: TerminalSession): void {
		if (session.startupTimer) {
			clearTimeout(session.startupTimer);
			session.startupTimer = undefined;
		}
		if (session.startupFallbackTimer) {
			clearTimeout(session.startupFallbackTimer);
			session.startupFallbackTimer = undefined;
		}
	}

	private destroySession(tabId: string): void {
		const session = this.sessions.get(tabId);
		if (!session) {
			return;
		}
		this.sessions.delete(tabId);
		this.clearStartupTimers(session);
		if (session.flushTimer) {
			clearTimeout(session.flushTimer);
			session.flushTimer = undefined;
		}
		session.outputBuffer = '';
		session.exited = true;
		session.dataDisposable?.dispose();
		session.exitDisposable?.dispose();
		if (session.pty) {
			try {
				session.pty.kill();
			} catch {
				// Ignore errors if the process already exited.
			}
			session.pty = undefined;
		}
	}

	private killAllSessions(): void {
		for (const tabId of [...this.sessions.keys()]) {
			this.destroySession(tabId);
		}
	}

	private getCurrentWorkspaceCwd(): string {
		const activeUri = vscode.window.activeTextEditor?.document.uri;
		const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri)?.uri.fsPath : undefined;
		const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
		return resolveWorkspaceCwd(activeFolder, workspacePaths, os.homedir());
	}

	private readLaunchOptions(): LaunchOption[] {
		const raw = vscode.workspace.getConfiguration('cliSidePanel').get<unknown>('launchOptions', []);
		return sanitizeLaunchOptions(raw);
	}

	private readAppearanceConfig(): TerminalAppearanceConfig {
		const termConfig = vscode.workspace.getConfiguration('terminal.integrated');
		const editorConfig = vscode.workspace.getConfiguration('editor');

		const rawFontFamily = termConfig.get<string>('fontFamily', '').trim() ||
			editorConfig.get<string>('fontFamily', '').trim() ||
			'Consolas, "Courier New", monospace';
		const rawFontSize = termConfig.get<number>('fontSize') || editorConfig.get<number>('fontSize') || 13;
		const rawLineHeight = termConfig.get<number>('lineHeight') || 1.1;
		const cursorBlink = termConfig.get<boolean>('cursorBlinking', false);
		const rawCursorStyle = termConfig.get<string>('cursorStyle', 'block');
		const cursorStyle: TerminalAppearanceConfig['cursorStyle'] =
			rawCursorStyle === 'bar' || rawCursorStyle === 'line'
				? 'bar'
				: rawCursorStyle === 'underline'
					? 'underline'
					: 'block';

		return {
			fontFamily: rawFontFamily,
			fontSize: Math.max(8, Math.min(48, rawFontSize)),
			lineHeight: Math.max(1, Math.min(2.5, rawLineHeight)),
			cursorBlink,
			cursorStyle,
		};
	}

	private postMessage(message: ExtensionToWebviewMessage): void {
		if (!this.view) {
			return;
		}
		void this.view.webview.postMessage(message);
	}

	private postOrQueueMessage(message: ExtensionToWebviewMessage): void {
		if (this.view && this.webviewReady) {
			this.postMessage(message);
		} else {
			this.pendingMessages.push(message);
		}
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
		const nonce = crypto.randomBytes(16).toString('base64');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
	<link rel="stylesheet" href="${styleUri}">
	<title>CLI Side Panel</title>
</head>
<body>
	<div id="app">
		<div id="tab-bar" role="tablist" aria-label="CLI Side Panel Tabs">
			<div id="tabs-list"></div>
			<button id="new-tab-btn" type="button" title="New Terminal" aria-haspopup="menu" aria-expanded="false">
				<span aria-hidden="true">+</span>
				<span class="chevron" aria-hidden="true">▾</span>
			</button>
		</div>
		<div id="stage">
			<div id="empty-state">
				<div class="empty-icon" aria-hidden="true">&gt;_</div>
				<div class="empty-title">No open terminals</div>
				<button id="empty-new-btn" type="button" aria-haspopup="menu" aria-expanded="false">
					<span>New Terminal</span>
					<span class="chevron" aria-hidden="true">▾</span>
				</button>
			</div>
			<div id="terminals-host"></div>
		</div>
		<div id="launch-menu" role="menu" hidden></div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
