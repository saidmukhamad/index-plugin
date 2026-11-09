import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { Plugin } from 'obsidian';
import type { IndexManager } from '../src/index-manager.ts';
import type { IndexPluginSettings } from '../src/settings.ts';

// Exercise the actual manager with Obsidian events and a deterministic clock.
const bundle = buildSync({
	entryPoints: ['src/index-manager.ts'], bundle: true, write: false,
	platform: 'node', format: 'cjs', external: ['obsidian'],
}).outputFiles[0]!.text;

class FakeFolder {
	path: string;
	name: string;
	parent: FakeFolder | null;
	children: (FakeFile | FakeFolder)[] = [];
	constructor(path: string, parent: FakeFolder | null) {
		this.path = path;
		this.name = path.split('/').at(-1) ?? '';
		this.parent = parent;
		parent?.children.push(this);
	}
	isRoot(): boolean { return this.parent === null; }
}
class FakeFile {
	path: string;
	parent: FakeFolder;
	extension = 'md';
	constructor(name: string, parent: FakeFolder) {
		this.path = `${parent.path}/${name}`;
		this.parent = parent;
		parent.children.push(this);
	}
	get name(): string { return this.path.split('/').at(-1)!; }
	get basename(): string { return this.name.slice(0, -3); }
}

type Listener = (...args: unknown[]) => void;
class Events {
	private listeners = new Map<string, Set<Listener>>();
	on(name: string, callback: Listener): () => void {
		const callbacks = this.listeners.get(name) ?? new Set<Listener>();
		callbacks.add(callback);
		this.listeners.set(name, callbacks);
		return () => { callbacks.delete(callback); };
	}
	emit(name: string, ...args: unknown[]): void {
		for (const callback of this.listeners.get(name) ?? []) callback(...args);
	}
}

function harness(filename = 'Projects.md', plainFolders: string[] = []) {
	let now = 1000;
	let nextTimer = 0;
	const timers = new Map<number, { due: number; run: () => void }>();
	const root = new FakeFolder('', null);
	const folder = new FakeFolder('Projects', root);
	const index = new FakeFile(filename, folder);
	new FakeFile('Child.md', folder);
	const folders = [root, folder];
	const caches = new Map<FakeFile, { frontmatter: Record<string, unknown> }>();
	caches.set(index, { frontmatter: {
		'index-plugin': 'folder-index', 'index-plugin-id': 'test-id',
		'index-plugin-folder-name': folder.name,
	} });
	const events = new Events();
	const metadata = new Events();
	const cleanups: (() => void)[] = [];
	const writes: string[] = [];
	const renames: string[] = [];
	const notices: { message: string; hidden: boolean }[] = [];
	const errors: unknown[][] = [];
	let processHook: (() => Promise<void>) | undefined;
	let frontmatterWrites = 0;
	const files = () => folders.flatMap((entry) => entry.children.filter((f): f is FakeFile => f instanceof FakeFile));
	const rename = (file: FakeFile, newPath: string) => {
		const oldPath = file.path;
		file.path = newPath;
		events.emit('rename', file, oldPath);
	};
	const plugin = {
		register: (callback: () => void) => { cleanups.push(callback); },
		registerEvent: (cleanup: () => void) => { cleanups.push(cleanup); },
		app: {
			workspace: { onLayoutReady: (callback: () => void) => { callback(); } },
			metadataCache: {
				on: metadata.on.bind(metadata),
				getFileCache: (file: FakeFile) => caches.get(file),
			},
			vault: {
				on: events.on.bind(events),
				getMarkdownFiles: files,
				getAllFolders: () => folders.filter((entry) => !entry.isRoot()),
				getFolderByPath: (path: string) => folders.find((entry) => entry.path === path),
				getFileByPath: (path: string) => files().find((file) => file.path === path),
				getAbstractFileByPath: (path: string) => [...files(), ...folders].find((file) => file.path === path),
				process: async (file: FakeFile, transform: (data: string) => string) => {
					writes.push(file.path);
					await processHook?.();
					return transform('');
				},
			},
			fileManager: {
				processFrontMatter: (file: FakeFile, update: (data: Record<string, unknown>) => void) => {
					frontmatterWrites++;
					update(caches.get(file)!.frontmatter);
				},
				renameFile: (file: FakeFile, newPath: string) => {
					renames.push(newPath);
					rename(file, newPath);
				},
				generateMarkdownLink: (file: FakeFile) => `[[${file.path}]]`,
			},
		},
	};
	const module = { exports: {} as { IndexManager: typeof IndexManager } };
	runInNewContext(bundle, {
		module, exports: module.exports,
		require: () => ({
			TFile: FakeFile, TFolder: FakeFolder, normalizePath: (path: string) => path,
			Notice: class {
				message: string;
				hidden = false;
				constructor(message: string) { this.message = message; notices.push(this); }
				setMessage(message: string): void { this.message = message; }
				hide(): void { this.hidden = true; }
			},
		}),
		Date: class extends Date { static now(): number { return now; } },
		Error,
		console: { error: (...args: unknown[]) => { errors.push(args); } },
		window: {
			setTimeout: (run: () => void, delay: number) => {
				const id = ++nextTimer;
				timers.set(id, { run, due: now + delay });
				return id;
			},
			clearTimeout: (id: number) => { timers.delete(id); },
		},
	});
	let settings: IndexPluginSettings = { autoIndexNewFolders: false, managedRoots: [], plainFolders };
	let settingsSaves = 0;
	const manager = new module.exports.IndexManager(
		plugin as unknown as Plugin,
		() => settings,
		async (update) => {
			const next = update(settings);
			if (next !== settings) settingsSaves++;
			settings = next;
		},
	);
	manager.start();
	return {
		manager, index, folder, writes, renames, notices, errors,
		get frontmatterWrites() { return frontmatterWrites; },
		get settings() { return settings; },
		get settingsSaves() { return settingsSaves; },
		renameFolder: (newPath: string) => {
			const oldPath = folder.path;
			folder.path = newPath;
			folder.name = newPath.split('/').at(-1) ?? '';
			for (const child of folder.children) child.path = `${newPath}/${child.path.slice(oldPath.length + 1)}`;
			events.emit('rename', folder, oldPath);
		},
		setProcessHook(hook?: () => Promise<void>) { processHook = hook; },
		rename: (path: string) => { rename(index, path); },
		metadataChanged: () => { metadata.emit('changed', index, '', caches.get(index)); },
		createChild: () => { events.emit('create', new FakeFile('New.md', folder)); },
		unload: () => { for (const cleanup of cleanups) cleanup(); },
		advance: async (milliseconds: number) => {
			const target = now + milliseconds;
			while (true) {
				const next = [...timers].filter(([, timer]) => timer.due <= target)
					.sort((a, b) => a[1].due - b[1].due)[0];
				if (!next) break;
				now = next[1].due;
				timers.delete(next[0]);
				next[1].run();
				await setImmediate();
			}
			now = target;
			await setImmediate();
		},
	};
}

void test('leaves temporary case-renames alone until the final rename, including metadata events', async () => {
	const h = harness();
	await h.advance(120);
	h.writes.length = 0;
	h.rename('Projects/__temp__projects.md');
	h.metadataChanged();
	await h.advance(6000); // Longer than the other plugin's default timeout.
	assert.deepEqual(h.renames, []);
	assert.deepEqual(h.writes, []);
	assert.equal(h.frontmatterWrites, 0);
	h.rename('Projects/Projects.md');
	await h.advance(749);
	assert.equal(h.writes.length, 0);
	await h.advance(1);
	assert.deepEqual(h.writes, ['Projects/Projects.md']);
	assert.deepEqual(h.errors, []);
	assert.deepEqual(h.notices, []);
	h.unload();
});

void test('does not seize a temporary folder note during startup', async () => {
	const h = harness('__temp__Projects.md');
	await h.advance(6000);
	assert.deepEqual(h.renames, []);
	assert.deepEqual(h.writes, []);
	assert.equal(h.frontmatterWrites, 0);
	h.rename('Projects/Projects.md');
	await h.advance(750);
	assert.equal(h.writes.length, 1);
	h.unload();
});

void test('still restores an ordinary renamed index after the last rename settles', async () => {
	const h = harness();
	h.rename('Projects/First.md');
	await h.advance(500);
	h.rename('Projects/Second.md');
	h.createChild(); // A shorter sync delay must not bypass the rename delay.
	await h.advance(749);
	assert.deepEqual(h.renames, []);
	await h.advance(1);
	assert.deepEqual(h.renames, ['Projects/Projects.md']);
	await h.advance(750);
	assert.equal(h.index.path, 'Projects/Projects.md');
	assert.deepEqual(h.errors, []);
	h.unload();
});

void test('coalesces new events while a write is running without overlapping writes', async () => {
	const h = harness();
	let finish = () => {};
	h.setProcessHook(() => new Promise<void>((resolve) => { finish = resolve; }));
	await h.advance(120);
	h.createChild();
	await h.advance(1000);
	assert.equal(h.writes.length, 1);
	h.setProcessHook();
	finish();
	await h.advance(0);
	assert.equal(h.writes.length, 2);
	h.unload();
});

void test('retries transient missing files and recovers without a notice', async () => {
	const h = harness();
	h.setProcessHook(() => Promise.reject(Object.assign(new Error('File moved'), { code: 'ENOENT' })));
	await h.advance(120);
	assert.equal(h.writes.length, 1);
	assert.equal(h.notices.length, 0);
	h.setProcessHook();
	await h.advance(750);
	assert.equal(h.writes.length, 2);
	assert.equal(h.notices.length, 0);
	h.unload();
});

void test('bounds missing-file retries and consolidates repeated failures until recovery', async () => {
	const h = harness();
	h.setProcessHook(() => Promise.reject(Object.assign(new Error('File missing'), { code: 'ENOENT' })));
	await h.advance(10000);
	assert.equal(h.writes.length, 3);
	assert.equal(h.notices.length, 1);
	assert.equal(h.errors.length, 1);
	h.createChild();
	await h.advance(1000);
	assert.equal(h.writes.length, 4);
	assert.equal(h.notices.length, 1);
	assert.equal(h.errors.length, 1);
	h.setProcessHook();
	h.createChild();
	await h.advance(1000);
	assert.equal(h.notices[0]!.hidden, true);
	h.unload();
});

void test('reports permanent errors without retrying and cancels queued work on unload', async () => {
	const h = harness();
	h.setProcessHook(() => Promise.reject(Object.assign(new Error('Permission denied'), { code: 'EACCES' })));
	await h.advance(10000);
	assert.equal(h.writes.length, 1);
	assert.equal(h.notices.length, 1);
	h.rename('Projects/Changed.md');
	h.unload();
	await h.advance(10000);
	assert.deepEqual(h.renames, []);
	assert.equal(h.writes.length, 1);
	assert.equal(h.notices[0]!.hidden, true);
});

void test('does not resume queued work or show errors after unloading during a write', async () => {
	const h = harness();
	let fail = (_error: Error) => {};
	h.setProcessHook(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
	await h.advance(120);
	h.createChild();
	h.unload();
	fail(new Error('Late failure'));
	await h.advance(10000);
	assert.equal(h.writes.length, 1);
	assert.deepEqual(h.notices, []);
	assert.deepEqual(h.errors, []);
});

void test('moves plain-folder settings with renamed folders without touching the previous settings object', async () => {
	const h = harness('Projects.md', ['Projects/Assets', 'Elsewhere']);
	const before = h.settings;
	h.renameFolder('Work');
	await h.advance(0);
	assert.deepEqual(h.settings.plainFolders, ['Work/Assets', 'Elsewhere']);
	assert.deepEqual(before.plainFolders, ['Projects/Assets', 'Elsewhere']);
	assert.equal(h.settingsSaves, 1);
	h.unload();
});

void test('does not save settings when a rename leaves plain folders unchanged', async () => {
	const h = harness('Projects.md', ['Elsewhere']);
	h.renameFolder('Work');
	await h.advance(0);
	assert.equal(h.settingsSaves, 0);
	h.unload();
});
