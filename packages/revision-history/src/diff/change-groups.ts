import type { Schema } from '@tiptap/pm/model'
import type { AttributionIndex } from './attribution'
import type { RevisionChange, RevisionChangeKind } from './diff-documents'

/**
 * 一段连续高亮区：徽章挂在它上面。
 *
 * 词级切分会把一次编辑拆成多个相邻 change（共享的字或空格留在中间算未变更），逐个
 * 挂徽章会让一句话里弹出好几个。分组后一整句只弹一个，与设计稿一致。
 *
 * 合并只在**块内**发生 —— 连续几个块级变更各自成组，理由见 {@link groupChanges}。
 */
export interface ChangeGroup {
  readonly kind: RevisionChangeKind
  readonly from: number
  readonly to: number
  /**
   * 该处作者，无归属时 `null` —— 此时徽章不显示，但仍然上色（中性色）。
   *
   * `null` 对**删除**是常态而非异常：Yjs 不记「谁删的」，归属又只声明本区间新增的位置，
   * 所以删除多数时候两个探针都落空。见 {@link resolveAuthor}。
   */
  readonly author: string | null
  /** 被删文本的拼接，仅 `deleted` 组有意义。 */
  readonly deletedText: string
  /** 本组覆盖的 change 在原数组里的下标，供导航定位。 */
  readonly changeIndexes: readonly number[]
  /**
   * 本组覆盖的是整个块，而不是块里的一段行内内容。
   *
   * 只用来阻止下一处变更并进来：块级组永远只装一个 change，所以合并后的组必然是
   * 行内的。
   */
  readonly isBlock: boolean
}

/**
 * 查一处变更的作者。
 *
 * 不能只查 `change.from`：归属区间与 change 的坐标不是一一对应的，`from` 那一位有两种
 * 形态会落在任何区间之外，此时 `authorAt` 按设计返回 `null`，徽章就整个不渲染 ——
 * 这正是「很多 diff hover 没有气泡」的两个来源。
 *
 * （历史说法「区间只覆盖文本」已不成立：服务端加了 `appendElementRange`，节点开标签
 * 那一位现在也有归属。探针依然必要，理由是坐标错位与区间量的过滤，不是缺少节点归属。）
 *
 * 所以按形态补一个探针，且**只朝该 change 自己覆盖的方向探**：
 *
 * - **非零宽（新增 / 格式变更）补 `from + 1`。** 块级变更的 `from` 是节点的开标签
 *   位置，正文在它之后一位。整段新增实测 `from=5`，而该段文本区间是 `[6,12)` ——
 *   差的就是这一位。不往前探：`from - 1` 是本次变更根本没覆盖的内容。
 * - **零宽（删除）补 `from - 1`。** 删除处现在没有内容，`from` 指向的是它后面那段；
 *   段末删除时 `from` 恰好等于前一段区间的排他右端点（删「甲乙丙」的「丙」得
 *   `from=3`，区间 `[1,3)`），于是两边都查不到。`from - 1` 是紧邻删除点之前的字符，
 *   那是被删内容真正的邻居。不往后探：那已由第一个探针覆盖。
 *
 * ## 探针顺序在区间量下才真正生效
 *
 * 顺序即置信度顺序，第一个命中即返回。这在归属还是**累计量**时是个陷阱：改老段落里的
 * 文字、diff 报成块级变更时，`authorAt(from)`（开标签那一位）会命中「当年建这个段落的
 * 人」并直接返回，`from + 1` 上真正的编辑者永远问不到，徽章因此签错人。
 *
 * 区间量下那一位只在**这一版新建了该节点**时才有归属，改老段落时落空，于是自然落到第
 * 二个探针拿到本次编辑者。顺序没有变，是它现在才对。
 *
 * ## 删除先查专门的删除署名
 *
 * 零宽变更**第一个**探针是 `deletedAuthorAt(change.from)`，优先于上面任何一条。删除的
 * 作者不在 Yjs 里（delete set 只记「删了什么」不记「谁删的」），由服务端协同层在删除
 * 那一刻捕获后随修订落库，锚点就是 `change.from`。
 *
 * 顺序不能颠倒：`authorAt(from)` 与 `from - 1` 拿到的都是**邻居**的作者 —— 前者是删除点
 * 之后那段、后者是之前那段。删除者与邻居作者不同时（我删掉你写的字，这是最常见的情形）
 * 那两个探针给出的是错名字。先查删除署名才能拿到真正动手的人。
 *
 * 没有删除记录时（存量修订、服务端未捕获到执行者、Redis 记录已过期）先走后两个精确
 * 探针；仍落空时按当前产品策略调用 `authorAtOrBefore`，在服务端下发的 range / deletion
 * 中向前取最近作者。这是坐标错位下的客户端就近适配，会用“更完整的署名”换取一定的
 * 误归属风险。
 *
 * 整篇归属（回滚版）在第一个探针就命中 —— 那一版的删除同样归执行恢复的人。
 */
function resolveAuthor(
  change: RevisionChange,
  attribution: AttributionIndex
): string | null {
  const isRemoval = change.to === change.from
  if (isRemoval) {
    const deleter = attribution.deletedAuthorAt(change.from)
    if (deleter !== null) {
      return deleter
    }
  }

  const exact = attribution.authorAt(change.from)
  if (exact !== null) {
    return exact
  }
  const adjacent = attribution.authorAt(
    isRemoval ? change.from - 1 : change.from + 1
  )
  if (adjacent !== null) {
    return adjacent
  }

  return attribution.authorAtOrBefore(change.from)
}

/**
 * 这处变更覆盖的是一整个块，而不是块里的一段行内内容。
 *
 * 判据是 `typeName` 在 schema 里的定义，不是坐标：连续几段被删除时三处变更的
 * `from` 全都相等（内容已不在本文档里，坐标只标「原来在这」），坐标无从区分，而
 * `typeName` 仍分别是 `paragraph` 与词级切碎的 `text`。
 *
 * schema 里查不到的类型按行内处理：合并是默认行为，未知类型不该因为认不出来就被
 * 拆开。
 */
function isBlockChange(change: RevisionChange, schema: Schema): boolean {
  const type = schema.nodes[change.typeName]
  return type !== undefined && !type.isInline
}

/**
 * 把相邻变更合并成连续高亮区。
 *
 * 四个条件全部满足才合并：同作者、同类型、位置相接、同为行内。
 *
 * - 同作者：不同人的改动合并会张冠李戴。
 * - 同类型：一次替换是「删除 + 插入」落在同一位置，合并后徽章说不清是哪种操作；
 *   界面中「新增」「删除」正是两个独立徽章。
 * - 位置相接：中间隔着未变内容的两处改动是两处，不是一处。
 * - 同为行内：块级变更各自成组。合并只为收拢词级切碎 —— 那是**一句话内**一次编辑被
 *   拆成的多个相邻 change，逐个挂徽章会在一句话上弹好几个气泡。跨块合并解决不了任何
 *   这类问题，却让徽章只剩一个锚点、只挂在首块之前：徽章靠相邻兄弟选择器
 *   （`.revision-vh-badge-anchor:has(+ .revision-vh-diff--inserted:hover)`）显形，锚点后面
 *   紧跟的只有第一块，后面几块 hover 时什么都不弹。实测三段连续新增得到 3 个 change、
 *   1 个组、1 个锚点，后两段无响应。
 */
export function groupChanges(
  changes: readonly RevisionChange[],
  attribution: AttributionIndex,
  schema: Schema
): readonly ChangeGroup[] {
  const groups: ChangeGroup[] = []

  changes.forEach((change, index) => {
    const author = resolveAuthor(change, attribution)
    const last = groups[groups.length - 1]

    if (
      last !== undefined &&
      last.kind === change.kind &&
      last.author === author &&
      last.to === change.from &&
      !last.isBlock &&
      !isBlockChange(change, schema)
    ) {
      groups[groups.length - 1] = {
        kind: last.kind,
        from: last.from,
        to: change.to,
        author,
        deletedText: last.deletedText + (change.deletedText ?? ''),
        changeIndexes: [...last.changeIndexes, index],
        isBlock: false,
      }
      return
    }

    groups.push({
      kind: change.kind,
      from: change.from,
      to: change.to,
      author,
      deletedText: change.deletedText ?? '',
      changeIndexes: [index],
      isBlock: isBlockChange(change, schema),
    })
  })

  return groups
}
