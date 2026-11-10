import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CHILDREN_END,
	CHILDREN_START,
	EMPTY_CHILDREN_MESSAGE,
	InvalidManagedBlockError,
	PAGES_CALLOUT,
	buildManagedBlock,
	buildNewIndexDocument,
	getManagedBlockRange,
	removeManagedBlock,
	replaceManagedBlock,
} from '../src/index-document.ts';

void test('adopts an existing index without changing its frontmatter or prose', () => {
	const original = [
		'---',
		'status: active',
		'tags:',
		'  - project',
		'---',
		'# Existing project',
		'',
		'Human-written prose.',
		'',
	].join('\n');
	const result = replaceManagedBlock(original, ['- [[Plan]]']);

	assert.equal(
		result,
		`${original}\n${CHILDREN_START}\n${PAGES_CALLOUT}\n>\n> - [[Plan]]\n${CHILDREN_END}\n`,
	);
});

void test('replaces only the existing managed block', () => {
	const original = `Before\n${CHILDREN_START}\n${PAGES_CALLOUT}\n>\n> - [[Old]]\n${CHILDREN_END}\nAfter\n`;
	const result = replaceManagedBlock(original, ['- [[New]]']);

	assert.equal(
		result,
		`Before\n${CHILDREN_START}\n${PAGES_CALLOUT}\n>\n> - [[New]]\n${CHILDREN_END}\nAfter\n`,
	);
});

void test('formats an empty index as a readable section', () => {
	const result = replaceManagedBlock('', []);

	assert.equal(
		result,
		`${CHILDREN_START}\n${PAGES_CALLOUT}\n>\n> ${EMPTY_CHILDREN_MESSAGE}\n${CHILDREN_END}\n`,
	);
});

void test('upgrades legacy Pages to a folded section without touching the journal', () => {
	const journal = '# Daily note\n\nMy writing stays here.\n\n';
	const legacy = `${journal}${CHILDREN_START}\n> [!index-pages] Pages\n>\n> - [[Old]]\n${CHILDREN_END}\nAfter the index.\n`;
	const result = replaceManagedBlock(legacy, ['- [[New]]']);
	assert.ok(result.startsWith(journal));
	assert.ok(result.endsWith('\nAfter the index.\n'));
	assert.ok(result.includes('> [!index-pages]- pages'));
	assert.equal(replaceManagedBlock(result, ['- [[New]]']), result);
});

void test('keeps pages directly after activity on creation and later refreshes', () => {
	const activity = '> [!activity]- activity\n> ![[Daily activity.base]]\n';
	const result = replaceManagedBlock(`${activity}\n\n`, []);
	assert.ok(result.startsWith(`${activity}${CHILDREN_START}\n`));
	assert.equal(replaceManagedBlock(result, []), result);
	const legacy = `${activity}\n\n${buildManagedBlock([])}\n`;
	assert.equal(replaceManagedBlock(legacy, []), result);
});

void test('locates the generated section so editor selection can exclude it', () => {
	const userContent = '# Journal\n\nSomething I wrote.\n\n';
	const managedBlock = buildManagedBlock(['- [[Roadmap]]']);
	const document = `${userContent}${managedBlock}\n`;

	assert.deepEqual(getManagedBlockRange(document), [
		userContent.length,
		userContent.length + managedBlock.length,
	]);
});

void test('removes only the managed block when retiring an old generated index', () => {
	const original = `Before\n\n${CHILDREN_START}\n${PAGES_CALLOUT}\n>\n> - [[Old]]\n${CHILDREN_END}\n\nAfter\n`;

	assert.equal(removeManagedBlock(original), 'Before\n\n\n\nAfter\n');
});

void test('refuses malformed markers instead of risking user content', () => {
	assert.throws(
		() => replaceManagedBlock(`Before\n${CHILDREN_START}\n`, []),
		InvalidManagedBlockError,
	);
});

void test('creates a self-identifying folder index', () => {
	const document = buildNewIndexDocument('Projects', 'test-id');

	assert.match(document, /index-plugin: folder-index/);
	assert.match(document, /index-plugin-id: test-id/);
	assert.doesNotMatch(document, /aliases:/);
	assert.doesNotMatch(document, /# Projects/);
});
