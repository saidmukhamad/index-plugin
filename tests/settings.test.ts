import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_SETTINGS,
	getManagedRootRule,
	loadIndexPluginSettings,
	shouldAutoAdoptFolder,
	shouldAutoIndexFolder,
	upsertManagedRoot,
} from '../src/settings.ts';

void test('keeps global new-folder indexing until managed roots are configured', () => {
	assert.equal(shouldAutoIndexFolder(DEFAULT_SETTINGS, 'projects/new'), true);
});

void test('scopes automatic indexing and adoption by root depth', () => {
	const settings = upsertManagedRoot(DEFAULT_SETTINGS, {
		path: 'logs',
		maxDepth: 3,
		autoAdopt: true,
	});

	assert.equal(shouldAutoIndexFolder(settings, 'logs/2026/August/21.08'), true);
	assert.equal(shouldAutoAdoptFolder(settings, 'logs/2026/August/21.08'), true);
	assert.equal(
		shouldAutoIndexFolder(settings, 'logs/2026/August/21.08/project'),
		false,
	);
	assert.equal(shouldAutoIndexFolder(settings, 'projects/new'), false);
	assert.equal(getManagedRootRule(settings, 'logs-archive/2026'), null);
});

void test('normalizes loaded settings and rejects invalid roots', () => {
	assert.deepEqual(
		loadIndexPluginSettings({
			autoIndexNewFolders: false,
			managedRoots: [
				{ path: '/logs/', maxDepth: 99, autoAdopt: true },
				{ path: '', maxDepth: 2 },
			],
		}),
		{
			autoIndexNewFolders: false,
			managedRoots: [{ path: 'logs', maxDepth: 32, autoAdopt: true }],
		},
	);
});
