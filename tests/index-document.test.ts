import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CHILDREN_END,
	CHILDREN_START,
	EMPTY_CHILDREN_MESSAGE,
	InvalidManagedBlockError,
	PAGES_CALLOUT,
	buildNewIndexDocument,
	removeManagedBlock,
	replaceManagedBlock,
} from '../src/index-document.ts';

void test('adds a managed block without replacing user content', () => {
	const result = replaceManagedBlock('# Projects\n\nKeep me.\n', ['- [[Roadmap]]']);

	assert.equal(
		result,
		`# Projects\n\nKeep me.\n\n${CHILDREN_START}\n${PAGES_CALLOUT}\n>\n> - [[Roadmap]]\n${CHILDREN_END}\n`,
	);
});

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
