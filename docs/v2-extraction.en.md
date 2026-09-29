# Scope of the public V2 practice-code adaptation

English · [简体中文](v2-extraction.zh-CN.md)

The main deliverable of this repository is reusable frontend and backend code adapted from an existing **V2 revision-history implementation**. V2 here means the history data and interaction contract: the current document and newly written revisions retain coherent full Yjs V2 state and canonical Tiptap JSON. An imported historical revision may temporarily contain complete V2 state alone and receive JSON on a detail read. Lists, detail, comparison, attribution, and restore operate around those two representations. Lightweight `Y.encodeSnapshotV2` metadata cannot reconstruct the body on its own.

## Design reference and code provenance

[Outline](https://github.com/outline/outline) informed delayed revision creation, body-and-title deduplication, a virtual current revision, metadata-only lists, and inline/block diff presentation. This project separately implements full Yjs V2 state plus JSON, CJK word boundaries, cursor pagination, and live collaboration restore. The mapping below follows **this project's own V2 source modules** into the public packages; this repository does not vendor Outline source code. [Outline's repository uses BSL 1.1](https://github.com/outline/outline/blob/main/LICENSE); this repository's code uses [MIT](../LICENSE).

The public adaptation preserves algorithms, state transitions, and critical write order while replacing product database, authorization, collaboration rooms, queue, identity directory, and media renderers with generic interfaces or omitting them. “Source module” entries below are paths relative to the source code repositories for responsibility tracing. The public code was sanitized, renamed, and generalized.

## Backend module mapping

| Source module (relative path) | Public module | Preserved practice and adaptation |
| --- | --- | --- |
| `packages/server/src/modules/history-core/{canonicalize,content-hash,schema-version}.ts` | `packages/v2-core/src/canonical.ts` | Schema round-trip, stable field ordering, content hash, and schema-version gate; the host injects its schema, with an observable degradation path for unknown types |
| `packages/server/src/modules/revision-persistence/document-history-fields.ts` | `packages/v2-core/src/document-history.ts` | Prepare JSON/hash outside the lock, compare business-level changes under the lock, and coherently write state, JSON, title, hash, and revision count |
| `packages/server/src/modules/revision-queue/{revision-dedup,revision-queue.processor,revision-queue.service}.ts` | `packages/v2-core/src/service.ts`, `src/adapters/{scheduler,redis}.ts` | Delayed scheduling after persistence, disconnect trigger, deduplication before and after locking, and attribution-interval claim/restore; the host can supply the queue and registry or use standard-environment adapters |
| `packages/server/src/modules/revision-persistence/revision-insert.ts` | `packages/v2-core/src/adapters/postgres.ts`, `schema.postgres.sql` | Unified insert columns and monotonically increasing version/time under a document lock; the public reference adapter uses PostgreSQL rather than the source ORM or table names |
| `packages/server/src/modules/revision-manual/revision-manual.service.ts` | `V2HistoryService.createManual` | Named manual bookmarks may repeat identical content |
| `packages/server/src/modules/revision-list/{revision-cursor,revision-current,revision-list.service,revision-detail.service}.ts` | `packages/v2-core/src/cursor.ts`, `service.ts`, `state-codec.ts` | Opaque cursor, metadata-only list, virtual `current-<documentId>` detail, and document-scoped reads; the public adaptation adds on-demand JSON projection for historical complete-V2-state rows |
| The V2 restore flow in `packages/server/src/modules/snapshot/snapshot.service.ts` | `V2HistoryService.restore`, `state-codec.ts`, `RoomReset` port | Replace the current document with the target's original full V2 state, preserve pre-restore content, record the restore source, and reset active collaboration rooms |

The backend entry point is `packages/v2-core/src/index.ts`. `ports.ts` defines `DocumentStore`, `RevisionStore`, `Scheduler`, `RoomReset`, and optional `RevisionProjectionDecoder`, `IntervalPort` / `EventPublisher` / failure-marker ports. The host owns HTTP controllers and identity checks. It must authorize document access before constructing `DocumentContext` and calling `list`, `detail`, `createManual`, or `restore`. See the [backend package guide](../packages/v2-core/README.en.md) for the PostgreSQL schema and driver wrapper.

The queue adapter is a generic modernization. Proxy-command restrictions from the source environment were not carried over. The public package accepts a structural BullMQ driver and a standard Redis 6.2+ `EVAL` / `GETDEL` registry, or other durable queue and TTL-registry implementations. This adapter handles revision jobs only; it does not synchronize collaborative documents or awareness. Room reset remains the separate `RoomReset` port. See the [backend package guide](../packages/v2-core/README.en.md) for Cluster hash-slot requirements.

### Public practice for upgrading historical snapshots

For imported `sourceFormat='state_only'` revisions, the public package **fills JSON on a detail read**. Lists still query metadata only; detail first checks the state byte length, and state larger than **5 MiB** never enters the decoder. The host should connect the asynchronous `RevisionProjectionDecoder` to a bounded worker pool using the same ProseMirror schema as the service. Inside the worker, `decodeV2Projection` can derive canonical body content, hash, and optional attribution from the same Y.Doc. Once attribution extraction succeeds, backfill uses `content_json IS NULL` as a compare-and-set and updates only JSON, content hash, `schemaVersion`, and attribution. Original state, provenance marker, `mtime`, and version remain intact. If attribution extraction fails, content remains readable but backfill is skipped for a later retry; after a lost CAS or write failure the service rechecks soft deletion. The host maps a saturated worker to retryable HTTP 503.

`availability` and `restorable` separately indicate preview capability and whether original state exists. Oversized, undecodable, or schema-incompatible state is not diffable, but the original state is not automatically deleted; restore independently validates it. If a row is soft-deleted during decoding and the recheck observes it, detail clears the derived content. The new table constraint requires a `state_only` row's JSON/hash/schema-version columns to be all absent or all present. The current `schemaVersion` is **1**, with no bundled cross-schema migration or batch-upgrade worker. This fills a historical JSON projection; it does not compact the active collaboration state. See the [architecture](architecture.en.md#3-on-demand-upgrade-of-historical-snapshots) and [data contract](contract.en.md#on-demand-historical-snapshot-upgrade-contract).

## Frontend module mapping

The frontend source directory is `packages/extensions/revision-history/src/`; the public directory is `packages/revision-history/src/`. These V2 file groups were adapted by responsibility while retaining testable diff algorithms and controller lifecycle.

| Source directory or module | Public directory or module | Preserved practice and adaptation |
| --- | --- | --- |
| `api/revision-api-client.ts`, `contracts/` | Same-named paths | V2 list/detail/restore response mapping, current-revision reference, cursors, auth-token refresh, and stable error classification; prefix, routes, headers, and `fetch` are configurable |
| `controller/revision-history-controller.ts`, `revision-history.ts` | Same-named files | Open/close, selection, comparison, obsolete-request cancellation, restore confirmation, and handoff to the host editor; runtime and mount points are injected |
| `diff/{tokenize,sequence-diff,diff-documents,diff-title,attribution,change-groups,diff-decorations}.ts` | Same-named directory and files | CJK tokenization, Myers sequence diff, structural diff, text attribution, and decorations; changes without attribution evidence stay neutral |
| `ui/`, `styles/version-history.scss` | Same-named paths | Lit list, panel, restore dialog, and styling; component names, copy, and palette use neutral public forms |
| `viewer/{render-history-document,revision-viewer-host}.ts` | Same-named paths | Separate read-only `EditorView`, historical schema degradation, and host isolation; media NodeViews are injected by the host |

Specialized image, audio/video, attachment, and embed NodeViews from the source directory are not published directly. A host with custom nodes can pass read-only `nodeViews` to `RevisionViewerHost` and verify historical JSON against its schema. The frontend package uses synthetic documents to test API, controller, diff, and viewer behavior; it contains no real document text, account fixture, or private resource. See the [frontend package guide](../packages/revision-history/README.md).

## Boundary of the public demo

`src/server/` and `src/client/` form an independent local example. The server uses canonicalization, cursor, and deduplication functions from `v2-core`, but implements its own file persistence, REST, and simple WebSocket transport. The React client shows live editing and history interactions. The demo does not call the full `V2HistoryService`, PostgreSQL adapter, or frontend `RevisionHistory` extension. It can verify V2 data and interaction paths; production integration of the two public packages is documented in their respective READMEs. Its short delay window, single-process serialization, and WebSocket `epoch` are local adaptations. `epoch` is not a V2 REST field.

The public code retains data types and service handling for `open_api`, automatic, manual, pre-restore, and restore records. The local demo exposes only automatic, manual, and restore operations. The host supplies product database structure, distributed queue driver, Hocuspocus room management, real identity and document tokens, proprietary node schema, notification/observability, and offline IndexedDB management. Frontend and backend transport success uses `{ code: 0, data }`. The frontend transport configuration can change routes and request headers, but the response fields it consumes must remain available.

## Restore and failure semantics

Complete Yjs V2 state is authoritative for restore. The service decodes and canonicalizes the target, preserves pre-restore content, then writes back the target's original state. The `RoomReset` implementation must prevent the old room from continuing to write, notify and disconnect connected clients. Clients destroy the old editor, Y.Doc, and provider, clear the document's offline cache, and reconnect. Directly applying the target update to an old Y.Doc merges two CRDT histories and cannot guarantee an exact restore.

The public service requires a successful pre-restore protection write before replacement. Once `RoomReset` blocks stale room writes, the protection revision, target state replacement, and restore-source audit are written in one document transaction; failure at any step rolls that transaction back. After commit, the host broadcasts reset and disconnects live clients. The local demo uses an atomic file replacement, which is not a substitute for a production database transaction.

## Verification scope

Package tests use synthetic documents to cover coherent JSON/state, semantic deduplication, repeated manual revisions, cursor and virtual current detail, on-demand historical state backfill, restore, and frontend async state. The repository root also retains local demo tests. `npm run check:public` scans public files for private identifiers and sensitive patterns. These checks do not replace host-environment schema round trips, database concurrency, bounded-worker saturation, queue failures, cross-instance eviction, and offline-client restore drills.
