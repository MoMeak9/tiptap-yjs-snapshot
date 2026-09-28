import { Editor, type JSONContent } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import StarterKit from '@tiptap/starter-kit'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createRevisionApi, type RevisionDetail, type RevisionSummary } from './api'
import { diffRevisions, type RevisionChange } from './diff'
import { createRealtimeSession, type RealtimeStatus } from './realtime'

const api = createRevisionApi()
const PAGE_SIZE = 12
const RESTORE_RESET_GRACE_MS = 1200

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function isAbort(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

function revisionTime(revision: { ctime: number }) {
  const raw = revision.ctime
  if (!raw) return '时间未知'
  const date = new Date(raw)
  return Number.isNaN(date.valueOf()) ? String(raw) : date.toLocaleString('zh-CN', { hour12: false })
}

function formatStatus(status: RealtimeStatus) {
  if (status === 'ready') return '实时连接正常'
  if (status === 'reconnecting') return '连接中断，正在重连'
  if (status === 'resetting') return '文档已恢复，正在重建编辑器'
  return '正在连接协作服务'
}

function Toolbar({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  const act = (command: (editor: Editor) => void) => () => {
    if (editor && !disabled) command(editor)
  }
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="正文格式">
      <button type="button" disabled={disabled} onClick={act((e) => e.chain().focus().toggleBold().run())} aria-label="加粗">B</button>
      <button type="button" disabled={disabled} onClick={act((e) => e.chain().focus().toggleItalic().run())} aria-label="斜体"><em>I</em></button>
      <button type="button" disabled={disabled} onClick={act((e) => e.chain().focus().toggleHeading({ level: 2 }).run())} aria-label="二级标题">H2</button>
      <span className="toolbar-divider" />
      <button type="button" disabled={disabled} onClick={act((e) => e.chain().focus().toggleBulletList().run())} aria-label="无序列表">• 列表</button>
      <button type="button" disabled={disabled} onClick={act((e) => e.chain().focus().toggleOrderedList().run())} aria-label="有序列表">1. 列表</button>
      <button type="button" disabled={disabled} onClick={act((e) => e.chain().focus().toggleBlockquote().run())} aria-label="引用">“ 引用</button>
    </div>
  )
}

function LiveDocument({ docId, onReset, readOnly, resetPending }: { docId: string; onReset: () => void; readOnly: boolean; resetPending: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<RealtimeStatus>('connecting')
  const [title, setTitle] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const titleTextRef = useRef<ReturnType<ReturnType<typeof createRealtimeSession>['doc']['getText']> | null>(null)
  const resetCallback = useRef(onReset)
  const readOnlyRef = useRef(readOnly)
  useEffect(() => { resetCallback.current = onReset }, [onReset])
  useEffect(() => { readOnlyRef.current = readOnly; editor?.setEditable(!readOnly && status === 'ready') }, [readOnly, editor, status])

  useEffect(() => {
    let liveEditor: Editor | null = null
    let active = true
    const session = createRealtimeSession({
      docId,
      onStatus(next) {
        if (!active) return
        setStatus(next)
        if (next === 'ready') {
          setConnectionError(null)
          if (!liveEditor && hostRef.current) {
            liveEditor = new Editor({
              element: hostRef.current,
              extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: session.doc, field: 'default' })],
              editorProps: { attributes: { class: 'tiptap live-content', 'aria-label': '实时正文编辑器' } },
              autofocus: false,
            })
            setEditor(liveEditor)
          }
          liveEditor?.setEditable(!readOnlyRef.current)
        } else {
          liveEditor?.setEditable(false)
        }
      },
      onReset() {
        if (!active) return
        liveEditor?.setEditable(false)
        resetCallback.current()
      },
      onError(message) {
        if (active) setConnectionError(message)
      },
    })
    const titleText = session.doc.getText('title')
    titleTextRef.current = titleText
    const updateTitle = () => { if (active) setTitle(titleText.toString()) }
    titleText.observe(updateTitle)
    updateTitle()

    return () => {
      active = false
      titleText.unobserve(updateTitle)
      titleTextRef.current = null
      liveEditor?.destroy()
      session.destroy()
    }
  }, [docId])

  function changeTitle(value: string) {
    const text = titleTextRef.current
    if (!text || status !== 'ready' || readOnly) return
    text.doc?.transact(() => {
      text.delete(0, text.length)
      text.insert(0, value)
    }, 'title-input')
    setTitle(value)
  }

  return (
    <section className="card live-card" aria-label="实时文档">
      <div className="card-heading">
        <div>
          <p className="eyebrow">01 · LIVE DOCUMENT</p>
          <h2>当前文档</h2>
        </div>
        <span className={`connection-pill ${status === 'ready' ? 'connected' : ''}`}><span className="status-dot" />{formatStatus(status)}</span>
      </div>
      {connectionError && <p className="inline-error" role="status">{connectionError}</p>}
      <label className="field-label" htmlFor="document-title">标题</label>
      <input id="document-title" className="title-input" value={title} onChange={(event) => changeTitle(event.target.value)} placeholder="给文档起个标题" disabled={status !== 'ready' || readOnly} />
      <div className="field-label body-label">正文 <span>自动同步到当前文档</span></div>
      <Toolbar editor={editor} disabled={status !== 'ready' || !editor || readOnly} />
      <div ref={hostRef} className="editor-surface" />
      {readOnly && <p className="editor-hint">{resetPending ? '等待协作重置，当前文档暂时只读。' : '版本历史已打开，当前文档暂时只读。'}</p>}
      {status !== 'ready' && <p className="editor-hint">连接就绪后即可编辑。恢复修订时会重新创建实时编辑器。</p>}
    </section>
  )
}

function ReadOnlyDocument({ title, content, label }: { title: string; content: JSONContent; label: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [renderError, setRenderError] = useState(false)
  useEffect(() => {
    if (!hostRef.current) return
    try {
      const editor = new Editor({
        element: hostRef.current,
        extensions: [StarterKit],
        content,
        editable: false,
        editorProps: { attributes: { class: 'tiptap preview-content', 'aria-label': label } },
      })
      setRenderError(false)
      return () => editor.destroy()
    } catch {
      setRenderError(true)
    }
  }, [content, label])
  return (
    <div className="preview-document">
      <div className="preview-document-title">{title || '未命名文档'}</div>
      <div ref={hostRef} className="preview-surface" />
      {renderError && <p className="inline-error">此版本包含 StarterKit 不支持的节点，示例无法渲染。</p>}
    </div>
  )
}

function RevisionList({
  revisions, selectedId, loading, moreLoading, hasMore, error, onSelect, onMore, onRetry,
}: {
  revisions: RevisionSummary[]
  selectedId: string | null
  loading: boolean
  moreLoading: boolean
  hasMore: boolean
  error: string | null
  onSelect: (id: string) => void
  onMore: () => void
  onRetry: () => void
}) {
  return (
    <div className="revision-list-wrap">
      <div className="section-line"><h3>修订记录</h3><span>{revisions.length} 条已加载</span></div>
      {loading && revisions.length === 0 && <div className="empty-state">正在读取修订记录…</div>}
      {!loading && revisions.length === 0 && !error && <div className="empty-state">还没有自动版本。编辑并离开文档后，服务端会生成历史记录。</div>}
      <div className="revision-list" role="listbox" aria-label="修订记录">
        {revisions.map((revision) => (
          <button
            type="button"
            role="option"
            aria-selected={selectedId === revision.id}
            className={`revision-item ${selectedId === revision.id ? 'selected' : ''}`}
            key={revision.id}
            onClick={() => onSelect(revision.id)}
          >
            <span className="version-badge">V{revision.version}</span>
            <span className="revision-text"><strong>{revision.name || `版本 ${revision.version}`}</strong><small>{revisionTime(revision)} · {revision.type === 'auto' ? '自动' : revision.type === 'manual' ? '手动' : revision.type === 'pre_restore' ? '恢复前' : '恢复'}</small>{revision.createdByUser && <small>触发：{revision.createdByUser.nickname || revision.createdByUser.username}</small>}{revision.collaborators?.length > 0 && <small>区间协作者：{revision.collaborators.map((person) => person.nickname || person.username).join('、')}</small>}{revision.restoredFromVersion != null && <small>恢复自 V{revision.restoredFromVersion}</small>}{revision.availability !== 'ready' && <small className="availability-note">{revision.availability === 'legacy_pending' ? '旧版本迁移中' : revision.availability === 'deleted' ? '已删除' : '旧版本尚不可预览'}</small>}</span>
            <span className="revision-chevron">›</span>
          </button>
        ))}
      </div>
      {error && <div className="list-error" role="alert">{error}<button type="button" onClick={onRetry}>重试</button></div>}
      {hasMore && <button type="button" className="load-more" disabled={moreLoading} onClick={onMore}>{moreLoading ? '加载中…' : '加载更多修订'}</button>}
    </div>
  )
}

function changeLabel(change: RevisionChange) {
  if (change.kind === 'title') return `标题：「${change.before || '未命名'}」→「${change.after || '未命名'}」`
  if (change.kind === 'block') return `第 ${change.block} 块结构：${change.before} → ${change.after}`
  if (change.kind === 'format') return `第 ${change.block} 块格式调整：「${change.text}」${change.before} → ${change.after}`
  return `第 ${change.block} 块${change.kind === 'insert' ? '新增' : '删除'}：「${change.text}」`
}

function SnapshotPanel({ detail, comparison, comparisonTarget, loading, compareLoading, error, comparisonError, onRestore, onCompare }: {
  detail: RevisionDetail | null
  comparison: RevisionDetail | null
  comparisonTarget: 'previous' | 'current'
  loading: boolean
  compareLoading: boolean
  error: string | null
  comparisonError: string | null
  onRestore: () => void
  onCompare: (target: 'previous' | 'current') => Promise<void>
}) {
  const [mode, setMode] = useState<'preview' | 'compare'>('preview')
  const from = comparisonTarget === 'previous' ? comparison : detail
  const to = comparisonTarget === 'previous' ? detail : comparison
  const diff = useMemo(() => from?.content && to?.content ? diffRevisions(
    { title: from.title, content: from.content },
    { title: to.title, content: to.content },
  ) : null, [from, to])
  if (loading) return <div className="preview-placeholder">正在读取版本正文…</div>
  if (error) return <div className="preview-placeholder error" role="alert">{error}</div>
  if (!detail) return <div className="preview-placeholder">从左侧选择一个修订版本，查看独立的只读预览。</div>
  return (
    <div className="snapshot-panel">
      <div className="snapshot-header">
        <div><span className="version-badge">V{detail.version}</span><h3>{detail.name || `版本 ${detail.version}`}</h3><p>{revisionTime(detail)} · ID {detail.id}</p></div>
        {detail.restorable && <button type="button" className="restore-button" onClick={onRestore}>恢复此版本</button>}
      </div>
      {detail.availability !== 'ready' && <p className="inline-error" role="status">{detail.availability === 'legacy_pending' ? '旧版本迁移中，正文尚不可用。' : detail.availability === 'deleted' ? '此版本已删除。' : detail.restorable ? '旧版本尚不可预览或比较，但仍可恢复。' : '旧版本尚不可用，无法预览或恢复。'}</p>}
      <div className="tab-row" role="tablist" aria-label="快照视图">
        <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>历史预览</button>
        <button type="button" role="tab" aria-selected={mode === 'compare'} className={mode === 'compare' ? 'active' : ''} disabled={!detail.diffEligible || !detail.content} onClick={() => { setMode('compare'); void onCompare('previous') }}>对比变更</button>
      </div>
      {mode === 'preview' ? (
        detail.content ? <ReadOnlyDocument key={detail.id} title={detail.title} content={detail.content} label="历史快照正文" /> : <div className="empty-state">此版本没有可预览的正文。</div>
      ) : (
        <div className="comparison">
          <div className="compare-controls">
            <button type="button" className={comparisonTarget === 'previous' ? 'active' : ''} onClick={() => void onCompare('previous')}>对照前一版本</button>
            <button type="button" className={comparisonTarget === 'current' ? 'active' : ''} onClick={() => void onCompare('current')}>对照当前版本</button>
          </div>
          {compareLoading && <div className="empty-state">正在计算版本差异…</div>}
          {comparisonError && <p className="inline-error" role="status">{comparisonError}</p>}
          {!compareLoading && diff && <>
            <div className="compare-meta"><span className={diff.changes.length ? 'different' : 'same'}>{diff.changes.length ? `${diff.changes.length} 处变更` : '标题与正文一致'}</span></div>
            <ol className="change-list" aria-label="变更明细">{diff.changes.map((change, index) => <li key={`${change.kind}-${index}`} className={`change-${change.kind}`}>{changeLabel(change)}</li>)}</ol>
            {diff.warnings.map((warning) => <p className="preview-note" key={warning}>{warning}</p>)}
            <div className="compare-grid">
              <div><h4>{comparisonTarget === 'previous' ? `前一版本 · V${comparison?.version}` : `所选版本 · V${detail.version}`}</h4>{from?.content && <ReadOnlyDocument key={`from-${from.id}`} title={from.title} content={from.content} label="比较起点正文" />}</div>
              <div><h4>{comparisonTarget === 'previous' ? `所选版本 · V${detail.version}` : '当前服务端状态'}</h4>{to?.content && <ReadOnlyDocument key={`to-${to.id}`} title={to.title} content={to.content} label="比较终点正文" />}</div>
            </div>
          </>}
        </div>
      )}
      <p className="preview-note">历史正文由独立的只读编辑器渲染。差异仅覆盖 StarterKit 文本、格式、块结构和标题；逐项作者归属不可用。</p>
    </div>
  )
}

export function App() {
  const [docId] = useState(() => new URLSearchParams(window.location.search).get('doc_id') || 'demo')
  const [generation, setGeneration] = useState(0)
  const generationRef = useRef(0)
  const [name, setName] = useState('')
  const [revisions, setRevisions] = useState<RevisionSummary[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [restorePendingReset, setRestorePendingReset] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RevisionDetail | null>(null)
  const [comparison, setComparison] = useState<RevisionDetail | null>(null)
  const [comparisonTarget, setComparisonTarget] = useState<'previous' | 'current'>('previous')
  const [compareLoading, setCompareLoading] = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [moreLoading, setMoreLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [comparisonError, setComparisonError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const listSeq = useRef(0)
  const detailSeq = useRef(0)
  const listAbort = useRef<AbortController | null>(null)
  const detailAbort = useRef<AbortController | null>(null)
  const pageCursor = useRef<string | null>(null)
  const moreAvailable = useRef(false)
  const comparisonSeq = useRef(0)
  const resetCount = useRef(0)
  const restoreFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadList = useCallback(async (reset: boolean) => {
    if (!reset && !moreAvailable.current) return
    listAbort.current?.abort()
    const controller = new AbortController()
    listAbort.current = controller
    const sequence = ++listSeq.current
    if (reset) setListLoading(true)
    else setMoreLoading(true)
    setListError(null)
    try {
      const page = await api.list(docId, PAGE_SIZE, reset ? undefined : pageCursor.current || undefined, controller.signal)
      if (sequence !== listSeq.current) return
      pageCursor.current = page.nextCursor
      moreAvailable.current = page.hasMore
      setHasMore(page.hasMore)
      setRevisions((previous) => {
        if (reset) return page.data
        const seen = new Set(previous.map((item) => item.id))
        return [...previous, ...page.data.filter((item) => !seen.has(item.id))]
      })
    } catch (error) {
      if (sequence === listSeq.current && !isAbort(error)) setListError(errorMessage(error))
    } finally {
      if (sequence === listSeq.current) {
        setListLoading(false)
        setMoreLoading(false)
      }
    }
  }, [docId])

  const selectRevision = useCallback(async (id: string) => {
    detailAbort.current?.abort()
    const controller = new AbortController()
    detailAbort.current = controller
    const sequence = ++detailSeq.current
    comparisonSeq.current += 1
    setSelectedId(id)
    setDetail(null)
    setComparison(null)
    setComparisonTarget('previous')
    setCompareLoading(false)
    setDetailLoading(true)
    setDetailError(null)
    setComparisonError(null)
    try {
      const result = await api.detail(docId, id, controller.signal)
      if (sequence === detailSeq.current) setDetail(result)
    } catch (error) {
      if (sequence === detailSeq.current && !isAbort(error)) setDetailError(errorMessage(error))
    }
    if (sequence === detailSeq.current) setDetailLoading(false)
  }, [docId])

  const loadComparison = useCallback(async (target: 'previous' | 'current') => {
    const sequence = ++comparisonSeq.current
    setComparisonTarget(target)
    setComparison(null)
    setComparisonError(null)
    if (!detail?.diffEligible || !detail.content) {
      setComparisonError('此版本暂不支持比较。')
      return
    }
    const selectedIndex = revisions.findIndex((item) => item.id === detail.id)
    const previous = revisions[selectedIndex + 1]
    if (target === 'previous' && !previous) {
      setComparisonError(hasMore ? '请加载更多修订后再比较前一版本。' : '这是最早的版本，没有前一版本。')
      return
    }
    setCompareLoading(true)
    try {
      const result = target === 'current' ? await api.current(docId) : await api.detail(docId, previous.id)
      if (sequence !== comparisonSeq.current) return
      if (!result.diffEligible || !result.content) setComparisonError('目标版本没有可比较的正文。')
      else setComparison(result)
    } catch (error) {
      if (sequence === comparisonSeq.current && !isAbort(error)) setComparisonError(errorMessage(error))
    } finally {
      if (sequence === comparisonSeq.current) setCompareLoading(false)
    }
  }, [detail, revisions, hasMore, docId])

  useEffect(() => {
    void loadList(true)
    return () => {
      listAbort.current?.abort()
      detailAbort.current?.abort()
      if (restoreFallbackTimer.current) clearTimeout(restoreFallbackTimer.current)
    }
  }, [loadList])

  useEffect(() => {
    if (historyOpen && !listLoading && !selectedId && revisions.length > 0) void selectRevision(revisions[0].id)
  }, [historyOpen, listLoading, revisions, selectedId, selectRevision])

  function openHistory() {
    if (restorePendingReset) return
    detailAbort.current?.abort()
    detailSeq.current += 1
    setSelectedId(null)
    setDetail(null)
    setHistoryOpen(true)
    void loadList(true)
  }

  const handleServerReset = useCallback((sourceGeneration: number) => {
    if (sourceGeneration !== generationRef.current) return
    if (restoreFallbackTimer.current) {
      clearTimeout(restoreFallbackTimer.current)
      restoreFallbackTimer.current = null
    }
    resetCount.current += 1
    generationRef.current += 1
    setGeneration(generationRef.current)
    setRestorePendingReset(false)
    setNotice('文档已从历史版本恢复，实时编辑器已重新连接。')
    void loadList(true)
    comparisonSeq.current += 1
    setComparison(null)
  }, [loadList])

  async function createRevision() {
    if (busy || restorePendingReset) return
    setBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      const result = await api.create(docId, name.trim() || undefined)
      setName('')
      setNotice(`已保存版本 V${result.version}。`)
      setHistoryOpen(true)
      await loadList(true)
      await selectRevision(result.id)
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function restoreRevision() {
    if (!detail || busy || restorePendingReset) return
    const targetId = detail.id
    const resetsBefore = resetCount.current
    setBusy(true)
    setRestorePendingReset(true)
    setActionError(null)
    setNotice(null)
    try {
      const result = await api.restore(docId, targetId)
      setConfirmRestore(false)
      setHistoryOpen(false)
      if (resetCount.current === resetsBefore) {
        const sourceGeneration = generationRef.current
        restoreFallbackTimer.current = setTimeout(() => {
          restoreFallbackTimer.current = null
          if (resetCount.current !== resetsBefore || generationRef.current !== sourceGeneration) return
          generationRef.current += 1
          setGeneration(generationRef.current)
          setRestorePendingReset(false)
          setNotice(`已恢复版本 V${detail.version}，实时编辑器已重新连接。`)
        }, RESTORE_RESET_GRACE_MS)
      }
      setNotice(resetCount.current > resetsBefore
        ? `已恢复版本 V${detail.version}，实时编辑器已重新连接。`
        : `已提交版本 V${detail.version} 的恢复（${result.id}），等待协作重置。`)
      await loadList(true)
      setSelectedId(null)
      setDetail(null)
    } catch (error) {
      setRestorePendingReset(false)
      setActionError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand"><div className="brand-mark">Y</div><div><strong>Tiptap × Yjs</strong><span>Snapshot reference</span></div></div>
        <span className="document-id">DOC <strong>{docId}</strong></span>
      </header>
      <main className="main-content">
        <div className="hero"><div><p className="eyebrow">COLLABORATIVE EDITING / REVISION HISTORY V2</p><h1>把文档的每一个重要时刻留下来。</h1><p>实时编辑当前文档；自动版本出现在历史记录中，可独立预览、比较与恢复。</p></div><div className="hero-number">01<span>/ 02</span></div></div>
        {(actionError || notice) && <div className={`global-message ${actionError ? 'error' : ''}`} role={actionError ? 'alert' : 'status'}>{actionError || notice}<button type="button" aria-label="关闭消息" onClick={() => { setActionError(null); setNotice(null) }}>×</button></div>}
        <div className="workspace-grid">
          <div className="left-column">
            <LiveDocument key={generation} docId={docId} onReset={() => handleServerReset(generation)} readOnly={historyOpen || restorePendingReset} resetPending={restorePendingReset} />
            <details className="card save-card manual-example">
              <summary>手动创建版本（API 集成示例）</summary>
              <p>V2 历史主要展示服务端自动生成的版本。这里保留手动创建接口供集成验证。</p>
              <div className="save-controls"><label className="sr-only" htmlFor="revision-name">版本名称</label><input id="revision-name" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createRevision() }} placeholder="版本名称（可选）" maxLength={80} disabled={restorePendingReset} /><button type="button" className="primary-button" disabled={busy || restorePendingReset} onClick={() => void createRevision()}>{busy ? '处理中…' : '保存版本'}</button></div>
            </details>
          </div>
          {historyOpen ? <section className="card history-card" aria-label="历史快照">
            <div className="card-heading"><div><p className="eyebrow">02 · HISTORY V2</p><h2>历史快照</h2></div><button type="button" className="restore-button" onClick={() => setHistoryOpen(false)}>返回编辑</button></div>
            <div className="history-layout"><RevisionList revisions={revisions} selectedId={selectedId} loading={listLoading} moreLoading={moreLoading} hasMore={hasMore} error={listError} onSelect={(id) => void selectRevision(id)} onMore={() => void loadList(false)} onRetry={() => void loadList(true)} /><div className="history-preview"><SnapshotPanel key={selectedId ?? 'none'} detail={detail} comparison={comparison} comparisonTarget={comparisonTarget} loading={detailLoading} compareLoading={compareLoading} error={detailError} comparisonError={comparisonError} onRestore={() => setConfirmRestore(true)} onCompare={loadComparison} /></div></div>
          </section> : <section className="card history-entry" aria-label="版本历史入口">
            <p className="eyebrow">02 · HISTORY V2</p><h2>版本历史</h2><p>查看自动版本，按时间比较前一版本，并在独立的只读视图中预览。</p>
            <button type="button" className="primary-button" disabled={restorePendingReset} onClick={openHistory}>打开版本历史</button>
          </section>}
        </div>
        <footer>示例范围：单进程文件存储 · Tiptap StarterKit · Yjs V2 自动版本与恢复 · JSON 文本差异</footer>
      </main>
      {confirmRestore && detail && <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirmRestore(false) }}><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="restore-dialog-title"><span className="dialog-icon">↶</span><h2 id="restore-dialog-title">恢复版本 V{detail.version}？</h2><p>当前内容会先保存为恢复前保护版本。服务端随后发出协作重置信号，编辑器会重新连接。</p>{actionError && <p className="inline-error" role="alert">{actionError}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setConfirmRestore(false)}>取消</button><button type="button" className="primary-button" disabled={busy} onClick={() => void restoreRevision()}>{busy ? '恢复中…' : '确认恢复'}</button></div></div></div>}
    </div>
  )
}
