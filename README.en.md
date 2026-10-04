# Wolai → Notion Sync

[完整中文指南](README.md) · [Narrated video walkthrough (Chinese)](tutorial/README.md) · [Copy-ready AI agent prompts (Chinese)](docs/ai-quickstart.md)

A local-first, one-way CLI that mirrors selected Wolai page trees into an existing Notion export root. No Codex, browser automation, personal keychain entry, or preconfigured account is required. This is an independent community project, not an official Wolai/Notion integration.

## Quick start

[Watch the Chinese video walkthrough](https://d1.music.126.net/dmusic/35bf/351c/7ed5/ccb22e35a81a28a49529bf5f67aeacbd.mp4?infoId=4482506) — approximately 3 min 41 sec, narrated with Fun-CosyVoice3. See [chapters, subtitles and redaction notes](tutorial/README.md).

Requirements: Node.js 22.19+, npm, a Wolai MCP token, and your own Notion token with read/insert/update access to the export root.

```sh
npm ci
node bin/cli.mjs init --source-root YOUR_WOLAI_PAGE_ID --notion-root YOUR_NOTION_PAGE_ID
```

Copy `.env.example` to a private `.env`, fill `WOLAI_MCP_TOKEN` and `NOTION_TOKEN`, then:

```sh
node --env-file=.env bin/cli.mjs check --remote
node --env-file=.env bin/cli.mjs sync         # Read-only plan; local cache is written
node --env-file=.env bin/cli.mjs sync --apply # Explicit remote write
node bin/cli.mjs status
node --env-file=.env bin/cli.mjs verify      # Read-only full page/order verification
```

`--source-root` is repeatable. All commands accept `--data-dir`; its default is `.wolai-notion-sync` in the current working directory. Each workspace is bound to its source roots and target root. Changing them requires a new data directory.

## Safety and limitations

- Every selected page is scanned recursively using both version and stable body fingerprints. Source pages are never edited; source removal does not delete target pages.
- Parent relationships and sibling order are retained. Manual target body/title/parent changes are protected. Failed writes do not advance successful versions.
- Batches default to 50 operations. Exit code `3` means a healthy partial batch: continue with `--resume` while the complete snapshot is under 24 hours old. Daily runs should rescan without `--resume`. Code `2` means failure, conflict, stopped run, or failed verification.
- Media may be inline uploads, zipped original files, oversized source links, or whole-page ZIP archives. These are distinct outcomes, not equivalent to full native replication.
- Database containers are preserved, but full database records/schemas/views are not enumerated. Comments, permissions, history, and all proprietary interactions are not mirrored.
- Verification checks all page identities/parents/body baselines, independent source text coverage, media counts, actual child order, and bytes for up to three media pages. It is not a byte audit of every media file.
- `idea` titles receive 💡 and dated titles 📅 unless a custom icon is already present.
- Tokens come only from your environment. Runtime data contains private notes and must never be published. There is no cross-device distributed lock: use a single writer per target.

See [operations](docs/operations.md), [architecture](docs/architecture.md), [security](SECURITY.md), and [contribution guidelines](CONTRIBUTING.md). Run `npm test`, `npm run privacy`, and `npm pack --dry-run` before release. The CI matrix is provided; its presence is not evidence that remote CI has run.

MIT licensed. Notion API compatibility is pinned to `2026-03-11`. This is a self-hosted CLI, not a hosted OAuth application.
