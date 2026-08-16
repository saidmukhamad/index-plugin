import { App, Modal, Setting } from 'obsidian';
import { normalizeNoteName } from './note-name';

export class NoteNameModal extends Modal {
	private resolveResult: ((value: string | null) => void) | null = null;
	private submittedName: string | null = null;

	static prompt(app: App): Promise<string | null> {
		let resolveResult: (value: string | null) => void = () => undefined;
		const result = new Promise<string | null>((resolve) => {
			resolveResult = resolve;
		});
		const modal = new NoteNameModal(app);
		modal.resolveResult = resolveResult;
		modal.open();
		return result;
	}

	onOpen(): void {
		this.setTitle('Create new (indexed)');
		const errorEl = this.contentEl.createDiv({ cls: 'index-plugin-name-error' });
		let input: HTMLInputElement | null = null;
		const submit = (): void => {
			try {
				this.submittedName = normalizeNoteName(input?.value ?? '');
				this.close();
			} catch (error) {
				errorEl.setText(error instanceof Error ? error.message : 'Invalid note name.');
			}
		};

		new Setting(this.contentEl)
			.setName('Note name')
			.setDesc('Creates a child note and links it from the folder index.')
			.addText((text) => {
				input = text.inputEl;
				text.setPlaceholder('Untitled').onChange(() => {
					errorEl.empty();
				});
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
