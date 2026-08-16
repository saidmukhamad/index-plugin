import { Notice, Plugin, TFile, TFolder } from 'obsidian';
import { hideManagedMarkersExtension } from './editor-markers';
import { ExplorerIntegration } from './explorer-integration';
import { IndexManager } from './index-manager';
import { NoteNameModal } from './note-name-modal';

export default class IndexPlugin extends Plugin {
	private indexManager!: IndexManager;
	private explorerIntegration!: ExplorerIntegration;

	onload(): void {
		this.registerEditorExtension(hideManagedMarkersExtension);

		this.indexManager = new IndexManager(this);
		this.indexManager.start();

		this.explorerIntegration = new ExplorerIntegration(this, this.indexManager);
		this.explorerIntegration.start();

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
