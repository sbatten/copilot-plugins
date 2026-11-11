# Copilot Plugins

A Copilot plugin marketplace containing two independent plugins:

- [Grove](plugins/grove/README.md) pairs Chief of Staff orchestration with a live
  pixel-art forest canvas.
- [Engineer](plugins/engineer/README.md) provides `/engineer`: reviewed planning,
  implementation and verification with parallel subagent reviewers and detailed
  report artifacts, without a canvas or companion plugin.

## Install

Add `sbatten/copilot-plugins` as a marketplace in Copilot's plugin manager,
then install `grove@sbatten`, `engineer@sbatten`, or both.

To refresh the marketplace catalog and update an existing Copilot-managed
installation:

```text
/plugin marketplace update sbatten
/plugin update grove@sbatten
/plugin update engineer@sbatten
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
.github/
  skills/
    grove-sprites/      # repository-only artwork guidance and validator
plugins/
  engineer/
    .plugin/plugin.json
    README.md
    agents/
    skills/
    tests/
  grove/
    .plugin/plugin.json
    README.md
    agents/
    extensions/
    skills/
    tests/
```

The root [marketplace manifest](marketplace.json) points to each plugin's
directory under `plugins/`. All plugin components and their relative paths
live inside their own directory; the repository root is not itself a plugin.

## Development

From the repository root:

```sh
node --test plugins/grove/tests/*.test.mjs
node --test plugins/engineer/tests/*.test.mjs
node .github/skills/grove-sprites/scripts/validate-sprites.mjs
node --check plugins/grove/extensions/grove/extension.mjs
```

The [grove-sprites repository skill](.github/skills/grove-sprites/SKILL.md)
supports maintaining Grove's artwork; it is not shipped with the plugin.

See the [Grove documentation](plugins/grove/README.md) and
[Engineer documentation](plugins/engineer/README.md) for workflow details.
When publishing a release, keep each plugin's version and description in
[marketplace.json](marketplace.json) aligned with its plugin manifest.
