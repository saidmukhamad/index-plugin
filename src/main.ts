import { Notice, Plugin } from 'obsidian';

export default class IndexPlugin extends Plugin {
	onload(): void {
		this.addRibbonIcon('list-tree', 'Index plugin', () => {
			new Notice('Index plugin is ready for development.');
		});

		this.addCommand({
			id: 'show-status',
			name: 'Show status',
			callback: () => {
				new Notice('Index plugin is ready for development.');
			},
		});
	}
}
