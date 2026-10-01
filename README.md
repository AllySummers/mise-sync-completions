# mise-sync-completions

Sync shell completions for tools managed by [mise](https://mise.jdx.dev).
Discovers globally installed tools, runs each tool's completion command (or a
custom handler), and writes completion scripts to a shared directory.

Tools installed through [packslip](https://mise.jdx.dev/dev-tools/backends/packslip.html)
that ship their own completion are left to mise, which
[loads them natively](https://mise.jdx.dev/dev-tools/packslip-resources.html#completions)
in an activated shell. This task only maintains fallback files for everything
else.

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
tools.usage = "3.4.0" # or "latest", since mise/etc can require new versions of `usage` for new features in completions

[hooks]
postinstall = ["mise run sync-completions"]
```

Pin to a
[release tag](https://github.com/AllySummers/mise-sync-completions/releases),
not `main`.

The postinstall hook keeps the fallback files current and reconciles files
whose tool now has a packslip completion. Packslip completions are not
regenerated on tool updates: mise resolves them for the active version every
time you press Tab.

### Requirements

- [mise](https://mise.jdx.dev). Handing off to packslip needs a mise with
  `mise completion --tool` (developed against 2026.9.17). On an older mise the
  probe simply fails, so every tool keeps its generated fallback file.
- [deno](https://deno.com/) — install via mise (`tools.deno = "2.8.2"` above)

### Shell wiring

There are two providers, and most setups use both:

1. **Packslip completions**, loaded by mise itself. Nothing is written by this
   task.
2. **Generated fallback files** that this task writes for every other tool.

#### Packslip completions

[Activate mise](https://mise.jdx.dev/cli/activate.html) in your interactive
shell. As tools become active, activation registers mise's loaders and
restores any earlier registration when a tool leaves scope. No extra
completion directory is needed. `mise` must already be on `PATH` when the
activation line runs.

```zsh
# ~/.zshrc: after the last compinit, so nothing later overwrites the loaders
eval "$(mise activate zsh)"
```

```bash
# ~/.bashrc
eval "$(mise activate bash)"
```

```fish
# ~/.config/fish/config.fish
mise activate fish | source
```

**Shells without activation** (shims only) need a persistent loader per
executable. Install only the ones you want, and follow the setup lines your
mise version prints:

```sh
mise completion zsh --tool hk --install   # or bash / fish
```

Use the executable name (for example `aubr`), not a backend identifier. Avoid
`--force`, which overwrites a completion file mise did not write.
`--completions-path` does not affect mise's installer. Don't run `--install`
from a postinstall hook: activated shells don't need it.

This task always skips a tool when the installed version's packslip provides
that executable's completion for the shell being synced. Without activation
or installed loaders, such tools have no completion.

#### Fallback files

Fallback completions are written to:

- zsh: `$XDG_DATA_HOME/mise-completions/zsh/`
- fish: `$XDG_DATA_HOME/mise-completions/fish/`
- bash: the [bash-completion](https://github.com/scop/bash-completion) user
  directory, `$BASH_COMPLETION_USER_DIR/completions` (first entry when it is a
  `:`-separated list), else `$XDG_DATA_HOME/bash-completion/completions`

`$XDG_DATA_HOME` defaults to `~/.local/share`. Override the write directory for
any shell with `--completions-path` or `MISE_SYNC_COMPLETIONS_PATH`.

You must wire these paths into your shell so completions load. The snippets
below follow common shell completion patterns and
[bash-completion's installation docs](https://github.com/scop/bash-completion#installation).

**zsh** (`~/.zshrc`):

Add the mise completions directory to `FPATH` before `compinit`:

```zsh
fpath=(~/.local/share/mise-completions/zsh $fpath)
autoload -Uz compinit && compinit
```

If completions do not appear after syncing, delete the completion dump your
`compinit` uses and start a new shell. That is `~/.zcompdump` by default, or
whatever file your configuration passes to `compinit -d`:

```zsh
rm -f ~/.zcompdump   # or your configured dump file
exec zsh
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
mise run sync-completions --force   # regenerate all fallback files
mise run sync-completions --verbose # per-tool status
mise run sync-completions --print-path
```

## How it works

1. Lists globally installed tools via `mise ls --global --json`, run outside any
   project, and keeps only the installed version each tool selects globally.
   A tool with no installed global version is skipped.
2. Adds `mise` itself via `mise --version` (not in `mise ls`). Its completion
   always comes from `mise completion`.
3. Looks up each tool in the **registry**. When several registry names map to
   the same output file (aliases), one owner is chosen deterministically.
4. Chooses a provider for each executable and shell before consulting the cache,
   including with `--force`. For an install with a `.mise-packslip.json`, it
   asks mise itself: `mise completion <shell> --tool <executable>`, run outside
   any project.
   - **packslip**: mise prints a completion. Nothing is generated. A file this
     task generated earlier is removed if it is unchanged.
   - **generated**: anything else (not a packslip install, no completion for
     this executable and shell, or a failed probe). The registry command or
     handler runs. A failed probe never removes anything.
5. Skips a generated file when its recorded shell, path, tool, version, install
   path, pinned `requires` versions, and content hash all still match.
   Otherwise it regenerates the file by running the exact discovered versions
   (`mise x tool@version`) outside your current project. A file that exists but
   was not written by this task, or was edited since, is never overwritten: it
   is reported and counted as `preserved`.
6. Writes files atomically:
   - zsh: `mise-completions/zsh/_tool`
   - fish: `mise-completions/fish/tool.fish`
   - bash: `bash-completion/completions/tool` (or `--completions-path`)
7. Reconciles: files this task wrote for tools that are no longer sync targets
   are removed if their content is unchanged. Edited files, symlinks, and files
   it never wrote are kept and reported. Nothing is removed when `mise ls`
   fails or returns no tools, and `--disable` only skips a tool.

State lives in `$XDG_DATA_HOME/mise-completions/.state.json` (schema 2). It
records each output by absolute path, with its shell, executable, tool,
version, install path, provider, and content hash, so runs for different
shells or output directories never mask one another. Runs that share the file
take a lock (`.state.json.lock`), so concurrent postinstall and manual runs are
serialized.

## Checking packslip completions

After a tool switches to a packslip completion:

1. Start a fresh shell. For zsh, delete the completion dump file your
   `compinit` uses first.
2. Check that mise can print the script, for example
   `mise completion zsh --tool hk >/dev/null`.
3. After the first prompt in a fresh zsh, run `typeset -f _hk`. It should be
   mise's loader, which calls `mise completion zsh --tool hk`. Then press Tab
   on `hk`.
4. Switch between projects that select different installed versions and check
   that completion follows the active version.

## Registry overrides

Built-in tool mappings live in [`registry.ts`](src/registry.ts). Reusable command
templates are in [`presets.ts`](src/presets.ts) (`standard`, `ghStyle`, etc.).

Keep registry entries for tools that also publish packslip completions (for
example `aube`, `hk`, `pitchfork`, `usage`, `fnox`). Older versions and
installs from other backends still need them, and detection is per installed
version, so no exclusion list is needed.

Override or extend locally at:

```
~/.config/mise/sync-completions/registry.ts
```

Or set `MISE_SYNC_COMPLETIONS_REGISTRY` to any `.ts` file path.

User entries are **merged on top** of built-in defaults.

Example override:

```ts
import { standard, standardCommands } from "https://raw.githubusercontent.com/AllySummers/mise-sync-completions/v0.1.0/presets.ts";
import type { RegistryEntry } from "https://raw.githubusercontent.com/AllySummers/mise-sync-completions/v0.1.0/shared.ts";

export const tools: Record<string, RegistryEntry> = {
  mycli: standard,
  myother: (tool) => ({ zsh: `${tool.name} completion zsh` }),
};
```

For handlers that fetch remote files or read bundled completions, use a
`RegistryHandlerEntry` in the registry (see `qsv`
in [`registry.ts`](src/registry.ts)). Tools that ship completion files in their
download can use the `bundled` helper in [`registry.ts`](src/registry.ts), which
maps each shell to a glob relative to the install path, for example
`**/completions/_tool`. `**` also matches zero directories, so one pattern covers
archives with and without a top-level directory (see `yazi`, `zoxide`, and
`zshellcheck`). For one-off user logic, vendor this repo and
edit [`custom-completions.ts`](src/custom-completions.ts) — it is merged last
and starts empty.

Object entries can also use registry metadata when a mise tool name differs
from its binary or needs another tool during generation:

```ts
export const tools: Record<string, RegistryEntry> = {
  "github:owner/example": {
    ...standardCommands("example"),
    completionName: "example",
    requires: "usage",
  },
};
```

Use `aliases` when multiple mise tool names install the same binary, `providedBy`
when one installed tool provides an additional binary, and `shells` to limit a
handler entry to the shells it supports.

## Upgrading

When you change the `ref=` pin:

```bash
mise cache clear
mise run sync-completions
```

State files from versions before schema 2 are ignored and replaced. Files those
versions wrote are not tracked, so they are neither removed nor overwritten:
they show up as `preserved`. Delete just the files this task generated (and
`.state.json`) once before the first run. Don't delete a shared directory such
as bash-completion's `completions`, which holds other tools' files.

## Security

Remote mise tasks download and execute code from the URL you configure. Only use
sources you trust, and **pin to a git ref** (tag or commit SHA) — never floating
`main`.

## Development

```bash
mise run check      # type-check sources and tests
mise run lint
mise run fmt --check
mise run test       # fixture tests; uses a fake `mise` on PATH and temp dirs only
```

Packslip detection lives in [`src/packslip.ts`](src/packslip.ts). It asks mise
rather than parsing packslip metadata; the only internal detail it relies on is
the `.mise-packslip.json` marker file, used to avoid probing non-packslip tools.

Clone and point mise at a local path while developing:

```toml
[tasks.sync-completions]
file = "{{ config_root }}/path/to/mise-sync-completions/src/sync-completions"
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
| mise-completions-sync | registry entry                              | retained for compatibility; this replaces it  |
| Overrides             | edit chezmoi files                          | `~/.config/mise/sync-completions/registry.ts` |
| Imports               | `../completion-sync/cli.ts`                 | sibling `./cli.ts` in flat repo layout        |

## License

MIT — see [LICENSE](LICENSE).
