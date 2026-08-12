---
name: napkin
description: Read, create, search, and manage notes in Obsidian vaults using the napkin CLI. Works directly on markdown files and canvas files — no Obsidian app required. Use when the user asks to interact with their Obsidian vault, set up or initialize a knowledge base / note vault (napkin init), configure the default vault, or manage notes, search vault content, work with tasks, tags, properties, daily notes, templates, bases, bookmarks, aliases, or canvas files from the command line.
---

# napkin

CLI for Obsidian vaults. Operates directly on markdown files — no Obsidian app, no Electron, no Catalyst license.

See: **[README.md](../../README.md)** for full documentation — install, config, auto-distill, concurrency, commands, tools, agent visibility, vault setup, and troubleshooting.

The single piece of agent-critical operational info we keep in the SKILL itself is vault resolution, since misresolution used to silently create a bare vault (a data-loss hazard) — that footgun is gone, but knowing where a command points remains essential.

## Vault Resolution

Before any command runs, napkin picks a vault in this order:

1. **`--vault <path>`** flag, if supplied.
2. **Nearest ancestor with `.napkin/`** (or `.obsidian/.napkin/`) walking up from cwd.
3. **Global fallback** — `vault` field in `$XDG_CONFIG_HOME/napkin/config.json` (defaults to `~/.config/napkin/config.json`).
4. **Error** — if none of the above exists, commands fail with `VaultNotFoundError` (exit code 4) and an actionable message. napkin **never** creates a vault implicitly.

### First-time setup

When the user has no vault yet, run `napkin init` in the directory they want as the vault root (optionally with `--template personal|coding|research|company|product`), or set up a global vault so commands work from any directory:

```json
// ~/.config/napkin/config.json
{
  "vault": "~/path/to/vault"
}
```

Supports `~` expansion; paths without `~` are resolved relative to the config file's directory. Override the default config location with `XDG_CONFIG_HOME`.

Confirm resolution before first use:

```bash
napkin vault --json | jq -r .path       # Should print the expected vault path
```

If it errors with `No napkin vault found`, either run `napkin init` in a directory you want as a vault, or configure the global fallback above and re-check.
