import { App, Modal, Setting } from 'obsidian';

export interface NameModalOptions {
	title: string;
	label: string;
	description: string;
	/** Returns the validated name or throws an error whose message is shown to the user. */
	normalize: (value: string) => string;
}

export class NameModal extends Modal {
	private resolveResult: ((value: string | null) => void) | null = null;
	private submittedName: string | null = null;

	private constructor(
		app: App,
		private readonly options: NameModalOptions,
	) {
		super(app);
	}

	static prompt(app: App, options: NameModalOptions): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new NameModal(app, options);
			modal.resolveResult = resolve;
			modal.open();
		});
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		const errorEl = this.contentEl.createDiv({ cls: 'index-plugin-name-error' });
		let input: HTMLInputElement | null = null;
		const submit = (): void => {
			try {
				this.submittedName = this.options.normalize(input?.value ?? '');
				this.close();
			} catch (error) {
				errorEl.setText(error instanceof Error ? error.message : 'Invalid name.');
			}
		};

		new Setting(this.contentEl)
			.setName(this.options.label)
			.setDesc(this.options.description)
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
