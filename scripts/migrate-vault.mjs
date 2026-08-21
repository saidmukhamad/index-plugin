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
	buildNewIndexDocument,
	replaceManagedBlock,
} from '../src/index-document.ts';
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

function setOwnershipMetadata(document, folderName, indexId) {
	const eol = document.includes('\r\n') ? '\r\n' : '\n';
	const metadata = [
		'index-plugin: folder-index',
		`index-plugin-id: ${indexId}`,
		`index-plugin-folder-name: ${JSON.stringify(folderName)}`,
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
		.filter(
			(line) =>
				!/^(?:index-plugin|index-plugin-id|index-plugin-folder-name):/.test(
					line,
				),
		);
	const updated = [...userLines, ...metadata].filter(
		(line, index, lines) => line !== '' || index !== lines.length - 1,
	);
	return `---${eol}${updated.join(eol)}${closingMarker}${document.slice(closingIndex + closingMarker.length)}`;
}

function findIndexId(document) {
	return (
		document.match(/^index-plugin-id:\s*([^\r\n]+)$/m)?.[1]?.trim() ??
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

async function writeBackupManifest(vaultPath, plan) {
	const filePaths = new Set(
		plan.actions.flatMap((action) =>
			action.sourcePath ? [action.sourcePath] : [],
		),
	);
	for (const duplicate of plan.duplicates) filePaths.add(duplicate.path);
	const files = [];
	for (const filePath of filePaths) {
		const filesystemPath = toFilesystemPath(vaultPath, filePath);
		const fileStats = await stat(filesystemPath);
		files.push({
			path: filePath,
			content: await readFile(filesystemPath, 'utf8'),
			ctime: fileStats.ctimeMs,
			mtime: fileStats.mtimeMs,
		});
	}
	const backupDirectory = path.join(
		vaultPath,
		'.obsidian',
		'plugins',
		'index-plugin',
		'migration-backups',
	);
	await mkdir(backupDirectory, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupPath = path.join(
		backupDirectory,
		`${timestamp}-${plan.rootPath.replace(/\//g, '-')}.json`,
	);
	await writeFile(
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
		'utf8',
	);
	return backupPath;
}

async function applyPlan(options, plan) {
	if (plan.blockers.length > 0) {
		throw new Error('Migration has blockers; refusing to apply.');
	}
	const backupPath = await writeBackupManifest(options.vault, plan);
	const actions = [...plan.actions].sort((left, right) =>
		left.depth === right.depth
			? left.folderPath.localeCompare(right.folderPath)
			: right.depth - left.depth,
	);

	for (const action of actions) {
		const targetPath = toFilesystemPath(options.vault, action.targetPath);
		if (
			action.kind === 'adopt-same-name' &&
			action.sourcePath !== action.targetPath
		) {
			await rename(
				toFilesystemPath(options.vault, action.sourcePath),
				targetPath,
			);
		} else if (action.kind === 'move-sidecar-and-adopt') {
			await rename(
				toFilesystemPath(options.vault, action.sourcePath),
				targetPath,
			);
		} else if (action.kind === 'adopt-legacy-index') {
			await rename(
				toFilesystemPath(options.vault, action.sourcePath),
				targetPath,
			);
		} else if (action.kind === 'create') {
			await writeFile(
				targetPath,
				buildNewIndexDocument(path.posix.basename(action.folderPath), randomUUID()),
				{ encoding: 'utf8', flag: 'wx' },
			);
		}

		if (action.kind !== 'create') {
			const document = await readFile(targetPath, 'utf8');
			const owned = setOwnershipMetadata(
				document,
				path.posix.basename(action.folderPath),
				findIndexId(document),
			);
			await writeFile(targetPath, replaceManagedBlock(owned, []), 'utf8');
		}
	}

	const actionByFolder = new Map(
		plan.actions.map((action) => [action.folderPath, action]),
	);
	for (const action of actions) {
		const targetPath = toFilesystemPath(options.vault, action.targetPath);
		const document = await readFile(targetPath, 'utf8');
		const links = await buildChildLinks(options.vault, action, actionByFolder);
		await writeFile(targetPath, replaceManagedBlock(document, links), 'utf8');
	}

	let trashedDuplicates = 0;
	if (options.trashEmptyDuplicates) {
		const trashRoot = path.join(
			options.vault,
			'.trash',
			'index-plugin-migration',
			new Date().toISOString().replace(/[:.]/g, '-'),
		);
		for (const duplicate of plan.duplicates) {
			if (duplicate.size !== 0) continue;
			const sourcePath = toFilesystemPath(options.vault, duplicate.path);
			if ((await stat(sourcePath)).size !== 0) continue;
			const trashPath = path.join(trashRoot, ...duplicate.path.split('/'));
			await mkdir(path.dirname(trashPath), { recursive: true });
			await rename(sourcePath, trashPath);
			trashedDuplicates += 1;
		}
	}

	return { backupPath, convertedFolders: actions.length, trashedDuplicates };
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
	const result = await applyPlan(options, plan);
	console.log(JSON.stringify({ preview, result }, null, 2));
}

await main();
