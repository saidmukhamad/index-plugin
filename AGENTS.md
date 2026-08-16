# Index Plugin contributor notes

- This is an Obsidian community plugin written in strict TypeScript and bundled with esbuild.
- Keep lifecycle registration in `src/main.ts`; move substantial features into focused modules under `src/`.
- Use Obsidian's `register*` helpers so hot reload unloads listeners and resources cleanly.
- Run `npm run check` before handing off a change.
- Use the isolated `dev` vault for manual testing. Never point development builds at a personal vault.
- Do not edit generated files in `dist/` or files under `dev/.obsidian/plugins/`.
