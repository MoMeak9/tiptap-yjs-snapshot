import type { JSONContent } from '@tiptap/core'

export type RevisionChange =
  | { kind: 'title'; before: string; after: string }
  | { kind: 'block'; block: number; before: string; after: string }
  | { kind: 'insert' | 'delete'; block: number; text: string }
  | { kind: 'format'; block: number; text: string; before: string; after: string }

export interface RevisionDiff {
  changes: RevisionChange[]
  warnings: string[]
}

interface Glyph { value: string; marks: string }
interface Block { text: string; glyphs: Glyph[]; signature: string; label: string }

const supportedNodes = new Set([
  'doc', 'paragraph', 'heading', 'text', 'hardBreak', 'blockquote', 'bulletList',
  'orderedList', 'listItem', 'codeBlock', 'horizontalRule',
])
const supportedMarks = new Set(['bold', 'italic', 'strike', 'code', 'link', 'underline'])

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function nodeLabel(node: JSONContent): string {
  if (node.type === 'heading') return `标题 H${node.attrs?.level ?? '?'}`
  if (node.type === 'paragraph') return '段落'
  if (node.type === 'codeBlock') return '代码块'
  if (node.type === 'horizontalRule') return '分隔线'
  return node.type || '未知节点'
}

function markLabel(value: string): string {
  if (!value) return '普通文本'
  try {
    const marks = JSON.parse(value) as Array<{ type: string; attrs?: Record<string, unknown> }>
    return marks.map((mark) => {
      const names: Record<string, string> = { bold: '加粗', italic: '斜体', strike: '删除线', code: '代码', link: '链接', underline: '下划线' }
      return mark.type === 'link' ? `链接 ${String(mark.attrs?.href ?? '')}` : names[mark.type] || mark.type
    }).join('、')
  } catch {
    return '文本格式'
  }
}

function linearBlocks(doc: JSONContent, warnings: Set<string>): Block[] {
  const blocks: Block[] = []
  function visit(node: JSONContent, ancestors: string[]) {
    const type = node.type || 'unknown'
    if (!supportedNodes.has(type)) warnings.add(`节点 ${type} 超出 StarterKit 文本差异范围`)
    const structure = `${type}:${stable(node.attrs ?? {})}`
    if (type === 'text') return
    if (type === 'doc' || type === 'blockquote' || type === 'bulletList' || type === 'orderedList' || type === 'listItem') {
      for (const child of node.content ?? []) visit(child, type === 'doc' ? ancestors : [...ancestors, structure])
      return
    }
    const glyphs: Glyph[] = []
    function collect(child: JSONContent) {
      if (child.type === 'text') {
        const marks = (child.marks ?? []).map((mark) => ({ type: mark.type, attrs: mark.attrs ?? {} }))
        for (const mark of marks) if (!supportedMarks.has(mark.type)) warnings.add(`标记 ${mark.type} 超出 StarterKit 文本差异范围`)
        const key = marks.length ? stable(marks.sort((a, b) => String(a.type).localeCompare(String(b.type)))) : ''
        for (const value of Array.from(child.text ?? '')) glyphs.push({ value, marks: key })
      } else if (child.type === 'hardBreak') {
        glyphs.push({ value: '\n', marks: '' })
      } else if (child.content) {
        for (const nested of child.content) collect(nested)
      } else if (child.type && child.type !== 'horizontalRule') {
        warnings.add(`节点 ${child.type} 超出 StarterKit 文本差异范围`)
      }
    }
    for (const child of node.content ?? []) collect(child)
    const text = glyphs.map((glyph) => glyph.value).join('')
    blocks.push({ text, glyphs, signature: [...ancestors, structure].join('/'), label: nodeLabel(node) })
  }
  visit(doc, [])
  return blocks
}

// Exact LCS for short passages. For long passages, preserve common edges and
// report the middle as a replacement to avoid quadratic work in the browser.
function lcsPairs<T>(left: T[], right: T[], equal: (a: T, b: T) => boolean): Array<[number, number]> {
  if (left.length * right.length > 250_000) {
    const pairs: Array<[number, number]> = []
    let start = 0
    while (start < left.length && start < right.length && equal(left[start], right[start])) {
      pairs.push([start, start]); start += 1
    }
    const tail: Array<[number, number]> = []
    let l = left.length - 1
    let r = right.length - 1
    while (l >= start && r >= start && equal(left[l], right[r])) {
      tail.unshift([l, r]); l -= 1; r -= 1
    }
    return [...pairs, ...tail]
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let l = left.length - 1; l >= 0; l -= 1) {
    for (let r = right.length - 1; r >= 0; r -= 1) {
      table[l][r] = equal(left[l], right[r]) ? table[l + 1][r + 1] + 1 : Math.max(table[l + 1][r], table[l][r + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let l = 0
  let r = 0
  while (l < left.length && r < right.length) {
    if (equal(left[l], right[r])) { pairs.push([l, r]); l += 1; r += 1 }
    else if (table[l + 1][r] >= table[l][r + 1]) l += 1
    else r += 1
  }
  return pairs
}

function pushText(changes: RevisionChange[], kind: 'insert' | 'delete', block: number, text: string) {
  if (!text) return
  const last = changes.at(-1)
  if (last?.kind === kind && last.block === block) last.text += text
  else changes.push({ kind, block, text })
}

function compareBlock(before: Block, after: Block, block: number, changes: RevisionChange[]) {
  if (before.signature !== after.signature) changes.push({
    kind: 'block', block,
    before: before.label === after.label ? before.signature : before.label,
    after: before.label === after.label ? after.signature : after.label,
  })
  const pairs = lcsPairs(before.glyphs, after.glyphs, (a, b) => a.value === b.value)
  let oldIndex = 0
  let newIndex = 0
  for (const [oldMatch, newMatch] of [...pairs, [before.glyphs.length, after.glyphs.length] as [number, number]]) {
    pushText(changes, 'delete', block, before.glyphs.slice(oldIndex, oldMatch).map((glyph) => glyph.value).join(''))
    pushText(changes, 'insert', block, after.glyphs.slice(newIndex, newMatch).map((glyph) => glyph.value).join(''))
    if (oldMatch < before.glyphs.length) {
      const oldGlyph = before.glyphs[oldMatch]
      const newGlyph = after.glyphs[newMatch]
      if (oldGlyph.marks !== newGlyph.marks) {
        const previous = changes.at(-1)
        const oldLabel = markLabel(oldGlyph.marks)
        const newLabel = markLabel(newGlyph.marks)
        if (previous?.kind === 'format' && previous.block === block && previous.before === oldLabel && previous.after === newLabel) previous.text += oldGlyph.value
        else changes.push({ kind: 'format', block, text: oldGlyph.value, before: oldLabel, after: newLabel })
      }
    }
    oldIndex = oldMatch + 1
    newIndex = newMatch + 1
  }
}

export function diffRevisions(
  from: { title: string; content: JSONContent },
  to: { title: string; content: JSONContent },
): RevisionDiff {
  const changes: RevisionChange[] = []
  const warnings = new Set<string>()
  if (from.title !== to.title) changes.push({ kind: 'title', before: from.title, after: to.title })
  const oldBlocks = linearBlocks(from.content, warnings)
  const newBlocks = linearBlocks(to.content, warnings)
  const pairs = lcsPairs(oldBlocks, newBlocks, (a, b) => a.text === b.text)
  let oldIndex = 0
  let newIndex = 0
  for (const [oldMatch, newMatch] of [...pairs, [oldBlocks.length, newBlocks.length] as [number, number]]) {
    const unmatchedOld = oldMatch - oldIndex
    const unmatchedNew = newMatch - newIndex
    const paired = Math.min(unmatchedOld, unmatchedNew)
    for (let offset = 0; offset < paired; offset += 1) compareBlock(oldBlocks[oldIndex + offset], newBlocks[newIndex + offset], newIndex + offset + 1, changes)
    for (let offset = paired; offset < unmatchedOld; offset += 1) {
      const source = oldBlocks[oldIndex + offset]
      changes.push({ kind: 'block', block: oldIndex + offset + 1, before: source.label, after: '已删除' })
      pushText(changes, 'delete', oldIndex + offset + 1, source.text)
    }
    for (let offset = paired; offset < unmatchedNew; offset += 1) {
      const target = newBlocks[newIndex + offset]
      changes.push({ kind: 'block', block: newIndex + offset + 1, before: '不存在', after: target.label })
      pushText(changes, 'insert', newIndex + offset + 1, target.text)
    }
    if (oldMatch < oldBlocks.length) compareBlock(oldBlocks[oldMatch], newBlocks[newMatch], newMatch + 1, changes)
    oldIndex = oldMatch + 1
    newIndex = newMatch + 1
  }
  return { changes, warnings: [...warnings] }
}
