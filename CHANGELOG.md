# Changelog

## 0.5.3

- Automatically launch Pi through `winpty` in Git Bash / MSYS when direct Pi output is unavailable.

## 0.5.2

- Fixed agent output compatibility in Git Bash / MSYS by launching inherited interactive agents through the active bash shell instead of npm's `.cmd` shim.

## 0.5.1

- Improved Codex continuous chat mode by using native inline rendering with `--no-alt-screen`.
- Removed the global `NO_COLOR` override for Codex so interactive mode keeps its native styling.

## 0.5.0

- Added `lash chat <agent> [args...]` for continuous interactive mode.
- `chat` always uses `interactiveArgs`, even when an initial prompt is provided.

## 0.4.0

- Added the Pi coding agent as a built-in agent.
- Added native Pi session discovery from `~/.pi/agent/sessions`.
- Added Pi resume support through `pi --session <id>`.

## 0.3.2

- Fixed `--user` handling for `lash path`, `lash init`, and `lash remove`.
- Deduplicated native sessions when multiple configured agents use the same session provider.
- Added end-to-end integration coverage for every public CLI command.

## 0.3.1

- Fixed `lash resume <agent> --last <prompt>` so text after `--last` is treated as a prompt, not a session reference.

## 0.3.0

- Added native session discovery for Codex and Claude Code.
- Added `lash sessions`, `lash last`, and `lash resume`.
- Added current-directory filtering plus `--all`, `--archived`, `--limit`, and `--json`.
- Added resumable session references by index, ID, ID prefix, or title.
- Added configurable session resume support for custom agents.

## 0.2.0

- Moved all source files, including the CLI entry point, under `src/`.
- Added a public Node.js API through `src/index.js`.
- Added `npm run install:global` for local development installation.
- Added package export metadata and publish checks.
- Changed the npm package name to `lashhub`; the executable remains `lash`.

## 0.1.0

- Initial CLI with built-in Codex and Claude Code agents.
- Project and user agent configuration.
- Agent inheritance and overrides.
