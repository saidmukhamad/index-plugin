import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { removeRedundantDailyLinks } from '../src/daily-links.ts';

function parseArguments(argv) {
	const options = { apply: false, root: '', vault: '' };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--apply') options.apply = true;
		else if (argument === '--vault') options.vault = argv[++index] ?? '';
		else if (argument === '--root') options.root = argv[++index] ?? '';
		else throw new Error(`Unknown argument: ${argument}`);
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
	return options;
}

function toFilesystemPath(vaultPath, vaultRelativePath) {
	const resolved = path.resolve(vaultPath, ...vaultRelativePath.split('/'));
	const prefix = `${path.resolve(vaultPath)}${path.sep}`;
	if (resolved !== path.resolve(vaultPath) && !resolved.startsWith(prefix)) {
		throw new Error(`Path escapes the vault: ${vaultRelativePath}`);
	}
	return resolved;
}

async function collectDailyNotes(vaultPath, directoryPath, notes) {
	for (const item of await readdir(directoryPath, { withFileTypes: true })) {
		if (!item.isDirectory() || item.name.startsWith('.')) continue;
		const itemPath = path.join(directoryPath, item.name);
		if (/^\d{2}\.\d{2}$/.test(item.name)) {
			const folderPath = path.relative(vaultPath, itemPath).split(path.sep).join('/');
			const notePath = path.join(itemPath, `${item.name}.md`);
			try {
				const document = await readFile(notePath, 'utf8');
				const result = removeRedundantDailyLinks(document, folderPath);
				if (result.removedLinkCount > 0) {
					notes.push({
						folderPath,
						notePath,
						vaultPath: `${folderPath}/${item.name}.md`,
						document,
						updatedDocument: result.document,
						removedLinkCount: result.removedLinkCount,
					});
				}
			} catch {
				// A date folder without its same-name Markdown note is not a cleanup target.
			}
		}
		await collectDailyNotes(vaultPath, itemPath, notes);
	}
}

async function writeBackup(vaultPath, rootPath, notes) {
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
		`${timestamp}-${rootPath.replace(/\//g, '-')}-daily-links.json`,
	);
	await writeFile(
		backupPath,
		JSON.stringify(
			{
				version: 1,
				createdAt: new Date().toISOString(),
				rootPath,
				files: notes.map((note) => ({
					path: note.vaultPath,
					content: note.document,
				})),
			},
			null,
			2,
		),
		'utf8',
	);
	return backupPath;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const rootPath = toFilesystemPath(options.vault, options.root);
	const notes = [];
	await collectDailyNotes(options.vault, rootPath, notes);
	const preview = {
		root: options.root,
		notes: notes.length,
		links: notes.reduce((total, note) => total + note.removedLinkCount, 0),
	};
	if (!options.apply) {
		console.log(JSON.stringify(preview, null, 2));
		return;
	}
	const backupPath = await writeBackup(options.vault, options.root, notes);
	for (const note of notes) {
		await writeFile(note.notePath, note.updatedDocument, 'utf8');
	}
	console.log(JSON.stringify({ preview, backupPath }, null, 2));
}

await main();
