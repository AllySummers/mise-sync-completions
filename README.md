# mise-sync-completions

Sync shell completions for tools managed by [mise](https://mise.jdx.dev).
Discovers globally installed tools, runs each tool's completion command (or a
custom handler), and writes completion scripts to a shared directory.

Replaces
[mise-completions-sync](https://github.com/alltuner/mise-completions-sync) with
a Deno-based remote mise task and a TypeScript registry you can override
locally.

## Quick start

Add to `~/.config/mise/config.toml` (or project `mise.toml`):

```toml
[tasks.sync-completions]
file = "git::https://github.com/AllySummers/mise-sync-completions//src/sync-completions"
tools.deno = "2.8.2"

[hooks]
postinstall = ["mise run sync-completions"]
```

Pin to a
[release tag](https://github.com/AllySummers/mise-sync-completions/releases),
not `main`.

### Requirements

- [mise](https://mise.jdx.dev)
- [deno](https://deno.com/) — install via mise (`tools.deno = "2.8.2"` above)

### Shell wiring

Completions are written to:

- zsh: `~/.local/share/mise-completions/zsh/`
- fish: `~/.local/share/mise-completions/fish/`
- bash: `~/.local/share/bash-completion/completions/` by default — the
  [bash-completion](https://github.com/scop/bash-completion) user directory
  (`$BASH_COMPLETION_USER_DIR/completions`, or
  `$XDG_DATA_HOME/bash-completion/completions` when unset)

Override the write directory for any shell with `--completions-path` or
`MISE_SYNC_COMPLETIONS_PATH`.

You must wire these paths into your shell so completions load. The snippets
below follow common shell completion patterns and
[bash-completion's installation docs](https://github.com/scop/bash-completion#installation).

**zsh** (`~/.zshrc`):

Add the mise completions directory to `FPATH` before `compinit`:

```zsh
fpath=(~/.local/share/mise-completions/zsh $fpath)
autoload -Uz compinit && compinit
```

If completions do not appear after syncing, rebuild the zcompdump cache:

```zsh
rm -f ~/.zcompdump; compinit
```

**bash** (`~/.bashrc` or `~/.bash_profile`):

First enable [bash-completion](https://github.com/scop/bash-completion). With
the system package (common on Linux):

```bash
[[ $PS1 && ! ${BASH_COMPLETION_VERSINFO:-} && -f /usr/share/bash-completion/bash_completion ]] &&
  . /usr/share/bash-completion/bash_completion
```

If you installed bash-completion via a package manager into a custom prefix,
source its profile script instead (path varies by install):

```bash
# Example — adjust to your install location
[[ -r /path/to/bash-completion/etc/profile.d/bash_completion.sh ]] &&
  . /path/to/bash-completion/etc/profile.d/bash_completion.sh
```

Once bash-completion is loaded, completions in
`~/.local/share/bash-completion/completions/` are picked up automatically on
tab (lazy-loaded per command). No extra sourcing loop is needed.

Without bash-completion, source them explicitly:

```bash
for f in ~/.local/share/bash-completion/completions/*; do
  [[ -f "$f" ]] && source "$f"
done
```

**fish** (`~/.config/fish/config.fish`):

Add the mise completions directory to `fish_complete_path`:

```fish
set -p fish_complete_path ~/.local/share/mise-completions/fish
```

### Run manually

```bash
mise run sync-completions              # sync for $SHELL
mise run sync-completions --shell zsh
mise run sync-completions --force   # regenerate all
mise run sync-completions --verbose # per-tool status
mise run sync-completions --print-path
```

## How it works

1. Lists globally installed tools via `mise ls --global --json`
2. Adds `mise` itself via `mise --version` (not in `mise ls`)
3. For each tool, checks `.state.json` and skips if version unchanged (unless
   `--force`)
4. Looks up the tool in the **registry** — runs a shell command, or calls a handler
   (e.g. qsv via HTTP fetch, hyperfine/killport from bundled files)
5. Writes files:
   - zsh: `mise-completions/zsh/_tool`
   - fish: `mise-completions/fish/tool.fish`
   - bash: `bash-completion/completions/tool` (or `--completions-path`)

State lives in `~/.local/share/mise-completions/.state.json`.

## Registry overrides

Built-in tool mappings live in [`registry.ts`](registry.ts). Reusable command
templates are in [`presets.ts`](presets.ts) (`standard`, `ghStyle`, etc.).

Override or extend locally at:

```
~/.config/mise/sync-completions/registry.ts
```

Or set `MISE_SYNC_COMPLETIONS_REGISTRY` to any `.ts` file path.

User entries are **merged on top** of built-in defaults.

Example override:

```ts
import { standard } from "https://raw.githubusercontent.com/AllySummers/mise-sync-completions/v0.1.0/presets.ts";
import type { RegistryEntry } from "https://raw.githubusercontent.com/AllySummers/mise-sync-completions/v0.1.0/shared.ts";

export const tools: Record<string, RegistryEntry> = {
  mycli: standard,
  myother: (tool) => ({ zsh: `${tool.name} completion zsh` }),
};
```

For handlers that fetch remote files or read bundled completions, use a
`RegistryHandlerEntry` in the registry (see `qsv`, `hyperfine`, and `killport`
in [`registry.ts`](registry.ts)). For one-off user logic, vendor this repo and
edit [`custom-completions.ts`](src/custom-completions.ts) — it is merged last
and starts empty.

## Upgrading

When you change the `ref=` pin:

```bash
mise cache clear
mise run sync-completions
```

## Security

Remote mise tasks download and execute code from the URL you configure. Only use
sources you trust, and **pin to a git ref** (tag or commit SHA) — never floating
`main`.

## Development

```bash
chmod +x sync-completions
./sync-completions --shell zsh --verbose
deno check src/cli.ts src/presets.ts src/registry.ts src/custom-completions.ts src/shared.ts src/completion-helpers.ts
```

Clone and point mise at a local path while developing:

```toml
[tasks.sync-completions]
file = "{{ config_root }}/path/to/mise-sync-completions/sync-completions"
```

## Migrating from chezmoi dotfiles

If you previously vendored completion-sync inside chezmoi:

1. Remove `home/dot_config/mise/completion-sync/` and
   `home/dot_config/mise/tasks/executable_sync-completions`
2. Replace `[task_config] includes = ["tasks"]` hook with the remote task
   snippet above
3. Remove `mise-completions-sync` from your tools if installed
4. Remove old shell wiring; add `fpath` (zsh), `fish_complete_path` (fish), and ensure bash-completion is loaded (bash)

### What changed from the chezmoi version

| Area                  | Before                                      | After                                         |
| --------------------- | ------------------------------------------- | --------------------------------------------- |
| Distribution          | Local chezmoi task + `completion-sync/` dir | Remote `git::` mise file task                 |
| Registry              | `registry.toml` + pattern indirection       | `presets.ts` + `registry.ts` (`tools` only)   |
| qsv                   | curl commands in registry                   | `registry.ts` handler (HTTP fetch)            |
| hyperfine / killport  | not supported                               | `registry.ts` handlers (bundled files)        |
| mise-completions-sync | registry entry                              | removed (this replaces it)                    |
| Overrides             | edit chezmoi files                          | `~/.config/mise/sync-completions/registry.ts` |
| Imports               | `../completion-sync/cli.ts`                 | sibling `./cli.ts` in flat repo layout        |

## License

MIT — see [LICENSE](LICENSE).
