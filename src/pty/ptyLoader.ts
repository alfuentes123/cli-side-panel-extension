import { createRequire } from 'node:module';
import * as path from 'node:path';

export interface PtyDisposable {
	dispose(): void;
}

export interface PtyExitEvent {
	exitCode: number;
	signal?: number;
}

export interface PtySpawnOptions {
	name?: string;
	cols?: number;
	rows?: number;
	cwd?: string;
	env?: Record<string, string>;
}

export interface PtyProcess {
	readonly pid: number;
	write(data: string): void;
	resize(columns: number, rows: number): void;
	kill(signal?: string): void;
	onData(listener: (data: string) => void): PtyDisposable;
	onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
}

export interface NodePtyModule {
	spawn(file: string, args: string[] | string, options: PtySpawnOptions): PtyProcess;
}

const cachedByAppRoot = new Map<string, NodePtyModule>();

export function getNodePtyCandidatePaths(appRoot: string): string[] {
	return [
		path.join(appRoot, 'node_modules', 'node-pty'),
		path.join(appRoot, 'node_modules.asar.unpacked', 'node-pty'),
		path.join(appRoot, 'node_modules.asar', 'node-pty'),
	];
}

function isNodePtyModule(value: unknown): value is NodePtyModule {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as Partial<NodePtyModule>).spawn === 'function'
	);
}

/**
 * Dynamically loads the host editor's bundled `node-pty` module so we avoid
 * bundling native C++ binaries or hitting Electron ABI mismatches across
 * VS Code, Cursor, Antigravity, and VSCodium.
 */
export function loadNodePty(appRoot: string): NodePtyModule {
	const cached = cachedByAppRoot.get(appRoot);
	if (cached) {
		return cached;
	}

	const runtimeRequire = createRequire(__filename);
	const candidates = [...getNodePtyCandidatePaths(appRoot), 'node-pty'];
	const errors: string[] = [];

	for (const candidate of candidates) {
		try {
			const loaded: unknown = runtimeRequire(candidate);
			if (isNodePtyModule(loaded)) {
				cachedByAppRoot.set(appRoot, loaded);
				return loaded;
			}
			errors.push(`${candidate}: module did not export spawn()`);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			errors.push(`${candidate}: ${detail}`);
		}
	}

	throw new Error(
		`Unable to load native node-pty from host editor (appRoot="${appRoot}").\nTried:\n- ${errors.join('\n- ')}`
	);
}
