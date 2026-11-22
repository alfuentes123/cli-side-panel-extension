import * as path from 'node:path';
import type { LaunchOption } from '../protocol';

export interface ShellResolutionInput {
	configuredShell?: string;
	configuredArgs?: readonly string[];
	vscodeEnvShell?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
}

export interface ResolvedShell {
	shell: string;
	args: string[];
}

export function resolveWorkspaceCwd(
	activeEditorFolderPath: string | undefined,
	workspaceFolderPaths: readonly string[],
	fallbackHome: string
): string {
	if (activeEditorFolderPath && activeEditorFolderPath.trim().length > 0) {
		return activeEditorFolderPath;
	}
	if (workspaceFolderPaths.length > 0 && workspaceFolderPaths[0].trim().length > 0) {
		return workspaceFolderPaths[0];
	}
	return fallbackHome;
}

export function resolveTabCwd(baseWorkspaceCwd: string, optionCwd: string | undefined): string {
	const trimmed = optionCwd?.trim();
	if (!trimmed) {
		return baseWorkspaceCwd;
	}
	if (path.isAbsolute(trimmed)) {
		return trimmed;
	}
	return path.resolve(baseWorkspaceCwd, trimmed);
}

export function resolveShell(input: ShellResolutionInput): ResolvedShell {
	const platform = input.platform ?? process.platform;
	const env = input.env ?? process.env;
	const args = input.configuredArgs ? [...input.configuredArgs] : [];

	const configured = input.configuredShell?.trim();
	if (configured) {
		return { shell: configured, args };
	}

	const editorShell = input.vscodeEnvShell?.trim();
	if (editorShell) {
		return { shell: editorShell, args };
	}

	if (platform === 'win32') {
		return {
			shell: 'powershell.exe',
			args,
		};
	}

	const envShell = env.SHELL?.trim();
	return {
		shell: envShell || '/bin/sh',
		args,
	};
}

export function buildTerminalEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (typeof value === 'string') {
			env[key] = value;
		}
	}

	// Strip VS Code Electron Extension Host internals that interfere with child Node/CLI tools.
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.VSCODE_INSPECTOR_OPTIONS;

	env.TERM = 'xterm-256color';
	env.COLORTERM = 'truecolor';
	return env;
}

export function sanitizeLaunchOptions(raw: unknown): LaunchOption[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const result: LaunchOption[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const name = typeof record.name === 'string' ? record.name.trim() : '';
		const command = typeof record.command === 'string' ? record.command.trim() : '';
		if (!name || !command) {
			continue;
		}

		const option: LaunchOption = { name, command };
		if (typeof record.shell === 'string' && record.shell.trim().length > 0) {
			option.shell = record.shell.trim();
		}
		if (Array.isArray(record.shellArgs)) {
			const cleanArgs = record.shellArgs.filter((a): a is string => typeof a === 'string');
			if (cleanArgs.length > 0) {
				option.shellArgs = cleanArgs;
			}
		}
		if (typeof record.cwd === 'string' && record.cwd.trim().length > 0) {
			option.cwd = record.cwd.trim();
		}
		result.push(option);
	}

	return result;
}
