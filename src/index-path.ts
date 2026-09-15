export function getFolderIndexFilename(folderName: string): string {
	return `${folderName}.md`;
}

export function getFolderIndexPath(folderPath: string, folderName: string): string {
	const filename = getFolderIndexFilename(folderName);
	return folderPath ? `${folderPath}/${filename}` : filename;
}

/** Custom Attachment Location uses this intermediate name for case-only renames. */
export function isTemporaryFolderIndex(filename: string, folderName: string): boolean {
	return filename.toLowerCase() === `__temp__${getFolderIndexFilename(folderName)}`.toLowerCase();
}
