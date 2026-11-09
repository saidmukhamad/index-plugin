import { randomUUID } from 'node:crypto';
import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
	INDEX_FOLDER_NAME_KEY,
	INDEX_ID_KEY,
	INDEX_OWNER_KEY,
	INDEX_OWNER_VALUE,
	buildNewIndexDocument,
	replaceManagedBlock,
} from '../src/index-document.ts';
import { applyMigrationPlan } from '../src/migration-apply.ts';
import {
	buildMigrationPlan,
	countMigrationActions,
} from '../src/migration-plan.ts';

function parseArguments(argv) {
	const options = {
		apply: false,
		maxDepth: 3,
		root: '',
		trashEmptyDuplicates: false,
		vault: '',
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--apply') options.apply = true;
		else if (argument === '--trash-empty-duplicates') {
			options.trashEmptyDuplicates = true;
		} else if (argument === '--vault') options.vault = argv[++index] ?? '';
		else if (argument === '--root') options.root = argv[++index] ?? '';
		else if (argument === '--max-depth') {
			options.maxDepth = Number(argv[++index]);
		} else throw new Error(`Unknown argument: ${argument}`);
	}
	if (!path.isAbsolute(options.vault)) {
		throw new Error('--vault must be an absolute path.');
	}
	if (
		!options.root ||
		path.isAbsolute(options.root) ||
		options.root.split('/').includes('..')
	) {
		throw new Error('--root must be a safe vault-relative path.');
	}
	if (!Number.isInteger(options.maxDepth) || options.maxDepth < 0) {
		throw new Error('--max-depth must be a non-negative integer.');
	}
	return options;
}

function toVaultPath(vaultPath, filesystemPath) {
	return path.relative(vaultPath, filesystemPath).split(path.sep).join('/');
}

function toFilesystemPath(vaultPath, vaultRelativePath) {
	const resolved = path.resolve(vaultPath, ...vaultRelativePath.split('/'));
	const prefix = `${path.resolve(vaultPath)}${path.sep}`;
	if (resolved !== path.resolve(vaultPath) && !resolved.startsWith(prefix)) {
		throw new Error(`Path escapes the vault: ${vaultRelativePath}`);
	}
	return resolved;
}

async function collectEntries(vaultPath, directoryPath, entries) {
	entries.push({
		path: toVaultPath(vaultPath, directoryPath),
		kind: 'folder',
	});
	for (const item of await readdir(directoryPath, { withFileTypes: true })) {
		if (item.name.startsWith('.')) continue;
		const itemPath = path.join(directoryPath, item.name);
		if (item.isDirectory()) await collectEntries(vaultPath, itemPath, entries);
		else if (item.isFile()) {
			const itemStats = await stat(itemPath);
			entries.push({
				path: toVaultPath(vaultPath, itemPath),
				kind: 'file',
				size: itemStats.size,
			});
		}
	}
}

const OWNERSHIP_KEYS = [INDEX_OWNER_KEY, INDEX_ID_KEY, INDEX_FOLDER_NAME_KEY];

function setOwnershipMetadata(document, folderName, indexId) {
	const eol = document.includes('\r\n') ? '\r\n' : '\n';
	const metadata = [
		`${INDEX_OWNER_KEY}: ${INDEX_OWNER_VALUE}`,
		`${INDEX_ID_KEY}: ${indexId}`,
		`${INDEX_FOLDER_NAME_KEY}: ${JSON.stringify(folderName)}`,
	];
	if (!document.startsWith(`---${eol}`)) {
		return `---${eol}${metadata.join(eol)}${eol}---${eol}${document}`;
	}
	const closingMarker = `${eol}---`;
	const closingIndex = document.indexOf(closingMarker, 3 + eol.length);
	if (closingIndex === -1) {
		throw new Error(`Malformed frontmatter in ${folderName}.md`);
	}
	const frontmatter = document.slice(3 + eol.length, closingIndex);
	const userLines = frontmatter
		.split(eol)
		.filter((line) => !OWNERSHIP_KEYS.some((key) => line.startsWith(`${key}:`)));
	const updated = [...userLines, ...metadata].filter(
		(line, index, lines) => line !== '' || index !== lines.length - 1,
	);
	return `---${eol}${updated.join(eol)}${closingMarker}${document.slice(closingIndex + closingMarker.length)}`;
}

function findIndexId(document) {
	return (
		document.match(new RegExp(`^${INDEX_ID_KEY}:\\s*([^\\r\\n]+)$`, 'm'))?.[1]?.trim() ??
		randomUUID()
	);
}

function removeMarkdownExtension(filePath) {
	return filePath.toLowerCase().endsWith('.md') ? filePath.slice(0, -3) : filePath;
}

function makeLink(targetPath, alias) {
	return `- [[${removeMarkdownExtension(targetPath)}|${alias}]]`;
}

async function buildChildLinks(vaultPath, action, actionByFolder) {
	const folderPath = toFilesystemPath(vaultPath, action.folderPath);
	const items = await readdir(folderPath, { withFileTypes: true });
	const collator = new Intl.Collator(undefined, {
		numeric: true,
		sensitivity: 'base',
	});
	items.sort((left, right) => {
		if (left.isDirectory() && !right.isDirectory()) return -1;
		if (!left.isDirectory() && right.isDirectory()) return 1;
		return collator.compare(left.name, right.name);
	});
	const links = [];
	for (const item of items) {
		const itemVaultPath = `${action.folderPath}/${item.name}`;
		if (item.isDirectory()) {
			const childAction = actionByFolder.get(itemVaultPath);
			let targetPath = childAction?.targetPath;
			if (!targetPath) {
				const sameName = `${itemVaultPath}/${item.name}.md`;
				const legacy = `${itemVaultPath}/index.md`;
				try {
					await stat(toFilesystemPath(vaultPath, sameName));
					targetPath = sameName;
				} catch {
					try {
						await stat(toFilesystemPath(vaultPath, legacy));
						targetPath = legacy;
					} catch {
						continue;
					}
				}
			}
			links.push(makeLink(targetPath, `${item.name}/`));
		} else if (item.isFile() && itemVaultPath !== action.targetPath) {
			links.push(
				makeLink(
					itemVaultPath,
					item.name.toLowerCase().endsWith('.md')
						? item.name.slice(0, -3)
						: item.name,
				),
			);
		}
	}
	return links;
}

async function statIfExists(filesystemPath) {
	try {
		return await stat(filesystemPath);
	} catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
}

function createFilesystemHost(vaultPath, plan) {
	const actionByFolder = new Map(
		plan.actions.map((action) => [action.folderPath, action]),
	);
	const trashRoot = path.join(
		vaultPath,
		'.trash',
		'index-plugin-migration',
		new Date().toISOString().replace(/[:.]/g, '-'),
	);
	return {
		async findFile(filePath) {
			const fileStats = await statIfExists(toFilesystemPath(vaultPath, filePath));
			return fileStats ? `${fileStats.dev}:${fileStats.ino}` : null;
		},
		async readBackupFile(filePath) {
			const filesystemPath = toFilesystemPath(vaultPath, filePath);
			const fileStats = await statIfExists(filesystemPath);
			if (!fileStats) return null;
			return {
				path: filePath,
				content: await readFile(filesystemPath, 'utf8'),
				ctime: fileStats.ctimeMs,
				mtime: fileStats.mtimeMs,
			};
		},
		async writeBackup(fileName, manifest) {
			const backupDirectory = path.join(
				vaultPath,
				'.obsidian',
				'plugins',
				'index-plugin',
				'migration-backups',
			);
			await mkdir(backupDirectory, { recursive: true });
			const backupPath = path.join(backupDirectory, fileName);
			await writeFile(backupPath, manifest, 'utf8');
			return backupPath;
		},
		async renameFile(sourcePath, targetPath) {
			await rename(
				toFilesystemPath(vaultPath, sourcePath),
				toFilesystemPath(vaultPath, targetPath),
			);
		},
		async adoptFolder(action) {
			const targetPath = toFilesystemPath(vaultPath, action.targetPath);
			const folderName = path.posix.basename(action.folderPath);
			let document;
			if (action.kind === 'create') {
				document = buildNewIndexDocument(folderName, randomUUID());
			} else {
				if (action.kind === 'adopt-legacy-index') {
					await rename(toFilesystemPath(vaultPath, action.sourcePath), targetPath);
				}
				const current = await readFile(targetPath, 'utf8');
				document = setOwnershipMetadata(current, folderName, findIndexId(current));
			}
			const links = await buildChildLinks(vaultPath, action, actionByFolder);
			await writeFile(targetPath, replaceManagedBlock(document, links), {
				encoding: 'utf8',
				flag: action.kind === 'create' ? 'wx' : 'w',
			});
		},
		async trashEmptyFile(filePath) {
			const sourcePath = toFilesystemPath(vaultPath, filePath);
			const fileStats = await statIfExists(sourcePath);
			if (!fileStats || fileStats.size !== 0) return false;
			const trashPath = path.join(trashRoot, ...filePath.split('/'));
			await mkdir(path.dirname(trashPath), { recursive: true });
			await rename(sourcePath, trashPath);
			return true;
		},
	};
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const rootPath = toFilesystemPath(options.vault, options.root);
	const entries = [];
	await collectEntries(options.vault, rootPath, entries);
	const rootSidecarPath = `${options.root}.md`;
	try {
		const rootSidecarStats = await stat(
			toFilesystemPath(options.vault, rootSidecarPath),
		);
		if (rootSidecarStats.isFile()) {
			entries.push({
				path: rootSidecarPath,
				kind: 'file',
				size: rootSidecarStats.size,
			});
		}
	} catch {
		// Root sidecars are optional.
	}
	const plan = buildMigrationPlan(options.root, options.maxDepth, entries);
	const preview = {
		root: plan.rootPath,
		maxDepth: plan.maxDepth,
		folders: plan.actions.length,
		actions: countMigrationActions(plan),
		duplicates: plan.duplicates,
		blockers: plan.blockers,
		excludedFolders: plan.excludedFolderCount,
	};
	if (!options.apply) {
		console.log(JSON.stringify(preview, null, 2));
		return;
	}
	const result = await applyMigrationPlan(
		plan,
		createFilesystemHost(options.vault, plan),
		{ trashEmptyDuplicates: options.trashEmptyDuplicates },
	);
	console.log(JSON.stringify({ preview, result }, null, 2));
}

await main();
