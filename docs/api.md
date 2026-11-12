# Folder page API (version 1)

The enabled plugin exposes `app.plugins.plugins['index-plugin'].api`. Check `api.version === 1` before use. The API works without a global variable or an additional plugin.

```ts
interface IndexPluginApi {
  version: 1;
  folderPages: {
    get(folderPath: string): TFile | null;
    folderFor(file: TFile): string | null;
    register(file: TFile, folderPath: string): Promise<void>;
    open(folderPath: string, options?: { newLeaf?: boolean }): Promise<void>;
  };
  childCreation: {
    register(handler: {
      id: string;
      matches(folderPath: string): boolean;
      open(folderPath: string): void | Promise<void>;
    }): () => void;
  };
}
```

## External pages

A page represents an existing vault directory through its `topic_folder` property. Paths are vault-relative, with no leading or trailing slash. The page can live beside that directory:

```text
learning/dl/embedding.md        topic_folder: learning/dl/embedding
learning/dl/embedding/
  data.md                      topic_folder: learning/dl/embedding/data
  data/
    article.md
```

`register(page, folderPath)` validates the freshly read property and updates the resolver immediately, before Obsidian's metadata cache catches up. It does not write frontmatter, add ownership markers, move the page, or create a directory. Repeating the same registration is harmless. Conflicting registrations throw. The existing metadata is the only persisted mapping; there is no parallel settings registry.

At startup, the resolver discovers these properties. Subsequent metadata changes update the mapping; removals and deletions unmap the page. Before index creation, a fresh sibling lookup closes the metadata-cache timing gap. A directory with several declared pages cannot be converted or indexed until the conflict is resolved; its pages remain visible for repair.

`get` returns the external page first, then an existing owned/conventional index. It does not create anything. `folderFor` returns the represented directory for an external or owned page. `open` opens the existing page, or follows normal indexing behavior for an unrepresented directory.

External pages are hidden as separate File Explorer rows only while they uniquely represent an existing directory. The folder name opens that page; the chevron still expands children. External content is never passed to the generated Pages-block writer, adopted as an owned index, or aligned to an in-folder filename. Ancestor owned indexes link the folder once, excluding its sidecar row.

## Child creation

Register the existing form, rather than a second creation workflow:

```js
const unregister = api.childCreation.register({
  id: 'learning',
  matches: path => isLearningTopic(path),
  open: path => openExistingForm({ topicFolder: path }),
});
```

The handler runs before the name prompt, for both a folder target and its page. A matched handler owns the creation interaction, including cancellation. If an external folder page has no available handler, the plugin reports that the form is unavailable rather than silently presenting a different form. Ordinary indexed folders keep the built-in prompt. More than one matching handler is an error; neither runs.

Handler IDs are unique. Call the returned function when reloading/unloading the caller; repeated disposal is safe. Index Plugin clears handlers on unload. The plugin emits the workspace event `index-plugin:api-ready` with the new API when loaded, allowing a caller to reconnect after plugin reload. Callers must also bind the currently enabled API on their own startup. Dispose the old registration before binding a replacement and remove the workspace listener on caller unload.

## Renames and migration boundaries

Folder renames update `topic_folder` throughout the mapped subtree. A matching sibling page follows its folder's name through Obsidian's native file manager, which updates note links. A separately renamed/moved page keeps its explicit folder mapping. Property editing changes representation, not physical note placement; the learning filing command remains responsible for entry moves.

The normal tree migration blocks scopes containing external folder pages, so its sidecar-folding rules cannot move or retire them. Existing redundant owned indexes require a separate, backed-up, one-time migration. Registering a canonical page deliberately does not delete or merge another file.

Implementation: `src/api.ts` owns the public contract and child dispatch; `src/folder-pages.ts` owns external mappings. `src/index-manager.ts` consults that resolver before normal owned-index operations. Explorer integration never treats an external page as an internally owned index.
