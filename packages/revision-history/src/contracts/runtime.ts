import type { RestoreResult, RevisionContent } from './api'

export interface RuntimeGeneration {
  readonly id: string
  readonly documentId: string
  readonly stateEpoch: number
}

export interface RevisionRuntimeAdapter {
  getGeneration(): RuntimeGeneration
  waitForInitialSync(input: {
    generation: RuntimeGeneration
    signal: AbortSignal
  }): Promise<void>
  getCurrentRevision(input: {
    generation: RuntimeGeneration
    signal: AbortSignal
  }): Promise<RevisionContent>
  rebuildAfterRestore(input: {
    previousGeneration: RuntimeGeneration
    result: RestoreResult
  }): Promise<RuntimeGeneration>
}
