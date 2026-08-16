import { existsSync, readFileSync } from 'node:fs';
import {
	lstat,
	mkdir,
	readFile,
	readlink,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vaultRoot = resolve(projectRoot, 'dev');
const obsidianRoot = resolve(vaultRoot, '.obsidian');
const pluginsRoot = resolve(obsidianRoot, 'plugins');
const distRoot = resolve(projectRoot, 'dist');
const pluginLink = resolve(pluginsRoot, 'index-plugin');
const hotReloadRoot = resolve(pluginsRoot, 'hot-reload');

await mkdir(pluginsRoot, { recursive: true });
await mkdir(distRoot, { recursive: true });

try {
	const current = await lstat(pluginLink);
	if (!current.isSymbolicLink()) {
		throw new Error(`${pluginLink} exists but is not a symbolic link.`);
	}
	const currentTarget = resolve(dirname(pluginLink), await readlink(pluginLink));
	if (currentTarget !== distRoot) {
		throw new Error(`${pluginLink} points to ${currentTarget}, not ${distRoot}.`);
	}
} catch (error) {
	if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
		await symlink(relative(pluginsRoot, distRoot), pluginLink, 'dir');
	} else {
		throw error;
	}
}

if (!existsSync(hotReloadRoot)) {
	const result = spawnSync(
		'git',
		[
			'clone',
			'--depth',
			'1',
			'https://github.com/pjeby/hot-reload.git',
			hotReloadRoot,
		],
		{ cwd: projectRoot, stdio: 'inherit' },
	);
	if (result.status !== 0) {
		throw new Error('Could not install the Hot-Reload plugin.');
	}
}

await writeFile(resolve(distRoot, '.hotreload'), '');

const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'manifest.json'), 'utf8'));
await writeFile(
	resolve(distRoot, 'manifest.json'),
	`${JSON.stringify(manifest, null, '\t')}\n`,
);

const enabledPluginsPath = resolve(obsidianRoot, 'community-plugins.json');
let enabledPlugins = [];
try {
	enabledPlugins = JSON.parse(await readFile(enabledPluginsPath, 'utf8'));
} catch (error) {
	if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
		throw error;
	}
}

for (const pluginId of ['hot-reload', manifest.id]) {
	if (!enabledPlugins.includes(pluginId)) {
		enabledPlugins.push(pluginId);
	}
}
await writeFile(enabledPluginsPath, `${JSON.stringify(enabledPlugins, null, '\t')}\n`);

const appConfigPath = resolve(obsidianRoot, 'app.json');
if (!existsSync(appConfigPath)) {
	await writeFile(appConfigPath, '{}\n');
}

console.log(`Development vault ready at ${vaultRoot}`);
