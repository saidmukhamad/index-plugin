import type { MigrationAction, MigrationPlan } from './migration-plan';

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

/** File operations a migration needs; implemented by the plugin (Obsidian vault) and the CLI (filesystem). */
export interface MigrationHost {
	/** Returns a value identifying the file at `path` (equal for the same file), or null if nothing is there. */
	findFile(path: string): Promise<unknown>;
	readBackupFile(path: string): Promise<MigrationBackupFile | null>;
	/** Stores the restoration manifest and returns where it was written. */
	writeBackup(fileName: string, manifest: string): Promise<string>;
	renameFile(sourcePath: string, targetPath: string): Promise<void>;
	/** Turns the action's folder into an indexed folder whose note is at `action.targetPath`. */
	adoptFolder(action: MigrationAction): Promise<void>;
	/** Moves an empty duplicate to the trash; returns false if it is gone or no longer safe to remove. */
	trashEmptyFile(path: string): Promise<boolean>;
}

export interface MigrationApplyOptions {
	trashEmptyDuplicates: boolean;
	onProgress?: (completed: number, total: number, folderPath: string) => void;
}

export async function applyMigrationPlan(
	plan: MigrationPlan,
	host: MigrationHost,
	options: MigrationApplyOptions,
): Promise<MigrationApplyResult> {
	if (plan.blockers.length > 0) {
		throw new Error('Resolve migration blockers before applying this plan.');
	}
	const backupPath = await writeMigrationBackup(plan, host);

	// Deepest folders first, so a parent sees its children's final folder notes.
	const actions = [...plan.actions].sort((left, right) =>
		left.depth === right.depth
			? left.folderPath.localeCompare(right.folderPath)
			: right.depth - left.depth,
	);
	let completed = 0;
	for (const action of actions) {
		if (
			action.sourcePath &&
			action.sourcePath !== action.targetPath &&
			(action.kind === 'adopt-same-name' || action.kind === 'move-sidecar-and-adopt')
		) {
			await moveFolderNote(host, action.sourcePath, action.targetPath);
		}
		await host.adoptFolder(action);
		completed += 1;
		options.onProgress?.(completed, actions.length, action.folderPath);
	}

	let trashedDuplicateCount = 0;
	if (options.trashEmptyDuplicates) {
		for (const duplicate of plan.duplicates) {
			if (duplicate.size === 0 && (await host.trashEmptyFile(duplicate.path))) {
				trashedDuplicateCount += 1;
			}
		}
	}

	return { backupPath, convertedFolderCount: completed, trashedDuplicateCount };
}

async function moveFolderNote(
	host: MigrationHost,
	sourcePath: string,
	targetPath: string,
): Promise<void> {
	const source = await host.findFile(sourcePath);
	if (source === null) throw new Error(`Could not find “${sourcePath}”.`);
	const occupant = await host.findFile(targetPath);
	// A case-only rename finds the source itself at the target path on case-insensitive systems.
	if (occupant !== null && occupant !== source) {
		throw new Error(`“${targetPath}” appeared during migration.`);
	}
	await host.renameFile(sourcePath, targetPath);
}

async function writeMigrationBackup(plan: MigrationPlan, host: MigrationHost): Promise<string> {
	const paths = new Set<string>();
	for (const action of plan.actions) {
		if (action.sourcePath) paths.add(action.sourcePath);
	}
	for (const duplicate of plan.duplicates) paths.add(duplicate.path);

	const files: MigrationBackupFile[] = [];
	for (const path of paths) {
		const file = await host.readBackupFile(path);
		if (file) files.push(file);
	}
	const createdAt = new Date().toISOString();
	const fileName = `${createdAt.replace(/[:.]/g, '-')}-${plan.rootPath.replace(/\//g, '-')}.json`;
	const manifest = JSON.stringify({ version: 1, createdAt, plan, files }, null, 2);
	return host.writeBackup(fileName, manifest);
}
