import { Editor, type JSONContent } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import StarterKit from '@tiptap/starter-kit'
import { useCallback, useEffect, useRef, useState } from 'react'

import { createRevisionApi, type CurrentDocument, type RevisionDetail, type RevisionSummary } from './api'
import { createRealtimeSession, type RealtimeStatus } from './realtime'

const api = createRevisionApi()
const PAGE_SIZE = 12

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function isAbort(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

function revisionTime(revision: RevisionSummary) {
  const raw = revision.createdAt ?? revision.ctime
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

function LiveDocument({ docId, onReset }: { docId: string; onReset: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<RealtimeStatus>('connecting')
  const [title, setTitle] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const titleTextRef = useRef<ReturnType<ReturnType<typeof createRealtimeSession>['doc']['getText']> | null>(null)
  const resetCallback = useRef(onReset)
  useEffect(() => { resetCallback.current = onReset }, [onReset])

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
          liveEditor?.setEditable(true)
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
    if (!text || status !== 'ready') return
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
      <input id="document-title" className="title-input" value={title} onChange={(event) => changeTitle(event.target.value)} placeholder="给文档起个标题" disabled={status !== 'ready'} />
      <div className="field-label body-label">正文 <span>自动同步到当前文档</span></div>
      <Toolbar editor={editor} disabled={status !== 'ready' || !editor} />
      <div ref={hostRef} className="editor-surface" />
      {status !== 'ready' && <p className="editor-hint">连接就绪后即可编辑。恢复修订时会重新创建实时编辑器。</p>}
    </section>
  )
}

function ReadOnlyDocument({ title, content, label }: { title: string; content: JSONContent; label: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hostRef.current) return
    const editor = new Editor({
      element: hostRef.current,
      extensions: [StarterKit],
      content,
      editable: false,
      editorProps: { attributes: { class: 'tiptap preview-content', 'aria-label': label } },
    })
    return () => editor.destroy()
  }, [content, label])
  return (
    <div className="preview-document">
      <div className="preview-document-title">{title || '未命名文档'}</div>
      <div ref={hostRef} className="preview-surface" />
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
      {!loading && revisions.length === 0 && !error && <div className="empty-state">还没有快照。编辑文档后保存第一个修订版本。</div>}
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
            <span className="revision-text"><strong>{revision.name || `版本 ${revision.version}`}</strong><small>{revisionTime(revision)}</small></span>
            <span className="revision-chevron">›</span>
          </button>
        ))}
      </div>
      {error && <div className="list-error" role="alert">{error}<button type="button" onClick={onRetry}>重试</button></div>}
      {hasMore && <button type="button" className="load-more" disabled={moreLoading} onClick={onMore}>{moreLoading ? '加载中…' : '加载更多修订'}</button>}
    </div>
  )
}

function SnapshotPanel({ detail, current, loading, error, currentError, onRestore, onRefreshCurrent }: {
  detail: RevisionDetail | null
  current: CurrentDocument | null
  loading: boolean
  error: string | null
  currentError: string | null
  onRestore: () => void
  onRefreshCurrent: () => Promise<void>
}) {
  const [mode, setMode] = useState<'preview' | 'compare'>('preview')
  const [refreshing, setRefreshing] = useState(false)
  async function refresh() {
    setRefreshing(true)
    try { await onRefreshCurrent() } finally { setRefreshing(false) }
  }
  if (loading) return <div className="preview-placeholder">正在读取版本正文…</div>
  if (error) return <div className="preview-placeholder error" role="alert">{error}</div>
  if (!detail) return <div className="preview-placeholder">从左侧选择一个修订版本，查看独立的只读预览。</div>
  return (
    <div className="snapshot-panel">
      <div className="snapshot-header">
        <div><span className="version-badge">V{detail.version}</span><h3>{detail.name || `版本 ${detail.version}`}</h3><p>{revisionTime(detail)} · ID {detail.id}</p></div>
        <button type="button" className="restore-button" onClick={onRestore}>恢复此版本</button>
      </div>
      <div className="tab-row" role="tablist" aria-label="快照视图">
        <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>历史预览</button>
        <button type="button" role="tab" aria-selected={mode === 'compare'} className={mode === 'compare' ? 'active' : ''} onClick={() => { setMode('compare'); void refresh() }}>对照当前</button>
      </div>
      {mode === 'preview' ? (
        <ReadOnlyDocument key={detail.id} title={detail.title} content={detail.content} label="历史快照正文" />
      ) : (
        refreshing ? <div className="preview-placeholder comparison-loading">正在刷新当前服务端状态…</div> : <div className="comparison">
          <div className="compare-meta">
            <span className={current && current.contentHash === detail.contentHash && current.title === detail.title ? 'same' : 'different'}>
              {!current ? '当前状态不可用' : current.contentHash === detail.contentHash && current.title === detail.title ? '标题与正文一致' : '标题或正文存在差异'}
            </span>
            <button type="button" onClick={() => void refresh()}>刷新当前状态</button>
          </div>
          {currentError && <p className="inline-error" role="alert">{currentError}</p>}
          <div className="compare-grid">
            <div><h4>历史版本 · V{detail.version}</h4><ReadOnlyDocument key={`revision-${detail.id}`} title={detail.title} content={detail.content} label="历史版本正文" /></div>
            <div><h4>当前服务端状态</h4>{current ? <ReadOnlyDocument key={`current-${current.contentHash}-${current.title}`} title={current.title} content={current.content} label="当前服务端正文" /> : <div className="empty-state">无法读取当前状态。</div>}</div>
          </div>
        </div>
      )}
      <p className="preview-note">历史正文由独立的只读编辑器渲染，不会写入左侧实时文档。</p>
    </div>
  )
}

export function App() {
  const [docId] = useState(() => new URLSearchParams(window.location.search).get('doc_id') || 'demo')
  const [generation, setGeneration] = useState(0)
  const [name, setName] = useState('')
  const [revisions, setRevisions] = useState<RevisionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RevisionDetail | null>(null)
  const [current, setCurrent] = useState<CurrentDocument | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [moreLoading, setMoreLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [currentError, setCurrentError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const listSeq = useRef(0)
  const detailSeq = useRef(0)
  const listAbort = useRef<AbortController | null>(null)
  const detailAbort = useRef<AbortController | null>(null)
  const pageCursor = useRef<string | null>(null)
  const moreAvailable = useRef(false)
  const currentSeq = useRef(0)
  const resetCount = useRef(0)

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

  const refreshCurrent = useCallback(async () => {
    const sequence = ++currentSeq.current
    try {
      const state = await api.current(docId)
      if (sequence !== currentSeq.current) return
      setCurrent(state)
      setCurrentError(null)
    } catch (error) {
      if (sequence === currentSeq.current && !isAbort(error)) {
        setCurrent(null)
        setCurrentError(errorMessage(error))
      }
    }
  }, [docId])

  const selectRevision = useCallback(async (id: string) => {
    detailAbort.current?.abort()
    const controller = new AbortController()
    detailAbort.current = controller
    const sequence = ++detailSeq.current
    const currentSequence = ++currentSeq.current
    setSelectedId(id)
    setDetail(null)
    setCurrent(null)
    setDetailLoading(true)
    setDetailError(null)
    setCurrentError(null)
    const [detailResult, currentResult] = await Promise.allSettled([
      api.detail(docId, id, controller.signal),
      api.current(docId, controller.signal),
    ])
    if (sequence !== detailSeq.current) return
    if (detailResult.status === 'fulfilled') setDetail(detailResult.value)
    else if (!isAbort(detailResult.reason)) setDetailError(errorMessage(detailResult.reason))
    if (currentSequence === currentSeq.current) {
      if (currentResult.status === 'fulfilled') setCurrent(currentResult.value)
      else if (!isAbort(currentResult.reason)) setCurrentError(errorMessage(currentResult.reason))
    }
    setDetailLoading(false)
  }, [docId])

  useEffect(() => {
    void loadList(true)
    return () => {
      listAbort.current?.abort()
      detailAbort.current?.abort()
    }
  }, [loadList])

  const handleServerReset = useCallback(() => {
    resetCount.current += 1
    setGeneration((value) => value + 1)
    setNotice('文档已从历史版本恢复，实时编辑器已重新连接。')
    void loadList(true)
    if (selectedId) void selectRevision(selectedId)
  }, [loadList, selectRevision, selectedId])

  async function createRevision() {
    if (busy) return
    setBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      const result = await api.create(docId, name.trim() || undefined)
      setName('')
      setNotice(`已保存版本 V${result.version}。`)
      await loadList(true)
      await selectRevision(result.id)
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function restoreRevision() {
    if (!detail || busy) return
    const targetId = detail.id
    const resetCountBeforeRestore = resetCount.current
    setBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      await api.restore(docId, targetId)
      setConfirmRestore(false)
      if (resetCount.current === resetCountBeforeRestore) setGeneration((value) => value + 1)
      setNotice(`已恢复版本 V${detail.version}，恢复前的当前状态已保存为保护版本。`)
      await loadList(true)
      await selectRevision(targetId)
    } catch (error) {
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
        <div className="hero"><div><p className="eyebrow">COLLABORATIVE EDITING / REVISION HISTORY</p><h1>把文档的每一个重要时刻留下来。</h1><p>实时编辑当前文档，手动保存修订；单独预览历史内容，并在需要时安全恢复。</p></div><div className="hero-number">01<span>/ 02</span></div></div>
        {(actionError || notice) && <div className={`global-message ${actionError ? 'error' : ''}`} role={actionError ? 'alert' : 'status'}>{actionError || notice}<button type="button" aria-label="关闭消息" onClick={() => { setActionError(null); setNotice(null) }}>×</button></div>}
        <div className="workspace-grid">
          <div className="left-column"><LiveDocument key={generation} docId={docId} onReset={handleServerReset} /><section className="card save-card"><div><p className="eyebrow">02 · CAPTURE</p><h2>保存一个修订版本</h2><p>保存时记录完整的 Yjs V2 状态与可预览的正文 JSON。</p></div><div className="save-controls"><label className="sr-only" htmlFor="revision-name">版本名称</label><input id="revision-name" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createRevision() }} placeholder="版本名称（可选）" maxLength={80} /><button type="button" className="primary-button" disabled={busy} onClick={() => void createRevision()}>{busy ? '处理中…' : '保存版本'}</button></div></section></div>
          <section className="card history-card" aria-label="历史快照"><div className="card-heading"><div><p className="eyebrow">03 · HISTORY</p><h2>历史快照</h2></div><span className="history-hint">按需读取正文</span></div><div className="history-layout"><RevisionList revisions={revisions} selectedId={selectedId} loading={listLoading} moreLoading={moreLoading} hasMore={hasMore} error={listError} onSelect={(id) => void selectRevision(id)} onMore={() => void loadList(false)} onRetry={() => void loadList(true)} /><div className="history-preview"><SnapshotPanel detail={detail} current={current} loading={detailLoading} error={detailError} currentError={currentError} onRestore={() => setConfirmRestore(true)} onRefreshCurrent={refreshCurrent} /></div></div></section>
        </div>
        <footer>示例范围：单进程文件存储 · Tiptap StarterKit · Yjs V2 · 手动快照与恢复</footer>
      </main>
      {confirmRestore && detail && <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirmRestore(false) }}><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="restore-dialog-title"><span className="dialog-icon">↶</span><h2 id="restore-dialog-title">恢复版本 V{detail.version}？</h2><p>当前内容会先保存为保护版本。恢复会重建所有已连接客户端的实时文档，之后可以继续编辑。</p>{actionError && <p className="inline-error" role="alert">{actionError}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setConfirmRestore(false)}>取消</button><button type="button" className="primary-button" disabled={busy} onClick={() => void restoreRevision()}>{busy ? '恢复中…' : '确认恢复'}</button></div></div></div>}
    </div>
  )
}
