import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getNodePtyCandidatePaths, loadNodePty } from '../pty/ptyLoader';
import {
	buildTerminalEnv,
	resolveShell,
	resolveTabCwd,
	resolveWorkspaceCwd,
	sanitizeLaunchOptions,
} from '../pty/terminalEnvironment';

suite('CLI Side Panel Test Suite', () => {
	suite('terminalEnvironment helpers', () => {
		test('resolveWorkspaceCwd prioritizes active editor folder, then first workspace, then home', () => {
			assert.strictEqual(
				resolveWorkspaceCwd('/ws/b', ['/ws/a', '/ws/b'], '/home/user'),
				'/ws/b'
			);
			assert.strictEqual(
				resolveWorkspaceCwd(undefined, ['/ws/a', '/ws/b'], '/home/user'),
				'/ws/a'
			);
			assert.strictEqual(
				resolveWorkspaceCwd(undefined, [], '/home/user'),
				'/home/user'
			);
		});

		test('resolveTabCwd resolves relative paths against workspace cwd and preserves absolute paths', () => {
			const base = path.resolve(os.tmpdir(), 'cli-side-panel-ws');
			assert.strictEqual(resolveTabCwd(base, undefined), base);
			assert.strictEqual(resolveTabCwd(base, '   '), base);
			assert.strictEqual(resolveTabCwd(base, 'packages/app'), path.resolve(base, 'packages/app'));

			const absoluteTarget = path.resolve(os.tmpdir(), 'other-dir');
			assert.strictEqual(resolveTabCwd(base, absoluteTarget), absoluteTarget);
		});

		test('resolveShell respects explicit override, vscode.env.shell, and platform fallbacks', () => {
			assert.deepStrictEqual(
				resolveShell({
					configuredShell: 'pwsh.exe',
					configuredArgs: ['-NoLogo'],
					vscodeEnvShell: 'cmd.exe',
					platform: 'win32',
				}),
				{ shell: 'pwsh.exe', args: ['-NoLogo'] }
			);

			assert.deepStrictEqual(
				resolveShell({
					configuredShell: '',
					vscodeEnvShell: '/bin/zsh',
					platform: 'darwin',
				}),
				{ shell: '/bin/zsh', args: [] }
			);

			assert.deepStrictEqual(
				resolveShell({
					configuredShell: '',
					vscodeEnvShell: '',
					platform: 'win32',
				}),
				{ shell: 'powershell.exe', args: [] }
			);

			assert.deepStrictEqual(
				resolveShell({
					configuredShell: '',
					vscodeEnvShell: '',
					platform: 'linux',
					env: { SHELL: '/usr/bin/fish' },
				}),
				{ shell: '/usr/bin/fish', args: [] }
			);
		});

		test('buildTerminalEnv strips Electron host internals and sets truecolor xterm vars', () => {
			const env = buildTerminalEnv({
				PATH: '/usr/bin',
				ELECTRON_RUN_AS_NODE: '1',
				VSCODE_INSPECTOR_OPTIONS: '{"port":1234}',
				EMPTY_VAR: undefined,
			});

			assert.strictEqual(env.PATH, '/usr/bin');
			assert.strictEqual(env.TERM, 'xterm-256color');
			assert.strictEqual(env.COLORTERM, 'truecolor');
			assert.strictEqual(env.ELECTRON_RUN_AS_NODE, undefined);
			assert.strictEqual(env.VSCODE_INSPECTOR_OPTIONS, undefined);
			assert.strictEqual('EMPTY_VAR' in env, false);
		});

		test('sanitizeLaunchOptions filters invalid items and normalizes valid entries', () => {
			assert.deepStrictEqual(sanitizeLaunchOptions(null), []);
			assert.deepStrictEqual(sanitizeLaunchOptions('not-an-array'), []);

			const sanitized = sanitizeLaunchOptions([
				{ name: ' Claude Code ', command: ' claude ', cwd: ' ./app ' },
				{ name: 'No Command', command: '   ' },
				{ name: '', command: 'echo hi' },
				{ name: 'Custom Shell', command: 'gemini', shell: 'pwsh.exe', shellArgs: ['-NoLogo', 123] },
				'invalid',
			]);

			assert.deepStrictEqual(sanitized, [
				{ name: 'Claude Code', command: 'claude', cwd: './app' },
				{ name: 'Custom Shell', command: 'gemini', shell: 'pwsh.exe', shellArgs: ['-NoLogo'] },
			]);
		});

		test('getNodePtyCandidatePaths returns expected host editor search locations', () => {
			const appRoot = path.join('editor', 'resources', 'app');
			const candidates = getNodePtyCandidatePaths(appRoot);
			assert.deepStrictEqual(candidates, [
				path.join(appRoot, 'node_modules', 'node-pty'),
				path.join(appRoot, 'node_modules.asar.unpacked', 'node-pty'),
				path.join(appRoot, 'node_modules.asar', 'node-pty'),
			]);
		});
	});

	suite('Extension Host integration', () => {
		test('activates, contributes expected commands, and focuses the Secondary Side Bar view', async () => {
			const ext = vscode.extensions.all.find(
				(candidate) => candidate.packageJSON?.name === 'cli-side-panel-extension'
			);
			assert.ok(ext, 'Expected cli-side-panel-extension to be discovered by Extension Host');
			await ext.activate();
			assert.strictEqual(ext.isActive, true);

			const commands = await vscode.commands.getCommands(true);
			assert.ok(commands.includes('cli-side-panel.newTerminal'));
			assert.ok(commands.includes('cli-side-panel.focus'));
			assert.ok(commands.includes('cli-side-panel.restart'));
			assert.ok(commands.includes('cli-side-panel.clear'));

			await vscode.commands.executeCommand('cli-side-panel.focus');
			// Restart and clear should safely no-op when starting with no open tabs.
			await vscode.commands.executeCommand('cli-side-panel.clear');
			await vscode.commands.executeCommand('cli-side-panel.restart');
		});

		test('loads host node-pty and runs a shell command in the target working directory', async function () {
			this.timeout(15000);

			const nodePty = loadNodePty(vscode.env.appRoot);
			const targetCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir();
			const isWin = process.platform === 'win32';
			const shell = isWin ? 'cmd.exe' : '/bin/sh';
			const marker = 'SIDEBAR_ANYCLI_PTY_OK';
			const args = isWin
				? ['/d', '/c', `echo ${marker} & cd`]
				: ['-c', `echo ${marker} && pwd`];

			const pty = nodePty.spawn(shell, args, {
				name: 'xterm-256color',
				cols: 80,
				rows: 24,
				cwd: targetCwd,
				env: buildTerminalEnv(process.env),
			});

			let output = '';
			const dataDisposable = pty.onData((chunk) => {
				output += chunk;
			});

			pty.resize(100, 30);

			const exitEvent = await new Promise<{ exitCode: number }>((resolve, reject) => {
				const timer = setTimeout(() => {
					try {
						pty.kill();
					} catch {
						// ignore
					}
					reject(new Error(`PTY timed out. Captured output: ${output}`));
				}, 10000);

				const exitDisposable = pty.onExit((evt) => {
					clearTimeout(timer);
					exitDisposable.dispose();
					resolve(evt);
				});
			});

			dataDisposable.dispose();

			assert.strictEqual(exitEvent.exitCode, 0);
			assert.ok(output.includes(marker), `Expected output to include marker. Got: ${output}`);
			assert.ok(
				output.toLowerCase().includes(path.basename(targetCwd).toLowerCase()),
				`Expected output to reference workspace folder "${path.basename(targetCwd)}". Got: ${output}`
			);
		});
	});
});
