import assert from 'node:assert/strict';
import test from 'node:test';
import {
	getFolderIndexFilename,
	getFolderIndexPath,
} from '../src/index-path.ts';

void test('names a folder note after its folder', () => {
	assert.equal(getFolderIndexFilename('Projects'), 'Projects.md');
	assert.equal(getFolderIndexPath('Projects', 'Projects'), 'Projects/Projects.md');
});

void test('keeps nested folder notes readable in links and graph view', () => {
	assert.equal(
		getFolderIndexPath('Projects/Alpha', 'Alpha'),
		'Projects/Alpha/Alpha.md',
	);
});
