export type MigrationActionKind =
	| 'adopt-same-name'
	| 'adopt-legacy-index'
	| 'move-sidecar-and-adopt'
	| 'create';

export interface MigrationEntryDescriptor {
	path: string;
	kind: 'file' | 'folder';
	size?: number;
}

export interface MigrationAction {
	folderPath: string;
	depth: number;
	kind: MigrationActionKind;
	sourcePath?: string;
	targetPath: string;
}

export interface MigrationDuplicate {
	folderPath: string;
	path: string;
	size: number;
	reason: 'sidecar' | 'legacy-index';
}

export interface MigrationBlocker {
	folderPath: string;
	path: string;
	reason: string;
}

export interface MigrationPlan {
	rootPath: string;
	maxDepth: number;
	actions: MigrationAction[];
	duplicates: MigrationDuplicate[];
	blockers: MigrationBlocker[];
	excludedFolderCount: number;
}

function normalizePath(path: string): string {
	return path.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

function getName(path: string): string {
	const separator = path.lastIndexOf('/');
	return separator === -1 ? path : path.slice(separator + 1);
}

function getParent(path: string): string {
	const separator = path.lastIndexOf('/');
	return separator === -1 ? '' : path.slice(0, separator);
}

function joinPath(parent: string, child: string): string {
	return parent ? `${parent}/${child}` : child;
}

export function getMigrationDepth(rootPath: string, folderPath: string): number | null {
	const root = normalizePath(rootPath);
	const folder = normalizePath(folderPath);
	if (folder === root) return 0;
	if (!folder.startsWith(`${root}/`)) return null;
	return folder.slice(root.length + 1).split('/').length;
}

export function buildMigrationPlan(
	rootPath: string,
	maxDepth: number,
	entries: readonly MigrationEntryDescriptor[],
): MigrationPlan {
	const root = normalizePath(rootPath);
	const depthLimit = Math.max(0, Math.floor(maxDepth));
	const byPath = new Map(
		entries.map((entry) => [normalizePath(entry.path), entry] as const),
	);
	const folders = entries
		.filter((entry) => entry.kind === 'folder')
		.map((entry) => normalizePath(entry.path))
		.map((path) => ({ path, depth: getMigrationDepth(root, path) }))
		.filter(
			(folder): folder is { path: string; depth: number } =>
				folder.depth !== null,
		);
	const selectedFolders = folders
		.filter((folder) => folder.depth <= depthLimit)
		.sort((left, right) =>
			left.depth === right.depth
				? left.path.localeCompare(right.path)
				: left.depth - right.depth,
		);
	const actions: MigrationAction[] = [];
	const duplicates: MigrationDuplicate[] = [];
	const blockers: MigrationBlocker[] = [];

	for (const folder of selectedFolders) {
		const folderName = getName(folder.path);
		const targetPath = joinPath(folder.path, `${folderName}.md`);
		const legacyPath = joinPath(folder.path, 'index.md');
		const sidecarPath = joinPath(getParent(folder.path), `${folderName}.md`);
		const target = byPath.get(targetPath);
		const legacy = legacyPath === targetPath ? undefined : byPath.get(legacyPath);
		const sidecar = folder.depth === 0 ? undefined : byPath.get(sidecarPath);

		if (target?.kind === 'folder') {
			blockers.push({
				folderPath: folder.path,
				path: targetPath,
				reason: 'The required folder-note path is a folder.',
			});
			continue;
		}
		if (!target && legacy?.kind === 'folder') {
			blockers.push({
				folderPath: folder.path,
				path: legacyPath,
				reason: 'The legacy index.md path is a folder.',
			});
			continue;
		}
		if (!target && !legacy && sidecar?.kind === 'folder') {
			blockers.push({
				folderPath: folder.path,
				path: sidecarPath,
				reason: 'The matching sidecar path is a folder.',
			});
			continue;
		}

		let action: MigrationAction;
		if (target?.kind === 'file') {
			action = {
				folderPath: folder.path,
				depth: folder.depth,
				kind: 'adopt-same-name',
				sourcePath: targetPath,
				targetPath,
			};
		} else if (legacy?.kind === 'file') {
			action = {
				folderPath: folder.path,
				depth: folder.depth,
				kind: 'adopt-legacy-index',
				sourcePath: legacyPath,
				targetPath,
			};
		} else if (sidecar?.kind === 'file') {
			action = {
				folderPath: folder.path,
				depth: folder.depth,
				kind: 'move-sidecar-and-adopt',
				sourcePath: sidecarPath,
				targetPath,
			};
		} else {
			action = {
				folderPath: folder.path,
				depth: folder.depth,
				kind: 'create',
				targetPath,
			};
		}
		actions.push(action);

		if (sidecar?.kind === 'file' && action.kind !== 'move-sidecar-and-adopt') {
			duplicates.push({
				folderPath: folder.path,
				path: sidecarPath,
				size: sidecar.size ?? 0,
				reason: 'sidecar',
			});
		}
		if (legacy?.kind === 'file' && action.kind !== 'adopt-legacy-index') {
			duplicates.push({
				folderPath: folder.path,
				path: legacyPath,
				size: legacy.size ?? 0,
				reason: 'legacy-index',
			});
		}
	}

	return {
		rootPath: root,
		maxDepth: depthLimit,
		actions,
		duplicates,
		blockers,
		excludedFolderCount: folders.length - selectedFolders.length,
	};
}

export function countMigrationActions(
	plan: MigrationPlan,
): Record<MigrationActionKind, number> {
	const counts: Record<MigrationActionKind, number> = {
		'adopt-same-name': 0,
		'adopt-legacy-index': 0,
		'move-sidecar-and-adopt': 0,
		create: 0,
	};
	for (const action of plan.actions) counts[action.kind] += 1;
	return counts;
}
