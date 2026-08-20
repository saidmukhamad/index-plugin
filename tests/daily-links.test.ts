import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CHILDREN_END,
	CHILDREN_START,
} from '../src/index-document.ts';
import { removeRedundantDailyLinks } from '../src/daily-links.ts';

void test('removes template links without touching the managed Pages links', () => {
	const folder = 'logs/2026/April/22.04';
	const document = [
		'---',
		'index-plugin: folder-index',
		'---',
		`[[${folder}/work|work]]`,
		`[[${folder}/reading|reading]]`,
		'',
		'Journal prose.',
		'',
		CHILDREN_START,
		'> [!index-pages] Pages',
		'>',
		`> - [[${folder}/reading|reading]]`,
		`> - [[${folder}/work|work]]`,
		CHILDREN_END,
		'',
	].join('\n');

	const result = removeRedundantDailyLinks(document, folder);

	assert.equal(result.removedLinkCount, 2);
	assert.doesNotMatch(result.document, new RegExp(`^\\[\\[${folder}/`, 'm'));
	assert.match(result.document, /> - \[\[logs\/2026\/April\/22\.04\/work\|work\]\]/);
	assert.match(result.document, /Journal prose\./);
});

void test('removes a single leftover template link', () => {
	const folder = 'logs/2026/August/12.08';
	const document = [
		'---',
		'index-plugin: folder-index',
		'---',
		'',
		`[[${folder}/reading|reading]]`,
		'',
		'',
		'----',
		'Riemann zeta',
		CHILDREN_START,
		'> [!index-pages] Pages',
		CHILDREN_END,
	].join('\n');

	const result = removeRedundantDailyLinks(document, folder);

	assert.equal(result.removedLinkCount, 1);
	assert.match(result.document, /^---\n[\s\S]*?---\n\n----\nRiemann zeta/m);
});

void test('leaves documents without exact bare template links unchanged', () => {
	const document = 'A [[work]] reference inside prose.\n';
	assert.deepEqual(removeRedundantDailyLinks(document, 'logs/2026/May/01.05'), {
		document,
		removedLinkCount: 0,
	});
});
