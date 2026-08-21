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
import { getFolderIndexFilename, getFolderIndexPath } from './index-path';
import {
	buildMigrationPlan,
	getMigrationDepth,
	type MigrationEntryDescriptor,
	type MigrationPlan,
} from './migration-plan';
import { normalizeFolderName, normalizeNoteName } from './note-name';
import {
	type IndexPluginSettings,
	isPlainFolder,
	shouldAutoAdoptFolder,
	shouldAutoIndexFolder,
} from './settings';

const SYNC_DELAY_MS = 120;
const AUTO_INDEX_DELAY_MS = 750;

export interface MigrationApplyResult {
	backupPath: string;
	convertedFolderCount: number;
	trashedDuplicateCount: number;
}

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
	private readonly aligningIndexes = new Map<string, Promise<TFile | null>>();
	private readonly refreshingOwnership = new Map<string, Promise<void>>();
	private readonly pendingFolderSyncs = new Set<string>();
	private readonly pendingFolderInitializations = new Map<string, number>();
	private readonly ownedIndexListeners = new Set<() => void>();
	private syncTimer: number | null = null;
	private migrationInProgress = false;
	private activeMigrationScope: { rootPath: string; maxDepth: number } | null = null;
	private disposed = false;

	constructor(
		private readonly plugin: Plugin,
		private readonly getSettings: () => IndexPluginSettings,
	) {}

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
				this.plugin.app.vault.on('modify', (file) => {
					if (file instanceof TFile) this.handleModify(file);
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
						const folder = file.parent;
						if (
							folder &&
							!folder.isRoot() &&
							(file.path !== this.getExpectedIndexPath(folder) ||
								cache.frontmatter?.[INDEX_FOLDER_NAME_KEY] !== folder.name ||
								this.hasManagedFolderAlias(cache.frontmatter, folder.name))
						) {
							void this.refreshOwnershipMetadata(folder).catch(
								(error: unknown) => {
									console.error(
										`Could not keep folder note ${file.path} synchronized.`,
										error,
									);
								},
							);
						}
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
		for (const timer of this.pendingFolderInitializations.values()) {
			window.clearTimeout(timer);
		}
		this.pendingFolderInitializations.clear();
		this.aligningIndexes.clear();
		this.refreshingOwnership.clear();
		this.ownedIndexListeners.clear();
	}

	onOwnedIndexesChanged(listener: () => void): () => void {
		this.ownedIndexListeners.add(listener);
		return () => this.ownedIndexListeners.delete(listener);
	}

	isOwnedIndex(file: TAbstractFile | null): boolean {
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

	isPlainFolder(folder: TFolder): boolean {
		return isPlainFolder(this.getSettings(), folder.path);
	}

	async createPlainFolder(
		target: TFile | TFolder,
		rawName: string,
	): Promise<TFolder> {
		const folderName = normalizeFolderName(rawName);
		const parent = target instanceof TFolder ? target : target.parent;
		if (!parent) throw new Error('Could not determine where to create the folder.');

		const folderPath = joinPath(parent.path, folderName);
		if (this.plugin.app.vault.getAbstractFileByPath(folderPath)) {
			throw new Error(`“${folderName}” already exists in this location.`);
		}

		const settings = this.getSettings();
		settings.plainFolders = [
			...settings.plainFolders.filter((path) => path !== folderPath),
			folderPath,
		];
		await this.plugin.saveData(settings);
		this.suppressedFolderCreates.add(folderPath);
		try {
			return await this.plugin.app.vault.createFolder(folderPath);
		} catch (error) {
			settings.plainFolders = settings.plainFolders.filter(
				(path) => path !== folderPath,
			);
			await this.plugin.saveData(settings);
			throw error;
		} finally {
			this.suppressedFolderCreates.delete(folderPath);
		}
	}

	async ensureIndex(folder: TFolder): Promise<TFile> {
		const existing = this.getIndex(folder);
		if (existing) return existing;
		await this.stopTreatingAsPlain(folder.path);

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

		const index = this.getIndex(folder);
		const futureIndexPath = joinPath(
			folder.path,
			getFolderIndexFilename(folderName),
		);
		const indexNameConflict =
			this.plugin.app.vault.getAbstractFileByPath(futureIndexPath);
		if (indexNameConflict && indexNameConflict !== index) {
			throw new Error(
				`“${folderName}.md” already exists inside this folder. Rename it before renaming the folder.`,
			);
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
		await this.stopTreatingAsPlain(folder.path);

		const namedIndexPath = this.getExpectedIndexPath(folder);
		const namedIndex = this.plugin.app.vault.getAbstractFileByPath(namedIndexPath);
		const legacyIndexPath = joinPath(folder.path, 'index.md');
		const legacyIndex =
			legacyIndexPath === namedIndexPath
				? null
				: this.plugin.app.vault.getAbstractFileByPath(legacyIndexPath);
		const previousOwnedIndexes = folder.children.filter(
			(child): child is TFile => this.isOwnedIndex(child),
		);
		let index: TFile;

		let adoptionCandidate: TFile | null = null;
		if (namedIndex instanceof TFile && !this.isOwnedIndex(namedIndex)) {
			adoptionCandidate = namedIndex;
		} else if (
			!namedIndex &&
			legacyIndex instanceof TFile &&
			!this.isOwnedIndex(legacyIndex)
		) {
			adoptionCandidate = legacyIndex;
		}

		if (adoptionCandidate) {
			await this.plugin.app.vault.process(adoptionCandidate, (document) =>
				replaceManagedBlock(document, []),
			);
			const indexId = createIndexId();
			this.ownedIndexPaths.add(adoptionCandidate.path);
			await this.writeOwnershipMetadata(adoptionCandidate, folder, indexId);
			index = adoptionCandidate;
			this.emitOwnedIndexesChanged();

			for (const previousIndex of previousOwnedIndexes) {
				if (previousIndex.path !== adoptionCandidate.path) {
					await this.retirePreviousIndex(previousIndex, folder);
				}
			}
		} else if (namedIndex instanceof TFile && this.isOwnedIndex(namedIndex)) {
			index = namedIndex;
			for (const previousIndex of previousOwnedIndexes) {
				if (previousIndex.path !== namedIndexPath) {
					await this.retirePreviousIndex(previousIndex, folder);
				}
			}
		} else if (namedIndex) {
			throw new Error(
				`The required “${getFolderIndexFilename(folder.name)}” path is not a Markdown file.`,
			);
		} else if (legacyIndex && !(legacyIndex instanceof TFile)) {
			throw new Error('The legacy index.md path is not a Markdown file.');
		} else if (previousOwnedIndexes[0]) {
			index = previousOwnedIndexes[0];
		} else {
			index = await this.ensureIndex(folder);
		}

		const alignedIndex = await this.alignOwnedIndexName(folder, index);
		if (!alignedIndex) {
			throw new Error('Could not locate the folder note after conversion.');
		}
		index = alignedIndex;

		await this.syncFolder(folder);
		this.scheduleFolderSync(folder.parent?.path ?? '');
		return index;
	}

	createMigrationPlan(root: TFolder, maxDepth: number): MigrationPlan {
		if (root.isRoot()) {
			throw new Error('The vault root cannot be migrated yet.');
		}
		const entries: MigrationEntryDescriptor[] = [];
		const visit = (folder: TFolder): void => {
			entries.push({ path: folder.path, kind: 'folder' });
			for (const child of folder.children) {
				if (child instanceof TFolder) visit(child);
				else if (child instanceof TFile) {
					entries.push({
						path: child.path,
						kind: 'file',
						size: child.stat.size,
					});
				}
			}
		};
		visit(root);
		const sidecar = this.plugin.app.vault.getFileByPath(`${root.path}.md`);
		if (sidecar) {
			entries.push({
				path: sidecar.path,
				kind: 'file',
				size: sidecar.stat.size,
			});
		}
		return buildMigrationPlan(root.path, maxDepth, entries);
	}

	async applyMigrationPlan(
		plan: MigrationPlan,
		trashEmptyDuplicates: boolean,
		onProgress?: (completed: number, total: number, folderPath: string) => void,
	): Promise<MigrationApplyResult> {
		if (plan.blockers.length > 0) {
			throw new Error('Resolve migration blockers before applying this plan.');
		}
		const root = this.plugin.app.vault.getFolderByPath(plan.rootPath);
		if (!root) throw new Error(`Could not find “${plan.rootPath}”.`);
		const currentPlan = this.createMigrationPlan(root, plan.maxDepth);
		if (this.getMigrationSignature(plan) !== this.getMigrationSignature(currentPlan)) {
			throw new Error('The folder tree changed. Review a fresh migration preview.');
		}
		const backupPath = await this.writeMigrationBackup(plan);
		const actions = [...plan.actions].sort((left, right) =>
			left.depth === right.depth
				? left.folderPath.localeCompare(right.folderPath)
				: right.depth - left.depth,
		);
		let completed = 0;
		this.migrationInProgress = true;
		this.activeMigrationScope = {
			rootPath: plan.rootPath,
			maxDepth: plan.maxDepth,
		};

		try {
			for (const action of actions) {
				if (
					action.kind === 'adopt-same-name' &&
					action.sourcePath !== action.targetPath
				) {
					const source = action.sourcePath
						? this.plugin.app.vault.getFileByPath(action.sourcePath)
						: null;
					if (!source) {
						throw new Error(`Could not find folder note “${action.sourcePath}”.`);
					}
					const conflict =
						this.plugin.app.vault.getAbstractFileByPath(action.targetPath);
					if (conflict && conflict !== source) {
						throw new Error(`“${action.targetPath}” appeared during migration.`);
					}
					await this.plugin.app.fileManager.renameFile(source, action.targetPath);
				} else if (action.kind === 'move-sidecar-and-adopt') {
					const source = action.sourcePath
						? this.plugin.app.vault.getFileByPath(action.sourcePath)
						: null;
					if (!source) {
						throw new Error(`Could not find sidecar note “${action.sourcePath}”.`);
					}
					if (this.plugin.app.vault.getAbstractFileByPath(action.targetPath)) {
						throw new Error(`“${action.targetPath}” appeared during migration.`);
					}
					await this.plugin.app.fileManager.renameFile(source, action.targetPath);
				}

				const folder = this.plugin.app.vault.getFolderByPath(action.folderPath);
				if (!folder) throw new Error(`Could not find “${action.folderPath}”.`);
				await this.convertFolder(folder);
				completed += 1;
				onProgress?.(completed, actions.length, action.folderPath);
			}
		} finally {
			this.migrationInProgress = false;
			this.activeMigrationScope = null;
		}

		let trashedDuplicateCount = 0;
		if (trashEmptyDuplicates) {
			for (const duplicate of plan.duplicates) {
				if (duplicate.size !== 0) continue;
				const file = this.plugin.app.vault.getFileByPath(duplicate.path);
				if (!file || file.stat.size !== 0 || this.isOwnedIndex(file)) continue;
				await this.plugin.app.fileManager.trashFile(file);
				trashedDuplicateCount += 1;
			}
		}

		return {
			backupPath,
			convertedFolderCount: completed,
			trashedDuplicateCount,
		};
	}

	private getMigrationSignature(plan: MigrationPlan): string {
		return JSON.stringify({
			actions: plan.actions.map((action) => [
				action.folderPath,
				action.kind,
				action.sourcePath,
				action.targetPath,
			]),
			duplicates: plan.duplicates.map((duplicate) => [
				duplicate.path,
				duplicate.size,
			]),
			blockers: plan.blockers.map((blocker) => [
				blocker.path,
				blocker.reason,
			]),
		});
	}

	private async writeMigrationBackup(plan: MigrationPlan): Promise<string> {
		const filePaths = new Set<string>();
		for (const action of plan.actions) {
			if (action.sourcePath) filePaths.add(action.sourcePath);
		}
		for (const duplicate of plan.duplicates) filePaths.add(duplicate.path);
		const files = [];
		for (const path of filePaths) {
			const file = this.plugin.app.vault.getFileByPath(path);
			if (!file) continue;
			files.push({
				path: file.path,
				content: await this.plugin.app.vault.read(file),
				ctime: file.stat.ctime,
				mtime: file.stat.mtime,
			});
		}
		const pluginDirectory =
			this.plugin.manifest.dir ??
			`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
		const backupDirectory = normalizePath(`${pluginDirectory}/migration-backups`);
		await this.ensureAdapterDirectory(backupDirectory);
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupPath = normalizePath(
			`${backupDirectory}/${timestamp}-${plan.rootPath.replace(/\//g, '-')}.json`,
		);
		await this.plugin.app.vault.adapter.write(
			backupPath,
			JSON.stringify(
				{
					version: 1,
					createdAt: new Date().toISOString(),
					plan,
					files,
				},
				null,
				2,
			),
		);
		return backupPath;
	}

	private async ensureAdapterDirectory(path: string): Promise<void> {
		let current = '';
		for (const part of path.split('/')) {
			current = joinPath(current, part);
			if (!(await this.plugin.app.vault.adapter.exists(current))) {
				await this.plugin.app.vault.adapter.mkdir(current);
			}
		}
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
			`Kept customized previous index as “${index.name}” after adopting the folder note.`,
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
		return (
			this.plugin.app.vault.getFileByPath(this.getExpectedIndexPath(folder)) ??
			this.plugin.app.vault.getFileByPath(joinPath(folder.path, 'index.md'))
		);
	}

	private getExpectedIndexPath(folder: TFolder): string {
		return normalizePath(getFolderIndexPath(folder.path, folder.name));
	}

	private refreshOwnedIndexPaths(): void {
		this.ownedIndexPaths.clear();
		const ownedFiles = this.plugin.app.vault
			.getMarkdownFiles()
			.filter((file) => this.cacheSaysOwned(file));
		for (const file of ownedFiles) {
			this.ownedIndexPaths.add(file.path);
			this.scheduleFolderSync(file.parent?.path ?? '');
		}
		this.emitOwnedIndexesChanged();

		for (const file of ownedFiles) {
			const folder = file.parent;
			if (!folder || folder.isRoot()) continue;
			const indexesInFolder = folder.children.filter(
				(child): child is TFile => this.isOwnedIndex(child),
			);
			if (indexesInFolder.length !== 1) continue;

			const frontmatter =
				this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
			const needsRefresh =
				file.path !== this.getExpectedIndexPath(folder) ||
				frontmatter?.[INDEX_FOLDER_NAME_KEY] !== folder.name ||
				this.hasManagedFolderAlias(frontmatter, folder.name);
			if (!needsRefresh) continue;

			void this.refreshOwnershipMetadata(folder).catch((error: unknown) => {
				console.error(`Could not migrate folder note ${file.path}.`, error);
				new Notice(
					`Could not rename the folder note for “${folder.name}”. Check for a conflicting file.`,
				);
			});
		}
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
		const indexPath = this.getExpectedIndexPath(folder);
		if (this.plugin.app.vault.getAbstractFileByPath(indexPath)) {
			throw new Error(
				`“${getFolderIndexFilename(folder.name)}” already exists. Use Convert (indexed) to adopt it.`,
			);
		}
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
		const indexPath = this.getExpectedIndexPath(folder);
		const indexConflict = this.plugin.app.vault.getAbstractFileByPath(indexPath);
		if (indexConflict && indexConflict !== file) {
			throw new Error(`“${getFolderIndexFilename(folder.name)}” already exists.`);
		}
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
		const inProgress = this.refreshingOwnership.get(folder.path);
		if (inProgress) return inProgress;

		const promise = this.performRefreshOwnershipMetadata(folder).finally(() => {
			if (this.refreshingOwnership.get(folder.path) === promise) {
				this.refreshingOwnership.delete(folder.path);
			}
		});
		this.refreshingOwnership.set(folder.path, promise);
		return promise;
	}

	private async performRefreshOwnershipMetadata(folder: TFolder): Promise<void> {
		const currentIndex = this.getIndex(folder);
		if (!currentIndex) return;
		const frontmatter =
			this.plugin.app.metadataCache.getFileCache(currentIndex)?.frontmatter;
		const rawIndexId: unknown = frontmatter?.[INDEX_ID_KEY];
		const index = await this.alignOwnedIndexName(folder, currentIndex);
		if (!index) return;
		await this.writeOwnershipMetadata(
			index,
			folder,
			typeof rawIndexId === 'string' ? rawIndexId : createIndexId(),
		);
	}

	private async alignOwnedIndexName(
		folder: TFolder,
		candidate?: TFile,
	): Promise<TFile | null> {
		const inProgress = this.aligningIndexes.get(folder.path);
		if (inProgress) return inProgress;

		const promise = this.performAlignOwnedIndexName(folder, candidate).finally(
			() => {
				if (this.aligningIndexes.get(folder.path) === promise) {
					this.aligningIndexes.delete(folder.path);
				}
			},
		);
		this.aligningIndexes.set(folder.path, promise);
		return promise;
	}

	private async performAlignOwnedIndexName(
		folder: TFolder,
		candidate?: TFile,
	): Promise<TFile | null> {
		const index = candidate ?? this.getIndex(folder);
		if (!index) return null;

		const expectedPath = this.getExpectedIndexPath(folder);
		if (index.path === expectedPath) return index;

		const conflict = this.plugin.app.vault.getAbstractFileByPath(expectedPath);
		if (conflict && conflict !== index) {
			throw new Error(
				`Could not rename the folder note to “${getFolderIndexFilename(folder.name)}” because that path already exists.`,
			);
		}

		const oldPath = index.path;
		await this.plugin.app.fileManager.renameFile(index, expectedPath);
		let renamedIndex = this.plugin.app.vault.getFileByPath(expectedPath);
		for (let attempt = 0; !renamedIndex && attempt < 10; attempt++) {
			await new Promise<void>((resolve) => {
				window.setTimeout(resolve, 20);
			});
			renamedIndex = this.plugin.app.vault.getFileByPath(expectedPath);
		}
		if (!renamedIndex) {
			throw new Error('The folder note was renamed but could not be found afterward.');
		}
		this.ownedIndexPaths.delete(oldPath);
		this.ownedIndexPaths.add(renamedIndex.path);
		this.emitOwnedIndexesChanged();
		return renamedIndex;
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
				let childIndex =
					this.getIndex(child) ?? this.getConventionalIndex(child);
				if (!childIndex) {
					if (!this.shouldIndexFolder(child.path)) continue;
					childIndex = await this.ensureIndex(child);
				}
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
			this.scheduleFolderInitialization(file);
			return;
		}

		if (this.pendingIndexCreates.has(file.path)) return;
		this.scheduleFolderSync(file.parent?.path ?? '');
		if (file instanceof TFile) this.scheduleConventionalIndexAdoption(file);
	}

	private handleModify(file: TFile): void {
		this.scheduleConventionalIndexAdoption(file);
	}

	private scheduleConventionalIndexAdoption(file: TFile): void {
		const folder = file.parent;
		if (
			!folder ||
			folder.isRoot() ||
			file.extension !== 'md' ||
			file.path !== this.getExpectedIndexPath(folder) ||
			this.isOwnedIndex(file) ||
			!shouldAutoAdoptFolder(this.getSettings(), folder.path)
		) {
			return;
		}
		this.scheduleFolderInitialization(folder);
	}

	private scheduleFolderInitialization(folder: TFolder): void {
		if (
			this.disposed ||
			this.migrationInProgress ||
			!shouldAutoIndexFolder(this.getSettings(), folder.path)
		) {
			return;
		}
		const existingTimer = this.pendingFolderInitializations.get(folder.path);
		if (existingTimer !== undefined) window.clearTimeout(existingTimer);
		const timer = window.setTimeout(() => {
			this.pendingFolderInitializations.delete(folder.path);
			void this.initializeManagedFolder(folder.path);
		}, AUTO_INDEX_DELAY_MS);
		this.pendingFolderInitializations.set(folder.path, timer);
	}

	private shouldIndexFolder(folderPath: string): boolean {
		if (this.activeMigrationScope) {
			const depth = getMigrationDepth(
				this.activeMigrationScope.rootPath,
				folderPath,
			);
			return depth !== null && depth <= this.activeMigrationScope.maxDepth;
		}
		return shouldAutoIndexFolder(this.getSettings(), folderPath);
	}

	private async initializeManagedFolder(folderPath: string): Promise<void> {
		if (this.disposed || this.migrationInProgress) return;
		const folder = this.plugin.app.vault.getFolderByPath(folderPath);
		if (!folder || !shouldAutoIndexFolder(this.getSettings(), folder.path)) return;

		try {
			const conventionalIndex = this.getConventionalIndex(folder);
			if (conventionalIndex && !this.isOwnedIndex(conventionalIndex)) {
				if (shouldAutoAdoptFolder(this.getSettings(), folder.path)) {
					await this.convertFolder(folder);
				}
				return;
			}
			await this.ensureIndex(folder);
			this.scheduleFolderSync(folder.path);
			this.scheduleFolderSync(folder.parent?.path ?? '');
		} catch (error) {
			console.error(`Could not initialize ${folder.path}.`, error);
			new Notice('Could not create a folder index. Check the developer console.');
		}
	}

	private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		const oldParentPath = getParentPath(oldPath);
		this.scheduleFolderSync(oldParentPath);
		this.scheduleFolderSync(file.parent?.path ?? '');

		if (file instanceof TFile) {
			const owned =
				this.ownedIndexPaths.delete(oldPath) || this.cacheSaysOwned(file);
			if (owned) {
				this.ownedIndexPaths.add(file.path);
				this.emitOwnedIndexesChanged();
				if (file.parent && !file.parent.isRoot()) {
					try {
						await this.refreshOwnershipMetadata(file.parent);
					} catch (error) {
						console.error(`Could not align folder note ${file.path}.`, error);
						new Notice(
							'Could not keep a folder note name synchronized. Check for a conflicting file.',
						);
					}
				}
			}
			return;
		}

		const settings = this.getSettings();
		const oldPrefix = `${oldPath}/`;
		const renamedPlainFolders = settings.plainFolders.map((path) =>
			path === oldPath
				? file.path
				: path.startsWith(oldPrefix)
					? `${file.path}/${path.slice(oldPrefix.length)}`
					: path,
		);
		if (
			renamedPlainFolders.some(
				(path, index) => path !== settings.plainFolders[index],
			)
		) {
			settings.plainFolders = renamedPlainFolders;
			await this.plugin.saveData(settings);
		}

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
			const settings = this.getSettings();
			const remainingPlainFolders = settings.plainFolders.filter(
				(path) => path !== file.path && !path.startsWith(prefix),
			);
			if (remainingPlainFolders.length !== settings.plainFolders.length) {
				settings.plainFolders = remainingPlainFolders;
				void this.plugin.saveData(settings);
			}
			for (const ownedPath of [...this.ownedIndexPaths]) {
				if (ownedPath.startsWith(prefix)) this.ownedIndexPaths.delete(ownedPath);
			}
		} else {
			this.ownedIndexPaths.delete(file.path);
		}
		this.emitOwnedIndexesChanged();
		this.scheduleFolderSync(file.parent?.path ?? getParentPath(file.path));
	}

	private async stopTreatingAsPlain(folderPath: string): Promise<void> {
		const settings = this.getSettings();
		if (!settings.plainFolders.includes(folderPath)) return;
		settings.plainFolders = settings.plainFolders.filter(
			(path) => path !== folderPath,
		);
		await this.plugin.saveData(settings);
	}
}
