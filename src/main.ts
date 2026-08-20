import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
} from 'obsidian';
import { hideManagedMarkersExtension } from './editor-markers';
import { ExplorerIntegration } from './explorer-integration';
import { IndexManager } from './index-manager';
import { MigrationModal } from './migration-modal';
import { NoteNameModal } from './note-name-modal';
import {
	DEFAULT_SETTINGS,
	type IndexPluginSettings,
	loadIndexPluginSettings,
	upsertManagedRoot,
} from './settings';

export default class IndexPlugin extends Plugin {
	settings: IndexPluginSettings = structuredClone(DEFAULT_SETTINGS);
	private indexManager!: IndexManager;
	private explorerIntegration!: ExplorerIntegration;

	async onload(): Promise<void> {
		this.settings = loadIndexPluginSettings(await this.loadData());
		this.registerEditorExtension(hideManagedMarkersExtension);

		this.indexManager = new IndexManager(this, () => this.settings);
		this.indexManager.start();

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
			id: 'initialize-folder-indexes',
			name: 'Initialize indexes for all folders',
			callback: () => {
				void this.initializeAllFolders();
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFolder && !file.isRoot()) {
					menu.addItem((item) =>
						item
							.setTitle('Migrate folder tree (indexed)…')
							.setIcon('folder-tree')
							.onClick(() => {
								this.openMigration(file);
							}),
					);
					menu.addItem((item) =>
						item
							.setTitle('Convert (indexed)')
							.setIcon('folder-cog')
							.onClick(() => {
								void this.convertFolder(file);
							}),
					);
					menu.addItem((item) =>
						item
							.setTitle('Open folder index')
							.setIcon('notebook-tabs')
							.onClick(() => {
								void this.indexManager.openIndex(file, false);
							}),
					);
					menu.addItem((item) =>
						item
							.setTitle('Create new (indexed)')
							.setIcon('file-plus-2')
							.onClick(() => {
								void this.promptAndCreate(file);
							}),
					);
				} else if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) =>
						item
							.setTitle('Create new (indexed)')
							.setIcon('file-plus-2')
							.onClick(() => {
								void this.promptAndCreate(file);
							}),
					);
				}
			}),
		);
	}

	private openMigration(folder: TFolder): void {
		new MigrationModal(this.app, {
			manager: this.indexManager,
			root: folder,
			onBeforeApply: async (maxDepth) => {
				this.settings = upsertManagedRoot(this.settings, {
					path: folder.path,
					maxDepth,
					autoAdopt: true,
				});
				await this.saveData(this.settings);
			},
		}).open();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async promptAndCreate(target: TFile | TFolder): Promise<void> {
		const noteName = await NoteNameModal.prompt(this.app);
		if (!noteName) return;

		try {
			await this.indexManager.createChildNote(target, noteName);
		} catch (error) {
			console.error('Could not create an indexed note.', error);
			new Notice(error instanceof Error ? error.message : 'Could not create the note.');
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
					this.plugin.settings.autoIndexNewFolders = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(this.containerEl).setName('Managed roots').setHeading();
		if (this.plugin.settings.managedRoots.length === 0) {
			this.containerEl.createEl('p', {
				text: 'No managed roots yet. Run “migrate folder tree (indexed)…” from a folder menu to add one.',
			});
			return;
		}

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
						this.plugin.settings.managedRoots =
							this.plugin.settings.managedRoots.filter(
								(item) => item.path !== rule.path,
							);
						await this.plugin.saveSettings();
						this.display();
					});
				});
		}
	}
}
