# Index Plugin

Obsidian plugin development workspace with an isolated `dev` vault and automatic plugin reloads.

## First-time setup

```bash
npm install
npm run setup
npm run dev
```

Open the `dev` directory as an Obsidian vault. If Obsidian asks, turn on community plugins. The setup script installs and enables [Hot-Reload](https://github.com/pjeby/hot-reload) and links `dist/` into the vault as `.obsidian/plugins/index-plugin`.

Keep `npm run dev` running while editing `src/**/*.ts` or `styles.css`. esbuild rebuilds the changed files and Hot-Reload reloads the plugin after the write settles.

Changes to `manifest.json` still require restarting Obsidian. Rerun `npm run setup` (or make any TypeScript change while the dev watcher runs) first so the updated manifest is copied to `dist/`.

## Commands

- `npm run dev` — build in watch mode and prepare the dev vault.
- `npm run check` — lint, type-check, and create a production build.
- `npm run build` — type-check and create minified release artifacts in `dist/`.
- `npm version patch|minor|major` — update package, manifest, and compatibility versions together.

Release assets are `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`.

## Project layout

```text
src/          TypeScript source
styles.css    Plugin styles
dist/         Generated plugin/release files
dev/          Disposable Obsidian development vault
scripts/      Local development setup
```

Do not develop against a real vault: plugin mistakes can modify or delete notes. The official [Build a plugin guide](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin) recommends a dedicated vault for this reason.
