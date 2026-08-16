import {
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	normalizePath,
} from 'obsidian';
import {
	INDEX_FOLDER_NAME_KEY,
	INDEX_ID_KEY,
	INDEX_OWNER_KEY,
	INDEX_OWNER_VALUE,
	buildNewIndexDocument,
	removeManagedBlock,
	replaceManagedBlock,
} from './index-document';
import { normalizeFolderName, normalizeNoteName } from './note-name';

const SYNC_DELAY_MS = 120;
const MAX_INDEX_FILENAME_ATTEMPTS = 100;

function joinPath(parent: string, child: string): string {
	return normalizePath(parent ? `${parent}/${child}` : child);
}

function getParentPath(path: string): string {
	const separator = path.lastIndexOf('/');
	return separator === -1 ? '' : path.slice(0, separator);
}

function createIndexId(): string {
	if (window.crypto?.randomUUID) {
		return window.crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class IndexManager {
	private readonly ownedIndexPaths = new Set<string>();
	private readonly pendingIndexCreates = new Set<string>();
	private readonly suppressedFolderCreates = new Set<string>();
	private readonly ensuringIndexes = new Map<string, Promise<TFile>>();
	private readonly pendingFolderSyncs = new Set<string>();
	private readonly ownedIndexListeners = new Set<() => void>();
	private syncTimer: number | null = null;
	private disposed = false;

	constructor(private readonly plugin: Plugin) {}

	start(): void {
		this.disposed = false;
		this.plugin.app.workspace.onLayoutReady(() => {
			this.refreshOwnedIndexPaths();

			this.plugin.registerEvent(
				this.plugin.app.vault.on('create', (file) => {
					void this.handleCreate(file);
				}),
			);
			this.plugin.registerEvent(
				this.plugin.app.vault.on('rename', (file, oldPath) => {
					void this.handleRename(file, oldPath);
				}),
			);
			this.plugin.registerEvent(
				this.plugin.app.vault.on('delete', (file) => {
					this.handleDelete(file);
				}),
			);
			this.plugin.registerEvent(
				this.plugin.app.metadataCache.on('changed', (file, _data, cache) => {
					const owned =
						cache.frontmatter?.[INDEX_OWNER_KEY] === INDEX_OWNER_VALUE;
					const changed = owned
						? !this.ownedIndexPaths.has(file.path)
						: this.ownedIndexPaths.delete(file.path);

					if (owned) {
						this.ownedIndexPaths.add(file.path);
					}
					if (changed) {
						this.emitOwnedIndexesChanged();
						this.scheduleFolderSync(file.parent?.path ?? '');
					}
				}),
			);
		});

		this.plugin.register(() => this.dispose());
	}

	dispose(): void {
		this.disposed = true;
		if (this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
		this.pendingFolderSyncs.clear();
		this.ownedIndexListeners.clear();
	}

	onOwnedIndexesChanged(listener: () => void): () => void {
		this.ownedIndexListeners.add(listener);
		return () => this.ownedIndexListeners.delete(listener);
	}

	isOwnedIndex(file: TAbstractFile | null): file is TFile {
		return (
			file instanceof TFile &&
			(this.ownedIndexPaths.has(file.path) || this.cacheSaysOwned(file))
		);
	}

	isOwnedIndexPath(path: string): boolean {
		return this.ownedIndexPaths.has(path);
	}

	getIndex(folder: TFolder): TFile | null {
		const indexes = folder.children
			.filter((child): child is TFile => this.isOwnedIndex(child))
			.sort((left, right) => left.name.localeCompare(right.name));
		return indexes[0] ?? null;
	}

	async ensureIndex(folder: TFolder): Promise<TFile> {
		const existing = this.getIndex(folder);
		if (existing) return existing;

		const inProgress = this.ensuringIndexes.get(folder.path);
		if (inProgress) return inProgress;

		const promise = this.createIndex(folder).finally(() => {
			this.ensuringIndexes.delete(folder.path);
		});
		this.ensuringIndexes.set(folder.path, promise);
		return promise;
	}

	async openIndex(folder: TFolder, newLeaf: boolean | 'tab' | 'split' | 'window'): Promise<void> {
		const index =
			this.getIndex(folder) ??
			this.getConventionalIndex(folder) ??
			(await this.ensureIndex(folder));
		await this.plugin.app.workspace.getLeaf(newLeaf).openFile(index);
	}

	async createChildNote(target: TFile | TFolder, rawName: string): Promise<TFile> {
		const noteName = normalizeNoteName(rawName);
		let folder: TFolder | null;
		if (target instanceof TFolder) {
			folder = target;
			await this.convertFolder(folder);
		} else if (this.isOwnedIndex(target)) {
			folder = target.parent;
		} else {
			folder = await this.convertNoteToIndex(target);
		}

		if (!(folder instanceof TFolder) || folder.isRoot()) {
			throw new Error('Could not determine the indexed folder.');
		}

		const childPath = joinPath(folder.path, `${noteName}.md`);
		if (this.plugin.app.vault.getAbstractFileByPath(childPath)) {
			throw new Error(`“${noteName}” already exists in this folder.`);
		}

		const child = await this.plugin.app.vault.create(childPath, '');
		this.scheduleFolderSync(folder.path);
		await this.plugin.app.workspace.getLeaf(false).openFile(child);
		return child;
	}

	async renameFolder(folder: TFolder, rawName: string): Promise<TFolder> {
		if (folder.isRoot() || !folder.parent) {
			throw new Error('The vault root cannot be renamed here.');
		}

		const folderName = normalizeFolderName(rawName);
		if (folderName === folder.name) {
			await this.refreshOwnershipMetadata(folder);
			return folder;
		}

		const newPath = joinPath(folder.parent.path, folderName);
		const conflict = this.plugin.app.vault.getAbstractFileByPath(newPath);
		if (conflict && conflict !== folder) {
			throw new Error(`“${folderName}” already exists in this location.`);
		}

		await this.plugin.app.fileManager.renameFile(folder, newPath);
		const renamedFolder = this.plugin.app.vault.getFolderByPath(newPath);
		if (!renamedFolder) {
			throw new Error('The folder was renamed, but could not be found afterward.');
		}
		await this.refreshOwnershipMetadata(renamedFolder);
		return renamedFolder;
	}

	async convertFolder(folder: TFolder): Promise<TFile> {
		if (folder.isRoot()) {
			throw new Error('The vault root cannot be converted yet.');
		}

		const conventionalIndexPath = joinPath(folder.path, 'index.md');
		const conventionalIndex =
			this.plugin.app.vault.getAbstractFileByPath(conventionalIndexPath);
		const previousOwnedIndexes = folder.children.filter(
			(child): child is TFile => this.isOwnedIndex(child),
		);
		let index: TFile;

		if (conventionalIndex instanceof TFile && !this.isOwnedIndex(conventionalIndex)) {
			await this.plugin.app.vault.process(conventionalIndex, (document) =>
				replaceManagedBlock(document, []),
			);
			const indexId = createIndexId();
			this.ownedIndexPaths.add(conventionalIndexPath);
			await this.writeOwnershipMetadata(conventionalIndex, folder, indexId);
			index = conventionalIndex;
			this.emitOwnedIndexesChanged();

			for (const previousIndex of previousOwnedIndexes) {
				if (previousIndex.path !== conventionalIndexPath) {
					await this.retirePreviousIndex(previousIndex, folder);
				}
			}
		} else if (conventionalIndex instanceof TFile) {
			index = conventionalIndex;
			for (const previousIndex of previousOwnedIndexes) {
				if (previousIndex.path !== conventionalIndexPath) {
					await this.retirePreviousIndex(previousIndex, folder);
				}
			}
		} else if (conventionalIndex) {
			throw new Error('The existing index.md path is not a Markdown file.');
		} else if (previousOwnedIndexes[0]) {
			index = previousOwnedIndexes[0];
		} else {
			index = await this.ensureIndex(folder);
		}

		await this.syncFolder(folder);
		this.scheduleFolderSync(folder.parent?.path ?? '');
		return index;
	}

	private async retirePreviousIndex(index: TFile, folder: TFolder): Promise<void> {
		const document = await this.plugin.app.vault.read(index);
		if (this.isPristineGeneratedIndex(document, index, folder)) {
			this.ownedIndexPaths.delete(index.path);
			await this.plugin.app.fileManager.trashFile(index);
			this.emitOwnedIndexesChanged();
			return;
		}

		await this.plugin.app.vault.process(index, removeManagedBlock);
		await this.plugin.app.fileManager.processFrontMatter(index, (frontmatter) => {
			const metadata = frontmatter as Record<string, unknown>;
			const managedFolderName = metadata[INDEX_FOLDER_NAME_KEY];
			delete metadata[INDEX_OWNER_KEY];
			delete metadata[INDEX_ID_KEY];
			delete metadata[INDEX_FOLDER_NAME_KEY];

			if (typeof managedFolderName !== 'string') return;
			if (Array.isArray(metadata.aliases)) {
				const aliases = metadata.aliases.filter(
					(alias) => alias !== managedFolderName,
				);
				if (aliases.length > 0) metadata.aliases = aliases;
				else delete metadata.aliases;
			} else if (metadata.aliases === managedFolderName) {
				delete metadata.aliases;
			}
		});
		this.ownedIndexPaths.delete(index.path);
		this.emitOwnedIndexesChanged();
		new Notice(
			`Kept customized previous index as “${index.name}” after adopting index.md.`,
		);
	}

	private isPristineGeneratedIndex(
		document: string,
		index: TFile,
		folder: TFolder,
	): boolean {
		const frontmatter =
			this.plugin.app.metadataCache.getFileCache(index)?.frontmatter;
		if (!frontmatter) return false;

		const userKeys = Object.keys(frontmatter).filter(
			(key) =>
				![
					INDEX_OWNER_KEY,
					INDEX_ID_KEY,
					INDEX_FOLDER_NAME_KEY,
					'aliases',
					'position',
				].includes(key),
		);
		if (userKeys.length > 0) return false;

		const withoutFrontmatter = document.replace(
			/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
			'',
		);
		const body = removeManagedBlock(withoutFrontmatter).trim();
		return body === '' || body === `# ${folder.name}`;
	}

	async initializeAllFolders(): Promise<number> {
		const folders = this.plugin.app.vault
			.getAllFolders(false)
			.filter((folder) => !folder.isRoot());
		const foldersToInitialize = folders.filter((folder) => {
			const conventionalIndex = this.getConventionalIndex(folder);
			return (
				!this.getIndex(folder) ||
				(conventionalIndex !== null && !this.isOwnedIndex(conventionalIndex))
			);
		});

		for (const folder of folders) {
			await this.convertFolder(folder);
		}

		return foldersToInitialize.length;
	}

	private cacheSaysOwned(file: TFile): boolean {
		return (
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[
				INDEX_OWNER_KEY
			] === INDEX_OWNER_VALUE
		);
	}

	private getConventionalIndex(folder: TFolder): TFile | null {
		return this.plugin.app.vault.getFileByPath(joinPath(folder.path, 'index.md'));
	}

	private refreshOwnedIndexPaths(): void {
		this.ownedIndexPaths.clear();
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			if (this.cacheSaysOwned(file)) {
				this.ownedIndexPaths.add(file.path);
				this.scheduleFolderSync(file.parent?.path ?? '');
				const frontmatter =
					this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
				if (
					file.parent &&
					(frontmatter?.[INDEX_FOLDER_NAME_KEY] !== file.parent.name ||
						this.hasManagedFolderAlias(frontmatter, file.parent.name))
				) {
					const rawIndexId: unknown = frontmatter?.[INDEX_ID_KEY];
					void this.writeOwnershipMetadata(
						file,
						file.parent,
						typeof rawIndexId === 'string' ? rawIndexId : createIndexId(),
					).catch((error: unknown) => {
						console.error(`Could not refresh metadata for ${file.path}.`, error);
					});
				}
			}
		}
		this.emitOwnedIndexesChanged();
	}

	private emitOwnedIndexesChanged(): void {
		for (const listener of this.ownedIndexListeners) listener();
	}

	private hasManagedFolderAlias(
		frontmatter: Record<string, unknown> | undefined,
		folderName: string,
	): boolean {
		const rawAliases = frontmatter?.aliases;
		return (
			(Array.isArray(rawAliases) &&
				rawAliases.length === 1 &&
				rawAliases[0] === folderName) ||
			rawAliases === folderName
		);
	}

	private async createIndex(folder: TFolder): Promise<TFile> {
		const indexId = createIndexId();
		const indexPath = this.chooseIndexPath(folder, indexId);
		this.pendingIndexCreates.add(indexPath);

		try {
			const index = await this.plugin.app.vault.create(
				indexPath,
				buildNewIndexDocument(folder.name, indexId),
			);
			this.ownedIndexPaths.add(index.path);
			this.emitOwnedIndexesChanged();
			return index;
		} finally {
			this.pendingIndexCreates.delete(indexPath);
		}
	}

	private chooseIndexPath(folder: TFolder, indexId: string): string {
		const preferredPath = joinPath(folder.path, 'index.md');
		if (!this.plugin.app.vault.getAbstractFileByPath(preferredPath)) {
			return preferredPath;
		}

		const shortId = indexId.slice(0, 8);
		for (let attempt = 0; attempt < MAX_INDEX_FILENAME_ATTEMPTS; attempt++) {
			const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
			const candidate = joinPath(folder.path, `index-${shortId}${suffix}.md`);
			if (!this.plugin.app.vault.getAbstractFileByPath(candidate)) {
				return candidate;
			}
		}

		throw new Error(`Could not choose a unique index filename for ${folder.path}.`);
	}

	private async convertNoteToIndex(file: TFile): Promise<TFolder> {
		if (file.extension !== 'md' || !file.parent) {
			throw new Error('Only Markdown notes can become indexed folders.');
		}

		const folderPath = joinPath(file.parent.path, file.basename);
		const conflictingItem = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		let folder: TFolder;

		if (conflictingItem instanceof TFolder) {
			folder = conflictingItem;
			if (this.getIndex(folder)) {
				throw new Error(`The folder “${folder.name}” already has an index.`);
			}
		} else if (conflictingItem) {
			throw new Error(`“${folderPath}” already exists and is not a folder.`);
		} else {
			this.suppressedFolderCreates.add(folderPath);
			try {
				folder = await this.plugin.app.vault.createFolder(folderPath);
			} finally {
				this.suppressedFolderCreates.delete(folderPath);
			}
		}

		const indexId = createIndexId();
		const indexPath = this.chooseIndexPath(folder, indexId);
		await this.plugin.app.fileManager.renameFile(file, indexPath);
		this.ownedIndexPaths.add(file.path);
		await this.writeOwnershipMetadata(file, folder, indexId);
		await this.plugin.app.vault.process(file, (document) =>
			replaceManagedBlock(document, []),
		);
		this.emitOwnedIndexesChanged();
		this.scheduleFolderSync(folder.path);
		this.scheduleFolderSync(folder.parent?.path ?? '');
		return folder;
	}

	private async writeOwnershipMetadata(
		index: TFile,
		folder: TFolder,
		indexId: string,
	): Promise<void> {
		await this.plugin.app.fileManager.processFrontMatter(index, (frontmatter) => {
			const metadata = frontmatter as Record<string, unknown>;
			const previousFolderName = metadata[INDEX_FOLDER_NAME_KEY];
			const rawAliases = metadata.aliases;
			const aliases = Array.isArray(rawAliases)
				? rawAliases.filter((alias): alias is string => typeof alias === 'string')
				: typeof rawAliases === 'string'
					? [rawAliases]
					: [];

			if (typeof previousFolderName === 'string') {
				const oldAliasIndex = aliases.indexOf(previousFolderName);
				if (oldAliasIndex !== -1) aliases.splice(oldAliasIndex, 1);
			}

			metadata[INDEX_OWNER_KEY] = INDEX_OWNER_VALUE;
			metadata[INDEX_ID_KEY] = indexId;
			metadata[INDEX_FOLDER_NAME_KEY] = folder.name;
			if (aliases.length > 0) metadata.aliases = aliases;
			else delete metadata.aliases;
		});
	}

	private async refreshOwnershipMetadata(folder: TFolder): Promise<void> {
		const index = this.getIndex(folder);
		if (!index) return;
		const frontmatter =
			this.plugin.app.metadataCache.getFileCache(index)?.frontmatter;
		const rawIndexId: unknown = frontmatter?.[INDEX_ID_KEY];
		await this.writeOwnershipMetadata(
			index,
			folder,
			typeof rawIndexId === 'string' ? rawIndexId : createIndexId(),
		);
	}

	private scheduleFolderSync(folderPath: string): void {
		if (!folderPath) return;
		this.pendingFolderSyncs.add(folderPath);
		if (this.syncTimer !== null) return;

		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			void this.flushFolderSyncs();
		}, SYNC_DELAY_MS);
	}

	private async flushFolderSyncs(): Promise<void> {
		const folderPaths = [...this.pendingFolderSyncs];
		this.pendingFolderSyncs.clear();

		for (const folderPath of folderPaths) {
			const folder = this.plugin.app.vault.getFolderByPath(folderPath);
			if (!folder || folder.isRoot()) continue;
			try {
				await this.syncFolder(folder);
			} catch (error) {
				console.error(`Could not synchronize ${folder.path}.`, error);
				new Notice('Could not update a folder index. Check the developer console.');
			}
		}

		if (this.pendingFolderSyncs.size > 0) {
			this.scheduleFolderSync([...this.pendingFolderSyncs][0] ?? '');
		}
	}

	private async syncFolder(folder: TFolder): Promise<void> {
		const index = this.getIndex(folder);
		if (!index) return;
		const children = [...folder.children]
			.filter((child) => !this.isOwnedIndex(child))
			.sort((left, right) => {
				if (left instanceof TFolder && right instanceof TFile) return -1;
				if (left instanceof TFile && right instanceof TFolder) return 1;
				return left.name.localeCompare(right.name, undefined, {
					numeric: true,
					sensitivity: 'base',
				});
			});
		const entries: string[] = [];

		for (const child of children) {
			if (child instanceof TFolder) {
				const childIndex =
					this.getIndex(child) ??
					this.getConventionalIndex(child) ??
					(await this.ensureIndex(child));
				const link = this.plugin.app.fileManager.generateMarkdownLink(
					childIndex,
					index.path,
					undefined,
					`${child.name}/`,
				);
				entries.push(`- ${link}`);
			} else if (child instanceof TFile) {
				const alias = child.extension === 'md' ? child.basename : child.name;
				const link = this.plugin.app.fileManager.generateMarkdownLink(
					child,
					index.path,
					undefined,
					alias,
				);
				entries.push(`- ${link}`);
			}
		}

		await this.plugin.app.vault.process(index, (document) =>
			replaceManagedBlock(document, entries),
		);
	}

	private async handleCreate(file: TAbstractFile): Promise<void> {
		if (file instanceof TFolder) {
			if (this.suppressedFolderCreates.has(file.path)) return;
			try {
				await new Promise<void>((resolve) => {
					window.setTimeout(resolve, SYNC_DELAY_MS);
				});
				if (this.disposed) return;
				const currentFolder = this.plugin.app.vault.getFolderByPath(file.path);
				if (!currentFolder) return;
				const conventionalIndex = this.getConventionalIndex(currentFolder);
				if (conventionalIndex && !this.isOwnedIndex(conventionalIndex)) return;
				await this.ensureIndex(currentFolder);
				this.scheduleFolderSync(currentFolder.path);
				this.scheduleFolderSync(currentFolder.parent?.path ?? '');
			} catch (error) {
				console.error(`Could not initialize ${file.path}.`, error);
				new Notice('Could not create a folder index. Check the developer console.');
			}
			return;
		}

		if (this.pendingIndexCreates.has(file.path)) return;
		this.scheduleFolderSync(file.parent?.path ?? '');
	}

	private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		const oldParentPath = getParentPath(oldPath);
		this.scheduleFolderSync(oldParentPath);
		this.scheduleFolderSync(file.parent?.path ?? '');

		if (file instanceof TFile) {
			if (this.ownedIndexPaths.delete(oldPath) || this.cacheSaysOwned(file)) {
				this.ownedIndexPaths.add(file.path);
				this.emitOwnedIndexesChanged();
			}
			return;
		}

		const oldPrefix = `${oldPath}/`;
		const newPrefix = `${file.path}/`;
		for (const ownedPath of [...this.ownedIndexPaths]) {
			if (!ownedPath.startsWith(oldPrefix)) continue;
			this.ownedIndexPaths.delete(ownedPath);
			this.ownedIndexPaths.add(`${newPrefix}${ownedPath.slice(oldPrefix.length)}`);
		}
		this.emitOwnedIndexesChanged();

		const folders = this.plugin.app.vault
			.getAllFolders(false)
			.filter(
				(folder) =>
					folder.path === file.path || folder.path.startsWith(`${file.path}/`),
			);
		for (const folder of folders) {
			await this.refreshOwnershipMetadata(folder);
			this.scheduleFolderSync(folder.path);
		}
	}

	private handleDelete(file: TAbstractFile): void {
		if (file instanceof TFolder) {
			const prefix = `${file.path}/`;
			for (const ownedPath of [...this.ownedIndexPaths]) {
				if (ownedPath.startsWith(prefix)) this.ownedIndexPaths.delete(ownedPath);
			}
		} else {
			this.ownedIndexPaths.delete(file.path);
		}
		this.emitOwnedIndexesChanged();
		this.scheduleFolderSync(file.parent?.path ?? getParentPath(file.path));
	}
}
