export interface ManagedRootRule {
	path: string;
	maxDepth: number;
	autoAdopt: boolean;
}

export interface IndexPluginSettings {
	autoIndexNewFolders: boolean;
	managedRoots: ManagedRootRule[];
	plainFolders: string[];
}

export const DEFAULT_SETTINGS: IndexPluginSettings = {
	autoIndexNewFolders: true,
	managedRoots: [],
	plainFolders: [],
};

function normalizePath(path: string): string {
	return path.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

function normalizeRule(value: unknown): ManagedRootRule | null {
	if (!value || typeof value !== 'object') return null;
	const rule = value as Partial<ManagedRootRule>;
	if (typeof rule.path !== 'string') return null;
	const path = normalizePath(rule.path);
	if (!path) return null;
	const maxDepth =
		typeof rule.maxDepth === 'number' && Number.isFinite(rule.maxDepth)
			? Math.max(0, Math.min(32, Math.floor(rule.maxDepth)))
			: 3;
	return {
		path,
		maxDepth,
		autoAdopt: rule.autoAdopt === true,
	};
}

export function loadIndexPluginSettings(data: unknown): IndexPluginSettings {
	if (!data || typeof data !== 'object') return structuredClone(DEFAULT_SETTINGS);
	const raw = data as Partial<IndexPluginSettings>;
	const rules = Array.isArray(raw.managedRoots)
		? raw.managedRoots
				.map(normalizeRule)
				.filter((rule): rule is ManagedRootRule => rule !== null)
		: [];
	const uniqueRules = new Map(rules.map((rule) => [rule.path, rule]));
	const plainFolders = Array.isArray(raw.plainFolders)
		? raw.plainFolders
				.filter((path): path is string => typeof path === 'string')
				.map(normalizePath)
				.filter(Boolean)
		: [];
	return {
		autoIndexNewFolders: raw.autoIndexNewFolders !== false,
		managedRoots: [...uniqueRules.values()],
		plainFolders: [...new Set(plainFolders)],
	};
}

export function isPlainFolder(
	settings: IndexPluginSettings,
	folderPath: string,
): boolean {
	return settings.plainFolders.includes(normalizePath(folderPath));
}

export function upsertManagedRoot(
	settings: IndexPluginSettings,
	rule: ManagedRootRule,
): IndexPluginSettings {
	const normalized = normalizeRule(rule);
	if (!normalized) return settings;
	return {
		...settings,
		managedRoots: [
			...settings.managedRoots.filter((item) => item.path !== normalized.path),
			normalized,
		],
	};
}

export function getManagedRootRule(
	settings: IndexPluginSettings,
	folderPath: string,
): ManagedRootRule | null {
	const path = normalizePath(folderPath);
	const matches = settings.managedRoots.filter((rule) => {
		if (path === rule.path) return true;
		if (!path.startsWith(`${rule.path}/`)) return false;
		const depth = path.slice(rule.path.length + 1).split('/').length;
		return depth <= rule.maxDepth;
	});
	return (
		matches.sort((left, right) => right.path.length - left.path.length)[0] ?? null
	);
}

export function shouldAutoIndexFolder(
	settings: IndexPluginSettings,
	folderPath: string,
): boolean {
	if (isPlainFolder(settings, folderPath)) return false;
	if (!settings.autoIndexNewFolders) return false;
	if (settings.managedRoots.length === 0) return true;
	return getManagedRootRule(settings, folderPath) !== null;
}

export function shouldAutoAdoptFolder(
	settings: IndexPluginSettings,
	folderPath: string,
): boolean {
	if (isPlainFolder(settings, folderPath)) return false;
	return getManagedRootRule(settings, folderPath)?.autoAdopt === true;
}
