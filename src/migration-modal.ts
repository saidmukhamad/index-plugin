import { App, Modal, Notice, Setting, TFolder } from 'obsidian';
import type { IndexManager, MigrationApplyResult } from './index-manager';
import { countMigrationActions, type MigrationPlan } from './migration-plan';

interface MigrationModalOptions {
	manager: IndexManager;
	root: TFolder;
	onBeforeApply: (maxDepth: number) => Promise<void>;
	onApplied?: (result: MigrationApplyResult) => Promise<void>;
}

export class MigrationModal extends Modal {
	private maxDepth = 3;
	private trashEmptyDuplicates = false;
	private applying = false;
	private errorMessage: string | null = null;

	constructor(
		app: App,
		private readonly options: MigrationModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		this.setTitle('Migrate folder tree (indexed)');
		this.contentEl.empty();
		this.contentEl.createEl('p', {
			text: `Previewing “${this.options.root.path}”. Existing note content is preserved, and a backup is written before any change.`,
		});
		if (this.errorMessage) {
			this.contentEl.createEl('p', {
				cls: 'index-plugin-migration-error',
				text: this.errorMessage,
			});
		}

		new Setting(this.contentEl)
			.setName('Maximum descendant depth')
			.setDesc('Depth 0 converts only this folder; depth 3 includes year, month, and day beneath logs.')
			.addDropdown((dropdown) => {
				for (let depth = 0; depth <= 6; depth += 1) {
					dropdown.addOption(String(depth), String(depth));
				}
				dropdown.setValue(String(this.maxDepth));
				dropdown.onChange((value) => {
					this.maxDepth = Number(value);
					this.render();
				});
			});

		let plan: MigrationPlan;
		try {
			plan = this.options.manager.createMigrationPlan(
				this.options.root,
				this.maxDepth,
			);
		} catch (error) {
			this.contentEl.createEl('p', {
				cls: 'index-plugin-migration-error',
				text: error instanceof Error ? error.message : 'Could not build the migration plan.',
			});
			return;
		}

		const counts = countMigrationActions(plan);
		const summary = this.contentEl.createEl('dl', {
			cls: 'index-plugin-migration-summary',
		});
		this.addSummaryRow(summary, 'Folders', String(plan.actions.length));
		this.addSummaryRow(summary, 'Adopt same-name notes', String(counts['adopt-same-name']));
		this.addSummaryRow(summary, 'Adopt legacy index.md', String(counts['adopt-legacy-index']));
		this.addSummaryRow(summary, 'Move sidecar notes', String(counts['move-sidecar-and-adopt']));
		this.addSummaryRow(summary, 'Create folder notes', String(counts.create));
		this.addSummaryRow(summary, 'Deeper folders excluded', String(plan.excludedFolderCount));

		if (plan.duplicates.length > 0) {
			const emptyDuplicates = plan.duplicates.filter(
				(duplicate) => duplicate.size === 0,
			).length;
			const nonEmptyDuplicates = plan.duplicates.length - emptyDuplicates;
			new Setting(this.contentEl)
				.setName(`Move ${emptyDuplicates} empty duplicate${emptyDuplicates === 1 ? '' : 's'} to trash`)
				.setDesc(
					nonEmptyDuplicates > 0
						? `${nonEmptyDuplicates} non-empty duplicate${nonEmptyDuplicates === 1 ? ' is' : 's are'} reported but never deleted automatically.`
						: 'Runs only after the migration succeeds. Files remain recoverable from Obsidian trash.',
				)
				.addToggle((toggle) => {
					toggle.setValue(this.trashEmptyDuplicates);
					toggle.setDisabled(emptyDuplicates === 0 || this.applying);
					toggle.onChange((value) => {
						this.trashEmptyDuplicates = value;
					});
				});
		}

		if (plan.blockers.length > 0) {
			this.contentEl.createEl('h3', { text: 'Blockers' });
			const list = this.contentEl.createEl('ul', {
				cls: 'index-plugin-migration-blockers',
			});
			for (const blocker of plan.blockers) {
				list.createEl('li', {
					text: `${blocker.path}: ${blocker.reason}`,
				});
			}
		}

		const progress = this.contentEl.createEl('p', {
			cls: 'index-plugin-migration-progress',
		});
		const actions = new Setting(this.contentEl);
		actions.addButton((button) => {
			button.setButtonText(this.applying ? 'Migrating…' : 'Back up and migrate');
			button.setCta();
			button.setDisabled(this.applying || plan.blockers.length > 0);
			button.onClick(() => {
				this.errorMessage = null;
				this.applying = true;
				button.setDisabled(true);
				button.setButtonText('Migrating…');
				void this.apply(plan, progress);
			});
		});
		actions.addButton((button) => {
			button.setButtonText('Cancel');
			button.setDisabled(this.applying);
			button.onClick(() => this.close());
		});
	}

	private addSummaryRow(container: HTMLElement, label: string, value: string): void {
		container.createEl('dt', { text: label });
		container.createEl('dd', { text: value });
	}

	private async apply(plan: MigrationPlan, progress: HTMLElement): Promise<void> {
		try {
			await this.options.onBeforeApply(this.maxDepth);
			const result = await this.options.manager.applyMigrationPlan(
				plan,
				this.trashEmptyDuplicates,
				(completed, total, folderPath) => {
					progress.setText(`${completed}/${total}: ${folderPath}`);
				},
			);
			await this.options.onApplied?.(result);
			new Notice(
				`Migrated ${result.convertedFolderCount} folders. Backup: ${result.backupPath}`,
				10_000,
			);
			this.close();
		} catch (error) {
			console.error('Could not migrate folder tree.', error);
			this.applying = false;
			this.errorMessage =
				error instanceof Error ? error.message : 'Could not migrate the folder tree.';
			this.render();
		}
	}
}
