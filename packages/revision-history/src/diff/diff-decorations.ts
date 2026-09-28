import {
  DOMSerializer,
  Fragment,
  type Mark,
  type Node,
} from '@tiptap/pm/model'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type {
  CollaboratorColor,
  CollaboratorColorAssigner,
} from '../ui/collaborator-colors'
import {
  createAttributionIndex,
  type AttributionIndex,
  type AttributionRange,
} from './attribution'
import { groupChanges, type ChangeGroup } from './change-groups'
import type { RevisionChange } from './diff-documents'

const CLASS_BY_KIND: Readonly<Record<RevisionChange['kind'], string>> =
  Object.freeze({
    inserted: 'revision-vh-diff--inserted',
    deleted: 'revision-vh-diff--deleted',
    'marks-changed': 'revision-vh-diff--marks',
    'attrs-changed': 'revision-vh-diff--attrs',
  })

/**
 * Block-level counterparts, mirroring outline's `diffNodeInsertion` /
 * `diffNodeDeletion` split.
 *
 * Only the two kinds that can be block-level are listed. `marks-changed` /
 * `attrs-changed` always describe inline runs.
 *
 * The two kinds combine differently, because only one of them needs a different
 * appearance:
 *
 * - **Deletion replaces** the inline class. The treatments genuinely conflict:
 *   `line-through` over an image or a table means nothing and obscures the
 *   content, and injected content carries none of the editor's own node-view
 *   sizing, so it needs a bound the inline rule must not fight over.
 * - **Insertion adds** to it. Inserted content is the document's own content,
 *   laid out by the editor's own node views, so it is already sized and looks
 *   the same either way; the extra class is a hook, not a different skin.
 *   Keeping `--inserted` on it also keeps every existing selector working.
 */
const NODE_CLASS_BY_KIND: Readonly<
  Partial<Record<RevisionChange['kind'], string>>
> = Object.freeze({
  inserted: 'revision-vh-diff--node-inserted',
  deleted: 'revision-vh-diff--node-deleted',
})

const ACTIVE_CLASS = 'revision-vh-diff--active'
const OWNER_SEGMENT_CLASS = 'revision-vh-diff--owner-segment'
const OWNER_SEGMENT_BADGE_CLASS = 'revision-vh-badge-anchor--owner-segment'

/**
 * Stands in for a revision the service sent no per-position attribution for.
 *
 * Built through `createAttributionIndex(null)` rather than an inline
 * `authorAt: () => null` so it cannot drift from what a real index does at a
 * position it has no answer for.
 */
const EMPTY_ATTRIBUTION: AttributionIndex = createAttributionIndex(null)

/**
 * Tags `widgetTag` uses for block-level removed content.
 *
 * The deletion widget already decides inline-vs-block when it picks its wrapper
 * tag; reading that decision back beats deriving it a second time from the
 * fragment, which would let the two disagree.
 */
const BLOCK_WIDGET_TAGS: ReadonlySet<string> = new Set([
  'div',
  'li',
  'td',
  'tr',
])

/**
 * 父节点为子节点建立的布局角色。
 *
 * 这是删除 widget 的核心不变量：**widget 必须承担被删节点原本的布局角色**。父节点
 * 一旦为子节点建立了格式化上下文（表格网格、flex、列表），多包一层就打断了父子之间
 * 的布局契约 —— 无论那层包裹在 HTML 上合法与否。实测过的两种形态：
 *
 * - **表格**：`<div>` / 重复的 `<tr>` 落进 `<tbody>` 是非法嵌套，浏览器用匿名表格盒
 *   修复，被删行整体脱离网格与 `<colgroup>`。3 列表格实测被删行 155px 对照上一行
 *   1471px、首格 49px 对照 392px。
 * - **分栏**：包裹层是合法的 `div`，但它自己成了 flex item（`flex-basis: auto`），
 *   实测 82px 而 30% 应为 450px；内层 `.column` 的百分比对着这 82px 算，塌到 25px。
 *
 * 判据放在**父节点**一侧而不是子节点一侧。子侧的 `contentMatch` 单独用太宽 —— `doc`
 * 同样接受 `paragraph`，那会让每个被删段落都从 `div` 包裹翻成裸 `<p>` 被采用，无谓
 * 改动最常见的删除路径。父侧判定则天然只命中真正建立了布局上下文的容器。
 */
type LayoutSlotKind = 'table' | 'row' | 'list' | 'flex-columns'

/**
 * 用 flex 给子节点分配宽度的容器类型名。
 *
 * 这是这套规则里唯一的手工登记点，因为「父节点是不是 flex 容器」在 schema 里没有任何
 * 信号 —— 它只存在于 CSS（`.column-block { display: flex }`）。`tableRole` 和
 * `group` 含 `list` 都能从 schema 读出来，flex 读不出来。
 *
 * 漏登记一个容器的后果是退回现有的 `div` 包裹行为，也就是上面记的那个 82px；不会更坏。
 */
const FLEX_COLUMN_CONTAINERS: ReadonlySet<string> = new Set(['columnBlock'])

/** 每种布局角色下，被删内容该以什么标签落地。 */
const WIDGET_TAG_BY_SLOT: Readonly<Record<LayoutSlotKind, string>> =
  Object.freeze({
    // 父节点是表格 → 被删的是一行。
    table: 'tr',
    // 父节点是行 → 被删的是一格。
    row: 'td',
    list: 'li',
    // 分栏的列本身就是 `div`，采用序列化根后它自带 `renderHTML` 写好的
    // `flex: 0 1 N%`，不需要再补尺寸。
    'flex-columns': 'div',
  })

/**
 * 折叠掉一个不该占网格位的被删单元格。
 *
 * 被删的那一列在宿主 `<colgroup>` 里没有对应的 `<col>`，而 `table-layout: fixed` 下
 * 任何多出来的列都必然从保留列身上分走宽度：让它占住自己记录的 180px，实测保留列从
 * 749/750 掉到 570/570。折叠之后实测 748/748，与「本来就没有这一列」的基线只差 1-2px。
 *
 * 已获用户确认不展示被删列占据的空间。代价是这一格的文字不再可读 —— 见样式表。
 */
const COLLAPSED_CLASS = 'revision-vh-diff--collapsed'

/**
 * Tags that paint a box by their place in a grid or a list.
 *
 * They hold no content of their own, so a text-based emptiness test reads them
 * as rendering nothing — see {@link isVisuallyEmpty}.
 */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set(['tr', 'td', 'th', 'li'])

/**
 * Marks a deletion widget that would otherwise render as nothing.
 *
 * A removed empty paragraph serialises to `<p></p>` — zero height, zero width,
 * invisible. The stylesheet gives this class a minimum size so the removal is
 * visible at all.
 */
const EMPTY_CLASS = 'revision-vh-diff--empty'

/**
 * Wraps the removed content inside a deletion widget so it can be faded.
 *
 * The design fades removed content to 40% while its fill and underline stay solid
 * . `opacity` composites an element
 * together with its own background and border, so the fade cannot go on the
 * widget itself — that would wash out the marking that identifies the deletion.
 *
 * A wrapper element rather than a `> *` selector: a text-only deletion puts its
 * text directly on the widget and has no element children to select.
 */
const FADE_CLASS = 'revision-vh-diff--faded'

/**
 * Whether a rendered widget would occupy no visible space.
 *
 * Checked on the serialised DOM rather than on the fragment: what matters is
 * whether anything reached the page, and an empty paragraph, an empty run of
 * paragraphs, and a whitespace-only deletion all arrive here differently but
 * render the same nothing.
 *
 * Text is not the only thing that paints. An `img` or an `hr` carries no text
 * yet occupies space, and treating one as empty would put it under the
 * minimum-size rule, which overrides the bound that keeps it inside the column.
 */
function isVisuallyEmpty(element: HTMLElement): boolean {
  // 行、单元格、列表项由所在的网格/列表画出盒子,空的一行照样占满整行宽度。给它们
  // 补最小尺寸只会去撑那个网格 —— 而 `min-width: 24px` 加在被删单元格上,正是把
  // 「这一列该有多宽」从列宽换成了 24px。删一整行拿到过这个类。
  if (STRUCTURAL_TAGS.has(element.tagName.toLowerCase())) {
    return false
  }
  // `<br>` has no textContent, but it still changes inline layout by ending the
  // current line. Treating a deleted hard break as an empty block applies the
  // minimum-size display rule and inserts an extra line before a replacement.
  if (
    element.tagName.toLowerCase() === 'br' ||
    element.querySelector('br') !== null
  ) {
    return false
  }
  // 一张全空单元格的表格没有文字、也没有下面这些媒体标签,但它**确实**画出了一个
  // 3x3 的网格。只按「有没有文字」判会把它当成什么都没渲染,于是套上了最小尺寸规则。
  // 表格、列表、分隔线这类靠自身结构占位的元素同样算「有内容」。
  if (
    element.querySelector(
      'img, hr, video, audio, iframe, svg, canvas, table, ul, ol, pre, blockquote'
    ) !== null
  ) {
    return false
  }
  return (element.textContent ?? '').trim() === ''
}

/**
 * Per-person colour handed to the stylesheet as custom properties.
 *
 * Inline custom properties rather than inline colours: the tier-to-role mapping
 * (5 = added text, 4 = removed text, 1 = added background) belongs in one place
 * in the stylesheet, and only the hue varies per person.
 */
function colourStyle(colour: CollaboratorColor | null): string | null {
  return colour === null
    ? null
    : `--revision-vh-owner-strong:${colour.strong};--revision-vh-owner-medium:${colour.medium};--revision-vh-owner-soft:${colour.soft}`
}

/** 每种布局角色下，HTML 只允许哪些标签作为直接子元素。 */
const LEGAL_CHILD_TAGS_BY_SLOT: Readonly<
  Record<LayoutSlotKind, ReadonlySet<string>>
> = Object.freeze({
  table: new Set(['tr']),
  // 被删的表头格序列化成 `th`，两者都是行的合法子元素。
  row: new Set(['td', 'th']),
  list: new Set(['li']),
  'flex-columns': new Set(['div']),
})

/**
 * 被删内容所落位置的布局角色，`null` 表示父节点不为子节点排版。
 *
 * 判定读的全部是父节点：`tableRole` 与 `group` 来自 schema，flex 容器只能靠登记表
 * （见 {@link FLEX_COLUMN_CONTAINERS}）。
 */
function resolveLayoutSlot(
  doc: Node,
  position: number
): { readonly kind: LayoutSlotKind; readonly parent: Node } | null {
  // `resolve` 会在位置于 diff 与渲染之间越界时抛错；widget 不能因此丢掉，退化成
  // 无布局角色即可 —— 那条路径产出的 `div` 仍然可渲染。
  let parent: Node | null = null
  try {
    parent = doc.resolve(position).parent
  } catch {
    parent = null
  }
  if (parent === null) {
    return null
  }

  const role = parent.type.spec.tableRole
  if (role === 'table') {
    return { kind: 'table', parent }
  }
  if (role === 'row') {
    return { kind: 'row', parent }
  }
  if (FLEX_COLUMN_CONTAINERS.has(parent.type.name)) {
    return { kind: 'flex-columns', parent }
  }
  const group = parent.type.spec.group
  // `bulletList` / `orderedList` / `taskList` 的 group 都是 `"block list"`，所以任务
  // 列表跟着这一条一起覆盖，不需要单独分支。
  if (typeof group === 'string' && group.includes('list')) {
    return { kind: 'list', parent }
  }
  return null
}

/**
 * Wrapper tag for removed content.
 *
 * A block deletion inside a `<span>` would nest block elements in an inline one,
 * which browsers reflow unpredictably. The tag is chosen from what was removed,
 * and matched to the surrounding context for table and list content, where only
 * a specific child tag is valid.
 *
 * Being inline is not on its own enough to earn a `span`: the content also has to
 * read as part of a sentence. An image is an inline atom, so a removed image —
 * whether it sat mid-paragraph beside text or was swapped for another image —
 * arrived here as a bare inline run and took the inline treatment, which paints
 * nothing on a picture. See {@link takesInlineTreatment}.
 */
function widgetTag(
  content: Fragment,
  slot: { readonly kind: LayoutSlotKind } | null
): string {
  if (takesInlineTreatment(content)) {
    return 'span'
  }
  return slot === null ? 'div' : WIDGET_TAG_BY_SLOT[slot.kind]
}

/**
 * Whether content should be marked the way running text is, rather than as a box.
 *
 * The single source of truth for that split, shared by both sides of the diff.
 * The two sides ask it for different reasons — a deletion needs a wrapper tag, an
 * insertion needs to pick a decoration type and class — but they are asking the
 * same question, and answering it twice is what let them disagree: the deletion
 * side learned that a lone image is a box (see {@link readsAsSentence}) while the
 * insertion side went on testing `isInline` alone, so an **inserted** image got
 * the text treatment — a text colour that means nothing on a picture and a
 * background the picture covers — and rendered with no marking at all.
 *
 * Empty content takes the inline treatment: there is nothing to paint a box for.
 */
function takesInlineTreatment(content: Fragment): boolean {
  const first = content.firstChild
  if (first === null) {
    return true
  }
  // LinkAtom is an inline atom rendered as an inline link. A lone link must stay
  // in the surrounding line; treating every atom-only fragment as a block would
  // inject a `div` widget on the deletion side and create an artificial line
  // break, and would box a link mid-sentence on the insertion side.
  if (first.type.name === 'linkAtom') {
    return true
  }
  return first.isInline && readsAsSentence(content)
}

/**
 * Inline leaves that carry no words yet still paint no box of their own.
 *
 * `isLeaf` is too coarse to decide block-vs-inline: a `hardBreak` is a childless
 * inline node just like an image, but it draws a line break, not a picture. Left
 * to `isLeaf` alone a removed `<br>` was pulled out into a block widget — deleting
 * one line break mid-sentence tore "甲乙" into three lines with a tinted box
 * between them.
 *
 * Named rather than derived: nothing on a `NodeSpec` distinguishes "renders as a
 * box" from "renders as a break", so the exceptions have to be listed. Keep this
 * to nodes that genuinely occupy no area.
 */
const AREALESS_INLINE_LEAVES: ReadonlySet<string> = new Set([
  'hardBreak',
  'hard_break',
])

/**
 * Whether a run of inline content reads as part of a sentence.
 *
 * Text does. So does a line break — it has no words of its own but it belongs to
 * the flow of the sentence around it. A lone inline atom that paints a box — an
 * image, a mention chip, a formula — does not: it carries no words, and it
 * occupies an area of its own.
 *
 * This decides block-vs-inline for the whole widget, so getting it wrong is
 * visible. An image is an *inline* node in this schema, so `widgetTag`'s
 * `isInline` test alone picks `span`, which carries the inline deletion class —
 * a text colour and a strike-through, neither of which means anything on an
 * image, and the block rule strikes `text-decoration: none` anyway. A removed
 * image then rendered with no marking at all: just a picture sitting there.
 *
 * Takes a `Fragment` rather than the wrapping node so both callers can share it:
 * a deletion arrives either as a paragraph to unwrap or as a bare inline run,
 * and only the latter reaches `widgetTag` with nothing to unwrap.
 */
function readsAsSentence(content: Fragment): boolean {
  let readsAsWords = false
  let boxes = 0
  content.forEach(child => {
    if (child.isText || AREALESS_INLINE_LEAVES.has(child.type.name)) {
      readsAsWords = true
      return
    }
    if (child.isAtom || child.isLeaf) {
      boxes += 1
    }
  })
  // Text alongside an atom still reads as a sentence (an emoji mid-phrase); an
  // atom on its own does not.
  return readsAsWords || boxes === 0
}

/**
 * Unwraps a single removed paragraph to its inline content.
 *
 * A lone removed paragraph rendered as `<p>` inside the widget would sit as a
 * block in the middle of a line; its inline content reads as part of the
 * sentence, which is what a word-level deletion is.
 *
 * An *empty* paragraph is left wrapped: there is no inline content to read as
 * part of a sentence, and unwrapping would erase the only evidence that a whole
 * block was removed — which is the thing the empty-block affordance has to show.
 *
 * A paragraph holding nothing but an inline atom is left wrapped for the same
 * reason — see {@link readsAsSentence}.
 */
function unwrapLoneParagraph(content: Fragment): Fragment {
  const only = content.childCount === 1 ? content.firstChild : null
  return only !== null &&
    only.type.name === 'paragraph' &&
    only.content.size > 0 &&
    readsAsSentence(only.content)
    ? only.content
    : content
}

/**
 * Whether a stored image address is safe to place in `src`.
 *
 * Allows what an image can legitimately be served from and rejects everything
 * else, rather than blocklisting known-bad schemes: a relative or protocol-
 * relative path, an absolute http(s) URL, or an inline `data:image/…`. Anything
 * with some other scheme is left alone, so the image renders broken instead of the
 * viewer rewriting an attribute to a value the document did not legitimately hold.
 */
function isSafeImageUrl(url: string): boolean {
  // Tab, newline and carriage return are stripped by the URL parser *before* the
  // scheme is read, so `java&#9;script:` reaches the browser as `javascript:`.
  // They have to come out here too, or the scheme test below matches nothing, the
  // value looks scheme-less, and it is waved through as a relative path.
  const bare = url.replace(/[\t\n\r]/g, '')

  // A scheme is `alpha [alnum +-.]* ':'`. No scheme at all means relative, which
  // resolves against this page and cannot introduce a new one.
  const scheme = /^([a-z][a-z0-9+\-.]*):/i.exec(bare)
  if (scheme === null) {
    return true
  }
  const name = scheme[1].toLowerCase()
  if (name === 'http' || name === 'https') {
    return true
  }
  // An inline raster image is fine. `data:image/svg+xml` is not: an SVG is a
  // document, it can carry script, and this value is read by other tooling as
  // well as by `<img src>` — where it would not execute. Allowing only the raster
  // types keeps that distinction from resting on the consumer.
  return /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)[;,]/i.test(
    bare
  )
}

/**
 * Repairs serialised content that a node view, not the schema, normally renders.
 *
 * `DOMSerializer` calls each node's `renderHTML`, which is only half the story for
 * any node that also has an `addNodeView()`: the live editor shows the node view's
 * DOM, and the schema output can be missing whatever that view builds at runtime.
 * Deleted content is injected, so no node view ever runs on it, and two nodes came
 * out unusable:
 *
 * - **Images.** `renderHTML` emits a bare `<img>` carrying `src`, but `src` may
 *   hold a stale base64 placeholder whose data lived in a client-side cache that
 *   is empty here; `data-url` is the uploaded address. The node view resolves this
 *   at render time via `getEffectiveImageSrc`, so a re-serialised image pointed at
 *   nothing and showed as a blank line.
 * - **Tables.** Cell widths live in a `data-colwidth` attribute, and the
 *   `<colgroup>` that turns them into real column widths is built by the table's
 *   node view. The stylesheet sets `table-layout: fixed`, which needs that
 *   `<colgroup>`; without it every column collapsed and only the bare text showed.
 *
 * Deliberately confined to reading attributes already on the serialised DOM. It
 * cannot import from the image or table packages — revision-history does not
 * depend on them, and a diff overlay must not start reaching into node views.
 */
function repairSerialisedContent(container: HTMLElement): void {
  container.querySelectorAll('img').forEach(image => {
    // Mirrors `getEffectiveImageSrc`: `data-url` wins when present.
    const uploaded = (image.getAttribute('data-url') ?? '').trim()
    // Both values come from stored document data, so the scheme is checked before
    // it reaches `src` rather than trusted. An `<img src>` does not execute
    // `javascript:`, but this attribute is also read by other tooling, and a
    // rewrite here should not be the thing that launders an unexpected scheme.
    if (uploaded !== '' && isSafeImageUrl(uploaded)) {
      image.setAttribute('src', uploaded)
    }
  })

  container.querySelectorAll('table').forEach(table => {
    if (table.querySelector('colgroup') !== null) {
      return
    }
    // The first row decides the column count. That is what the editor's own table
    // view does, and `prosemirror-tables` keeps every row the same width, so there
    // is no wider row further down to miss. If a stored table ever disagreed, the
    // columns this misses are simply left to share the remaining space — the same
    // outcome as a cell with no declared width.
    const firstRow = table.querySelector('tr')
    if (firstRow === null) {
      return
    }

    const widths: (string | null)[] = []
    for (const cell of Array.from(firstRow.children)) {
      // A merged cell spans several columns and carries one width per column, so
      // its `colspan` decides how many entries it contributes.
      const span = Number.parseInt(cell.getAttribute('colspan') ?? '1', 10)
      const columns = Number.isNaN(span) || span < 1 ? 1 : span
      // Only digits survive: this value comes from stored document data and is
      // interpolated into a `style` property below, so anything that is not a
      // plain pixel count is dropped rather than passed through.
      const declared = (cell.getAttribute('data-colwidth') ?? '')
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => /^\d+$/.test(entry))

      for (let index = 0; index < columns; index += 1) {
        widths.push(declared[index] ?? null)
      }
    }
    if (widths.length === 0) {
      return
    }

    const colgroup = document.createElement('colgroup')
    for (const width of widths) {
      const col = document.createElement('col')
      // Unwidthed columns are left to share what is left over, which is what the
      // editor's own table view does.
      if (width !== null) {
        col.style.width = `${width}px`
      }
      colgroup.appendChild(col)
    }
    table.insertBefore(colgroup, table.firstChild)
  })

  // SVG link icons do not participate in text-decoration. Add the deletion
  // stroke inside the icon itself so it remains aligned even when the link wraps.
  container.querySelectorAll<SVGSVGElement>('.revision-link-icon').forEach(icon => {
    if (icon.querySelector('[data-revision-deletion-stroke]') !== null) return
    const stroke = icon.ownerDocument.createElementNS(
      icon.namespaceURI,
      'line'
    )
    stroke.setAttribute('data-revision-deletion-stroke', 'true')
    stroke.setAttribute('x1', '0')
    stroke.setAttribute('y1', '10')
    stroke.setAttribute('x2', '20')
    stroke.setAttribute('y2', '10')
    stroke.setAttribute('stroke', 'var(--revision-vh-owner-medium, #88a4ff)')
    stroke.setAttribute('stroke-width', '1.5')
    stroke.setAttribute('pointer-events', 'none')
    icon.appendChild(stroke)
  })
}

/**
 * The serialised element the widget can *be*, rather than sit around.
 *
 * 原来的 bug 是同一个决定被推导了两遍：`widgetTag` 按上下文选标签，序列化器按内容再
 * 选一次，行 / 格 / 列表项这三种情形下两者必然一致 —— 于是 widget 成了 `<tr>` 套
 * `<tr>`。这里返回序列化根，让调用方**采用**它而不是再包一层。
 *
 * 三道闸门必须同时成立：
 *
 * 1. 位置有布局角色（{@link resolveLayoutSlot}）—— 只有父节点亲自为子节点排版时，多
 *    一层包裹才会破坏布局契约；普通流内块（段落、标题、引用、图片…）走包裹路径是对的，
 *    整表删除更是**依赖**那层 `div` 里 {@link repairSerialisedContent} 重建的
 *    `<colgroup>`。
 * 2. schema 认这个父子关系 —— 被删节点确实是宿主父节点的合法子节点。这道守卫防的是
 *    「位置解析出的父节点」与「被删内容的实际类型」不匹配时硬塞进去。
 * 3. 序列化结果恰好是一个元素节点，且标签在该角色的合法子元素集合里。
 *
 * `null` 表示任一条不成立，退回包裹路径 —— 那是现有行为，不会更坏。
 */
function adoptableRoot(
  slot: { readonly kind: LayoutSlotKind; readonly parent: Node } | null,
  content: Fragment,
  // `serializeFragment` is typed as returning either, and a single-node fragment
  // is exactly the case that matters here. Both expose the two members read
  // below, so neither needs narrowing.
  serialised: DocumentFragment | HTMLElement
): HTMLElement | null {
  if (slot === null) {
    return null
  }
  const removed = content.firstChild
  // 只有单节点内容才谈得上「采用它的根」；多节点 fragment 没有唯一根。
  if (removed === null || content.childCount !== 1) {
    return null
  }
  // schema 层守卫：父节点得真的接受这个类型。
  if (slot.parent.type.contentMatch.matchType(removed.type) === null) {
    return null
  }
  // One *node*, not one element: a stray text sibling would be dropped on the
  // floor by adopting, so that fragment goes down the wrapper path instead.
  if (serialised.childNodes.length !== 1) {
    return null
  }
  const root = serialised.firstElementChild
  if (
    root === null ||
    !LEGAL_CHILD_TAGS_BY_SLOT[slot.kind].has(root.tagName.toLowerCase())
  ) {
    return null
  }
  return root as HTMLElement
}

/**
 * Adds the deletion's own inline properties without discarding the content's.
 *
 * An adopted element arrives carrying whatever `renderHTML` put on it — a
 * cell's own width, text alignment and background colour are all inline styles.
 * Assigning over the attribute, which is what the wrapper path can safely do to
 * an element it just created, would drop every one of them.
 */
function addInlineStyle(element: HTMLElement, addition: string): void {
  const existing = element.getAttribute('style')
  element.setAttribute(
    'style',
    existing === null || existing.trim() === ''
      ? addition
      : `${existing.replace(/;\s*$/, '')};${addition}`
  )
}

/**
 * 被删的单元格不占网格位。
 *
 * 被采用的单元格比它被注入的那张表多出一列 —— 宿主的 `<colgroup>` 只描述**留下来**的
 * 那些列，没有它的 `<col>`。`table-layout: fixed` 下没被描述的列会吃掉全部剩余宽度，
 * 实测 1201px 对照旁边 120px 的列。
 *
 * 让它占住自己 `data-colwidth` 记的宽度能拉回来，但**不可能不扰动**其余列：多出来的列
 * 必然从保留列身上分走宽度。1500px 表实测保留列 749/750 → 570/570（占 180px 时），
 * 折叠后 748/748，与「本来就没有这一列」的基线只差 1-2px。用户已确认不展示被删列占据
 * 的空间，所以折叠。
 *
 * 尺寸落在样式表而不是内联：这是呈现，而且 `--node-deleted` 只可能由
 * {@link deletedWidget} 产出（`buildDiffDecorations` 里删除分支提前 return，
 * `Decoration.node` 永远碰不到删除），所以这个类不会误伤保留的单元格。
 *
 * 一个已知边界：`table-layout: fixed` 只读**首行**定列宽。整列删除时每一行都会拿到
 * 一个 widget（首行也在内），折叠因此成立；若只有后续行拿到（例如合并单元格配对成
 * 别的形状），首行没有这一列可折叠，实测该格仍会摊到 899px。
 */
function collapseRemovedCell(cell: HTMLElement): void {
  cell.classList.add(COLLAPSED_CLASS)
}

/**
 * Renders removed content as a widget.
 *
 * A deletion has nothing in this document to decorate, so the removed content is
 * injected read-only instead. It is serialised through the schema's own
 * `DOMSerializer` so bold, links, list items and table cells look the way they
 * did — a plain-text rendering would silently drop every mark and structure.
 * It carries `contenteditable="false"` so it is never mistaken for part of the
 * revision.
 *
 * Serialising happens *before* the widget element exists, because in a row, cell
 * or list context the serialised root is legal where the widget goes and the
 * widget becomes that element rather than wrapping it — see
 * {@link adoptableRoot}.
 */
function deletedWidget(
  doc: Node,
  change: RevisionChange,
  active: boolean,
  style: string | null
): Decoration {
  return Decoration.widget(
    change.from,
    () => {
      const raw = change.deletedContent
      // Unwrap first, then choose the tag from what will actually be serialised:
      // a lone paragraph unwraps to inline content, and reading the tag off the
      // wrapped fragment would put that inline content inside a block `div` and
      // label it as a block-level deletion.
      const content = raw === undefined ? undefined : unwrapLoneParagraph(raw)
      // 布局角色只解析一次，标签选择与「能否采用序列化根」共用它 —— 原来的 bug 正是
      // 同一个决定被两处独立推导出来，然后彼此叠加。
      const slot = resolveLayoutSlot(doc, change.from)
      const tag =
        content === undefined ? 'span' : widgetTag(content, slot)

      // Serialised before the widget element exists, so the widget can *be* the
      // result wherever that is legal instead of wrapping it in a second element
      // of the same role. The compared side may come from an older schema
      // generation whose types have no serialiser here; that falls back to text
      // below rather than letting an exception take down the whole overlay.
      let serialised: DocumentFragment | HTMLElement | null = null
      if (content !== undefined) {
        try {
          serialised = DOMSerializer.fromSchema(
            doc.type.schema
          ).serializeFragment(content, { document })
        } catch {
          serialised = null
        }
      }

      const adopted =
        serialised === null || content === undefined
          ? null
          : adoptableRoot(slot, content, serialised)
      const element = adopted ?? document.createElement(tag)

      // The tag is the inline-vs-block signal: `widgetTag` returns `span` only
      // for inline content. Read off `tag` rather than the element so an adopted
      // `th` is still classed by the cell context it stands in.
      const baseClass = BLOCK_WIDGET_TAGS.has(tag)
        ? (NODE_CLASS_BY_KIND.deleted as string)
        : CLASS_BY_KIND.deleted
      // Added, not assigned: an adopted element arrives carrying whatever classes
      // `renderHTML` gave it, and those are part of how the content looked.
      element.classList.add(baseClass)
      if (active) {
        element.classList.add(ACTIVE_CLASS)
      }
      element.setAttribute('contenteditable', 'false')
      element.setAttribute('aria-label', '已删除内容')
      if (style !== null) {
        addInlineStyle(element, style)
      }
      // 只有独自站着的单元格才是宿主 `<colgroup>` 没描述过的那一列。被采用的**行**
      // 里的那些单元格对应的是留下来的列，已经被 colgroup 覆盖了，不能折叠 ——
      // 所以判据是所在的布局角色（`row` = 被删的是一格），不是元素自己的标签。
      if (adopted !== null && slot?.kind === 'row') {
        collapseRemovedCell(element)
      }

      // Removed content goes inside a layer of its own so the stylesheet can fade
      // it without touching the widget's own fill and underline. `opacity`
      // composites an element together with its background and border, so fading
      // the widget itself would wash out the very marking that identifies it as a
      // deletion. A wrapper is used rather than a `> *` selector because a
      // text-only deletion has no element children to select.
      //
      // The wrapper tag has to be legal inside the widget's own tag. A `tr` may
      // only contain `td`/`th`, so a `div` in there gets wrapped in an anonymous
      // table by the browser and the row drops out of its grid; `td` and `li` take
      // flow content and are fine. A removed row therefore fades through its cells
      // instead of a wrapper of its own — the stylesheet reaches both.
      const fadeTag =
        tag === 'tr' ? null : BLOCK_WIDGET_TAGS.has(tag) ? 'div' : 'span'
      const fade =
        fadeTag === null ? element : document.createElement(fadeTag)
      if (fade !== element) {
        fade.className = FADE_CLASS
        // Around the existing children, not merely appended beside them: an
        // adopted element already holds the removed content, and leaving it
        // outside the fade would paint it at full strength. The loop is a no-op
        // on the wrapper path, where `element` was just created empty.
        while (element.firstChild !== null) {
          fade.appendChild(element.firstChild)
        }
        element.appendChild(fade)
      } else {
        // No wrapper: the fade class rides on the widget itself, so `opacity`
        // composites the widget's own fill and border along with the content.
        // The stylesheet therefore strips the fill, the underline and the radius
        // from a `tr` and paints the row through its cells instead — those sit
        // inside the fade, so they keep their colour.
        element.classList.add(FADE_CLASS)
      }

      if (content === undefined) {
        // Pre-existing changes carry only text; keep rendering them rather than
        // showing an empty marker.
        fade.textContent = change.deletedText ?? ''
        return element
      }

      if (serialised === null) {
        // The compared side may come from an older schema generation whose types
        // have no serialiser here. Text is a lossy but readable fallback; an
        // exception would take down the whole overlay.
        fade.textContent = change.deletedText ?? ''
      } else {
        // Only the wrapper path still has content to place — an adopted element
        // *is* the serialised root, already moved inside the fade above.
        if (adopted === null) {
          fade.appendChild(serialised)
        }
        // Serialising is only half of rendering for nodes that carry a node view.
        // Run from the widget rather than the fade layer so it also reaches an
        // adopted element's own attributes.
        repairSerialisedContent(element)
      }

      // A removed empty paragraph serialises to nothing at all, so the widget
      // would be an empty box: the reader cannot tell a paragraph was removed.
      // Flagged for the stylesheet to give it a minimum size — no injected text,
      // because the design specifies no wording for this and inventing a label
      // would be a guess.
      if (isVisuallyEmpty(element)) {
        element.classList.add(EMPTY_CLASS)
      }
      return element
    },
    // Deletions sort before insertions at the same position so a replacement
    // reads old-then-new.
    { side: -1 }
  )
}

/**
 * Badge wording per change kind.
 *
 * Only the two kinds the design specifies  get an entry. `marks-changed` and `attrs-changed` are absent on
 * purpose: the design has no badge form for them, and inventing wording would be
 * a guess about what the product wants to say. They stay highlighted, just
 * unlabelled.
 */
const BADGE_LABEL: Readonly<Partial<Record<RevisionChange['kind'], string>>> =
  Object.freeze({
    inserted: '新增',
    deleted: '删除',
  })

/**
 * How many frames to keep retrying a measurement that reads as unlaid-out.
 *
 * A widget is built before its layout exists, and "no layout yet" is
 * indistinguishable from "zero-size box": both report 0. Measuring once and
 * giving up left the badge on the CSS fallback **permanently** — observed with
 * the panel's editor still `display: none` at build time, where the badge stayed
 * 36px off on a heading long after the editor became visible.
 *
 * Bounded rather than a `ResizeObserver`/`MutationObserver`: the viewer applies
 * no transactions and has no teardown hook for a widget, so an open-ended
 * observer would have nothing to unsubscribe it. A handful of frames covers
 * becoming visible and webfont swap; past that the CSS fallback stands.
 */
const BADGE_ALIGN_ATTEMPTS = 10

/**
 * Whether a measured box carries no layout at all.
 *
 * Inside a `display: none` ancestor every coordinate reads exactly 0, which is
 * how "the editor has not been shown yet" presents to a measurement. A real box
 * on screen has a non-zero edge somewhere — even one flush against the viewport
 * origin has height.
 */
function isUnlaidOut(box: { top: number; bottom: number }): boolean {
  return box.top === 0 && box.bottom === 0
}

/**
 * Classes the decorations paint a change's own box with.
 *
 * Derived from the two class maps rather than written out: a hand-kept list drifts
 * from what is actually emitted, and silently — a name that matches nothing simply
 * never finds a highlight, so the badge falls back to `coordsAtPos` and lands
 * offset by a line. That is exactly what happened with `marks-changed` /
 * `attrs-changed`, which are the *kind* names; the classes are `--marks` /
 * `--attrs`, so both branches were dead from the start.
 */
export const HIGHLIGHT_CLASSES: ReadonlySet<string> = new Set([
  ...Object.values(CLASS_BY_KIND),
  ...Object.values(NODE_CLASS_BY_KIND),
])

/**
 * Finds the box the badge is labelling: the highlight that follows its anchor.
 *
 * Preferred over asking the view for the coordinates of the widget's position.
 * `coordsAtPos` answers for the *document position*, and at a block boundary that
 * position belongs to the block **before** the one the highlight renders in — a
 * deletion at a paragraph's start measured against the previous paragraph's line
 * and put the badge 36.5px below the struck-through text it was meant to sit on.
 * The DOM sibling is the element actually being labelled, so it cannot disagree.
 *
 * Walks forward past intervening widgets (a deletion renders its removed content
 * as one) to the first element carrying a change class. Returns `null` when there
 * is none, which leaves the caller on its `coordsAtPos` path.
 */
function findHighlightAfter(anchor: HTMLElement): HTMLElement | null {
  let sibling = anchor.nextElementSibling
  while (sibling !== null) {
    for (const name of sibling.classList) {
      if (HIGHLIGHT_CLASSES.has(name)) {
        return sibling as HTMLElement
      }
    }
    sibling = sibling.nextElementSibling
  }
  return null
}

/**
 * Finds an ancestor that would clip the badge where it wants to sit.
 *
 * Only vertical clipping matters, and only above the anchor — that is the one
 * direction the badge grows in. Returns the nearest such ancestor, or `null` when
 * the badge has room.
 *
 * The case this exists for is a table cell: the table extension wraps tables in
 * `.table-scrollable` with `overflow-x: auto`, and CSS forces the cross axis to
 * become `hidden` rather than staying `visible`. A badge inside a cell in the
 * first row therefore gets its top sliced off — measured at 3.5px, enough to cut
 * into the name. That `hidden` is load-bearing for horizontal scrolling, so the
 * badge has to leave the clipping context instead.
 */
function findClippingAncestor(
  anchor: HTMLElement,
  badgeTop: number
): HTMLElement | null {
  let element = anchor.parentElement
  while (element !== null && element !== document.body) {
    const overflowY = getComputedStyle(element).overflowY
    if (overflowY !== 'visible') {
      if (element.getBoundingClientRect().top > badgeTop) {
        return element
      }
    }
    element = element.parentElement
  }
  return null
}

/**
 * Measures the badge's height while it is still hidden.
 *
 * The badge is `display: none` until hover, and a `display: none` box reports
 * every dimension as 0 — which is not merely imprecise but actively wrong here: a
 * zero height made every badge look as though it fitted above any clip line, and
 * left the fixed-position offset short by exactly the height it failed to
 * measure (a uniform 25px error).
 *
 * `visibility: hidden` instead of `display: none` for the duration: it takes part
 * in layout, so the box has real dimensions, while staying invisible — the value
 * is read and the style restored within the same frame, so nothing can be painted
 * in between.
 */
function measureHiddenHeight(badge: HTMLElement): number {
  const previousDisplay = badge.style.display
  const previousVisibility = badge.style.visibility
  badge.style.visibility = 'hidden'
  badge.style.display = 'inline-flex'
  const height = badge.offsetHeight
  badge.style.display = previousDisplay
  badge.style.visibility = previousVisibility
  return height
}

/**
 * Re-anchors the badge to the viewport when an ancestor would clip it.
 *
 * `position: fixed` is the only way out of an ancestor's `overflow` clip; no
 * `z-index` or stacking change escapes it. The cost is that a fixed box does not
 * move with the content, so the offset has to be recomputed while scrolling —
 * hence the listeners, which are the reason this is applied *only* when something
 * actually clips rather than to every badge.
 *
 * Listeners are attached once per badge and removed as soon as the anchor leaves
 * the document, which is the only teardown signal available: the viewer applies no
 * transactions and ProseMirror gives a widget no destroy hook. `capture` is
 * required because the scroll happens on the ancestor, not on `window`, and
 * scroll events do not bubble.
 */
function escapeClippingAncestor(
  badge: HTMLElement,
  anchor: HTMLElement,
  offset: number
): void {
  const height = measureHiddenHeight(badge)
  // Where the badge's top edge would land if it stayed in flow.
  const wouldSitAt = anchor.getBoundingClientRect().bottom - offset - height
  if (findClippingAncestor(anchor, wouldSitAt) === null) {
    return
  }

  const reposition = (): boolean => {
    if (!anchor.isConnected) {
      return false
    }
    const anchorBox = anchor.getBoundingClientRect()
    // Same geometry as the absolute case — anchor baseline minus the measured
    // offset puts the badge's lower edge on the highlight — just expressed in
    // viewport coordinates, so `top` also takes off the badge's own height.
    badge.style.position = 'fixed'
    badge.style.bottom = 'auto'
    badge.style.top = `${anchorBox.bottom - offset - height}px`
    badge.style.left = `${anchorBox.left}px`
    return true
  }

  if (!reposition()) {
    return
  }

  const onViewportChange = (): void => {
    if (!reposition()) {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
}

/**
 * Sits the badge's lower edge on the top of the highlight's background box.
 *
 * Measured rather than expressed in CSS because the target edge is the font's
 * ascent above the baseline, and CSS has no unit for it — see {@link badgeWidget}.
 * `coordsAtPos` reports exactly that box, so the offset is the distance from the
 * anchor's own baseline down to it.
 *
 * The first attempt is a microtask so a badge that *can* be measured is placed
 * within the frame it appears in, never seen at the fallback offset first.
 * Attempts after that go on `requestAnimationFrame`, because what they are
 * waiting for is a layout that has not happened yet — re-reading in the same tick
 * would return the same zeroes.
 *
 * Retrying is what makes this correct rather than merely usually-correct: the
 * widget's DOM is built while the viewer's editor may still be hidden, and a
 * single measurement then reads zeroes and would strand the badge on a fallback
 * that is only right at the 16px body size.
 *
 * Gives up silently, leaving that fallback in place. `getPos` returning
 * `undefined` and `coordsAtPos` throwing both mean the position is simply gone
 * (the overlay was rebuilt, the panel closed) — a badge a few pixels off is a far
 * better outcome than an exception taking down the whole overlay.
 */
function alignBadgeToHighlight(
  badge: HTMLElement,
  anchor: HTMLElement,
  view: EditorView,
  getPos: () => number | undefined
): void {
  let remaining = BADGE_ALIGN_ATTEMPTS

  const attempt = (): void => {
    // Not connected yet is not a failure on the first pass — ProseMirror inserts
    // the returned node after this factory runs — so it is retried like any other
    // unmeasurable state rather than abandoned.
    if (anchor.isConnected) {
      let offset: number | null = null
      try {
        const position = getPos()
        if (position === undefined) {
          // The position no longer exists; no later frame will bring it back.
          return
        }
        // The highlight's own first line box when it can be found, since that is
        // the element being labelled; `coordsAtPos` is the fallback for a change
        // whose box is not a following sibling. Both report the background box —
        // measured to agree to the pixel — but only the sibling is guaranteed to
        // be the *right* box at a block boundary.
        const highlight = findHighlightAfter(anchor)
        const target =
          highlight?.getClientRects()[0] ?? view.coordsAtPos(position)
        const anchorBox = anchor.getBoundingClientRect()
        // "Nothing laid out yet" is detected from the boxes themselves, not from
        // the sign of the result. A legitimate offset can be negative: a
        // block-level change's widget renders inside the **previous** block, so
        // the badge has to move *down* to reach its heading. Rejecting negatives
        // left every block-level badge stranded on the CSS fallback — measured
        // 36.5px off on an `h1`, which is the misplacement this whole function
        // exists to remove.
        offset =
          isUnlaidOut(anchorBox) && isUnlaidOut(target)
            ? null
            : anchorBox.bottom - target.top
      } catch {
        // `coordsAtPos` throws for a position the view cannot resolve. Same as
        // above: not something a later frame fixes.
        return
      }

      if (offset !== null && Number.isFinite(offset)) {
        badge.style.bottom = `${offset}px`
        escapeClippingAncestor(badge, anchor, offset)
        return
      }
    }

    remaining -= 1
    if (remaining > 0) {
      requestAnimationFrame(attempt)
    }
  }

  void Promise.resolve().then(attempt)
}

/**
 * Renders the hover badge naming who made a change.
 *
 * `null` when the group should carry no badge — no name to show at all, or a kind
 * the design has no badge for. A badge with no name would be an empty box.
 *
 * 作者只认逐处归属。查不到人时不出徽章，**不回落到版本级 `createdBy`** —— 后者是
 * 「谁创建了这份快照」，与「这段内容是谁写的」没有可推导关系。曾经用它兜底，结果是
 * 把「不知道是谁」显示成确定的署名：实测一份 createdBy 为甲的自动快照，把乙写的整段
 * 新增标成了「甲 新增」。粗一点的名字和错的名字在这里是同一件事。
 *
 * 归属为空的正确读法是「这一版没在这个位置新增内容」，由高亮的中性色承担 —— 见
 * {@link AttributionIndex}。
 *
 * **删除基本都走这条路**：归属是区间量，而 Yjs 不记「谁删的」，所以删除组的 `author`
 * 通常是 `null`，`删除` 徽章因此多数时候不出现。这是从「签错人」换来的「不签名」——
 * 此前是靠探到邻居那段幸存文本的原作者才有名字的。要为删除署名只能靠侧栏的版本级
 * `createdBy` / `collaborators`（服务端把区间贡献者并进了后者），不在这一层。
 *
 * The anchor is a zero-size span so it adds no gap to the running text, and it
 * carries its own positioning context: the viewer body is mounted in the host's
 * document area, which is not guaranteed to be positioned. Reveal is pure CSS
 * hover — the viewer applies no transactions and runs no plugins, so a JS
 * listener here would need its own teardown and race handling with nothing to
 * hang it on.
 *
 * The vertical offset, however, cannot come from CSS. The design puts the badge's
 * lower edge on the **top of the highlight's background box** , and that edge sits at the font's ascent above the baseline — a
 * font metric with no CSS unit to reference. `bottom: 100%` measures from the
 * line box instead, which is taller than the background box by
 * `(line-height − glyph box) / 2`; measured in-browser that left the badge 1.5px
 * high at 16px/26px and 2px *into* the text at line-height 1.2, and the error
 * grew with the line height. So the offset is measured from the live layout via
 * `coordsAtPos`, whose returned box is exactly the background box (verified: both
 * report 22.5px tall at 16px). Aligning this way is exact at every size — eight
 * font-size/line-height combinations measured 0px error, including the 18/20/24px
 * heading sizes a fixed `em` offset was several pixels out on.
 *
 * "Above" throughout describes where the badge sits relative to its highlight,
 * not which way it gets shifted: a block-level change's widget renders inside the
 * *previous* block, so reaching its own highlight means moving down. See
 * {@link alignBadgeToHighlight}.
 */
function badgeWidget(
  group: ChangeGroup,
  colour: CollaboratorColor | null,
  position = group.from,
  nestedOwnerSegment = false,
  marks?: readonly Mark[],
  names?: DisplayNames
): Decoration | null {
  const author = group.author
  const label = BADGE_LABEL[group.kind]
  if (author === null || author === '' || label === undefined) {
    return null
  }
  // 归属只认 username（协同侧登记的是 clientId → username），昵称是另一张表。查不到昵称
  // 就显示 username —— 显示一个能对上人的拼音，比显示空白或猜一个名字都好。
  const displayName = names?.get(author) ?? author

  const style = colourStyle(colour)
  return Decoration.widget(
    position,
    (view, getPos) => {
      const anchor = document.createElement('span')
      anchor.className = `revision-vh-badge-anchor${
        group.isBlock ? ' revision-vh-badge-anchor--block' : ''
      }${nestedOwnerSegment ? ` ${OWNER_SEGMENT_BADGE_CLASS}` : ''}`
      anchor.setAttribute('contenteditable', 'false')

      const badge = document.createElement('span')
      badge.className = 'revision-vh-badge'
      if (style !== null) {
        badge.setAttribute('style', style)
      }
      alignBadgeToHighlight(badge, anchor, view, getPos)

      const name = document.createElement('span')
      name.className = 'revision-vh-badge-name'
      name.textContent = displayName
      // 身份仍是 username：配色、activity、DOM 属性都按它对齐,昵称可以重名也可以改。
      anchor.setAttribute('data-collaborator', author)
      const action = document.createElement('span')
      action.className = 'revision-vh-badge-action'
      action.textContent = label

      badge.append(name, action)
      anchor.appendChild(badge)
      return anchor
    },
    // The same `side` as the deletion widget, deliberately. ProseMirror sorts
    // same-position widgets by `side` first and only falls back to insertion order
    // within one `side`, so the badge keeping its own `-2` would have pulled *every*
    // badge in front of *every* deletion at that position: several paragraphs
    // deleted at once all report the same `from`, and the result was three anchors
    // followed by three removed blocks. The badge reveals on hover through an
    // adjacent-sibling selector, so each anchor then sat next to another anchor
    // instead of the block it labels and only the first one worked. Sharing the
    // `side` puts the pairing back on insertion order, which `buildDiffDecorations`
    // controls — it emits each badge immediately before its own highlight, so the
    // badge still precedes the removed content and the old-then-new reading order
    // holds.
    //
    // `marks` 是「hover 偶发不出气泡」的修复点。徽章靠相邻兄弟选择器揭示，而
    // ProseMirror 对 **未声明 marks** 的 widget 按 `side` 推断包裹层：`side` 为负取
    // **前一个节点**的 marks。高亮是 `Decoration.inline`，永远渲染在**这段内容自己**的
    // mark 包裹层里面。两者只要不同，锚点和高亮就不再是兄弟——新增内容带 bold /
    // link 时锚点留在 `<p>` 下、高亮进了 `<strong>`；反向（前文带 mark、新增是纯文本）
    // 锚点被关进 `<strong>`、高亮留在 `<p>` 下。纯文本改动两边都空，所以能对上，这正是
    // 「偶发」的来源:它只在改动落在 mark 边界上时复现。
    //
    // 显式声明这段内容自己的 marks，锚点与高亮就同层，`:has(+ …)` 重新成立。删除组不
    // 传:删除内容不在当前文档里,由 widget 自带 DOM 承载,它同样不声明 marks,两个
    // widget 因此落在同一层;只给其中一个声明反而会把它们拆开。
    marks === undefined ? { side: -1 } : { side: -1, marks }
  )
}

/**
 * username → 昵称。
 *
 * 只读 `get`，所以调用方给一个 `Map` 就行,不必新建类型。归属里的作者是 **username**
 * （`author1`）,而界面显示的是昵称（`示例作者`）—— 昵称由服务端在
 * `RevisionListItem.collaborators[].nickname` 上给出,前端只做映射,不拼接、不猜。
 */
export type DisplayNames = Pick<Map<string, string>, 'get'>

/**
 * 高亮所在的 mark 包裹层，交给徽章 widget 声明成自己的（见 {@link badgeWidget} 的
 * `marks`）。
 *
 * 只对**行内**改动有意义：`Decoration.inline` 会被渲染进这段内容自己的 mark 层里。块级
 * 改动用 `Decoration.node`，块之间没有跨越的 mark 层，返回 `undefined` 保持原样。
 *
 * 一组可能横跨多个 mark 层（前半纯文本、后半加粗）。这里取**起点**那一段的 marks —— 徽章
 * 只需要和它紧邻的那一段同层，`buildDiffDecorations` 保证徽章紧贴组的起点发出。
 */
function highlightMarks(doc: Node, position: number): readonly Mark[] | undefined {
  const node = doc.nodeAt(position)
  return node !== null && node.isInline ? node.marks : undefined
}

interface OwnedSpan extends AttributionRange {}

/** 把相邻同作者区间收拢，避免一个连续文本片段产生多个重叠高亮和徽章。 */
function appendOwnedSpan(
  spans: OwnedSpan[],
  from: number,
  to: number,
  author: string | null
): void {
  if (author === null || author === '' || to <= from) {
    return
  }
  const previous = spans[spans.length - 1]
  if (
    previous !== undefined &&
    previous.author === author &&
    previous.to === from
  ) {
    spans[spans.length - 1] = { ...previous, to }
    return
  }
  spans.push({ from, to, author })
}

/**
 * 把一段可渲染内容校准到服务端证据。
 *
 * 精确相交的 range 保持原作者；range 之间的坐标空隙沿用产品已确定的“向前适配”，
 * 通过 `authorAtOrBefore` 同时比较前序 range 与 deletion。这样嵌套块拆开后不会另起一套
 * 坐标策略，也不会因为结构 token 没落在 range 里重新出现蓝色断层。
 */
function ownedSpansBetween(
  attribution: AttributionIndex,
  from: number,
  to: number
): readonly OwnedSpan[] {
  if (to <= from) {
    return []
  }

  const spans: OwnedSpan[] = []
  let cursor = from
  for (const range of attribution.rangesBetween(from, to)) {
    if (range.from > cursor) {
      appendOwnedSpan(
        spans,
        cursor,
        range.from,
        attribution.authorAtOrBefore(cursor)
      )
    }
    const rangeFrom = Math.max(cursor, range.from)
    appendOwnedSpan(spans, rangeFrom, range.to, range.author)
    cursor = Math.max(cursor, range.to)
  }
  if (cursor < to) {
    appendOwnedSpan(spans, cursor, to, attribution.authorAtOrBefore(cursor))
  }
  return spans
}

function authorsBetween(
  attribution: AttributionIndex,
  from: number,
  to: number
): ReadonlySet<string> {
  return new Set(attribution.rangesBetween(from, to).map(range => range.author))
}

/**
 * 把嵌套 owner 的徽章放进它的第一个文本块，而不是硬塞到结构节点之前。
 *
 * `span` 直接成为 `tr` / `ul` / `table` 的孩子会破坏网格或列表布局；沿第一条子树下降到
 * 文本块内容起点，对表格、列表、分栏、引用以及未来新增的容器都合法，不依赖类型名。
 */
function badgePositionInside(node: Node, position: number): number {
  let current = node
  let currentPosition = position

  while (!current.isTextblock && current.childCount > 0) {
    currentPosition += 1
    current = current.firstChild as Node
  }
  return current.isTextblock ? currentPosition + 1 : position
}

interface NestedInsertionContext {
  readonly active: boolean
  readonly attribution: AttributionIndex
  readonly colourFor: (author: string | null) => CollaboratorColor | null
  readonly decorations: Decoration[]
  readonly names?: DisplayNames
}

function ownerGroup(
  from: number,
  to: number,
  author: string,
  isBlock: boolean
): ChangeGroup {
  return {
    kind: 'inserted',
    from,
    to,
    author,
    deletedText: '',
    changeIndexes: [],
    isBlock,
  }
}

function insertedClasses(isBlock: boolean, active: boolean): string {
  return [
    CLASS_BY_KIND.inserted,
    isBlock ? NODE_CLASS_BY_KIND.inserted : undefined,
    OWNER_SEGMENT_CLASS,
    active ? ACTIVE_CLASS : undefined,
  ]
    .filter((entry): entry is string => entry !== undefined)
    .join(' ')
}

function ownedAttributes(
  isBlock: boolean,
  active: boolean,
  colour: CollaboratorColor | null
): { class: string; style?: string } {
  const className = insertedClasses(isBlock, active)
  const style = colourStyle(colour)
  return style === null ? { class: className } : { class: className, style }
}

/** 为一个已确定只有单一作者的完整节点上色，并把徽章安全地放进节点内部。 */
function paintOwnedNode(
  node: Node,
  position: number,
  author: string,
  context: NestedInsertionContext
): void {
  const to = position + node.nodeSize
  const takesBox = !node.isInline || !takesInlineTreatment(Fragment.from(node))
  const attributes = ownedAttributes(
    takesBox,
    context.active,
    context.colourFor(author)
  )

  context.decorations.push(
    takesBox
      ? Decoration.node(position, to, attributes)
      : Decoration.inline(position, to, attributes)
  )
  const badge = badgeWidget(
    ownerGroup(position, to, author, takesBox),
    context.colourFor(author),
    badgePositionInside(node, position),
    true,
    undefined,
    context.names
  )
  if (badge !== null) {
    context.decorations.push(badge)
  }
}

/** 文本节点可能自身就是多人交错，按校准后的最小连续作者区间分别渲染。 */
function paintOwnedText(
  node: Node,
  position: number,
  context: NestedInsertionContext
): void {
  for (const span of ownedSpansBetween(
    context.attribution,
    position,
    position + node.nodeSize
  )) {
    const attributes = ownedAttributes(
      false,
      context.active,
      context.colourFor(span.author)
    )
    context.decorations.push(Decoration.inline(span.from, span.to, attributes))
    const badge = badgeWidget(
      ownerGroup(span.from, span.to, span.author, false),
      context.colourFor(span.author),
      span.from,
      false,
      // 整段共享一个文本节点的 marks，逐区间不会再变。
      node.marks,
      context.names
    )
    if (badge !== null) {
      context.decorations.push(badge)
    }
  }
}

/**
 * 递归寻找“最高的单作者子树”。多人则继续下钻，单作者就在当前节点停止。
 *
 * 这个结构判据覆盖所有可嵌套 block：它只读 `Node` 的孩子和坐标，不认识 table、list、
 * blockquote、column 等任何业务节点名。新增新的容器类型时无需登记白名单。
 */
function paintNestedOwners(
  node: Node,
  position: number,
  context: NestedInsertionContext
): void {
  if (node.isText) {
    paintOwnedText(node, position, context)
    return
  }

  const to = position + node.nodeSize
  const authors = authorsBetween(context.attribution, position, to)
  if (authors.size <= 1) {
    const exact = authors.values().next().value as string | undefined
    const author =
      exact ??
      context.attribution.authorAt(position) ??
      context.attribution.authorAt(position + 1) ??
      context.attribution.authorAtOrBefore(position)
    if (author !== null) {
      paintOwnedNode(node, position, author, context)
    }
    return
  }

  node.forEach((child, offset) => {
    paintNestedOwners(child, position + 1 + offset, context)
  })
}

/**
 * Builds the decoration set for a change list.
 *
 * `activeIndex` marks the change the navigation is currently on; `-1` means
 * none. Out-of-range positions are skipped rather than thrown on: the two sides
 * may come from different schema generations, and one unmappable change must not
 * lose the whole overlay.
 *
 * `attribution` plus `colors` turn on per-change attribution: each highlight run
 * gets a hover badge naming its author, coloured with **that** author's hue, so
 * one revision's overlay can carry several colours the way the design shows it.
 * Attribution is only ever read through `groupChanges`, never by walking the raw
 * ranges: the index filters degenerate ranges that the parsed response still
 * carries, so a direct walk would render a badge whose author disagrees with
 * `authorAt`.
 *
 * 归属答不出的位置**不署名也不上色**，走样式表里的中性色。这里刻意不接版本级的
 * `createdBy` 作为回落：它是快照创建者，与「这段内容是谁写的」没有可推导关系，
 * 用它兜底等于把「未记录」显示成一个确定的人。
 *
 * 答不上来是**常态，不是缺陷**：归属是区间量，只声明本区间新增的位置，所以上一版就有
 * 的内容与全部删除都答不出人（见 {@link AttributionIndex}）。因此一份 diff 里「有些
 * 改动署名、有些只上中性色」是正确形态，不要为了填满徽章而在这里加回落。服务端能保证
 * 的只是新增位置的作者查得到（协同侧登记每个 clientId），不包括删除。
 *
 * `showChanges` 仍是「是否上任何 overlay」的唯一开关：调用方隐藏变更时传空的变更
 * 列表，没有 group 可挂徽章。
 */
export function buildDiffDecorations(
  doc: Node,
  changes: readonly RevisionChange[],
  activeIndex = -1,
  attribution: AttributionIndex | null = null,
  colors?: Pick<CollaboratorColorAssigner, 'get'>,
  names?: DisplayNames
): DecorationSet {
  const decorations: Decoration[] = []
  const limit = doc.content.size

  // Keyed by the group's leading change, so the badge can be emitted from inside
  // the main loop — interleaved with the highlight it labels rather than appended
  // after all of them. See {@link badgeWidget} for why the order is load-bearing.
  const badgeByChange = new Map<number, ChangeGroup>()
  // 每个 change 该用谁的色。原来的 bug 是「这处是谁改的」被算了两遍：徽章问
  // `group.author`，高亮却另有来源 —— 同一段内容因此徽章一个色、底色另一个色（实测
  // 徽章洋红 author1、高亮绿 author2）。分组跑一次，两处共用它的结论，两者就不可能
  // 再各说各话。
  const styleByChange = new Map<number, string | null>()

  /**
   * 该处作者的色。取不到人或没有配色器时返回 `null` —— 由样式表的中性色兜底。
   *
   * 不退回版本级 createdBy 的色：那会让「未记录归属」的内容染上快照创建者的颜色，
   * 与徽章不署名的结论自相矛盾，读者仍会以为是那个人改的。
   */
  const colourFor = (author: string | null): CollaboratorColor | null =>
    author === null || colors === undefined ? null : colors.get(author)

  if (attribution !== null) {
    const index = attribution ?? EMPTY_ATTRIBUTION
    // One badge per contiguous run *within a block*, not per change: word-level
    // diffing splits a single edit into several adjacent changes, and a badge on
    // each would pop several boxes over one sentence. Consecutive blocks each keep
    // their own badge — see {@link groupChanges}.
    groupChanges(changes, index, doc.type.schema).forEach(group => {
      badgeByChange.set(group.changeIndexes[0], group)
      // 上色按**组**，与徽章同一个 `group.author` —— 一组就是一处连续改动，它只能
      // 有一个作者，所以徽章和高亮不可能再指向两个人。组内每个 change 都登记，因为
      // 主循环是逐 change 出装饰的。
      const groupStyle = colourStyle(colourFor(group.author))
      for (const changeIndex of group.changeIndexes) {
        styleByChange.set(changeIndex, groupStyle)
      }
    })
  }

  const pushBadge = (index: number): void => {
    const group = badgeByChange.get(index)
    if (group === undefined) {
      return
    }
    if (group.from < 0 || group.to > limit || group.from > group.to) {
      return
    }
    // 徽章锚点是个 `<span>`，落点必须对父节点合法 —— 和 `widgetTag` 是同一条约束，
    // 只是这条路径长期漏掉了。整行 / 整格新增时 `group.from` 正好在 `<tbody>` / `<tr>`
    // 的子节点位置上，而表格里不允许游离的行内内容：浏览器会用**匿名表格盒**兜住它，
    // 凭空多出一行，列宽随之错位。这就是「历史记录里的表格展示错乱」。
    //
    // 修法沿用 `badgePositionInside` 给 owner segment 用的那套：把锚点下沉到该节点的
    // 第一个文本块里（表格是 `<td>` 里的段落），DOM 重新合法，表格结构不再被撑开。
    // 只对表格纠正 —— 匿名表格盒是表格独有的重排规则，`<ul>` 里的游离行内内容浏览器
    // 按行内内容照常排，不会改变列表结构，没必要动。
    const slot = resolveLayoutSlot(doc, group.from)
    const structuralTableSlot =
      slot !== null && (slot.kind === 'table' || slot.kind === 'row')
    const host = structuralTableSlot ? doc.nodeAt(group.from) : null
    // 下沉后锚点不再是高亮的相邻兄弟，`:has(+ …)` 那组选择器照不到它，改由已署名的
    // 祖先 hover 显示 —— 所以要带上 owner-segment 那个类。
    const badgePosition =
      host === null ? group.from : badgePositionInside(host, group.from)
    const sunk = badgePosition !== group.from
    // Same helper the highlight uses, so the two cannot resolve differently for
    // one group.
    const badge = badgeWidget(
      group,
      colourFor(group.author),
      badgePosition,
      sunk,
      // 删除组不声明 marks —— 它要和删除 widget 留在同一层，见 `badgeWidget`。
      group.kind === 'deleted' ? undefined : highlightMarks(doc, badgePosition),
      names
    )
    if (badge !== null) {
      decorations.push(badge)
    }
  }

  changes.forEach((change, index) => {
    if (change.from < 0 || change.to > limit || change.from > change.to) {
      return
    }

    // 没有分组结论（这一版没有逐处归属）时不写内联色，由样式表的中性色兜底。
    const changeStyle = styleByChange.get(index) ?? null

    const active = index === activeIndex
    if (change.kind === 'deleted') {
      // Before the highlight, never after: at one position ProseMirror orders
      // same-`side` widgets by insertion order, and that is what pairs each badge
      // with its own highlight.
      pushBadge(index)
      decorations.push(deletedWidget(doc, change, active, changeStyle))
      return
    }

    // A zero-width non-deletion has nothing to paint.
    if (change.from === change.to) {
      return
    }

    const node = doc.nodeAt(change.from)
    // Whether the change delimits exactly one node. `Decoration.node` requires
    // it, and it is also what rules out a *run*: `ChangeBuilder` merges adjacent
    // same-kind changes, so two inserted images arrive as one change covering
    // both and have to stay on the range path.
    const coversWholeNode =
      node !== null && change.from + node.nodeSize === change.to
    // Block-level changes decorate the node so the whole block is marked; inline
    // ones decorate the range, which is all that changed. The same test also
    // picks the class.
    //
    // "Block-level" here means *marked as a box*, which is not the same as being
    // a block node. A lone inline atom that paints a box — an image, a mention
    // chip — carries no text, so the inline treatment's text colour means nothing
    // on it and its background sits underneath an opaque picture: an inserted
    // image rendered with no marking at all. The deletion side already draws this
    // distinction; both now read it from {@link takesInlineTreatment} so they
    // cannot drift apart again.
    const isBlock =
      coversWholeNode &&
      (!node.isInline || !takesInlineTreatment(Fragment.from(node)))
    // Additive, not a replacement: an inserted block looks the same as an
    // inserted inline run, so the block class is an extra hook rather than a
    // different skin. Dropping `--inserted` here would silently unstyle every
    // block insertion for anything already selecting on it.
    const nodeClass = isBlock ? NODE_CLASS_BY_KIND[change.kind] : undefined
    const className = [
      CLASS_BY_KIND[change.kind],
      nodeClass,
      active ? ACTIVE_CLASS : undefined,
    ]
      .filter((entry): entry is string => entry !== undefined)
      .join(' ')

    /**
     * 一个整块新增 diff 可以包住多人共同写出的任意嵌套容器。原来的单作者 group 只能把
     * `change.from` 的作者色挂到根节点，CSS 变量再沿子树继承，最终把表格、列表、引用、
     * 分栏等全部染成一个人。
     *
     * 根节点仍保留中性的整块新增标识，保证结构新增不会消失；作者色从孩子开始按“最高
     * 单作者子树”递归落下。这里不调用默认 `pushBadge`，因为那个徽章同样只代表根起点的
     * 一个人；递归路径会为每个实际 owner segment 产生自己的徽章。
     */
    const nestedAuthors =
      attribution !== null &&
      change.kind === 'inserted' &&
      isBlock &&
      node !== null &&
      node.childCount > 0
        ? authorsBetween(attribution, change.from, change.to)
        : new Set<string>()
    if (
      nestedAuthors.size > 1 &&
      node !== null &&
      attribution !== null
    ) {
      decorations.push(
        Decoration.node(change.from, change.to, { class: className })
      )
      const context: NestedInsertionContext = {
        active,
        attribution,
        colourFor,
        decorations,
        names,
      }
      node.forEach((child, offset) => {
        paintNestedOwners(child, change.from + 1 + offset, context)
      })
      return
    }

    // Normal single-owner changes keep the existing one-group/one-badge path.
    pushBadge(index)

    const attributes =
      changeStyle === null
        ? { class: className }
        : { class: className, style: changeStyle }

    if (isBlock) {
      decorations.push(Decoration.node(change.from, change.to, attributes))
      return
    }
    decorations.push(Decoration.inline(change.from, change.to, attributes))
  })

  return DecorationSet.create(doc, decorations)
}
