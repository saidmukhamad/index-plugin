import { App, Modal, Setting } from 'obsidian';
import { normalizeFolderName } from './note-name';

export class FolderNameModal extends Modal {
	private resolveResult: ((value: string | null) => void) | null = null;
	private submittedName: string | null = null;

	static prompt(app: App): Promise<string | null> {
		let resolveResult: (value: string | null) => void = () => undefined;
		const result = new Promise<string | null>((resolve) => {
			resolveResult = resolve;
		});
		const modal = new FolderNameModal(app);
		modal.resolveResult = resolveResult;
		modal.open();
		return result;
	}

	onOpen(): void {
		this.setTitle('Create folder');
		const errorEl = this.contentEl.createDiv({ cls: 'index-plugin-name-error' });
		let input: HTMLInputElement | null = null;
		const submit = (): void => {
			try {
				this.submittedName = normalizeFolderName(input?.value ?? '');
				this.close();
			} catch (error) {
				errorEl.setText(error instanceof Error ? error.message : 'Invalid folder name.');
			}
		};

		new Setting(this.contentEl)
			.setName('Folder name')
			.setDesc('Creates a plain folder without an index note.')
			.addText((text) => {
				input = text.inputEl;
				text.setPlaceholder('Untitled').onChange(() => errorEl.empty());
				text.inputEl.addEventListener('keydown', (event) => {
					if (event.key !== 'Enter') return;
					event.preventDefault();
					submit();
				});
			})
			.addButton((button) => {
				button.setButtonText('Create').setCta().onClick(submit);
			});

		window.setTimeout(() => input?.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolveResult?.(this.submittedName);
		this.resolveResult = null;
	}
}
