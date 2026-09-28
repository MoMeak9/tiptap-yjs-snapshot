/** Generic, replaceable collaborator palette. */

/** 一个色系的三档取色。 */
export interface CollaboratorColor {
  /** Stable palette key. */
  readonly hue: string
  /** 第 5 档：人员色 / 新增文本色 / hover 框背景。 */
  readonly strong: string
  /** 第 4 档：删除文本色 / 人员操作下划线。 */
  readonly medium: string
  /** 第 1 档：新增文本背景 / 操作模块背景。 */
  readonly soft: string
}

/** A neutral open-source default; applications can inject their own palette. */
export const COLLABORATOR_COLORS: readonly CollaboratorColor[] = Object.freeze([
  { hue: 'purple', strong: '#6D28D9', medium: '#8B5CF6', soft: '#F3E8FF' },
  { hue: 'teal', strong: '#0F766E', medium: '#14B8A6', soft: '#CCFBF1' },
  { hue: 'amber', strong: '#92400E', medium: '#D97706', soft: '#FEF3C7' },
  { hue: 'blue', strong: '#1D4ED8', medium: '#3B82F6', soft: '#DBEAFE' },
  { hue: 'rose', strong: '#BE123C', medium: '#F43F5E', soft: '#FFE4E6' },
  { hue: 'green', strong: '#166534', medium: '#22C55E', soft: '#DCFCE7' },
  { hue: 'orange', strong: '#9A3412', medium: '#F97316', soft: '#FFEDD5' },
  { hue: 'cyan', strong: '#0E7490', medium: '#06B6D4', soft: '#CFFAFE' },
])

/**
 * 在一个文档内把协作者名映射到颜色。
 *
 * 设计允许"再次进入文档时重置关联颜色",所以这里按**分配顺序**发色而不是对名字做哈希：
 * 顺序分配能保证在色系用尽前**同文档内不同人必然不同色**,而哈希会撞色。
 * 同一实例内同一个人始终同色(这是设计的硬要求),实例随面板生命周期存在。
 */
export class CollaboratorColorAssigner {
  private readonly assigned = new Map<string, CollaboratorColor>()

  constructor(
    private readonly palette: readonly CollaboratorColor[] = COLLABORATOR_COLORS
  ) {}

  /**
   * 取某人的配色。
   *
   * 人数超过色系数量后从头复用 —— 复用优于造一个色库外的颜色。
   */
  get(name: string): CollaboratorColor {
    const existing = this.assigned.get(name)
    if (existing !== undefined) {
      return existing
    }

    const color = this.palette[this.assigned.size % this.palette.length]
    this.assigned.set(name, color)
    return color
  }
}
