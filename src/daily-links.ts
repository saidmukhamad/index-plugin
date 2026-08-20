import { CHILDREN_START } from './index-document.ts';

export interface DailyLinkCleanupResult {
	document: string;
	removedLinkCount: number;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function removeRedundantDailyLinks(
	document: string,
	folderPath: string,
): DailyLinkCleanupResult {
	const markerIndex = document.indexOf(CHILDREN_START);
	const userContent = markerIndex === -1 ? document : document.slice(0, markerIndex);
	const managedContent = markerIndex === -1 ? '' : document.slice(markerIndex);
	const eol = document.includes('\r\n') ? '\r\n' : '\n';
	const redundantLinks = new Set([
		`[[${folderPath}/work|work]]`,
		`[[${folderPath}/reading|reading]]`,
	]);
	let removedLinkCount = 0;
	const filteredLines = userContent.split(/\r?\n/).filter((line) => {
		if (!redundantLinks.has(line)) return true;
		removedLinkCount += 1;
		return false;
	});
	if (removedLinkCount === 0) return { document, removedLinkCount };

	let cleanedUserContent = filteredLines.join(eol);
	const frontmatterPattern = new RegExp(
		`^(---${escapeRegExp(eol)}[\\s\\S]*?${escapeRegExp(eol)}---)(?:${escapeRegExp(eol)}){3,}`,
	);
	cleanedUserContent = cleanedUserContent.replace(
		frontmatterPattern,
		`$1${eol}${eol}`,
	);
	return {
		document: `${cleanedUserContent}${managedContent}`,
		removedLinkCount,
	};
}
