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

## Indexed folders

The plugin makes folders feel like notes while keeping ownership explicit:

- Creating a folder creates a hidden, plugin-owned note named after the folder: `Projects/Projects.md`. Nested folders follow the same rule, such as `Projects/Alpha/Alpha.md`, so tabs, links, and Graph View use meaningful names instead of `index`.
- Every owned index shows an editable folder name in Obsidian's normal inline-title position. Renaming either that title or the folder renames the other; Markdown headings remain untouched user content.
- Ownership frontmatter, its Properties panel, and its property-count status are hidden inside Obsidian; user-authored properties remain visible.
- Clicking a folder title opens its folder note; clicking the chevron still expands or collapses it. If an existing folder already has an unowned same-name note or legacy `index.md`, clicking opens it without hiding or modifying it.
- Direct child notes and indexed subfolders are maintained in a marked list inside the index.
- Only files with `index-plugin: folder-index` frontmatter are hidden. Unrelated same-name notes and `index.md` files are never hidden automatically.
- `Create new (indexed)` creates a child note. When run from a regular Markdown note, it first converts `Note.md` to `Note/Note.md`, preserving the note content.
- `Convert (indexed)` in a folder's context menu adopts a same-name note first, falls back to a legacy `index.md`, or creates the folder note. Adoption preserves all existing content and adds only the plugin-owned list block. Existing plugin-owned `index.md` files migrate to the folder-named convention automatically. If an untouched generated fallback already exists, it is moved to Obsidian's recoverable vault trash; a customized fallback is kept as a regular visible note.
- `Initialize indexes for all folders` explicitly converts every existing non-root folder.

The generated child list is rendered as a styled **Pages** panel and bounded by `index-plugin:children:start` and `index-plugin:children:end` HTML comments. The plugin hides those exact marker lines in Obsidian's editor while retaining them in the Markdown file as safe update boundaries. Content outside the markers belongs to the user and is not rewritten. Incomplete or duplicate markers stop the update instead of risking the note.

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
