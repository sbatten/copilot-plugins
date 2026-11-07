# Copilot Plugins

A Copilot plugin marketplace containing one plugin:
[Grove](plugins/grove/README.md), which pairs Chief
of Staff orchestration with a live pixel-art forest canvas.

## Install

Add `sbatten/copilot-plugins` as a marketplace in Copilot's plugin manager,
then install `grove@sbatten`.

To refresh the marketplace catalog and update an existing Copilot-managed
installation:

```text
/plugin marketplace update sbatten
/plugin update grove@sbatten
```

Refreshing the catalog and updating the installed plugin are separate operations.
An older direct installation must be removed before installing the marketplace
copy to avoid duplicates.

The plugin, extension, and canvas IDs are now `grove`. Saved scenes and board
registrations use `extension-data/grove/`, and persisted format IDs use the
`grove/` prefix. State from the previous identity is not migrated; start a new
Chief of Staff chat after installing the renamed plugin.

## Layout

```text
marketplace.json
plugins/
  grove/
    .plugin/plugin.json
    README.md
    agents/
    extensions/
    skills/
    tests/
```

The root [marketplace manifest](marketplace.json) points to
`./plugins/grove/`. All plugin components and their relative paths
live inside that directory; the repository root is not itself a plugin.

## Development

From the repository root:

```sh
cd plugins/grove
node --test tests/*.test.mjs
node skills/grove-sprites/scripts/validate-sprites.mjs
node --check extensions/grove/extension.mjs
```

See the [plugin documentation](plugins/grove/README.md) for workflow
details and individual test commands. When publishing a release, keep the plugin
version and description in [marketplace.json](marketplace.json) aligned with the
[plugin manifest](plugins/grove/.plugin/plugin.json).
