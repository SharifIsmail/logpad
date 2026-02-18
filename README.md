# 🗃️ logpad

> A local-first spreadsheet that never forgets anything.

**logpad** is a zero-backend database app that lives entirely in your browser. Every cell change is stored as an immutable event — nothing is ever overwritten, nothing is ever lost. Full history on every row, forever.

## Features

- **Append-only event store** — edits never destroy data, they stack on top
- **Multiple tables** with foreign keys between them
- **Full row history** — see every change, who made it, when
- **Sorts, renames, inline editing** — feels like a spreadsheet
- **Zero server** — runs off a single `index.html` via [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) + OPFS
- **Tab navigation**, **auto-focus**, **uniqueness constraints**, **FK dropdowns**

## Usage

Just open `static/index.html` in Chrome (or any browser with OPFS support). That's it. No install, no server, no account.

```
open static/index.html
```

Data is stored in your browser's [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) — it persists across sessions and never leaves your machine.

## How it works

Every cell edit appends a row to `cell_history`. The current state of any row is computed via a SQL window function (last-write-wins per column). Deletes are soft — a `deleted_at` timestamp, nothing more.

## Stack

- **wa-sqlite** — SQLite compiled to WASM, running in a Web Worker
- **OPFS** — browser filesystem for persistent storage
- Vanilla JS + HTML + CSS — no build step, no framework, no fuss

## License

MIT
