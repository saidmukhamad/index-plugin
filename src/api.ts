import type { TFile } from 'obsidian';
import type { IndexManager } from './index-manager';

export interface ChildCreator {
	id: string;
	matches(folderPath: string): boolean;
	open(folderPath: string): void | Promise<void>;
}

export class ChildCreation {
	private disposed = false;
	private readonly handlers = new Map<string, ChildCreator>();
	register(handler: ChildCreator): () => void {
		if (this.disposed) throw new Error('Index Plugin is unloaded.');
		if (!handler.id || this.handlers.has(handler.id)) throw new Error(`A child creator named “${handler.id}” is already registered.`);
		const entry = {...handler};
		this.handlers.set(handler.id, entry);
		return () => { if (this.handlers.get(handler.id) === entry) this.handlers.delete(handler.id); };
	}
	async tryOpen(folderPath: string): Promise<boolean> {
		if (this.disposed) throw new Error('Index Plugin is unloaded.');
		const handlers = [...this.handlers.values()].filter(h => h.matches(folderPath));
		if (handlers.length > 1) throw new Error(`More than one creation form handles “${folderPath}”.`);
		const handler = handlers[0];
		if (!handler) return false;
		await handler.open(folderPath);
		return true;
	}
	dispose(): void { this.disposed = true; this.handlers.clear(); }
}

export interface IndexPluginApi {
	version: 1;
	folderPages: {
		get(folderPath: string): TFile | null;
		folderFor(file: TFile): string | null;
		register(file: TFile, folderPath: string): Promise<void>;
		open(folderPath: string, options?: {newLeaf?: boolean}): Promise<void>;
	};
	childCreation: Pick<ChildCreation, 'register'>;
}

export function createApi(manager: IndexManager, childCreation: ChildCreation): IndexPluginApi {
	return {
		version: 1,
		folderPages: {
			get: path => manager.resolveFolderPage(path),
			folderFor: file => manager.getRepresentedFolder(file)?.path ?? null,
			register: (file, path) => manager.folderPages.register(file, path),
			open: (path, options) => manager.openFolderPath(path, options?.newLeaf ?? false),
		},
		childCreation: {register: handler => childCreation.register(handler)},
	};
}
