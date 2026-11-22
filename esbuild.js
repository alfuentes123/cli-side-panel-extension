const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

let activeBuilds = 0;

/**
 * Coordinates problem matcher output across both esbuild contexts so
 * VS Code's $esbuild-watch matcher sees balanced start/finish markers.
 * @returns {import('esbuild').Plugin}
 */
function createProblemMatcherPlugin() {
	return {
		name: 'esbuild-problem-matcher',
		setup(build) {
			build.onStart(() => {
				if (activeBuilds === 0) {
					console.log('[watch] build started');
				}
				activeBuilds += 1;
			});
			build.onEnd((result) => {
				result.errors.forEach(({ text, location }) => {
					console.error(`✘ [ERROR] ${text}`);
					if (location) {
						console.error(`    ${location.file}:${location.line}:${location.column}:`);
					}
				});
				activeBuilds = Math.max(0, activeBuilds - 1);
				if (activeBuilds === 0) {
					console.log('[watch] build finished');
				}
			});
		},
	};
}

async function main() {
	const extensionCtx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			createProblemMatcherPlugin(),
		],
	});

	const webviewCtx = await esbuild.context({
		entryPoints: [
			'src/webview/main.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		target: ['es2022'],
		outfile: 'dist/webview.js',
		logLevel: 'silent',
		plugins: [
			createProblemMatcherPlugin(),
		],
	});

	if (watch) {
		await Promise.all([
			extensionCtx.watch(),
			webviewCtx.watch(),
		]);
	} else {
		await Promise.all([
			extensionCtx.rebuild(),
			webviewCtx.rebuild(),
		]);
		await Promise.all([
			extensionCtx.dispose(),
			webviewCtx.dispose(),
		]);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
