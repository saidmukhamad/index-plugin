import type { MigrationAction, MigrationPlan } from './plan';

export interface MigrationBackupFile {
	path: string;
	content: string;
	ctime: number;
	mtime: number;
}

export interface MigrationApplyResult {
	backupPath: string;
	convertedFolderCount: number;
	trashedDuplicateCount: number;
}

/** Vault operations behind a migration: Obsidian's vault in the plugin, the filesystem in the CLI. */
export interface MigrationHost {
	/** Equal values mean the same file; null means nothing is at `path`. */
	findFile(path: string): Promise<unknown>;
	readBackupFile(path: string): Promise<MigrationBackupFile | null>;
	writeBackup(fileName: string, manifest: string): Promise<string>;
	renameFile(sourcePath: string, targetPath: string): Promise<void>;
	adoptFolder(action: MigrationAction): Promise<void>;
	/** Returns false when the file is gone or no longer empty. */
	trashEmptyFile(path: string): Promise<boolean>;
}

export async function applyMigrationPlan(
	plan: MigrationPlan,
	host: MigrationHost,
	options: {
		trashEmptyDuplicates: boolean;
		onProgress?: (completed: number, total: number, folderPath: string) => void;
	},
): Promise<MigrationApplyResult> {
	if (plan.blockers.length > 0) {
		throw new Error('Resolve migration blockers before applying this plan.');
	}
	const backupPath = await writeBackup(plan, host);

	// Deepest folders first, so a parent sees its children's final folder notes.
	const actions = [...plan.actions].sort((left, right) =>
		left.depth === right.depth
			? left.folderPath.localeCompare(right.folderPath)
			: right.depth - left.depth,
	);
	for (const [index, action] of actions.entries()) {
		if (
			action.sourcePath &&
			action.sourcePath !== action.targetPath &&
			(action.kind === 'adopt-same-name' || action.kind === 'move-sidecar-and-adopt')
		) {
			const source = await host.findFile(action.sourcePath);
			if (source === null) throw new Error(`Could not find “${action.sourcePath}”.`);
			// A case-only rename finds the source itself at the target on case-insensitive systems.
			const occupant = await host.findFile(action.targetPath);
			if (occupant !== null && occupant !== source) {
				throw new Error(`“${action.targetPath}” appeared during migration.`);
			}
			await host.renameFile(action.sourcePath, action.targetPath);
		}
		await host.adoptFolder(action);
		options.onProgress?.(index + 1, actions.length, action.folderPath);
	}

	let trashedDuplicateCount = 0;
	for (const duplicate of options.trashEmptyDuplicates ? plan.duplicates : []) {
		if (duplicate.size === 0 && (await host.trashEmptyFile(duplicate.path))) {
			trashedDuplicateCount += 1;
		}
	}
	return { backupPath, convertedFolderCount: actions.length, trashedDuplicateCount };
}

async function writeBackup(plan: MigrationPlan, host: MigrationHost): Promise<string> {
	const paths = new Set([
		...plan.actions.flatMap((action) => (action.sourcePath ? [action.sourcePath] : [])),
		...plan.duplicates.map((duplicate) => duplicate.path),
	]);
	const files: MigrationBackupFile[] = [];
	for (const path of paths) {
		const file = await host.readBackupFile(path);
		if (file) files.push(file);
	}
	const createdAt = new Date().toISOString();
	const fileName = `${createdAt.replace(/[:.]/g, '-')}-${plan.rootPath.replace(/\//g, '-')}.json`;
	return host.writeBackup(fileName, JSON.stringify({ version: 1, createdAt, plan, files }, null, 2));
}
