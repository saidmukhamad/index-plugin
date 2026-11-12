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
	stat = {size:100,ctime:1,mtime:1};
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
	const documents = new Map<string, string>();
	const renames: string[] = [];
	const notices: { message: string; hidden: boolean }[] = [];
	const errors: unknown[][] = [];
	const opened: string[] = [];
	let processHook: (() => Promise<void>) | undefined;
	let frontmatterWrites = 0;
	const files = () => folders.flatMap((entry) => entry.children.filter((f): f is FakeFile => f instanceof FakeFile));
	const rename = (file: FakeFile | FakeFolder, newPath: string) => {
		const oldPath = file.path;
		if (file instanceof FakeFolder) {
			for (const child of [...folders, ...files()]) if (child !== file && child.path.startsWith(oldPath + '/')) child.path = newPath + child.path.slice(oldPath.length);
			file.name = newPath.split('/').at(-1)!;
		}
		for (const [path, document] of [...documents]) if (path === oldPath || path.startsWith(oldPath + '/')) { documents.delete(path); documents.set(newPath + path.slice(oldPath.length), document); }
		file.path = newPath;
		events.emit('rename', file, oldPath);
	};
	const plugin = {
		register: (callback: () => void) => { cleanups.push(callback); },
		registerEvent: (cleanup: () => void) => { cleanups.push(cleanup); },
		app: {
			workspace: { onLayoutReady: (callback: () => void) => { callback(); }, getLeaf: () => ({openFile: async (file: FakeFile) => { opened.push(file.path); }}) },
			metadataCache: {
				on: metadata.on.bind(metadata),
				getFileCache: (file: FakeFile) => caches.get(file),
			},
			vault: {
				on: events.on.bind(events),
				read: async (file: FakeFile) => documents.get(file.path) ?? ('---\n' + Object.entries(caches.get(file)?.frontmatter ?? {}).map(([k,v])=>k+': '+JSON.stringify(v)).join('\n') + '\n---\n'),
				create: async (path: string, text: string) => {
					const parent = folders.find(f=>f.path===path.split('/').slice(0,-1).join('/'))!;
					const file = new FakeFile(path.split('/').at(-1)!, parent);documents.set(path,text);caches.set(file,{frontmatter:{}});events.emit('create',file);return file;
				},
				getMarkdownFiles: files,
				getAllFolders: () => folders.filter((entry) => !entry.isRoot()),
				getFolderByPath: (path: string) => folders.find((entry) => entry.path === path),
				getFileByPath: (path: string) => files().find((file) => file.path === path),
				getAbstractFileByPath: (path: string) => [...files(), ...folders].find((file) => file.path === path),
				process: async (file: FakeFile, transform: (data: string) => string) => {
					writes.push(file.path);
					await processHook?.();
					const document = transform(documents.get(file.path) ?? '');
					documents.set(file.path, document);
					return document;
				},
			},
			fileManager: {
				processFrontMatter: (file: FakeFile, update: (data: Record<string, unknown>) => void) => {
					frontmatterWrites++;
					update(caches.get(file)!.frontmatter);
					const body = (documents.get(file.path) ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '');
					documents.set(file.path, '---\n' + Object.entries(caches.get(file)!.frontmatter).map(([k,v])=>k+': '+JSON.stringify(v)).join('\n') + '\n---\n' + body);
					metadata.emit('changed', file, '', caches.get(file));
				},
				renameFile: (file: FakeFile | FakeFolder, newPath: string) => {
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
			getFrontMatterInfo: (text: string) => { const m=text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);return {exists:!!m,frontmatter:m?.[1]??''}; },
			parseYaml: (text: string) => Object.fromEntries(text.split('\n').filter(Boolean).map(line=>{const i=line.indexOf(':');return [line.slice(0,i),JSON.parse(line.slice(i+1))];})),
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
		manager, index, folder, writes, renames, notices, errors, documents, opened,
		setManagedDepth(maxDepth: number) {
			settings = { ...settings, autoIndexNewFolders: true,
				managedRoots: [{ path: folder.path, maxDepth, autoAdopt: true }] };
		},
		addFolder(name: string, emitCreate = true) {
			const child = new FakeFolder(`${folder.path}/${name}`, folder);
			folders.push(child);
			if (emitCreate) events.emit('create', child);
			return child;
		},
		addFolderNote(child: FakeFolder, emitCreate = true) {
			const note = new FakeFile(`${child.name}.md`, child);
			if (emitCreate) events.emit('create', note);
			return note;
		},
		addPage(child: FakeFolder, cacheReady = true) {
			const page = new FakeFile(child.name + '.md', child.parent!);
			const props = {topic_folder:child.path, learning_type:'topic', added:'2026-11-01'};
			documents.set(page.path, '---\n' + Object.entries(props).map(([k,v])=>k+': '+JSON.stringify(v)).join('\n') + '\n---\nMy original topic content.\n![[Shared topic.base]]\n');
			caches.set(page, {frontmatter:cacheReady?props:{}});
			if(cacheReady) metadata.emit('changed',page,'',caches.get(page));
			return page;
		},
		setPageCache(page: FakeFile, props: Record<string, unknown>) {caches.set(page,{frontmatter:props});metadata.emit('changed',page,'',caches.get(page));},
		deleteFile(file: FakeFile) { file.parent.children=file.parent.children.filter(f=>f!==file);events.emit('delete',file); },
		move: rename,
		markOwned(note: FakeFile) {
			caches.set(note, { frontmatter: {
				'index-plugin': 'folder-index',
				'index-plugin-folder-name': note.parent.name,
			} });
			metadata.emit('changed', note, '', caches.get(note));
		},
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

void test('refreshes parent links when a folder appears beyond the managed depth', async () => {
	const h = harness();
	h.setManagedDepth(0);
	await h.advance(120);
	const child = h.addFolder('reading');
	h.addFolderNote(child, false);
	await h.advance(120);
	assert.match(h.documents.get(h.index.path)!, /\[\[Projects\/reading\/reading.md\]\]/);
	assert.deepEqual(h.errors, []);
	h.unload();
});

void test('refreshes parent links when a conventional note arrives after the folder sync', async () => {
	const h = harness();
	h.setManagedDepth(0);
	await h.advance(120);
	const child = h.addFolder('reading');
	await h.advance(120);
	assert.doesNotMatch(h.documents.get(h.index.path)!, /reading/);
	h.addFolderNote(child);
	await h.advance(120);
	assert.match(h.documents.get(h.index.path)!, /\[\[Projects\/reading\/reading.md\]\]/);
	assert.deepEqual(h.errors, []);
	h.unload();
});

void test('refreshes parent links when metadata discovers an owned child index', async () => {
	const h = harness();
	h.setManagedDepth(0);
	await h.advance(120);
	const child = h.addFolder('reading', false);
	const note = h.addFolderNote(child, false);
	h.markOwned(note);
	await h.advance(120);
	assert.match(h.documents.get(h.index.path)!, /\[\[Projects\/reading\/reading.md\]\]/);
	assert.ok(h.documents.has(note.path));
	assert.deepEqual(h.errors, []);
	h.unload();
});

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


void test('reuses a canonical topic page for open, convert and concurrent ensure before metadata catches up', async () => {
	const h = harness();
	const folder = h.addFolder('embedding');
	const page = h.addPage(folder, false);
	const original = h.documents.get(page.path);
	const ensures = await Promise.all([h.manager.ensureIndex(folder as never), h.manager.convertFolder(folder as never), h.manager.ensureIndex(folder as never)]);
	for (const file of ensures) assert.equal(file, page);
	await h.manager.openIndex(folder as never, false);
	assert.equal(h.opened.at(-1), page.path);
	assert.equal(h.manager.getRepresentedFolder(page as never), folder);
	assert.equal(h.manager.isFolderPagePath(page.path), true);
	await h.advance(2000);
	assert.equal(h.documents.get(page.path), original);
	assert.ok(!folder.children.some(f => f.name === 'embedding.md'));
	assert.equal((h.documents.get(h.index.path)!.match(/Projects\/embedding.md/g) ?? []).length, 1);
	assert.deepEqual(h.errors, []);
	h.unload();
});

void test('registered topic wins over an old owned duplicate without writing either page', async () => {
	const h = harness();const folder = h.addFolder('embedding');const page = h.addPage(folder);
	const duplicate = h.addFolderNote(folder);h.markOwned(duplicate);
	await h.advance(2000);
	assert.equal(await h.manager.convertFolder(folder as never),page);
	assert.equal(h.manager.resolveFolderPage(folder.path),page);
	assert.ok(!h.writes.includes(page.path));assert.ok(!h.writes.includes(duplicate.path));
	h.unload();
});

void test('API registration reads persisted metadata, is idempotent and rejects mismatches', async () => {
	const h=harness();const folder=h.addFolder('embedding');const page=h.addPage(folder,false);
	await h.manager.folderPages.register(page as never,folder.path);
	await h.manager.folderPages.register(page as never,folder.path);
	assert.equal(h.manager.resolveFolderPage(folder.path),page);
	await assert.rejects(h.manager.folderPages.register(page as never,'Projects'),/must match/);
	assert.equal(h.frontmatterWrites,0);
	h.unload();await assert.rejects(h.manager.folderPages.register(page as never,folder.path),/unloaded/);
});

void test('ambiguous mappings fail closed and stay visible; deletion restores unique ownership', async () => {
	const h=harness();const folder=h.addFolder('embedding');const page=h.addPage(folder);await h.advance(0);
	const other=h.addPage(folder);other.path='Projects/other.md';await h.advance(0);
	assert.throws(()=>h.manager.resolveFolderPage(folder.path),/More than one/);
	assert.equal(h.manager.isFolderPagePath(page.path),false);
	await assert.rejects(h.manager.ensureIndex(folder as never),/More than one/);
	h.deleteFile(other);assert.equal(h.manager.resolveFolderPage(folder.path),page);
	h.unload();
});

void test('creating a child from a topic page files it inside the topic without converting the sidecar', async () => {
	const h=harness();const folder=h.addFolder('embedding');const page=h.addPage(folder);await h.advance(0);
	const child=await h.manager.createChildNote(page as never,'article');
	assert.equal(child.path,'Projects/embedding/article.md');assert.equal(page.path,'Projects/embedding.md');
	assert.ok(!folder.children.some(f=>f.name==='embedding.md'));h.unload();
});

void test('renaming a topic folder updates its sidecar and nested mappings while preserving content and dates', async () => {
	const h=harness();const folder=h.addFolder('embedding');const page=h.addPage(folder);await h.advance(0);
	// Reuse the helper to create a nested folder under the topic.
	const nested=h.addFolder('embedding/data');folder.children.push(nested);nested.parent=folder;
	const nestedPage=h.addPage(nested);await h.advance(0);
	await h.manager.renameFolder(folder as never,'vectors');await h.advance(1000);
	assert.equal(page.path,'Projects/vectors.md');assert.equal(h.manager.resolveFolderPage('Projects/vectors'),page);
	assert.equal(h.manager.resolveFolderPage('Projects/vectors/data'),nestedPage);
	assert.match(h.documents.get(page.path)!,/My original topic content/);assert.match(h.documents.get(page.path)!,/2026-11-01/);
	assert.match(h.documents.get(nestedPage.path)!,/Projects\/vectors\/data/);
	assert.ok(!h.writes.includes(page.path));assert.deepEqual(h.errors,[]);h.unload();
});

void test('rename conflicts are rejected before changing the topic folder', async () => {
	const h=harness();const folder=h.addFolder('embedding');h.addPage(folder);const other=h.addFolder('vectors');h.addPage(other);await h.advance(0);
	await assert.rejects(h.manager.renameFolder(folder as never,'vectors'),/already exists/);
	assert.equal(folder.path,'Projects/embedding');h.unload();
});

void test('tree migration cannot move or retire an externally managed topic page', async () => {
	const h=harness();const folder=h.addFolder('embedding');h.addPage(folder);await h.advance(0);
	const plan=h.manager.createMigrationPlan(folder as never,2);
	assert.ok(plan.blockers.some(b=>b.reason.includes('externally managed')));h.unload();
});
