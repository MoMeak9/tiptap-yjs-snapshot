import type {
  RevisionHistoryErrorCode,
  RevisionHistoryPublicError,
} from '../contracts/api'

/**
 * User-facing copy per failure code.
 *
 * `RevisionHistoryPublicError` carries a `messageKey` for a host translator, but
 * rendering that key directly puts a raw identifier like
 * `revisionHistory.apiUnavailable` on screen. The code set is closed and
 * exhaustively mapped here so every state has readable copy until a translator
 * is wired in.
 */
const COPY: Record<RevisionHistoryErrorCode, string> = {
  REVISION_LIST_FAILED: '版本列表加载失败，请重试',
  REVISION_DETAIL_FAILED: '版本内容加载失败，请重试',
  REVISION_UNAVAILABLE: '该版本内容不可用',
  REVISION_SCHEMA_UNSUPPORTED: '该版本由更新的编辑器创建，暂不支持查看',
  REVISION_HASH_MISMATCH: '版本内容校验失败，暂不可查看',
  REVISION_DIFF_FAILED: '版本对比失败，请重试',
  REVISION_API_UNAVAILABLE: '历史版本功能暂未开放',
  REVISION_BUSY: '历史内容解析繁忙，请稍后重试',
  REVISION_UNAUTHORIZED: '登录状态已失效，请刷新后重试',
  // The service answers 404 both for a disabled rollout gate and for a revision
  // outside this document, so the copy has to hold for either.
  REVISION_RESTORE_UNAVAILABLE: '该版本无法恢复',
  REVISION_RESTORE_FORBIDDEN: '你没有编辑权限，无法恢复此版本',
  RESTORE_PREFLIGHT_FAILED: '恢复前检查失败，请重试',
  RESTORE_EPOCH_STALE: '文档已被他人更新，请刷新后重试',
  RESTORE_RUNTIME_MISMATCH: '文档状态已变化，请刷新后重试',
  RESTORE_FAILED: '恢复失败，请重试',
}

const FALLBACK = '操作失败，请重试'

/**
 * Describes a failure for display.
 *
 * Only the mapped code is used — never `messageKey` or an attached `cause`, so
 * neither raw keys nor server exception text can reach the user.
 */
export function describeRevisionError(
  error: RevisionHistoryPublicError | null | undefined
): string {
  if (error === null || error === undefined) {
    return FALLBACK
  }
  return COPY[error.code] ?? FALLBACK
}
