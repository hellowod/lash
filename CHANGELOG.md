# Changelog

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




