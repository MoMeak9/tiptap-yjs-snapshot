import { Extension } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { createRevisionApiClient } from './api/revision-api-client'
import type {
  RevisionHistoryControllerPort,
  RevisionHistoryOptions,
} from './contracts/controller'
import { RevisionHistoryController } from './controller/revision-history-controller'
import { diffDocuments } from './diff/diff-documents'
import { CollaboratorColorAssigner } from './ui/collaborator-colors'
import './ui/revision-history-panel'
import { renderHistoryDocument } from './viewer/render-history-document'
import { RevisionViewerHost } from './viewer/revision-viewer-host'

/**
 * Controller plus the lifecycle and toggle affordances the extension needs.
 *
 * `toggle` stays off `RevisionHistoryControllerPort` because the UI never needs
 * it: components render from a snapshot and emit explicit open/close intents.
 * Only the Tiptap command surface toggles.
 */
type DisposableController = RevisionHistoryControllerPort & {
  toggle(): void
  dispose(): void
}

interface RevisionHistoryStorage {
  controller: DisposableController | null
  createdPanel: HTMLElement | null
  viewerHost: RevisionViewerHost | null
  unsubscribeViewer: (() => void) | null
  mountResolved: boolean
}

/** Build the V2 controller from the host's transport and live schema. */
function createController(
  options: RevisionHistoryOptions,
  schema: Schema
): DisposableController {
  return new RevisionHistoryController({
    api: createRevisionApiClient({
      documentId: options.documentId,
      servicePrefix: options.servicePrefix,
      auth: options.auth,
      fetchImpl: options.fetchImpl,
      transport: options.transport,
    }),
    documentId: options.documentId,
    // Both sides go through the same degrading renderer the viewer uses, so the
    // diff is computed over exactly what is on screen — diffing the raw JSON
    // would report changes in content the viewer had dropped.
    diff: (compared, selected) =>
      diffDocuments(
        renderHistoryDocument(schema, compared).doc,
        renderHistoryDocument(schema, selected).doc
      ).changes,
    onError: options.onError,
    onOpenChange: open => {
      options.onOpenChange?.({ documentId: options.documentId, open })
    },
    onRestoreComplete: result => {
      options.onRestoreComplete?.({
        documentId: options.documentId,
        revisionId: result.revisionId,
      })
    },
  })
}

function isHTMLElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== 'undefined' && value instanceof HTMLElement
}

/**
 * Builds the body renderer, or nothing when the host gave it no place to render.
 *
 * A missing or failing `viewerMount` is fail-soft on purpose: the sidebar list
 * is useful on its own, and losing it because the document area could not be
 * resolved would be a worse outcome than showing no body.
 */
function createViewerHost(
  options: RevisionHistoryOptions,
  schema: Schema,
  colors: CollaboratorColorAssigner
): RevisionViewerHost | null {
  if (options.viewerMount === undefined) {
    return null
  }

  let container: unknown
  try {
    container = options.viewerMount()
  } catch {
    return null
  }
  if (!isHTMLElement(container) || container.ownerDocument === null) {
    return null
  }

  const { documentId, onDegradation } = options
  return new RevisionViewerHost({
    container,
    schema,
    nodeViews: options.nodeViews,
    colors,
    onDegradation:
      onDegradation === undefined
        ? undefined
        : degradations => {
            // Names and kinds only: a degradation must never carry document
            // text into a diagnostic sink.
            onDegradation({
              documentId,
              kinds: [...new Set(degradations.map(entry => entry.kind))],
              names: [...new Set(degradations.map(entry => entry.name))],
              count: degradations.length,
            })
          },
  })
}

function defaultOptions(): RevisionHistoryOptions {
  return {
    documentId: '',
    servicePrefix: '',
    dataSource: 'v2',
    auth: {
      getToken: () => '',
      applyTokenEnvelope: () => undefined,
    },
    mount: () => {
      throw new Error('RevisionHistory mount is not configured')
    },
    viewerMount: undefined,
    nodeViews: undefined,
    canRestore: true,
    onDegradation: undefined,
    fetchImpl: undefined,
    transport: undefined,
    addonDescriptors: undefined,
    onOpenChange: undefined,
    onRestoreComplete: undefined,
    onError: undefined,
  }
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    revisionHistory: {
      openRevisionHistory: () => ReturnType
      closeRevisionHistory: () => ReturnType
      toggleRevisionHistory: () => ReturnType
      nextRevisionChange: () => ReturnType
      previousRevisionChange: () => ReturnType
    }
  }
}

export const RevisionHistory = Extension.create<
  RevisionHistoryOptions,
  RevisionHistoryStorage
>({
  name: 'revisionHistory',

  addOptions() {
    return defaultOptions()
  },

  addStorage() {
    return {
      controller: null,
      createdPanel: null,
      viewerHost: null,
      unsubscribeViewer: null,
      mountResolved: false,
    }
  },

  onCreate() {
    if (this.storage.mountResolved) {
      return
    }
    this.storage.mountResolved = true

    let host: unknown
    try {
      host = this.options.mount()
    } catch {
      return
    }

    if (!isHTMLElement(host)) {
      return
    }

    let ownerDocument: Document | null
    try {
      ownerDocument = host.ownerDocument
    } catch {
      return
    }
    if (ownerDocument === null) {
      return
    }

    const controller = createController(this.options, this.editor.schema)
    // One assigner for both surfaces: the sidebar's dots and the body's diff must
    // agree on a person's colour, and the design requires one colour per person
    // per document.
    const colors = new CollaboratorColorAssigner()
    type PanelElement = HTMLElement & {
      controller?: RevisionHistoryControllerPort | null
      colors?: CollaboratorColorAssigner
      canRestore?: boolean
    }
    let panel: PanelElement | null = null
    try {
      panel = ownerDocument.createElement(
        'yjs-revision-history-panel'
      ) as PanelElement
      panel.controller = controller
      panel.colors = colors
      // Host policy for the whole panel, not a per-revision fact: `false` hides
      // the restore action (see RevisionHistoryOptions.canRestore).
      panel.canRestore = this.options.canRestore ?? true
      host.appendChild(panel)
    } catch {
      if (panel?.parentNode === host) {
        try {
          host.removeChild(panel)
        } catch {
          // The host owns the append operation; a failing cleanup is isolated.
        }
      }
      controller.dispose()
      return
    }

    this.storage.controller = controller
    this.storage.createdPanel = panel

    this.storage.viewerHost = createViewerHost(
      this.options,
      this.editor.schema,
      colors
    )
    if (this.storage.viewerHost !== null) {
      const host = this.storage.viewerHost
      this.storage.unsubscribeViewer = controller.subscribe(snapshot => {
        host.update(snapshot)
      })
    }
  },

  onDestroy() {
    const controller = this.storage.controller
    const panel = this.storage.createdPanel
    const unsubscribeViewer = this.storage.unsubscribeViewer
    const viewerHost = this.storage.viewerHost

    this.storage.controller = null
    this.storage.createdPanel = null
    this.storage.unsubscribeViewer = null
    this.storage.viewerHost = null

    // Unsubscribe before disposing so a dispose-time snapshot cannot reach a
    // viewer that is about to be torn down.
    unsubscribeViewer?.()
    controller?.dispose()
    viewerHost?.destroy()

    if (panel !== null && panel.parentNode !== null) {
      panel.parentNode.removeChild(panel)
    }
  },

  addCommands() {
    return {
      openRevisionHistory: () => () => {
        const controller = this.storage.controller
        if (controller === null) {
          return false
        }
        controller.open()
        return true
      },
      closeRevisionHistory: () => () => {
        const controller = this.storage.controller
        if (controller === null) {
          return false
        }
        controller.close()
        return true
      },
      toggleRevisionHistory: () => () => {
        const controller = this.storage.controller
        if (controller === null) {
          return false
        }
        controller.toggle()
        return true
      },
      nextRevisionChange: () => () => {
        const controller = this.storage.controller
        if (controller === null) {
          return false
        }
        controller.stepChange(1)
        return true
      },
      previousRevisionChange: () => () => {
        const controller = this.storage.controller
        if (controller === null) {
          return false
        }
        controller.stepChange(-1)
        return true
      },
    }
  },
})
