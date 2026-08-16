import {
	Keymap,
	MarkdownView,
	Notice,
	Plugin,
	TFolder,
} from 'obsidian';
import {
	INDEX_FOLDER_NAME_KEY,
	INDEX_ID_KEY,
	INDEX_OWNER_KEY,
} from './index-document';
import type { IndexManager } from './index-manager';

const OWNED_INDEX_CLASS = 'index-plugin-owned-index';
const INDEXED_FOLDER_CLASS = 'index-plugin-indexed-folder';
const INDEX_VIEW_CLASS = 'index-plugin-index-view';
const HIDE_PROPERTIES_CLASS = 'index-plugin-hide-properties';
const MANAGED_ALIAS_CLASS = 'index-plugin-managed-alias';
const INTERNAL_PROPERTIES_CONTAINER_CLASS =
	'index-plugin-internal-properties-container';
const INTERNAL_PROPERTIES_STATUS_CLASS = 'index-plugin-internal-properties-status';
const INTERNAL_PROPERTY_KEYS = new Set([
	INDEX_OWNER_KEY,
	INDEX_ID_KEY,
	INDEX_FOLDER_NAME_KEY,
	'position',
]);

export class ExplorerIntegration {
	private observer: MutationObserver | null = null;
	private removeIndexListener: (() => void) | null = null;

	constructor(
		private readonly plugin: Plugin,
		private readonly manager: IndexManager,
	) {}

	start(): void {
		this.plugin.app.workspace.onLayoutReady(() => {
			this.refreshExplorerClasses();
			this.refreshIndexViewClasses();
			this.observer = new MutationObserver(() => {
				this.refreshExplorerClasses();
				this.refreshIndexViewClasses();
			});
			this.observer.observe(activeDocument.body, {
				childList: true,
				subtree: true,
			});

			this.plugin.registerDomEvent(
				activeDocument,
				'click',
				(event) => this.handleFolderClick(event),
				true,
			);
			this.plugin.registerDomEvent(
				activeDocument,
				'input',
				(event) => this.handleFolderTitleInput(event),
				true,
			);
			this.plugin.registerDomEvent(
				activeDocument,
				'keydown',
				(event) => this.handleFolderTitleKeydown(event),
				true,
			);
			this.plugin.registerDomEvent(
				activeDocument,
				'blur',
				(event) => this.handleFolderTitleBlur(event),
				true,
			);
			this.plugin.registerDomEvent(
				activeDocument,
				'auxclick',
				(event) => {
					if (event.button === 1) this.handleFolderClick(event);
				},
				true,
			);
			this.plugin.registerEvent(
				this.plugin.app.workspace.on('file-open', () => {
					this.refreshIndexViewClasses();
				}),
			);
		});

		this.removeIndexListener = this.manager.onOwnedIndexesChanged(() => {
			this.refreshExplorerClasses();
			this.refreshIndexViewClasses();
		});
		this.plugin.register(() => this.dispose());
	}

	dispose(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.removeIndexListener?.();
		this.removeIndexListener = null;
		activeDocument.querySelectorAll(`.${INDEX_VIEW_CLASS}`).forEach((element) => {
			element.classList.remove(INDEX_VIEW_CLASS);
			element.classList.remove(HIDE_PROPERTIES_CLASS);
			element.classList.remove(MANAGED_ALIAS_CLASS);
			element
				.querySelectorAll<HTMLElement>(
					'.inline-title[data-index-plugin-folder-title]',
				)
				.forEach((title) => {
					title.setText(title.dataset.indexPluginOriginalTitle ?? 'index');
					delete title.dataset.indexPluginFolderTitle;
					delete title.dataset.indexPluginOriginalTitle;
					delete title.dataset.folderPath;
				});
			element
				.querySelectorAll(`.${INTERNAL_PROPERTIES_CONTAINER_CLASS}`)
				.forEach((container) =>
					container.classList.remove(INTERNAL_PROPERTIES_CONTAINER_CLASS),
				);
		});
		activeDocument
			.querySelectorAll(`.${INTERNAL_PROPERTIES_STATUS_CLASS}`)
			.forEach((element) =>
				element.classList.remove(INTERNAL_PROPERTIES_STATUS_CLASS),
			);
	}

	private refreshIndexViewClasses(): void {
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) return;
			const owned = this.manager.isOwnedIndex(view.file);
			view.containerEl.classList.toggle(INDEX_VIEW_CLASS, owned);
			if (!owned || !view.file?.parent) {
				view.containerEl.classList.remove(HIDE_PROPERTIES_CLASS);
				view.containerEl.classList.remove(MANAGED_ALIAS_CLASS);
				view.containerEl
					.querySelectorAll<HTMLElement>(
						'.inline-title[data-index-plugin-folder-title]',
					)
					.forEach((title) => {
						title.setText(title.dataset.indexPluginOriginalTitle ?? view.file?.basename ?? '');
						delete title.dataset.indexPluginFolderTitle;
						delete title.dataset.indexPluginOriginalTitle;
						delete title.dataset.folderPath;
					});
				view.containerEl
					.querySelectorAll(`.${INTERNAL_PROPERTIES_CONTAINER_CLASS}`)
					.forEach((container) =>
						container.classList.remove(INTERNAL_PROPERTIES_CONTAINER_CLASS),
					);
				return;
			}

			this.refreshFolderTitle(view, view.file.parent);
			this.refreshPropertyVisibility(view);
		});
		this.refreshPropertiesStatus();
	}

	private refreshPropertiesStatus(): void {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		const owned = this.manager.isOwnedIndex(activeFile);
		activeDocument
			.querySelectorAll(`.${INTERNAL_PROPERTIES_STATUS_CLASS}`)
			.forEach((item) => item.classList.remove(INTERNAL_PROPERTIES_STATUS_CLASS));
		if (!owned) return;

		activeDocument
			.querySelectorAll<HTMLElement>('body *')
			.forEach((item) => {
				if (/^\d+ propert(?:y|ies)$/.test(item.textContent?.trim() ?? '')) {
					item.classList.add(INTERNAL_PROPERTIES_STATUS_CLASS);
				}
			});
	}

	private refreshFolderTitle(view: MarkdownView, folder: TFolder): void {
		const inlineTitle =
			view.containerEl.querySelector<HTMLElement>('.inline-title');
		if (!inlineTitle) return;
		inlineTitle.dataset.indexPluginOriginalTitle ??= inlineTitle.textContent ?? 'index';
		inlineTitle.dataset.indexPluginFolderTitle = 'true';
		inlineTitle.dataset.folderPath = folder.path;
		inlineTitle.setAttribute('aria-label', 'Folder name');
		if (
			activeDocument.activeElement !== inlineTitle &&
			inlineTitle.textContent !== folder.name
		) {
			inlineTitle.setText(folder.name);
		}
	}

	private getFolderTitle(target: EventTarget | null): HTMLElement | null {
		if (!(target instanceof HTMLElement)) return null;
		return target.closest<HTMLElement>(
			'.inline-title[data-index-plugin-folder-title="true"]',
		);
	}

	private handleFolderTitleInput(event: Event): void {
		if (!this.getFolderTitle(event.target)) return;
		event.stopImmediatePropagation();
	}

	private handleFolderTitleKeydown(event: KeyboardEvent): void {
		const title = this.getFolderTitle(event.target);
		if (!title) return;
		event.stopImmediatePropagation();

		if (event.key === 'Enter') {
			event.preventDefault();
			title.blur();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			const currentFolder = title.dataset.folderPath
				? this.plugin.app.vault.getFolderByPath(title.dataset.folderPath)
				: null;
			if (currentFolder) title.setText(currentFolder.name);
			title.blur();
		}
	}

	private handleFolderTitleBlur(event: FocusEvent): void {
		const title = this.getFolderTitle(event.target);
		if (!title) return;
		event.stopImmediatePropagation();
		void this.commitFolderTitle(title);
	}

	private refreshPropertyVisibility(view: MarkdownView): void {
		if (!view.file?.parent) return;
		const frontmatter =
			this.plugin.app.metadataCache.getFileCache(view.file)?.frontmatter;
		const rawAliases: unknown = frontmatter?.aliases;
		const aliases = Array.isArray(rawAliases)
			? rawAliases.filter((alias): alias is string => typeof alias === 'string')
			: typeof rawAliases === 'string'
				? [rawAliases]
				: [];
		const managedAlias =
			aliases.length === 1 &&
			(aliases[0] === view.file.parent.name ||
				aliases[0] === frontmatter?.[INDEX_FOLDER_NAME_KEY]);
		view.containerEl.classList.toggle(MANAGED_ALIAS_CLASS, managedAlias);

		let hasVisibleProperties = false;
		view.containerEl
			.querySelectorAll<HTMLElement>('.metadata-container')
			.forEach((container) => {
				let visiblePropertyCount = 0;
				container
					.querySelectorAll<HTMLElement>(
						'.metadata-property[data-property-key]',
					)
					.forEach((property) => {
						const key = property.dataset.propertyKey;
						const visible =
							key !== undefined &&
							!INTERNAL_PROPERTY_KEYS.has(key) &&
							!(key === 'aliases' && managedAlias);
						if (visible) visiblePropertyCount++;
					});
				if (visiblePropertyCount > 0) hasVisibleProperties = true;
				container.classList.toggle(
					INTERNAL_PROPERTIES_CONTAINER_CLASS,
					visiblePropertyCount === 0,
				);
			});
		view.containerEl.classList.toggle(
			HIDE_PROPERTIES_CLASS,
			!hasVisibleProperties,
		);
	}

	private async commitFolderTitle(title: HTMLElement): Promise<void> {
		if (title.dataset.renaming === 'true') return;
		const folderPath = title.dataset.folderPath;
		const folder = folderPath
			? this.plugin.app.vault.getFolderByPath(folderPath)
			: null;
		if (!folder) return;

		title.dataset.renaming = 'true';
		try {
			const renamedFolder = await this.manager.renameFolder(
				folder,
				title.textContent ?? '',
			);
			title.dataset.folderPath = renamedFolder.path;
			title.setText(renamedFolder.name);
		} catch (error) {
			console.error(`Could not rename ${folder.path}.`, error);
			title.setText(folder.name);
			new Notice(error instanceof Error ? error.message : 'Could not rename the folder.');
		} finally {
			delete title.dataset.renaming;
		}
	}

	refreshExplorerClasses(): void {
		activeDocument.querySelectorAll(`.${OWNED_INDEX_CLASS}`).forEach((element) => {
			element.classList.remove(OWNED_INDEX_CLASS);
		});
		activeDocument.querySelectorAll(`.${INDEXED_FOLDER_CLASS}`).forEach((element) => {
			element.classList.remove(INDEXED_FOLDER_CLASS);
		});

		activeDocument
			.querySelectorAll<HTMLElement>('.nav-file-title[data-path]')
			.forEach((title) => {
				const path = title.dataset.path;
				if (!path || !this.manager.isOwnedIndexPath(path)) return;
				(title.closest('.nav-file') ?? title).classList.add(OWNED_INDEX_CLASS);
			});

		activeDocument
			.querySelectorAll<HTMLElement>('.nav-folder-title[data-path]')
			.forEach((title) => {
				const path = title.dataset.path;
				if (path) {
					title.classList.add(INDEXED_FOLDER_CLASS);
				}
			});
	}

	private handleFolderClick(event: MouseEvent): void {
		if (!(event.target instanceof Element)) return;
		if (!event.target.closest('.nav-folder-title-content')) return;

		const title = event.target.closest<HTMLElement>('.nav-folder-title[data-path]');
		const folderPath = title?.dataset.path;
		if (!folderPath) return;

		const folder = this.plugin.app.vault.getFolderByPath(folderPath);
		if (!(folder instanceof TFolder) || folder.isRoot()) return;

		event.preventDefault();
		event.stopImmediatePropagation();
		const newLeaf = event.button === 1 ? 'tab' : Keymap.isModEvent(event);
		void this.manager.openIndex(folder, newLeaf).catch((error: unknown) => {
			console.error(`Could not open the index for ${folder.path}.`, error);
			new Notice('Could not open the folder index. Check the developer console.');
		});
	}
}
