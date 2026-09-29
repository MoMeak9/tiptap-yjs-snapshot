# Frontend and backend architecture of V2 revision history

English · [简体中文](architecture.zh-CN.md)

This page describes how to integrate the public practice code into a real collaborative editor and how the local demo verifies the flow. See [V2 extraction scope](v2-extraction.en.md) for source modules and adaptation boundaries, and the [contract](contract.en.md) for fields and HTTP examples.

[Outline](https://github.com/outline/outline) is a design reference for delayed revisions, body-and-title deduplication, a virtual current revision, metadata-only lists, and inline/block diff. This project's Yjs V2 state plus JSON, CJK diff, cursor pagination, and live restore have additional constraints; see [source and adaptation notes](v2-extraction.en.md).

## 1. Two coherent representations

The body lives in `Y.XmlFragment('default')` and the title in `Y.Text('title')`. From the same Y.Doc, the server obtains full `Y.encodeStateAsUpdateV2` state and Tiptap JSON. It canonicalizes JSON with the host's ProseMirror schema and computes a semantic hash. On a normal V2 write, the current document and new revision rows store both state and JSON; imported historical revisions may temporarily retain complete V2 state alone. JSON supports history reading and diff, while original state supports restore. Lightweight `Y.encodeSnapshotV2` metadata contains no standalone body and cannot serve as a restorable revision.

```mermaid
flowchart TD
  LIVE[Live Y.Doc] --> STATE[Full Yjs V2 state]
  LIVE --> JSON[Coherent Tiptap JSON]
  LIVE --> TITLE[Title]
  JSON --> CANON[Schema canonicalization and SHA-256]
  STATE --> CURRENT[Current document storage]
  TITLE --> CURRENT
  CANON --> CURRENT
  CURRENT --> JOB[Delayed or disconnect materialization]
  JOB --> REV[New revision row: state + JSON]
  REV --> API[Metadata list / JSON detail]
  API --> UI[Lit panel + separate read-only viewer]
  REV --> RESTORE[Replace current state with target state]
  RESTORE --> RESET[Room reset and client reconnection]
```

`packages/v2-core` provides `V2HistoryService`, canonicalization, a Yjs V2 decoder, and persistence ports. `schema.postgres.sql` and `PostgresDocumentStore` / `PostgresRevisionStore` are PostgreSQL reference adapters. The host supplies collaboration transport, authorization, queue instances, and room management. `packages/revision-history` provides the frontend API, controller, diff, Lit UI, and read-only viewer. The host owns the live editor and provider.

## 2. Writes and revision creation

1. After the collaboration service applies an incoming update to its active Y.Doc, it obtains full V2 state, body JSON, and title from that same state.
2. `prepareWrite` performs schema canonicalization, stable serialization, and hashing outside the document lock. `commitWrite` reads the current document under the lock and advances `revisionCount` only when the semantic body hash or title changes. It writes state, JSON, title, hash, and schema version together. If a structure cannot be canonicalized, it does not advance V2 metadata; the host may still persist raw state under its own policy and mark the failure.
3. **After the current state is durably persisted**, `Scheduler` schedules a delayed job. The last disconnect may trigger earlier materialization. A worker first compares the current content with the latest revision cheaply, then acquires the document lock, rereads the latest revision, and makes the authoritative decision. It creates an automatic revision only when the body hash or title differs.
4. Manual revisions are bookmarks. `createManual` saves the current complete state and JSON under the document lock, even when the content is identical. Revision versions increase monotonically under that lock.
5. The list uses an opaque `(version DESC, id DESC)` cursor and returns metadata and availability flags only. The client fetches JSON detail after selection. A historical state-only revision triggers on-demand JSON backfill on its first detail read. Detail also accepts the virtual `current-<documentId>` ID so the frontend can compare a revision with the current document.

Canonical content comparison avoids duplicate automatic revisions for the same visible body. A Yjs update's bytes contain client clocks and edit history and cannot serve as a business-content deduplication key. Custom nodes and marks need compatible schemas in the editor, server canonicalizer, and history viewer, plus JSON↔Yjs round-trip checks.

## 3. On-demand upgrade of historical snapshots

“Upgrade” here means filling a missing JSON projection from an imported **complete V2 state**. It neither re-encodes nor replaces the original state, and it does not compact the active collaboration document's state.

1. `list` queries metadata plus JSON and state presence only. A state-only row initially reports `legacy_pending`; lists do not fetch or decode the binary. `detail` first calls `getDetailRow` for metadata and state byte length. If JSON already exists, it is read directly.
2. If JSON is absent and state exists within the **5 MiB** limit, `getState` loads the binary. The host's `RevisionProjectionDecoder` should run in an **asynchronous bounded worker pool**. Inside that worker, the package's `decodeV2Projection` can decode the Y.Doc once, extract the body, canonicalize it with the host schema, and derive optional attribution from that same document and canonical tree.
3. The worker hashes canonical JSON with SHA-256 and labels the derived projection with `CURRENT_SCHEMA_VERSION` (currently **1**). When attribution extraction succeeds, `backfillProjectionIfMissing` uses `content_json IS NULL` as a compare-and-set and writes only JSON, hash, schema version, and attribution. It preserves original state, `sourceFormat='state_only'`, `mtime`, version, and contributors. If attribution extraction fails, content remains readable but backfill is skipped so a later request can retry. One concurrent request wins the backfill; after a lost CAS or failed backfill write, the service rechecks whether the row was deleted.
4. A successfully decoded, non-deleted detail immediately returns `ready`, `decodedFromState=true`, and diffable content. A subsequent read of persisted JSON returns `decodedFromState=false`. Missing state returns `legacy_pending`; oversized state, a missing decoder, or decode failure returns `legacy_failed`. Neither unavailable state supports diff, while `restorable` remains an independent test of original state presence. A saturated worker throws `RevisionProjectionBusyError`, which the host maps to retryable HTTP 503.

Diagnostics need only error classes and should never log document bodies. Attribution coordinates must correspond to the canonical content; previously stored whole-document credit or captured deletions should retain their stored semantics. If a row is soft-deleted during decoding and the recheck observes it, detail clears content and returns `deleted`. The virtual `current-<documentId>` detail does not take this backfill path. `migrateToCurrentSchemaVersion` gates registered migrations only; this repository includes no automatic cross-schema conversion or batch-upgrade worker. The new table constraint requires the JSON/hash/schema-version columns of a `state_only` row to be either all absent or all present. Existing PostgreSQL tables require an explicit constraint migration; rerunning `CREATE TABLE IF NOT EXISTS` does not alter them.

If the **latest revision** still lacks `content_hash` after import, automatic materialization's hash deduplication treats it as different content and may create an automatic revision with the same visible body. Before enabling automatic materialization, if the document's latest revision is an unfilled `state_only` row, the host can request its detail, then reread the list to confirm it is `ready`, meaning JSON and hash were durably backfilled. If decoding or backfill cannot complete, accept that the first automatic revision may repeat visible content and keep the original state for later handling.

## 4. History view and diff

The frontend `RevisionHistory` extension uses `RevisionHistoryController` for open/close, pagination, selection, comparison, and restore confirmation. `RevisionApiClient` handles the V2 envelope, cursor, auth header, and stable error classification. `RevisionViewerHost` displays historical JSON in a separate read-only ProseMirror `EditorView`. When the history panel is open, the host should lock the live body, title, and toolbar. It must not write historical JSON into the collaborative editor.

The diff modules tokenize JSON structure and text, calculate sequence, node, formatting, and attribution changes, and produce viewer decorations. Without trustworthy per-position attribution, changes stay neutral; the person who saved a revision is not assumed to have authored every character. The host may inject read-only media NodeViews. For unsupported custom nodes, the viewer presents readable content where possible and reports degradation.

List, detail, and comparison selection may change quickly. The controller cancels obsolete requests or discards late responses so old detail cannot replace the current selection. Restore is a write: after the HTTP acknowledgement, the host must still wait for the collaboration reset signal and a fresh sync before making the live editor writable again.

## 5. Restore and connected clients

```mermaid
sequenceDiagram
  participant UI as History panel / host
  participant API as V2HistoryService
  participant Store as Document and revision stores
  participant Room as RoomReset adapter
  UI->>API: restore(document, revision)
  API->>Store: Read and validate original target V2 state
  API->>Room: flushAndReset(document, reason, persist)
  Room->>Room: Gate new room loads; flush active Y.Doc
  Room->>Store: Save pre_restore when content differs
  Room->>Store: Replace current document with original target state
  Room->>Store: Write restore-source audit in the same transaction
  Room-->>UI: Broadcast reset after commit; close old connections
  API-->>UI: Return restore result
  UI->>UI: Destroy old editor, Y.Doc, and provider
  UI->>Room: Clear offline copy and reconnect
```

Restore writes the revision's **original full state** back to the current document. Decoding validates the state and derives coherent JSON/title; applying the target update to the old Y.Doc would merge CRDT histories. The host's `RoomReset` implementation must block old-room loads and writes during replacement, send reset to every instance, and close old connections. With IndexedDB or another offline Yjs copy, the client must clear that document's cache before reconnecting, or stale updates can reenter the new room.

The public service requires successful persistence of the pre-restore protection revision before replacement. The protection revision, target state replacement, and restore-source audit share one document transaction, which rolls back if any write fails. After commit, the host broadcasts reset and closes old connections. Access control must complete before constructing `DocumentContext`; a document ID in the query string is only a routing key.

## 6. Local demo and verification

`src/server/` uses file storage, a per-document serial queue, and a simple WebSocket; `src/client/` uses React and StarterKit. The demo reuses the core package's canonicalization, cursor, and deduplication algorithms but has its own REST, WebSocket, and revision model, as well as its own frontend UI. Its `document.reset`, close code 4205, and transport `epoch` demonstrate a stale-connection fence; `epoch` belongs only to the demo transport. See the root [README](../README.en.md) for runtime settings.

Package tests cover coherent state/JSON, deduplication under a lock, list pagination, on-demand historical JSON backfill, manual revisions, restore, and the frontend controller, diff, and read-only isolation. A real deployment also needs integration checks for its schema, transactional database, durable queue, bounded decoder worker pool, cross-instance rooms, and offline clients.
