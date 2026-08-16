import type { Extension, Range } from '@codemirror/state';
import {
	Decoration,
	ViewPlugin,
	type DecorationSet,
	type EditorView,
	type ViewUpdate,
} from '@codemirror/view';
import {
	CHILDREN_END,
	CHILDREN_START,
	INDEX_FOLDER_NAME_KEY,
	INDEX_ID_KEY,
	INDEX_OWNER_KEY,
	INDEX_OWNER_VALUE,
} from './index-document';

const hiddenMarkerLine = Decoration.line({
	attributes: { class: 'index-plugin-managed-marker' },
});
const hiddenMarkerText = Decoration.replace({});
const INTERNAL_FRONTMATTER_KEYS = new Set([
	INDEX_OWNER_KEY,
	INDEX_ID_KEY,
	INDEX_FOLDER_NAME_KEY,
]);

function getHiddenFrontmatterLines(view: EditorView): Set<number> {
	const hiddenLines = new Set<number>();
	const document = view.state.doc;
	if (document.lines < 3 || document.line(1).text.trim() !== '---') {
		return hiddenLines;
	}

	let closingLine = 0;
	let owned = false;
	let hasUserFrontmatter = false;
	for (let lineNumber = 2; lineNumber <= document.lines; lineNumber++) {
		const text = document.line(lineNumber).text;
		if (text.trim() === '---') {
			closingLine = lineNumber;
			break;
		}

		const key = /^([\w-]+):/.exec(text)?.[1];
		if (key && INTERNAL_FRONTMATTER_KEYS.has(key)) {
			hiddenLines.add(lineNumber);
			if (text.trim() === `${INDEX_OWNER_KEY}: ${INDEX_OWNER_VALUE}`) {
				owned = true;
			}
		} else if (text.trim()) {
			hasUserFrontmatter = true;
		}
	}

	if (!owned || closingLine === 0) return new Set<number>();
	if (!hasUserFrontmatter) {
		hiddenLines.add(1);
		hiddenLines.add(closingLine);
	}
	return hiddenLines;
}

function buildMarkerDecorations(view: EditorView): DecorationSet {
	const decorations: Range<Decoration>[] = [];
	const hiddenFrontmatterLines = getHiddenFrontmatterLines(view);
	let lastLineNumber = 0;

	for (const range of view.visibleRanges) {
		const firstLine = view.state.doc.lineAt(range.from).number;
		const lastLine = view.state.doc.lineAt(range.to).number;
		for (
			let lineNumber = Math.max(firstLine, lastLineNumber + 1);
			lineNumber <= lastLine;
			lineNumber++
		) {
			const line = view.state.doc.line(lineNumber);
			const text = line.text.trim();
			if (
				text === CHILDREN_START ||
				text === CHILDREN_END ||
				hiddenFrontmatterLines.has(lineNumber)
			) {
				decorations.push(hiddenMarkerLine.range(line.from));
				decorations.push(hiddenMarkerText.range(line.from, line.to));
			}
		}
		lastLineNumber = Math.max(lastLineNumber, lastLine);
	}

	return Decoration.set(decorations, true);
}

const markerViewPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildMarkerDecorations(view);
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = buildMarkerDecorations(update.view);
			}
		}
	},
	{
		decorations: (value) => value.decorations,
	},
);

export const hideManagedMarkersExtension: Extension = markerViewPlugin;
