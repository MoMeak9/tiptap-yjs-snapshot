# V2 revision-history data and API contract

English · [简体中文](contract.zh-CN.md)

This repository publishes frontend and backend practice code adapted from an existing V2 revision-history flow, with a runnable local integration demo. This page separates the **reusable package interfaces** from the **`src/` demo's HTTP/WebSocket API**. See [extraction scope](v2-extraction.en.md) for source modules, sanitization, and generalization.

[Outline](https://github.com/outline/outline) is a design reference for revision-history interactions. This page defines this project's full Yjs V2 state plus JSON, cursor, and live restore contract. The public code was adapted from this project's own V2 modules; it does not vendor Outline source code.

## Core data invariants

- The body uses Yjs `XmlFragment('default')`, and the title uses `Y.Text('title')`. A restorable revision stores the complete `Y.encodeStateAsUpdateV2(doc)` state. Restore decodes it with `Y.applyUpdateV2` for validation and persists the revision's original state. Lightweight `Y.encodeSnapshotV2` metadata contains no independently restorable body.
- The current document persists coherent state, canonical Tiptap JSON, title, SHA-256 content hash, schema version, and revision count. A new revision row stores the same-state immutable JSON, complete state, title, hash, and `sourceFormat: 'v2_json'`. The body hash and title jointly decide business-level changes.
- Automatic revisions are scheduled only after the current state is persisted. A job performs a cheap deduplication check outside the document lock, then rereads the latest revision and checks again under the lock. Every manual request writes a revision, even if body and title are unchanged.
- Lists paginate by `(version DESC, id DESC)` using an opaque cursor and read only metadata plus JSON/state presence. Detail reads the persisted JSON. `current-<documentId>` is a virtual detail ID for the current document and never enters the revision list.
- Before restore, the service saves a `pre_restore` protection revision when content differs, replaces the current document with the target original state, and writes a `restore` source row. Old connected rooms and Y.Docs must become invalid. On reset, the client rebuilds its editor, Y.Doc, and provider and clears any offline copy for that document.

Minimal JSON body before a change (title is stored separately in `Y.Text('title')`):

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"First draft"}]}]}
```

A later version:

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Second draft"}]}]}
```

Both JSON documents must round-trip through the same host schema and Yjs body fragment. The reusable package accepts a host schema; the local demo uses StarterKit. The host must declare, migrate, or degrade unknown product nodes and marks rather than silently writing them back to the live document.

## Reusable backend ports

`packages/v2-core/src/ports.ts` defines these boundaries:

| Port | Host requirement |
| --- | --- |
| `DocumentStore` / `RevisionStore` | Write state, insert revisions, and assign versions for the same document under one transaction connection and document lock; query metadata only for lists |
| `Scheduler` | Persist delayed and immediate materialization jobs and coordinate/cancel them across instances |
| `RoomReset` | During restore, gate new room loads, flush the active document, run replacement, broadcast reset, and disconnect old clients on every instance |
| `V2StateCodec` | Extract body and optional title from complete V2 state for validation and JSON derivation before restore |
| `IntervalPort`, `EventPublisher`, failure marker | Optionally integrate attribution, events, and canonicalization-failure recovery without depending on a particular identity directory or messaging system |

The package includes `PostgresDocumentStore`, `PostgresRevisionStore`, and a [PostgreSQL schema](../packages/v2-core/schema.postgres.sql) as reference adapters. `V2HistoryService` implements `prepareWrite` / `commitWrite`, scheduling and materialization, `createManual`, `list`, `detail`, and `restore`. The host must check read/write access before constructing `DocumentContext` and calling the service. The package does not include a production HTTP controller, authorization system, or collaboration server.

The frontend [RevisionHistory](../packages/revision-history/README.md) extension, API client, and controller expect V2 list, detail, and restore responses. `RevisionTransportConfig` can change the document-ID query key, token header, refreshed-token envelope header, and routes. Each list item needs at least `id`, `documentId`, `version`, `name`, `type`, `title`, `ctime`, `availability`, `diffEligible`, and `restorable`. Detail additionally needs `content` and `contentHash`, with optional attribution. Without real per-position attribution, return an empty value and leave changes neutral; the person who saved the revision must not be inferred as the author of its text.

## Local demo REST API

`src/server/` provides these reference routes. HTTP success uses `{ "code": 0, "data": ... }`; failure returns a nonzero `code` and `message`. `doc_id` selects a demo document and defaults to `demo`. It does not imply authorization. By default, the local service listens only on `127.0.0.1`.

| Method | Path | Input | Successful `data` |
| --- | --- | --- | --- |
| GET | `/api/revisions/list` | `doc_id`, `limit` (1–100), `cursor?` | `{ data, nextCursor, hasMore }`; `data` is a metadata list |
| GET | `/api/revisions/detail` | `doc_id`, `id` (revision ID or `current-<documentId>`) | Revision metadata, `content`, `contentHash`, availability, attribution |
| POST | `/api/revisions/create` | `doc_id`, JSON `{ name? }` | `{ id, version }` |
| POST | `/api/revisions/restore` | `doc_id`, JSON `{ id }` | `{ id }` |

`POST /create` is a manual-revision route provided by the demo. The frontend `RevisionHistory` package focuses on read, compare, and restore; the host owns the creation entry point. The demo produces only complete native V2 revisions, so list `availability` is `ready`. `diffEligible` and `restorable` independently indicate comparison and restore capability. `sourceFormat` and state stay in server storage and are not sent in lists. Current-document detail uses `id=current-<documentId>` and has `restorable: false`.

WebSocket `/collaboration?doc_id=...` sends `{ type: 'sync', epoch, update: <base64 V2> }` on connect; the client sends `{ type: 'update', epoch, update: <base64 V2> }` when editing. After restore, the server emits `document.reset` and closes old connections with code 4205; the client creates a new Y.Doc. `epoch` fences old connections in the demo adapter and is not a REST field. A real collaboration service may use another cross-instance reset implementation, provided it prevents old state from being written back.

## Compatibility and security boundaries

The public packages use synthetic test data. The host must provide real read/write authorization, a transactional database, durable jobs, cross-instance room reset, and any necessary offline-cache clearing. Demo file storage only supports a single-process integration. Each write saves its own format through a temporary file and atomic rename; it does not convert other storage formats. Set `PORT`, `DATA_DIR`, and `FRONTEND_ORIGINS` as shown in [`.env.example`](../.env.example). The demo restricts browser origins but has no account system.

Invalid document IDs, cursors, revision IDs, names, and request bodies return 4xx; a revision from another document appears not found. A target state that cannot be decoded must not replace the current document. Production integration also needs custom-schema JSON↔Yjs round-trip tests, offline-client restore checks, queue retry tests, and compensation for audit failure.
