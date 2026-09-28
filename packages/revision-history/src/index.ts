export { RevisionHistory } from './revision-history'

export {
  createRevisionApiClient,
  currentRevisionId,
  RevisionApiError,
} from './api/revision-api-client'
export type { RevisionApiClientConfig, RevisionTransportConfig } from './api/revision-api-client'
export { RevisionHistoryController } from './controller/revision-history-controller'
export type {
  RevisionDiffPort,
  RevisionHistoryControllerConfig,
} from './controller/revision-history-controller'

export type {
  RevisionApiClient,
  RevisionAuthAdapter,
  RevisionAvailability,
  RevisionCollaborator,
  RevisionContent,
  RevisionHistoryErrorCode,
  RevisionHistoryPublicError,
  RevisionListItem,
  RevisionPage,
  RevisionRef,
  RestoreResult,
} from './contracts/api'
export type {
  CompareTarget,
  DescriptorFactoryContext,
  RevisionDegradationEvent,
  RevisionExtensionDescriptor,
  RevisionHistoryControllerPort,
  RevisionHistoryOpenChangeEvent,
  RevisionHistoryOptions,
  RevisionHistoryRestoreCompleteEvent,
  RuntimeMode,
} from './contracts/controller'
export type {
  RevisionRuntimeAdapter,
  RuntimeGeneration,
} from './contracts/runtime'
export type {
  RevisionHistoryViewState,
  RevisionViewerState,
} from './contracts/state'
export {
  formatContributors,
  formatRevisionTime,
  groupRevisionsByDate,
} from './ui/date-groups'
export type { RevisionDateGroup } from './ui/date-groups'
export {
  dispatchRevisionIntent,
  REVISION_CLOSE_EVENT,
  REVISION_COMPARE_TARGET_CHANGE_EVENT,
  REVISION_LOAD_NEXT_PAGE_EVENT,
  REVISION_RESTORE_CANCEL_EVENT,
  REVISION_RESTORE_CONFIRM_EVENT,
  REVISION_RESTORE_REQUEST_EVENT,
  REVISION_SELECT_EVENT,
  REVISION_SHOW_CHANGES_EVENT,
  REVISION_STEP_CHANGE_EVENT,
} from './ui/events'
export type {
  RevisionCloseDetail,
  RevisionCompareTargetChangeDetail,
  RevisionLoadNextPageDetail,
  RevisionRestoreCancelDetail,
  RevisionRestoreConfirmDetail,
  RevisionRestoreRequestDetail,
  RevisionSelectDetail,
  RevisionShowChangesDetail,
  RevisionStepChangeDetail,
} from './ui/events'
export { RevisionList } from './ui/revision-list'
export { RevisionRestoreConfirmDialog } from './ui/restore-confirm-dialog'
export { RevisionViewerShell } from './ui/revision-viewer-shell'
export { RevisionHistoryPanel } from './ui/revision-history-panel'
export { buildDiffDecorations } from './diff/diff-decorations'
export { diffDocuments, EMPTY_REVISION_DIFF } from './diff/diff-documents'
export type {
  RevisionChange,
  RevisionChangeKind,
  RevisionDiff,
} from './diff/diff-documents'
export { createAttributionIndex } from './diff/attribution'
export type {
  AttributionIndex,
  AttributionRange,
  RangesAttribution,
  RevisionAttribution,
  WholeAttribution,
} from './diff/attribution'
export { renderHistoryDocument } from './viewer/render-history-document'
export type {
  HistoryDegradation,
  HistoryDegradationKind,
  HistoryDocumentRender,
} from './viewer/render-history-document'
export { RevisionViewerHost } from './viewer/revision-viewer-host'
export type { RevisionViewerHostConfig } from './viewer/revision-viewer-host'
