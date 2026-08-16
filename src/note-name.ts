const INVALID_NOTE_NAME_CHARACTERS = /[\\/:*?"<>|]/;

function normalizeFileName(value: string, emptyMessage: string): string {
	const trimmed = value.trim();

	if (!trimmed) {
		throw new Error(emptyMessage);
	}
	if (trimmed === '.' || trimmed === '..') {
		throw new Error('Choose a different name.');
	}
	if (INVALID_NOTE_NAME_CHARACTERS.test(trimmed)) {
		throw new Error('The name contains a character that cannot be used.');
	}

	return trimmed;
}

export function normalizeNoteName(value: string): string {
	return normalizeFileName(
		value.trim().replace(/\.md$/i, '').trim(),
		'Enter a note name.',
	);
}

export function normalizeFolderName(value: string): string {
	return normalizeFileName(value, 'Enter a folder name.');
}
