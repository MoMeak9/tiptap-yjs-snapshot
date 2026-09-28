import type { RevisionListItem } from '../contracts/api'

const UNKNOWN_TIME = '时间未知'

export interface RevisionDateGroup {
  readonly label: string
  readonly items: readonly RevisionListItem[]
}

function toValidDate(timestamp: number): Date | null {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function formatDateGroupLabel(date: Date, now: Date): string {
  if (isSameLocalDay(date, now)) {
    return '今天'
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameLocalDay(date, yesterday)) {
    return '昨天'
  }

  const monthAndDay = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === now.getFullYear()
    ? monthAndDay
    : `${date.getFullYear()}年${monthAndDay}`
}

/**
 * 按日历日切分修订列表，**保持传入顺序**。
 *
 * 不再自己排序。服务端按 `(ctime DESC, id DESC)` 返回，而游标分页的 key 就是这一对：
 * 客户端另排一次的结果只要与之不同，翻页边界就会错位。原先这里按 `createdAt` 降序
 * 重排，既与服务端重复，又丢掉了 `id` 这一级 tie-breaker（只用数组下标保稳定），
 * 是更弱的序。
 *
 * 同一天的行因此靠"传入顺序里相邻"成组。这由服务端的有序性保证；顺序若乱，这里
 * 会如实呈现出来（可能出现同一标签的两段），而不是用一次客户端排序把它盖掉 ——
 * 排序掩盖的恰是「version 与 ctime 不同向」这类真实的数据缺陷。
 */
export function groupRevisionsByDate(
  items: readonly RevisionListItem[],
  now: number
): readonly RevisionDateGroup[] {
  const referenceDate = new Date(now)
  const groups: Array<{ label: string; items: RevisionListItem[] }> = []

  for (const item of items) {
    const date = toValidDate(item.createdAt)
    const label =
      date === null ? UNKNOWN_TIME : formatDateGroupLabel(date, referenceDate)
    const currentGroup = groups.at(-1)

    if (currentGroup?.label === label) {
      currentGroup.items.push(item)
    } else {
      groups.push({ label, items: [item] })
    }
  }

  return groups
}

export function formatRevisionTime(timestamp: number): string {
  const date = toValidDate(timestamp)
  if (date === null) {
    return UNKNOWN_TIME
  }

  // `YYYY-MM-DD HH:mm` per the revision card. The year is always shown because
  // cards are no longer grouped under a date header that could supply it.
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hour = date.getHours().toString().padStart(2, '0')
  const minute = date.getMinutes().toString().padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

/**
 * Formats one collaborator's edit time, shown under their name when expanded.
 *
 * Seconds are included: several edits inside one revision commonly fall in the
 * same minute, and identical timestamps would look like duplicate rows.
 */
export function formatRevisionActivityTime(timestamp: number): string {
  const date = toValidDate(timestamp)
  if (date === null) {
    return UNKNOWN_TIME
  }

  const second = date.getSeconds().toString().padStart(2, '0')
  return `${formatRevisionTime(timestamp)}:${second}`
}

export function formatContributors(names: readonly string[]): string {
  const visibleNames = names.slice(0, 3)
  const joined = visibleNames.join(', ')
  const remaining = names.length - visibleNames.length

  return remaining > 0 ? `${joined} +${remaining}` : joined
}
