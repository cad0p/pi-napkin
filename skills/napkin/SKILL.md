---
name: napkin
description: Read, create, search, and manage notes in Obsidian vaults using the napkin CLI. Works directly on markdown files and canvas files — no Obsidian app required. Use when the user asks to interact with their Obsidian vault, manage notes, search vault content, work with tasks, tags, properties, daily notes, templates, bases, bookmarks, aliases, or canvas files from the command line.
---

# napkin

CLI for Obsidian vaults. Operates directly on markdown files — no Obsidian app, no Electron, no Catalyst license.

See: **[README.md](../../README.md)** for full documentation — install, config, auto-distill, concurrency, commands, tools, agent visibility, vault setup, and troubleshooting.

The single piece of agent-critical operational info we keep in the SKILL itself is vault resolution, since misresolution silently creates a bare vault (which is a data-loss hazard).

## Vault Resolution

Before any command runs, napkin picks a vault in this order:

1. **`--vault <path>`** flag, if supplied.
2. **Nearest ancestor with `.napkin/`** (or `.obsidian/.napkin/`) walking up from cwd.
3. **Global fallback** — `vault` field in `$XDG_CONFIG_HOME/napkin/config.json` (defaults to `~/.config/napkin/config.json`).
4. **Bare vault auto-created at cwd** — last resort. napkin silently creates `.napkin/` + `NAPKIN.md` + `.obsidian/` in the current directory with no prompt.

> **Warning:** Step 4 is a footgun at first setup. Running `napkin vault` (or any command that resolves the vault) from a random directory with no ancestor `.napkin/` and no global config will silently create an empty vault there. Always confirm the resolved vault before running commands that might trigger this fallback.

### First-time setup

Configure the global fallback so commands never accidentally create bare vaults:

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

If it prints a path that shouldn't be a vault (e.g. your cwd or `$HOME`), napkin just created a bare vault there — either delete the stray `.napkin/`/`NAPKIN.md`/`.obsidian/` it generated and configure the global fallback, or re-run with `--vault <path>`.
