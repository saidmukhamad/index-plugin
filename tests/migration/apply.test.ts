import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrationPlan, type MigrationHost } from '../../src/migration/apply.ts';
import type { MigrationPlan } from '../../src/migration/plan.ts';

function fakeHost(files: Record<string, string>, identities: Record<string, string> = {}) {
	const calls: string[] = [];
	let manifest = '';
	const host: MigrationHost = {
		findFile: async (path) => (path in files ? (identities[path] ?? path) : null),
		readBackupFile: async (path) =>
			path in files ? { path, content: files[path]!, ctime: 1, mtime: 2 } : null,
		writeBackup: async (fileName, contents) => {
			manifest = contents;
			calls.push('backup');
			return `backups/${fileName}`;
		},
		renameFile: async (source, target) => {
			files[target] = files[source]!;
			delete files[source];
			calls.push(`rename ${source} -> ${target}`);
		},
		adoptFolder: async (action) => { calls.push(`adopt ${action.folderPath}`); },
		trashEmptyFile: async (path) => {
			calls.push(`trash ${path}`);
			return files[path] === '';
		},
	};
	return { host, calls, get manifest() { return JSON.parse(manifest) as { files: { path: string }[] }; } };
}

const plan: MigrationPlan = {
	rootPath: 'logs',
	maxDepth: 3,
	excludedFolderCount: 0,
	blockers: [],
	actions: [
		{ folderPath: 'logs', depth: 0, kind: 'create', targetPath: 'logs/logs.md' },
		{
			folderPath: 'logs/July', depth: 1, kind: 'move-sidecar-and-adopt',
			sourcePath: 'logs/July.md', targetPath: 'logs/July/July.md',
		},
		{
			folderPath: 'logs/July/react', depth: 2, kind: 'adopt-same-name',
			sourcePath: 'logs/July/react/React.md', targetPath: 'logs/July/react/react.md',
		},
	],
	duplicates: [
		{ folderPath: 'logs/July', path: 'logs/July/old.md', size: 0, reason: 'sidecar' },
		{ folderPath: 'logs/July', path: 'logs/July/kept.md', size: 12, reason: 'sidecar' },
	],
};

void test('backs up first, then moves and adopts folder notes deepest first', async () => {
	const fake = fakeHost(
		{ 'logs/July.md': 'july', 'logs/July/react/React.md': 'react', 'logs/July/old.md': '' },
		{ 'logs/July/react/react.md': 'logs/July/react/React.md' },
	);
	const progress: string[] = [];
	const result = await applyMigrationPlan(plan, fake.host, {
		trashEmptyDuplicates: true,
		onProgress: (completed, total, folderPath) => progress.push(`${completed}/${total} ${folderPath}`),
	});

	assert.deepEqual(fake.calls, [
		'backup',
		'rename logs/July/react/React.md -> logs/July/react/react.md',
		'adopt logs/July/react',
		'rename logs/July.md -> logs/July/July.md',
		'adopt logs/July',
		'adopt logs',
		'trash logs/July/old.md',
	]);
	assert.deepEqual(progress, ['1/3 logs/July/react', '2/3 logs/July', '3/3 logs']);
	assert.deepEqual(
		fake.manifest.files.map((file) => file.path),
		['logs/July.md', 'logs/July/react/React.md', 'logs/July/old.md'],
	);
	assert.equal(result.convertedFolderCount, 3);
	assert.equal(result.trashedDuplicateCount, 1);
	assert.match(result.backupPath, /^backups\/.+-logs\.json$/);
});

void test('stops before overwriting a note that appeared at the target path', async () => {
	const fake = fakeHost({
		'logs/July.md': 'july',
		'logs/July/July.md': 'someone else',
		'logs/July/react/React.md': 'react',
	});
	await assert.rejects(
		applyMigrationPlan(plan, fake.host, { trashEmptyDuplicates: false }),
		/“logs\/July\/July\.md” appeared during migration/,
	);
	assert.ok(!fake.calls.includes('adopt logs/July'));
	assert.ok(!fake.calls.includes('adopt logs'));
});

void test('refuses plans with blockers without touching the vault', async () => {
	const fake = fakeHost({});
	const blockers = [{ folderPath: 'logs', path: 'logs/logs.md', reason: 'folder' }];
	await assert.rejects(
		applyMigrationPlan({ ...plan, blockers }, fake.host, { trashEmptyDuplicates: false }),
		/Resolve migration blockers/,
	);
	assert.deepEqual(fake.calls, []);
});
