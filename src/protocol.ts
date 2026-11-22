export interface LaunchOption {
	name: string;
	command: string;
	shell?: string;
	shellArgs?: string[];
	cwd?: string;
}

export interface TerminalAppearanceConfig {
	fontFamily: string;
	fontSize: number;
	lineHeight: number;
	cursorBlink: boolean;
	cursorStyle: 'block' | 'underline' | 'bar';
}

export type WebviewToExtensionMessage =
	| { type: 'ready' }
	| { type: 'createTab'; tabId: string; cols: number; rows: number; launchOptionIndex?: number }
	| { type: 'closeTab'; tabId: string }
	| { type: 'restartTab'; tabId: string; cols: number; rows: number }
	| { type: 'setActiveTab'; tabId: string | undefined }
	| { type: 'input'; tabId: string; data: string }
	| { type: 'resize'; tabId: string; cols: number; rows: number }
	| { type: 'copy'; text: string }
	| { type: 'pasteRequest'; tabId: string }
	| { type: 'openSettings' };

export type ExtensionToWebviewMessage =
	| { type: 'init'; config: TerminalAppearanceConfig; launchOptions: LaunchOption[] }
	| { type: 'config'; config: TerminalAppearanceConfig }
	| { type: 'launchOptions'; launchOptions: LaunchOption[] }
	| { type: 'requestNewTab'; launchOptionIndex?: number }
	| { type: 'requestRestartActive' }
	| { type: 'output'; tabId: string; data: string }
	| { type: 'paste'; tabId: string; text: string }
	| { type: 'clear'; tabId?: string }
	| { type: 'focus' }
	| { type: 'exit'; tabId: string; exitCode: number; signal?: number }
	| { type: 'error'; tabId: string; message: string };
