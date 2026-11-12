import { Plugin, TFile, TFolder, getFrontMatterInfo, parseYaml } from 'obsidian';

/** Persisted by the page's owner. Index Plugin never writes a Pages block here. */
export const FOLDER_PAGE_KEY = 'topic_folder';

type Binding = { file: TFile; folderPath: string };

export function validFolderPath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 &&
		!value.includes('\\') && !/[:*?"<>|]/.test(value) && ![...value].some(c => c.charCodeAt(0) < 32) &&
		value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export class FolderPages {
	private readonly bindings = new Map<TFile, Binding>();
	private readonly folders = new Map<string, Set<TFile>>();
	private readonly revisions = new Map<TFile, number>();
	private readonly writing = new Set<TFile>();
	private readonly renaming = new Map<string, Promise<void>>();
	private disposed = false;

	constructor(private readonly plugin: Plugin, private readonly changed: (paths?: string[]) => void) {}

	start(): void {
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const value: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[FOLDER_PAGE_KEY];
			if (validFolderPath(value)) this.set(file, value);
		}
		this.changed();
	}

	private set(file: TFile, folderPath: string | null): void {
		const previous = this.bindings.get(file);
		if (previous?.folderPath === folderPath) return;
		if (previous) {
			const files = this.folders.get(previous.folderPath);
			files?.delete(file);
			if (files?.size === 0) this.folders.delete(previous.folderPath);
			this.bindings.delete(file);
		}
		if (folderPath !== null) {
			this.bindings.set(file, { file, folderPath });
			const files = this.folders.get(folderPath) ?? new Set<TFile>();
			files.add(file);
			this.folders.set(folderPath, files);
		}
		this.changed([...(previous ? [previous.folderPath] : []), ...(folderPath ? [folderPath] : [])]);
	}

	get(folderPath: string): TFile | null {
		if (this.disposed) throw new Error('Index Plugin is unloaded.');
		const files = this.folders.get(folderPath);
		if (!files?.size) return null;
		if (files.size > 1) throw new Error(`More than one page represents “${folderPath}”. Resolve the duplicate topic_folder properties first.`);
		return [...files][0] ?? null;
	}

	folderFor(file: TFile): string | null {
		const path = this.bindings.get(file)?.folderPath;
		if (!path) return null;
		this.get(path); // Conflicts fail closed for every entry point.
		return path;
	}

	/** Explorer refresh must leave ambiguous pages visible, without throwing. */
	isPagePath(path: string): boolean {
		const file = this.plugin.app.vault.getFileByPath(path);
		const binding = file ? this.bindings.get(file) : undefined;
		return !!binding && this.folders.get(binding.folderPath)?.size === 1 && !!this.plugin.app.vault.getFolderByPath(binding.folderPath);
	}

	private async readFolder(file: TFile): Promise<string | null> {
		const text = await this.plugin.app.vault.read(file);
		const info = getFrontMatterInfo(text);
		const props: unknown = info.exists ? parseYaml(info.frontmatter) : null;
		const value: unknown = props && typeof props === 'object' ? (props as Record<string, unknown>)[FOLDER_PAGE_KEY] : null;
		if (value == null) return null;
		if (!validFolderPath(value)) throw new Error(`Invalid topic_folder in “${file.path}”.`);
		return value;
	}

	async register(file: TFile, folderPath: string): Promise<void> {
		if (this.disposed) throw new Error('Index Plugin is unloaded.');
		if (file.extension !== 'md' || this.plugin.app.vault.getFileByPath(file.path) !== file) throw new Error('Register an existing Markdown page.');
		if (!validFolderPath(folderPath) || !this.plugin.app.vault.getFolderByPath(folderPath)) throw new Error('Register an existing vault folder.');
		if (await this.readFolder(file) !== folderPath) throw new Error('The page’s topic_folder must match the registered folder.');
		const previous = this.get(folderPath);
		if (previous && previous !== file) throw new Error(`“${folderPath}” already has a canonical page.`);
		if (this.disposed) throw new Error('Index Plugin is unloaded.');
		this.revisions.set(file, (this.revisions.get(file) ?? 0) + 1);
		this.set(file, folderPath);
	}

	async refresh(file: TFile, cachedFolder: unknown): Promise<void> {
		if (this.disposed || this.writing.has(file) || (!this.bindings.has(file) && cachedFolder == null)) return;
		const revision = (this.revisions.get(file) ?? 0) + 1;
		this.revisions.set(file, revision);
		const folderPath = await this.readFolder(file);
		if (this.revisions.get(file) !== revision || this.disposed || this.writing.has(file) || this.plugin.app.vault.getFileByPath(file.path) !== file) return;
		this.set(file, folderPath);
	}

	/** Fresh sibling lookup closes the create/cache/startup race before writing an index. */
	async discover(folder: TFolder): Promise<TFile | null> {
		const registered = this.get(folder.path);
		if (registered) return registered;
		const sibling = this.plugin.app.vault.getFileByPath(`${folder.path}.md`);
		if (sibling && await this.readFolder(sibling) === folder.path) await this.register(sibling, folder.path);
		return this.get(folder.path);
	}

	checkRename(folder: TFolder, newPath: string): void {
		const page = this.get(folder.path);
		if (page?.path.toLowerCase() !== `${folder.path}.md`.toLowerCase()) return;
		const conflict = this.plugin.app.vault.getAbstractFileByPath(`${newPath}.md`);
		if (conflict && conflict !== page) throw new Error(`“${newPath}.md” already exists. Rename that note first.`);
	}

	folderRenamed(oldPath: string, newPath: string): Promise<void> {
		const active = this.renaming.get(oldPath);
		if (active) return active;
		const affected = [...this.bindings.values()].filter(b => b.folderPath === oldPath || b.folderPath.startsWith(`${oldPath}/`));
		// Reserve the new mappings synchronously, before native metadata events arrive.
		for (const binding of affected) {
			this.writing.add(binding.file);
			this.set(binding.file, newPath + binding.folderPath.slice(oldPath.length));
		}
		const run = async (): Promise<void> => {
			try {
				for (const {file, folderPath} of affected) {
					if (this.disposed) return;
					const target = newPath + folderPath.slice(oldPath.length);
					await this.plugin.app.fileManager.processFrontMatter(file, raw => {
						const props = raw as Record<string, unknown>;
						if (props[FOLDER_PAGE_KEY] !== folderPath && props[FOLDER_PAGE_KEY] !== target) throw new Error(`“${file.path}” changed during the folder rename.`);
						props[FOLDER_PAGE_KEY] = target;
						const root: unknown = props.learning_root;
						if (typeof root === 'string' && (root === oldPath || root.startsWith(`${oldPath}/`))) props.learning_root = newPath + root.slice(oldPath.length);
					});
					// Only the direct sidecar follows its folder's name. Descendants move natively.
					if (folderPath === oldPath && file.path.toLowerCase() === `${oldPath}.md`.toLowerCase()) {
						const conflict = this.plugin.app.vault.getAbstractFileByPath(`${newPath}.md`);
						if (conflict && conflict !== file) throw new Error(`The folder moved, but “${newPath}.md” already exists. Kept the topic page at “${file.path}”.`);
						await this.plugin.app.fileManager.renameFile(file, `${newPath}.md`);
					}
				}
			} finally {
				for (const {file} of affected) this.writing.delete(file);
				this.changed();
			}
		};
		const promise = run().finally(() => this.renaming.delete(oldPath));
		this.renaming.set(oldPath, promise);
		return promise;
	}

	deleted(file: TFile | TFolder): void {
		if (file instanceof TFile) { this.revisions.set(file,(this.revisions.get(file)??0)+1); this.set(file, null); }
		else this.changed(); // Retain dangling metadata: a deleted folder must not hide its note.
	}

	dispose(): void {
		this.disposed = true;
		this.revisions.clear();
		this.bindings.clear();
		this.folders.clear();
		this.renaming.clear();
	}
}
