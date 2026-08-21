export const INDEX_OWNER_KEY = 'index-plugin';
export const INDEX_OWNER_VALUE = 'folder-index';
export const INDEX_ID_KEY = 'index-plugin-id';
export const INDEX_FOLDER_NAME_KEY = 'index-plugin-folder-name';

export const CHILDREN_START = '<!-- index-plugin:children:start -->';
export const CHILDREN_END = '<!-- index-plugin:children:end -->';
export const PAGES_CALLOUT = '> [!index-pages] Pages';
export const EMPTY_CHILDREN_MESSAGE = '*No pages yet.*';

export class InvalidManagedBlockError extends Error {
	constructor() {
		super('The index contains incomplete or duplicate managed-block markers.');
		this.name = 'InvalidManagedBlockError';
	}
}

export function getManagedBlockRange(document: string): [number, number] | null {
	const start = document.indexOf(CHILDREN_START);
	const end = document.indexOf(CHILDREN_END);
	const hasDuplicateStart = start !== document.lastIndexOf(CHILDREN_START);
	const hasDuplicateEnd = end !== document.lastIndexOf(CHILDREN_END);

	if (
		(start === -1) !== (end === -1) ||
		hasDuplicateStart ||
		hasDuplicateEnd ||
		(start !== -1 && end < start)
	) {
		throw new InvalidManagedBlockError();
	}

	return start === -1 ? null : [start, end + CHILDREN_END.length];
}

export function buildManagedBlock(entries: readonly string[]): string {
	return [
		CHILDREN_START,
		PAGES_CALLOUT,
		'>',
		...(entries.length > 0
			? entries.map((entry) => `> ${entry}`)
			: [`> ${EMPTY_CHILDREN_MESSAGE}`]),
		CHILDREN_END,
	].join('\n');
}

export function replaceManagedBlock(
	document: string,
	entries: readonly string[],
): string {
	const range = getManagedBlockRange(document);
	const block = buildManagedBlock(entries);
	if (!range) {
		const existing = document.trimEnd();
		return `${existing}${existing ? '\n\n' : ''}${block}\n`;
	}

	return `${document.slice(0, range[0])}${block}${document.slice(range[1])}`;
}

export function removeManagedBlock(document: string): string {
	const range = getManagedBlockRange(document);
	if (!range) return document;
	return `${document.slice(0, range[0])}${document.slice(range[1])}`;
}

export function buildNewIndexDocument(
	folderName: string,
	indexId: string,
): string {
	const yamlFolderName = JSON.stringify(folderName);
	return [
		'---',
		`${INDEX_OWNER_KEY}: ${INDEX_OWNER_VALUE}`,
		`${INDEX_ID_KEY}: ${indexId}`,
		`${INDEX_FOLDER_NAME_KEY}: ${yamlFolderName}`,
		'---',
		buildManagedBlock([]),
		'',
	].join('\n');
}
