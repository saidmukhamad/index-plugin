export function getFolderIndexFilename(folderName: string): string {
	return `${folderName}.md`;
}

export function getFolderIndexPath(folderPath: string, folderName: string): string {
	const filename = getFolderIndexFilename(folderName);
	return folderPath ? `${folderPath}/${filename}` : filename;
}
