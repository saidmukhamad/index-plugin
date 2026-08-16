import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFolderName, normalizeNoteName } from '../src/note-name.ts';

void test('normalizes whitespace and an optional Markdown extension', () => {
	assert.equal(normalizeNoteName('  Roadmap.md  '), 'Roadmap');
});

void test('rejects empty and path-like names', () => {
	assert.throws(() => normalizeNoteName('  '), /Enter a note name/);
	assert.throws(() => normalizeNoteName('../Roadmap'), /cannot be used/);
});

void test('normalizes and validates editable folder titles', () => {
	assert.equal(normalizeFolderName('  Projects  '), 'Projects');
	assert.throws(() => normalizeFolderName('Roadmap/2026'), /cannot be used/);
	assert.throws(() => normalizeFolderName('  '), /Enter a folder name/);
});
