import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import type {
	ExtensionToWebviewMessage,
	LaunchOption,
	TerminalAppearanceConfig,
	WebviewToExtensionMessage,
} from '../protocol';

interface VsCodeApi {
	postMessage(message: WebviewToExtensionMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface TabState {
	readonly id: string;
	readonly title: string;
	readonly tabEl: HTMLDivElement;
	readonly paneEl: HTMLDivElement;
	readonly term: Terminal;
	readonly fitAddon: FitAddon;
	lastCols: number;
	lastRows: number;
	exited: boolean;
}

const vscode = acquireVsCodeApi();
const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

const tabsListEl = document.getElementById('tabs-list') as HTMLDivElement;
const newTabBtn = document.getElementById('new-tab-btn') as HTMLButtonElement;
const emptyStateEl = document.getElementById('empty-state') as HTMLDivElement;
const emptyNewBtn = document.getElementById('empty-new-btn') as HTMLButtonElement;
const terminalsHostEl = document.getElementById('terminals-host') as HTMLDivElement;
const launchMenuEl = document.getElementById('launch-menu') as HTMLDivElement;

const tabs = new Map<string, TabState>();
const tabOrder: string[] = [];

let activeTabId: string | undefined;
let tabIdSeq = 0;
let emptyTerminalSeq = 0;
let launchOptions: LaunchOption[] = [];
let appearanceConfig: TerminalAppearanceConfig = {
	fontFamily: 'Consolas, "Courier New", monospace',
	fontSize: 13,
	lineHeight: 1.1,
	cursorBlink: false,
	cursorStyle: 'block',
};

let menuOpen = false;
let menuAnchor: HTMLButtonElement | undefined;
let menuFocusedIndex = 0;
let resizeFrameId: number | undefined;

function readCssVar(styles: CSSStyleDeclaration, name: string): string | undefined {
	const value = styles.getPropertyValue(name).trim();
	return value.length > 0 ? value : undefined;
}

function getComputedTerminalTheme(): ITheme {
	const styles = getComputedStyle(document.documentElement);
	const background =
		readCssVar(styles, '--vscode-terminal-background') ??
		readCssVar(styles, '--vscode-sideBar-background') ??
		readCssVar(styles, '--vscode-editor-background');
	const foreground =
		readCssVar(styles, '--vscode-terminal-foreground') ??
		readCssVar(styles, '--vscode-editor-foreground') ??
		readCssVar(styles, '--vscode-foreground');

	return {
		background,
		foreground,
		cursor: readCssVar(styles, '--vscode-terminalCursor-foreground') ?? foreground,
		cursorAccent: readCssVar(styles, '--vscode-terminalCursor-background') ?? background,
		selectionBackground: readCssVar(styles, '--vscode-terminal-selectionBackground'),
		selectionForeground: readCssVar(styles, '--vscode-terminal-selectionForeground'),
		selectionInactiveBackground: readCssVar(styles, '--vscode-terminal-inactiveSelectionBackground'),
		black: readCssVar(styles, '--vscode-terminal-ansiBlack'),
		red: readCssVar(styles, '--vscode-terminal-ansiRed'),
		green: readCssVar(styles, '--vscode-terminal-ansiGreen'),
		yellow: readCssVar(styles, '--vscode-terminal-ansiYellow'),
		blue: readCssVar(styles, '--vscode-terminal-ansiBlue'),
		magenta: readCssVar(styles, '--vscode-terminal-ansiMagenta'),
		cyan: readCssVar(styles, '--vscode-terminal-ansiCyan'),
		white: readCssVar(styles, '--vscode-terminal-ansiWhite'),
		brightBlack: readCssVar(styles, '--vscode-terminal-ansiBrightBlack'),
		brightRed: readCssVar(styles, '--vscode-terminal-ansiBrightRed'),
		brightGreen: readCssVar(styles, '--vscode-terminal-ansiBrightGreen'),
		brightYellow: readCssVar(styles, '--vscode-terminal-ansiBrightYellow'),
		brightBlue: readCssVar(styles, '--vscode-terminal-ansiBrightBlue'),
		brightMagenta: readCssVar(styles, '--vscode-terminal-ansiBrightMagenta'),
		brightCyan: readCssVar(styles, '--vscode-terminal-ansiBrightCyan'),
		brightWhite: readCssVar(styles, '--vscode-terminal-ansiBrightWhite'),
	};
}

function syncThemeToAllTabs(): void {
	const theme = getComputedTerminalTheme();
	for (const tab of tabs.values()) {
		tab.term.options.theme = theme;
	}
}

function applyAppearanceConfig(config: TerminalAppearanceConfig): void {
	appearanceConfig = config;
	for (const tab of tabs.values()) {
		tab.term.options.fontFamily = config.fontFamily;
		tab.term.options.fontSize = config.fontSize;
		tab.term.options.lineHeight = config.lineHeight;
		tab.term.options.cursorBlink = config.cursorBlink;
		tab.term.options.cursorStyle = config.cursorStyle;
	}
	scheduleFitActiveTab();
}

function updateEmptyState(): void {
	emptyStateEl.classList.toggle('hidden', tabOrder.length > 0);
}

function measureAndFitTab(tab: TabState): { cols: number; rows: number } {
	if (terminalsHostEl.clientWidth > 20 && terminalsHostEl.clientHeight > 20) {
		try {
			tab.fitAddon.fit();
		} catch {
			// Ignore transient fit errors while layout settles.
		}
	}
	return {
		cols: Math.max(2, tab.term.cols || 80),
		rows: Math.max(1, tab.term.rows || 24),
	};
}

function fitActiveTab(notifyResize = true): void {
	if (!activeTabId) {
		return;
	}
	const tab = tabs.get(activeTabId);
	if (!tab) {
		return;
	}
	if (terminalsHostEl.clientWidth <= 20 || terminalsHostEl.clientHeight <= 20) {
		return;
	}

	const { cols, rows } = measureAndFitTab(tab);
	if (notifyResize && (cols !== tab.lastCols || rows !== tab.lastRows)) {
		tab.lastCols = cols;
		tab.lastRows = rows;
		vscode.postMessage({ type: 'resize', tabId: tab.id, cols, rows });
	}
}

function scheduleFitActiveTab(): void {
	if (resizeFrameId !== undefined) {
		cancelAnimationFrame(resizeFrameId);
	}
	resizeFrameId = requestAnimationFrame(() => {
		resizeFrameId = undefined;
		fitActiveTab(true);
	});
}

function activateTab(tabId: string | undefined, notifyResize = true): void {
	activeTabId = tabId;

	for (const tab of tabs.values()) {
		const isActive = tab.id === tabId;
		tab.tabEl.classList.toggle('active', isActive);
		tab.tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
		tab.paneEl.classList.toggle('active', isActive);
	}

	vscode.postMessage({ type: 'setActiveTab', tabId });

	if (!tabId) {
		return;
	}

	const tab = tabs.get(tabId);
	if (!tab) {
		return;
	}

	tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });

	if (notifyResize) {
		requestAnimationFrame(() => {
			fitActiveTab(true);
			tab.term.focus();
		});
	}
}

function restartTab(tabId: string): void {
	const tab = tabs.get(tabId);
	if (!tab) {
		return;
	}
	tab.exited = false;
	tab.tabEl.classList.remove('exited');
	tab.term.reset();
	const { cols, rows } = measureAndFitTab(tab);
	tab.lastCols = cols;
	tab.lastRows = rows;
	vscode.postMessage({ type: 'restartTab', tabId, cols, rows });
	tab.term.focus();
}

function closeTab(tabId: string): void {
	const tab = tabs.get(tabId);
	if (!tab) {
		return;
	}

	const index = tabOrder.indexOf(tabId);
	if (index !== -1) {
		tabOrder.splice(index, 1);
	}

	tabs.delete(tabId);
	tab.term.dispose();
	tab.tabEl.remove();
	tab.paneEl.remove();

	vscode.postMessage({ type: 'closeTab', tabId });
	updateEmptyState();

	if (activeTabId === tabId) {
		const nextTabId = tabOrder[index] ?? tabOrder[index - 1];
		activateTab(nextTabId, true);
	}
}

function createTab(launchOptionIndex?: number): void {
	closeLaunchMenu();

	const option =
		typeof launchOptionIndex === 'number' ? launchOptions[launchOptionIndex] : undefined;
	const tabId = `tab-${++tabIdSeq}`;
	const title = option ? option.name : `Terminal ${++emptyTerminalSeq}`;

	const tabEl = document.createElement('div');
	tabEl.className = 'tab-item';
	tabEl.setAttribute('role', 'tab');
	tabEl.setAttribute('tabindex', '0');
	tabEl.setAttribute('aria-selected', 'false');
	tabEl.title = option ? `${option.name} (${option.command})` : title;

	const titleSpan = document.createElement('span');
	titleSpan.className = 'tab-title';
	titleSpan.textContent = title;

	const closeBtn = document.createElement('button');
	closeBtn.className = 'tab-close';
	closeBtn.type = 'button';
	closeBtn.title = 'Close Terminal';
	closeBtn.setAttribute('aria-label', `Close ${title}`);
	closeBtn.textContent = '×';
	closeBtn.addEventListener('click', (event) => {
		event.stopPropagation();
		closeTab(tabId);
	});

	tabEl.addEventListener('click', () => {
		activateTab(tabId, true);
	});
	tabEl.addEventListener('auxclick', (event) => {
		if (event.button === 1) {
			event.preventDefault();
			closeTab(tabId);
		}
	});
	tabEl.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			activateTab(tabId, true);
		}
	});

	tabEl.append(titleSpan, closeBtn);
	tabsListEl.append(tabEl);

	const paneEl = document.createElement('div');
	paneEl.className = 'terminal-pane';
	terminalsHostEl.append(paneEl);

	const term = new Terminal({
		cursorBlink: appearanceConfig.cursorBlink,
		cursorStyle: appearanceConfig.cursorStyle,
		fontFamily: appearanceConfig.fontFamily,
		fontSize: appearanceConfig.fontSize,
		lineHeight: appearanceConfig.lineHeight,
		scrollback: 5000,
		theme: getComputedTerminalTheme(),
	});

	const fitAddon = new FitAddon();
	term.loadAddon(fitAddon);

	const tabState: TabState = {
		id: tabId,
		title,
		tabEl,
		paneEl,
		term,
		fitAddon,
		lastCols: 80,
		lastRows: 24,
		exited: false,
	};

	tabs.set(tabId, tabState);
	tabOrder.push(tabId);
	updateEmptyState();

	// Make pane visible before opening & measuring xterm so FitAddon gets real dimensions.
	activateTab(tabId, false);
	term.open(paneEl);

	term.attachCustomKeyEventHandler((event) => {
		if (event.type !== 'keydown') {
			return true;
		}

		// Press Enter in an exited tab to restart it immediately.
		if (tabState.exited && event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
			restartTab(tabId);
			return false;
		}

		const primaryMod = isMac ? event.metaKey : event.ctrlKey;
		const keyLower = event.key.toLowerCase();

		// Let core workbench shortcuts bubble up to VS Code.
		if (
			(primaryMod && event.shiftKey && keyLower === 'p') ||
			event.key === 'F1' ||
			(primaryMod && event.altKey && keyLower === 'b')
		) {
			return false;
		}

		// Copy selection on Ctrl+Shift+C, Cmd+C (macOS with selection), or Ctrl+C (non-mac with selection).
		if (
			(primaryMod && event.shiftKey && keyLower === 'c') ||
			(primaryMod && !event.shiftKey && !event.altKey && keyLower === 'c' && term.hasSelection())
		) {
			const selection = term.getSelection();
			if (selection.length > 0) {
				vscode.postMessage({ type: 'copy', text: selection });
				term.clearSelection();
			}
			return false;
		}

		// Paste on Ctrl+V / Ctrl+Shift+V / Cmd+V via extension host clipboard bridge.
		if (primaryMod && !event.altKey && keyLower === 'v') {
			vscode.postMessage({ type: 'pasteRequest', tabId });
			return false;
		}

		return true;
	});

	term.onData((data) => {
		if (!tabState.exited) {
			vscode.postMessage({ type: 'input', tabId, data });
		}
	});

	const { cols, rows } = measureAndFitTab(tabState);
	tabState.lastCols = cols;
	tabState.lastRows = rows;

	vscode.postMessage({
		type: 'createTab',
		tabId,
		cols,
		rows,
		launchOptionIndex: option ? launchOptionIndex : undefined,
	});

	term.focus();
}

function renderLaunchMenu(): void {
	launchMenuEl.replaceChildren();
	const menuButtons: HTMLButtonElement[] = [];

	const addMenuItem = (
		label: string,
		onSelect: () => void,
		options?: { secondary?: boolean }
	) => {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = options?.secondary ? 'menu-item secondary' : 'menu-item';
		btn.setAttribute('role', 'menuitem');

		const labelEl = document.createElement('span');
		labelEl.className = 'menu-item-label';
		labelEl.textContent = label;
		btn.append(labelEl);

		const idx = menuButtons.length;
		btn.addEventListener('mouseenter', () => {
			setMenuFocus(idx);
		});
		btn.addEventListener('click', (event) => {
			event.stopPropagation();
			onSelect();
		});

		menuButtons.push(btn);
		launchMenuEl.append(btn);
	};

	const addSeparator = () => {
		const sep = document.createElement('div');
		sep.className = 'menu-separator';
		sep.setAttribute('role', 'separator');
		launchMenuEl.append(sep);
	};

	addMenuItem('Empty terminal', () => createTab(undefined));

	if (launchOptions.length > 0) {
		addSeparator();
		launchOptions.forEach((opt, index) => {
			addMenuItem(opt.name, () => createTab(index));
		});
	}

	addSeparator();
	addMenuItem(
		'Configure launch options…',
		() => {
			closeLaunchMenu();
			vscode.postMessage({ type: 'openSettings' });
		},
		{ secondary: true }
	);

	menuFocusedIndex = 0;
	updateMenuFocusClass();
}

function getMenuButtons(): HTMLButtonElement[] {
	return Array.from(launchMenuEl.querySelectorAll<HTMLButtonElement>('.menu-item'));
}

function updateMenuFocusClass(): void {
	const buttons = getMenuButtons();
	buttons.forEach((btn, idx) => {
		btn.classList.toggle('focused', idx === menuFocusedIndex);
	});
}

function setMenuFocus(index: number): void {
	const buttons = getMenuButtons();
	if (buttons.length === 0) {
		return;
	}
	menuFocusedIndex = (index + buttons.length) % buttons.length;
	updateMenuFocusClass();
	buttons[menuFocusedIndex].focus();
}

function positionLaunchMenu(anchor: HTMLElement): void {
	const anchorRect = anchor.getBoundingClientRect();
	const margin = 6;

	// Temporarily position at top-left to measure rendered size cleanly.
	launchMenuEl.style.left = '0px';
	launchMenuEl.style.top = '0px';
	const menuRect = launchMenuEl.getBoundingClientRect();

	let left = anchorRect.right - menuRect.width;
	if (anchor === emptyNewBtn) {
		left = anchorRect.left + (anchorRect.width - menuRect.width) / 2;
	}
	left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));

	let top = anchorRect.bottom + 4;
	if (top + menuRect.height > window.innerHeight - margin) {
		top = Math.max(margin, anchorRect.top - menuRect.height - 4);
	}

	launchMenuEl.style.left = `${Math.round(left)}px`;
	launchMenuEl.style.top = `${Math.round(top)}px`;
}

function openLaunchMenu(anchor: HTMLButtonElement): void {
	if (menuOpen && menuAnchor === anchor) {
		closeLaunchMenu();
		return;
	}

	closeLaunchMenu();
	renderLaunchMenu();

	menuOpen = true;
	menuAnchor = anchor;
	anchor.setAttribute('aria-expanded', 'true');
	launchMenuEl.hidden = false;
	positionLaunchMenu(anchor);
	setMenuFocus(0);
}

function closeLaunchMenu(): void {
	if (!menuOpen) {
		return;
	}
	menuOpen = false;
	menuAnchor?.setAttribute('aria-expanded', 'false');
	menuAnchor = undefined;
	launchMenuEl.hidden = true;
}

newTabBtn.addEventListener('click', (event) => {
	event.stopPropagation();
	openLaunchMenu(newTabBtn);
});

emptyNewBtn.addEventListener('click', (event) => {
	event.stopPropagation();
	openLaunchMenu(emptyNewBtn);
});

document.addEventListener('click', (event) => {
	if (!menuOpen) {
		return;
	}
	const target = event.target as Node | null;
	if (target && (launchMenuEl.contains(target) || menuAnchor?.contains(target))) {
		return;
	}
	closeLaunchMenu();
});

document.addEventListener('keydown', (event) => {
	if (!menuOpen) {
		return;
	}
	if (event.key === 'Escape') {
		event.preventDefault();
		const previousAnchor = menuAnchor;
		closeLaunchMenu();
		previousAnchor?.focus();
	} else if (event.key === 'ArrowDown') {
		event.preventDefault();
		setMenuFocus(menuFocusedIndex + 1);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		setMenuFocus(menuFocusedIndex - 1);
	}
});

window.addEventListener('blur', () => {
	closeLaunchMenu();
});

window.addEventListener('resize', () => {
	if (menuOpen && menuAnchor) {
		positionLaunchMenu(menuAnchor);
	}
});

const resizeObserver = new ResizeObserver(() => {
	scheduleFitActiveTab();
});
resizeObserver.observe(terminalsHostEl);

const themeObserver = new MutationObserver(() => {
	syncThemeToAllTabs();
});
themeObserver.observe(document.documentElement, {
	attributes: true,
	attributeFilter: ['style', 'class'],
});
themeObserver.observe(document.body, {
	attributes: true,
	attributeFilter: ['style', 'class'],
});

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
	const message = event.data;
	if (!message || typeof message !== 'object') {
		return;
	}

	switch (message.type) {
		case 'init': {
			launchOptions = message.launchOptions;
			applyAppearanceConfig(message.config);
			updateEmptyState();
			return;
		}
		case 'config': {
			applyAppearanceConfig(message.config);
			return;
		}
		case 'launchOptions': {
			launchOptions = message.launchOptions;
			if (menuOpen && menuAnchor) {
				renderLaunchMenu();
				positionLaunchMenu(menuAnchor);
			}
			return;
		}
		case 'requestNewTab': {
			createTab(message.launchOptionIndex);
			return;
		}
		case 'requestRestartActive': {
			if (activeTabId) {
				restartTab(activeTabId);
			}
			return;
		}
		case 'output': {
			tabs.get(message.tabId)?.term.write(message.data);
			return;
		}
		case 'paste': {
			const tab = tabs.get(message.tabId);
			if (tab && !tab.exited) {
				tab.term.paste(message.text);
			}
			return;
		}
		case 'clear': {
			const targetId = message.tabId ?? activeTabId;
			if (targetId) {
				tabs.get(targetId)?.term.clear();
			}
			return;
		}
		case 'focus': {
			if (activeTabId) {
				const tab = tabs.get(activeTabId);
				if (tab) {
					fitActiveTab(true);
					tab.term.focus();
				}
			}
			return;
		}
		case 'exit': {
			const tab = tabs.get(message.tabId);
			if (tab) {
				tab.exited = true;
				tab.tabEl.classList.add('exited');
				tab.term.write(
					`\r\n\x1b[2m[Process exited with code ${message.exitCode} — press Enter to restart]\x1b[0m\r\n`
				);
			}
			return;
		}
		case 'error': {
			const tab = tabs.get(message.tabId);
			if (tab) {
				tab.exited = true;
				tab.tabEl.classList.add('exited');
				tab.term.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
			}
			return;
		}
	}
});

vscode.postMessage({ type: 'ready' });
