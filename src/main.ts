import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
} from 'obsidian';
import { ChildCreation, createApi, type IndexPluginApi } from './api';
import { hideManagedMarkersExtension } from './editor-markers';
import { ExplorerIntegration } from './explorer-integration';
import { IndexManager } from './index-manager';
import { MigrationModal } from './migration/modal';
import { NameModal } from './name-modal';
import { normalizeFolderName, normalizeNoteName } from './note-name';
import {
	DEFAULT_SETTINGS,
	type IndexPluginSettings,
	loadIndexPluginSettings,
	upsertManagedRoot,
} from './settings';

export default class IndexPlugin extends Plugin {
	settings: IndexPluginSettings = structuredClone(DEFAULT_SETTINGS);
	api!: IndexPluginApi;
	private readonly childCreation = new ChildCreation();
	private indexManager!: IndexManager;
	private explorerIntegration!: ExplorerIntegration;

	async onload(): Promise<void> {
		this.settings = loadIndexPluginSettings(await this.loadData());
		this.registerEditorExtension(hideManagedMarkersExtension);

		this.indexManager = new IndexManager(
			this,
			() => this.settings,
			(update) => this.updateSettings(update),
		);
		this.api = createApi(this.indexManager, this.childCreation);
		this.register(() => this.childCreation.dispose());
		this.indexManager.start();
		this.app.workspace.trigger('index-plugin:api-ready', this.api);

		this.explorerIntegration = new ExplorerIntegration(this, this.indexManager);
		this.explorerIntegration.start();
		this.addSettingTab(new IndexPluginSettingTab(this.app, this));

		this.addRibbonIcon('file-plus-2', 'Create new (indexed)', () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || file.extension !== 'md') {
				new Notice('Open a Markdown note before creating an indexed child.');
				return;
			}
			void this.promptAndCreate(file);
		});
		this.addRibbonIcon('folder-plus', 'Create folder', () => {
			const file = this.app.workspace.getActiveFile();
			if (!file) {
				new Notice('Open a note before creating a folder here.');
				return;
			}
			void this.promptAndCreateFolder(file);
		});

		this.addCommand({
			id: 'create-new-indexed',
			name: 'Create new (indexed)',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const available = file instanceof TFile && file.extension === 'md';
				if (available && !checking) void this.promptAndCreate(file);
				return available;
			},
		});

		this.addCommand({
			id: 'create-folder',
			name: 'Create folder',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const available = file instanceof TFile;
				if (available && !checking) void this.promptAndCreateFolder(file);
				return available;
			},
		});

		this.addCommand({
			id: 'initialize-folder-indexes',
			name: 'Initialize indexes for all folders',
			callback: () => {
				void this.initializeAllFolders();
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				const add = (title: string, icon: string, action: () => void): void => {
					menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(action));
				};
				if (file instanceof TFolder) {
					if (!file.isRoot()) {
						add('Migrate folder tree (indexed)…', 'folder-tree', () => this.openMigration(file));
						add('Convert (indexed)', 'folder-cog', () => void this.convertFolder(file));
						add('Open folder index', 'notebook-tabs', () => void this.indexManager.openIndex(file, false));
						add('Create new (indexed)', 'file-plus-2', () => void this.promptAndCreate(file));
					}
					add('Create folder', 'folder-plus', () => void this.promptAndCreateFolder(file));
				} else if (file instanceof TFile && file.extension === 'md') {
					add('Create new (indexed)', 'file-plus-2', () => void this.promptAndCreate(file));
					add('Create folder', 'folder-plus', () => void this.promptAndCreateFolder(file));
				}
			}),
		);
	}

	private openMigration(folder: TFolder): void {
		new MigrationModal(this.app, {
			manager: this.indexManager,
			root: folder,
			onBeforeApply: (maxDepth) =>
				this.updateSettings((settings) =>
					upsertManagedRoot(settings, {
						path: folder.path,
						maxDepth,
						autoAdopt: true,
					}),
				),
		}).open();
	}

	async updateSettings(
		update: (settings: IndexPluginSettings) => IndexPluginSettings,
	): Promise<void> {
		const next = update(this.settings);
		if (next === this.settings) return;
		this.settings = next;
		await this.saveData(this.settings);
	}

	private async promptAndCreate(target: TFile | TFolder): Promise<void> {
		try {
			const folder = await this.indexManager.prepareTargetFolder(target);
			if (folder && await this.childCreation.tryOpen(folder.path)) return;
			if (folder && await this.indexManager.folderPages.discover(folder)) throw new Error('The creation form for this topic is unavailable. Reload the learning input automation.');
		} catch (error) {
			new Notice(error instanceof Error ? error.message : 'Could not open the creation form.');
			return;
		}
		const noteName = await NameModal.prompt(this.app, {
			title: 'Create new (indexed)',
			label: 'Note name',
			description: 'Creates a child note and links it from the folder index.',
			normalize: normalizeNoteName,
		});
		if (!noteName) return;

		try {
			await this.indexManager.createChildNote(target, noteName);
		} catch (error) {
			console.error('Could not create an indexed note.', error);
			new Notice(error instanceof Error ? error.message : 'Could not create the note.');
		}
	}

	private async promptAndCreateFolder(target: TFile | TFolder): Promise<void> {
		const folderName = await NameModal.prompt(this.app, {
			title: 'Create folder',
			label: 'Folder name',
			description: 'Creates a plain folder without an index note.',
			normalize: normalizeFolderName,
		});
		if (!folderName) return;

		try {
			await this.indexManager.createPlainFolder(target, folderName);
		} catch (error) {
			console.error('Could not create a plain folder.', error);
			new Notice(error instanceof Error ? error.message : 'Could not create the folder.');
		}
	}

	private async initializeAllFolders(): Promise<void> {
		try {
			const initialized = await this.indexManager.initializeAllFolders();
			new Notice(
				`Initialized ${initialized} folder ${initialized === 1 ? 'index' : 'indexes'}.`,
			);
		} catch (error) {
			console.error('Could not initialize folder indexes.', error);
			new Notice('Could not initialize folder indexes. Check the developer console.');
		}
	}

	private async convertFolder(folder: TFolder): Promise<void> {
		try {
			const index = await this.indexManager.convertFolder(folder);
			await this.app.workspace.getLeaf(false).openFile(index);
		} catch (error) {
			console.error(`Could not convert ${folder.path}.`, error);
			new Notice(error instanceof Error ? error.message : 'Could not convert the folder.');
		}
	}
}

class IndexPluginSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: IndexPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();

		new Setting(this.containerEl)
			.setName('Automatically index new folders')
			.setDesc(
				this.plugin.settings.managedRoots.length === 0
					? 'Applies across the vault until a managed root is configured.'
					: 'Applies only inside the configured managed roots and depth limits.',
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoIndexNewFolders);
				toggle.onChange(async (value) => {
					await this.plugin.updateSettings((settings) => ({
						...settings,
						autoIndexNewFolders: value,
					}));
				});
			});

		new Setting(this.containerEl).setName('Managed roots').setHeading();
		if (this.plugin.settings.managedRoots.length === 0) {
			this.containerEl.createEl('p', {
				text: 'No managed roots yet. Run “migrate folder tree (indexed)…” from a folder menu to add one.',
			});
		} else {
			for (const rule of this.plugin.settings.managedRoots) {
				new Setting(this.containerEl)
					.setName(rule.path)
					.setDesc(
						`Depth ${rule.maxDepth}; ${rule.autoAdopt ? 'automatically adopts' : 'does not adopt'} same-name notes.`,
					)
					.addButton((button) => {
						button.setButtonText('Remove');
						button.setWarning();
						button.onClick(async () => {
							await this.plugin.updateSettings((settings) => ({
								...settings,
								managedRoots: settings.managedRoots.filter(
									(item) => item.path !== rule.path,
								),
							}));
							this.display();
						});
					});
			}
		}

		new Setting(this.containerEl).setName('Plain folders').setHeading();
		if (this.plugin.settings.plainFolders.length === 0) {
			this.containerEl.createEl('p', {
				text: 'Folders explicitly created without an index appear here.',
			});
		} else {
			for (const path of this.plugin.settings.plainFolders) {
				new Setting(this.containerEl)
					.setName(path)
					.setDesc('Clicking this folder expands it without creating a folder note.')
					.addButton((button) => {
						button.setButtonText('Allow indexing');
						button.onClick(async () => {
							await this.plugin.updateSettings((settings) => ({
								...settings,
								plainFolders: settings.plainFolders.filter(
									(item) => item !== path,
								),
							}));
							this.display();
						});
					});
			}
		}
	}
}
