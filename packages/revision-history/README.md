# V2 revision history client

This package opens a stored V2 revision list, compares canonical Tiptap JSON bodies in the browser, paints attributed changes, renders historical content in an isolated read-only ProseMirror `EditorView`, and sends an explicit restore request. It is adapted from an editor's production V2 revision-history module; names, palette, environment wiring, and media renderers have been replaced for public use. The source algorithms and controller lifecycle are preserved. No document text or account fixtures from the source system are included.

## Integration

Install compatible `@tiptap/core`, `@tiptap/pm`, and `lit`, build this package, and load `@tiptap-yjs-snapshot/revision-history/styles`. Mount the sidebar and the viewer in separate host elements. The host owns the live editor and collaboration provider:

```ts
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { RevisionHistory } from '@tiptap-yjs-snapshot/revision-history'
import '@tiptap-yjs-snapshot/revision-history/styles'

let editor: Editor
let resetPending = false
let documentToken = '' // Set from the host's short-lived auth state.
const liveEditorElement = document.getElementById('live-editor')!
const sidebarElement = document.getElementById('revision-sidebar')!
const viewerElement = document.getElementById('revision-viewer')!
const titleInput = document.querySelector<HTMLInputElement>('#document-title')!
const toolbarButtons = document.querySelectorAll<HTMLButtonElement>('#editor-toolbar button')

function setHostEditable(editable: boolean) {
  editor.setEditable(editable)
  titleInput.readOnly = !editable
  toolbarButtons.forEach(button => { button.disabled = !editable })
}

editor = new Editor({
  element: liveEditorElement,
  extensions: [
    StarterKit,
    RevisionHistory.configure({
      dataSource: 'v2',
      documentId: 'document-123',
      servicePrefix: '/api',
      mount: () => sidebarElement,
      viewerMount: () => viewerElement,
      auth: {
        getToken: () => documentToken,
        applyTokenEnvelope: ({ token }) => { documentToken = token },
      },
      canRestore: true,
      onOpenChange: ({ open }) => {
        setHostEditable(!open && !resetPending)
        // The viewer remains mounted in its own element beside the sidebar.
      },
      onRestoreComplete: () => {
        resetPending = true
        setHostEditable(false)
        editor.commands.closeRevisionHistory()
        // Rebuild the live Y.Doc, provider, and editor from the server's reset
        // signal. The restore HTTP response only acknowledges the request.
      },
    }),
  ],
})

// The host's collaboration event handler, after receiving document.reset or
// a server-defined reset close code (4205 in the source practice):
//   dispose the old provider and live Y.Doc
//   load a fresh document/provider, wait for initial sync
//   resetPending = false; setHostEditable(true)

editor.commands.openRevisionHistory()
```

The reference wire contract uses `GET /revisions/list`, `GET /revisions/detail`, and `POST /revisions/restore`. Every request includes `doc_id`; the default token header is `x-document-token`; successful responses use `{ code: 0, data }`. The list `data` contains `{ data: RevisionListItem[], nextCursor, hasMore }`. `RevisionTransportConfig` changes routes, query key, and header names while retaining the V2 response model. Use `tokenHeader: null` for a cookie-authenticated service. The server must authorize access independently of the document ID query value.

For restore, the HTTP adapter must answer `{ code: 0, data: { id: requestedTargetRevisionId } }`. An audit record may have its own ID, but it must not replace the target revision ID in this field: the client treats `data.id` as the restored target. Collaboration reset and fresh synchronization still determine when the live editor can resume.

```ts
const transport = {
  documentIdQueryKey: 'document_id',
  tokenHeader: 'authorization',
  refreshEnvelopeHeader: null,
  routes: {
    list: '/history',
    detail: '/history/item',
    restore: '/history/restore',
  },
} as const
```

Pass `transport` to `RevisionHistory.configure` or `createRevisionApiClient`. `fetchImpl` can be injected for browser or test environments. `RevisionViewerHost` uses the host's schema; unsupported historical node types retain readable children and report degradation. Custom media node views are supplied through `nodeViews` as read-only ProseMirror `NodeViewConstructor`s. If omitted, ProseMirror uses the schema's DOM serializer. Do not reuse upload-enabled live editor node views in the historical viewer.

## Source boundaries

| Preserved V2 practice | Public adaptation |
| --- | --- |
| API mapping, cursor pagination, current revision reference, restore errors | Configurable routes and auth headers |
| Controller state transitions, request cancellation, comparison selection, restore confirmation | No inactive placeholder controller |
| CJK tokenization, sequence/structure diff, attribution and change grouping | Synthetic public tests only |
| Diff decorations, Lit panel/list/dialog, isolated read-only `EditorView` | Neutral custom element names and CSS palette |
| Historical schema degradation | Host-supplied media node views instead of product-specific views |

The server is responsible for coherent V2 Yjs state and canonical JSON, revision materialization, access control, and active-room reset after restore. See the repository's backend package for that implementation. The client never applies a restored document state to its active provider from an HTTP response.

Run `npm run typecheck --prefix packages/revision-history`, `npm run build --prefix packages/revision-history`, and `npx vitest run packages/revision-history/__tests__` from the repository root.
