import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildMigrationPlan,
	countMigrationActions,
	getMigrationDepth,
} from '../src/migration-plan.ts';

void test('calculates descendant depth without matching sibling prefixes', () => {
	assert.equal(getMigrationDepth('logs', 'logs'), 0);
	assert.equal(getMigrationDepth('logs', 'logs/2026/August'), 2);
	assert.equal(getMigrationDepth('logs', 'logs-archive/2026'), null);
});

void test('plans adoption, legacy migration, sidecar folding, and creation', () => {
	const plan = buildMigrationPlan('logs', 3, [
		{ path: 'logs', kind: 'folder' },
		{ path: 'logs/index.md', kind: 'file', size: 69 },
		{ path: 'logs/2026', kind: 'folder' },
		{ path: 'logs/2026/August', kind: 'folder' },
		{ path: 'logs/2026/August/21.08', kind: 'folder' },
		{ path: 'logs/2026/August/21.08/21.08.md', kind: 'file', size: 120 },
		{ path: 'logs/2026/July', kind: 'folder' },
		{ path: 'logs/2026/July.md', kind: 'file', size: 80 },
		{ path: 'logs/2026/June', kind: 'folder' },
		{ path: 'logs/2026/June/28.06', kind: 'folder' },
		{ path: 'logs/2026/June/28.06/keybox', kind: 'folder' },
	]);

	assert.deepEqual(countMigrationActions(plan), {
		'adopt-same-name': 1,
		'adopt-legacy-index': 1,
		'move-sidecar-and-adopt': 1,
		create: 4,
	});
	assert.equal(plan.excludedFolderCount, 1);
	assert.deepEqual(
		plan.actions.find((action) => action.folderPath === 'logs/2026/July'),
		{
			folderPath: 'logs/2026/July',
			depth: 2,
			kind: 'move-sidecar-and-adopt',
			sourcePath: 'logs/2026/July.md',
			targetPath: 'logs/2026/July/July.md',
		},
	);
});

void test('reports duplicate sidecars without deleting them', () => {
	const plan = buildMigrationPlan('logs', 3, [
		{ path: 'logs', kind: 'folder' },
		{ path: 'logs/logs.md', kind: 'file' },
		{ path: 'logs/2026', kind: 'folder' },
		{ path: 'logs/2026/April', kind: 'folder' },
		{ path: 'logs/2026/April/19.04', kind: 'folder' },
		{ path: 'logs/2026/April/19.04.md', kind: 'file', size: 0 },
		{ path: 'logs/2026/April/19.04/19.04.md', kind: 'file', size: 125 },
	]);

	assert.deepEqual(plan.duplicates, [
		{
			folderPath: 'logs/2026/April/19.04',
			path: 'logs/2026/April/19.04.md',
			size: 0,
			reason: 'sidecar',
		},
	]);
});

void test('adopts a same-name note with mismatched casing', () => {
	const plan = buildMigrationPlan('stuff', 1, [
		{ path: 'stuff', kind: 'folder' },
		{ path: 'stuff/react', kind: 'folder' },
		{ path: 'stuff/react/React.md', kind: 'file', size: 120 },
	]);

	assert.deepEqual(
		plan.actions.find((action) => action.folderPath === 'stuff/react'),
		{
			folderPath: 'stuff/react',
			depth: 1,
			kind: 'adopt-same-name',
			sourcePath: 'stuff/react/React.md',
			targetPath: 'stuff/react/react.md',
		},
	);
});

void test('blocks paths that cannot become Markdown folder notes', () => {
	const plan = buildMigrationPlan('logs', 1, [
		{ path: 'logs', kind: 'folder' },
		{ path: 'logs/logs.md', kind: 'folder' },
	]);

	assert.equal(plan.actions.length, 1);
	assert.deepEqual(plan.blockers, [
		{
			folderPath: 'logs',
			path: 'logs/logs.md',
			reason: 'The required folder-note path is a folder.',
		},
	]);
});
