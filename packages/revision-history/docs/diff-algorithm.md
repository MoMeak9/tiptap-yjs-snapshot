# 版本历史 Diff 算法

[English](diff-algorithm.en.md) · 简体中文

本文档梳理 `src/diff/` 下的 diff 逻辑：从两份 ProseMirror 文档到带归属的高亮装饰。

对应实现：`tokenize.ts`、`diff-documents.ts`、`attribution.ts`、`change-groups.ts`、`diff-decorations.ts`。

[Outline](https://github.com/outline/outline) 是行内/块级差异展示的设计参考；CJK 分词、位置预算和归属索引是本项目的 V2 实践。本包不内置 [Outline BSL 1.1](https://github.com/outline/outline/blob/main/LICENSE) 源码。本文的服务端归属生成段落描述**宿主接入约束**：公开后端只提供可选的 `IntervalPort`，本机演示没有逐处归属来源。

## 总览

```text
compared doc ──┐
               ├─→ diffDocuments ─→ RevisionChange[]
selected doc ──┘        │
                        ├── pairChildren    结构配对（有预算上限的 Myers）
                        ├── pairRewrites    改写配对（第二轮）
                        ├── compareInline   行内 token 级比较
                        └── ChangeBuilder   合并相邻同类变更

RevisionChange[] ─┐
                  ├─→ groupChanges ─→ ChangeGroup[] ─→ 每组一个 hover 徽章
attribution ──────┘   （同作者+同类型+相接）
```

## 一、为什么不用 `diffWordsWithSpace`

通用的 `diffWordsWithSpace` 对中文经常无法切出足够细的边界。例如：

```text
输入: 这是一段很长的文字内容旧尾 → 这是一段很长的文字内容新尾
输出: -"这是一段很长的文字内容旧尾"   ← 整段
      +"这是一段很长的文字内容新尾"   ← 整段
```

其 tokenizer 主要切在空白与拉丁词边界。中文两者都没有，**整段 CJK 是一个 token**。英文文本仍能正常切分。

照搬会让中文保持整段变色，因此这里采用结构配对加词级比较，并重写 tokenizer。

## 二、切分：`tokenize.ts`

用原生 `Intl.Segmenter`（ICU 支持，无需额外 diff 依赖）：

```typescript
new Intl.Segmenter(undefined, { granularity: 'word' })
```

**locale 传 `undefined` 是有意的。** 词边界是文本的属性，不是读者的属性；若按 locale 切分，两个人比较同一对版本会看到不同的变更数。

**空白保留为独立 token。** token 会被重新拼回文档位置，丢一个就会让后面所有位置偏移。

**降级路径。** 无 `Intl.Segmenter` 的运行时退回 `fallbackTokens`：CJK 逐字、其他整段。它是无损的（`join('') === input`），所以位置仍精确，只是粒度变粗。

降级用 `\p{Script=Han}` 等 script 属性转义，而不是字面码点区间。早期版本把 CJK 兼容表意文字的边界写成字面量 U+F900，而它 **NFC 规范化会变成 U+8C48**，导致区间前移约 29000 个码点，把 Hangul 音节吞进 CJK 分支、韩文被逐字切开。字面量每次被重新键入都会重现这个陷阱；script 转义不会被规范化破坏，且自我描述。

## 三、结构配对：`diff-documents.ts`

### 3.1 `pairChildren`：首轮 Myers 配对

按节点身份调用共享的 `diffSequence`，产出 `equal` / `insert` / `delete` 三种配对。节点身份包含类型名与内容，所以只有完全相同的节点才算 `equal`。`diffSequence` 先去掉公共前后缀，再运行有编辑距离与 trace 内存预算的 Myers；超过预算时中段降级为全删加全增，避免比较大段无关内容时长期占用主线程。

### 3.2 `pairRewrites`：第二轮改写配对

**这是词级生效的前提。** 首轮里，编辑过的段落两侧都不相同，会得到 `delete` + `insert` 两条独立配对——永远进不到行内比较，于是整段变色。

第二轮在一段连续的非 `equal` 配对里，把满足条件的 `delete`/`insert` 配成「改写」（`changed`），从而能递归做行内比较。

两个约束都必要：

- **限定同一段连续未配对区间**——防止顶部的改写抢走下方无关块的配对。
- **限定类型名相同**——防止把段落读成改写过的标题。比较 `.type.name` 而不是 `NodeType` 对象：两份文档可能来自不同 schema 世代，同名类型是不同对象，比对象会让配对永不发生、静默退回整块行为。

**必须保持右文档顺序。** `compareChildren` 靠按顺序累加 `rightPosition += after.nodeSize` 算位置，该累加器只在配对列表与右文档子节点顺序一致时有效。早期实现分两阶段推入（先所有 `changed`、再所有未配对项），破坏了顺序，导致「在编辑过的段落上方插入标题」时标题的高亮画到段落里、段落的改动画到标题里——两处都错，且不报错。现在改写在**原 `insert` 的下标处**就地替换，匹配的 `delete` 被丢弃；`changed` 消耗的位置预算与它作为 `insert` 时完全相同，累加器因此仍然有效。

### 3.3 `compareInline`：token 级行内比较

对配成 `changed` 的一对节点，把行内内容切成 token，再调用同一个 `diffSequence`。

**token 身份故意不含 marks。** 这样给某个词加粗时，该词仍能配对成功并报 `marks-changed`，而不是读成「删除 + 新增」。

**行内原子（如 mention、图片）整体作为一个 token**，`size` 取 `nodeSize`（行内原子为 1）。它没有内部结构可比。

**文本 token 的 `size` 是 UTF-16 码元数**，与 ProseMirror 文本位置的单位一致；`Intl.Segmenter` 不会切开代理对，所以不会有 token 跨半个码点。

### 3.4 `ChangeBuilder`：合并相邻变更

把相接的同类变更合并成一条，避免一次编辑产出一串碎片。

合并判据是 `kind` + 位置相接 + `typeName` 相同。`typeName` 必须参与：连续删除都是同位置零宽，若不比类型，删除的行内原子与删除的文本会并成一条、标签取先到者，字段就会说谎。

`flush` 先置空 `pending` 再判空后推入，因此幂等——重复调用是空操作而不是重复推入。跨块不会串味：一个块最后一个行内 token 结束位置比该块闭合标签早一位，所以下个块的内容与它不相接。

## 四、删除的表示

删除在**当前文档里没有任何东西可以装饰**——那段内容已经不存在了。所以 `RevisionChange` 对删除：

- `from === to`（零宽位置）
- `deletedText`：纯文本，用于无障碍与降级
- `deletedContent: Fragment`：保留 marks 与节点结构

渲染时注入一个只读 widget（见第六节）。

## 五、归属

### 5.1 数据来源

若宿主服务提供逐处归属，应在解码 Yjs state 时与 canonical content **同一次解码**产出归属区间。同源是坐标正确的前提：分两次解码在 canonicalize 版本升级后可能得到不同结果，区间就会错位。公开后端通过可选 `IntervalPort` 接收该区间，不负责提取真实用户身份。

区间以 canonical 文档的 ProseMirror 坐标表达。注意 **ProseMirror 的叶子节点占 1 位**（`nodeSize = isLeaf ? 1 : 2 + content.size`）：早期实现给每个 Yjs `XmlElement` 都算开闭各 1 位，导致图片、提及、分割线、shift-Enter 换行等每出现一次就让后续区间 +1 且误差累积，最终 `textBetween` 越界抛出。

### 5.2 三种形态：`attribution.ts`

```text
{ kind: 'ranges', ranges: [{ from, to, author }] }   逐处归属（普通快照）
{ kind: 'whole', author }                            整篇归属（回滚快照）
null                                                 无归属 → 不署名、走中性色
```

`ranges` 是**区间量**：只声明「从上一版到这一版之间，新增了哪些位置、是谁写的」，不描述「此刻每个幸存字符是谁写的」。若宿主采用源系统的提取方式，应拿上一条修订的 Yjs 状态向量作基线，只声明 `clock` 在基线之后的 item（跨基线的 item 按 clock 切开 —— Yjs 会合并同一 client 连续相邻的 item，不切开会让「接着上一版末尾往下写」整段丢归属）。

这与列表侧的 `collaborators` 因此是同一量纲，两者刻意配套：一个说「这个区间改了哪些位置」，一个说「谁改的」。归属的唯一消费者是 diff 徽章，而徽章要回答「**这一处改动**是谁做的」—— 累计量答的是另一个问题，后果见 5.3。

`null` **不回落到版本级 `createdBy`**：那是「谁存了这一版」，与内容作者没有可推导关系。缺颜色是外观问题，错颜色是事实问题。区间量下「这一版什么都没新增」（纯删除、只改标题）是常态，同样落到 `null`。

`whole` 存在的原因：回滚快照的 `state` 是被恢复版的**逐字节副本**，逐处推导会得到内容原作者；而这一版的内容是执行恢复者一个动作造成的。侧栏写着「某人 恢复了第N版内容」，正文 hover 必须一致。

用带 `kind` 的联合而非「空数组表示整篇」：后者会让「整篇归某人」与「算不出归属」在线上不可区分，而客户端对两者的处理相反。

`createAttributionIndex` 三分支各自语义：`ranges` 二分查找、`whole` 恒定返回（**不看 position**）、`null` 恒定为空。**落在区间外返回 `null` 而不是就近取一段**——猜出来的归属和错误的归属没有区别。

### 5.3 分组：`change-groups.ts`

词级切分会把一次编辑拆成多个相邻 change（共享的字或空格留在中间算未变更）。逐个挂徽章会让一句话弹出好几个，界面中一整句只有一个。

合并要求三条**全部**满足：

- **同作者**——不同人的改动合并会张冠李戴
- **同类型**——一次替换是「删除 + 插入」落在同一位置，合并后徽章说不清是哪种操作；界面中「新增」「删除」正是两个独立徽章
- **位置相接**——中间隔着未变内容的两处改动是两处

只经 `authorAt` 消费归属，不直接遍历 `ranges`：解析层按类型过滤、索引层按值过滤，判据不同，`to <= from` 的坏区间会存在于 `detail.attribution` 但在索引里不存在。

## 六、渲染：`diff-decorations.ts`

### 6.1 类分层

`--inserted` / `--deleted` 用于行内，`--node-inserted` / `--node-deleted` 用于块级。理由见 6.3。

两者的叠加方式不同，因为只有删除侧需要不同外观：

- **删除是替换**：块级拿 `--node-deleted`，不带 `--deleted`。两种处理真的冲突——`line-through` 画在图片或表格上没有意义且会盖住内容，注入的内容还需要一个不被行内规则争抢的尺寸约束。
- **插入是叠加**：块级同时带 `--inserted` 与 `--node-inserted`。插入的内容是文档自己的内容，由编辑器自己的 node view 排版，本来就有尺寸，两种情况长得一样；块级类只是一个挂载点，不是另一套皮肤。保留 `--inserted` 也让消费方既有的选择器不被静默改废（宿主可继续使用该类选择块级插入）。

块级删除的包裹标签决定类名，不另算一次：`widgetTag` 返回 `span` 才是行内。标签必须按**解包后**的内容算——单独一个非空段落会解包成行内内容，按解包前算会把行内内容塞进块级 `div` 并误标成块级删除。

### 6.2 删除 widget

用 schema 自己的 `DOMSerializer` 序列化 `deletedContent`，使加粗、链接、列表项、表格单元格按原样呈现——纯文本渲染会静默丢掉所有 mark 与结构。

包裹标签按上下文选择：行内内容用 `span`；块级按父节点的 `tableRole` / `group` 选 `tr` / `td` / `li`，否则 `div`。块级内容套在 `span` 里会让浏览器以不可预期的方式重排。

单独一个被删段落会解包为行内内容，因为词级删除读起来是句子的一部分。

序列化抛错时退回纯文本：被比较的一侧可能来自更老的 schema 世代、其类型在这里没有序列化器，而一个异常会掀翻整个覆盖层。

### 6.3 块级删除的尺寸约束

被删的图片、附件等块级原子若不加约束，会以**自然尺寸**渲染，溢出正文并盖住周围文字。行内文字的处理（`line-through` + 着色）对它们没有意义——描边才是。

因此块级删除：限制最大高度、`object-fit` 收敛、用 `outline` 而非文字着色表达删除语义。

### 6.4 空块的可见性

被删的空段落序列化后是 `<div></div>`——完全不可见，用户看不出有段落被删除。

空块必须有可见的占位表达，否则「删了一个空段落」这件事在 UI 上不存在。

落法：序列化后判定「渲染出来是否占位」，是则加 `--empty`，由样式表给最小尺寸 + 虚线描边（虚线区别于有内容的块，表示这里本来就是空的）。

**不注入任何文案。** 界面没有「删除了一个空段落」的文案形态，凭空写一句中文会被读成文档里本来没有的内容，所以只做纯视觉处理。

判空看的是「有没有东西画到页面上」而不是有没有文字：`img` / `hr` 这类没有文字但占位的元素必须排除在外，否则会被误判成空块，尺寸约束反而被最小尺寸规则盖掉。

空段落因此**不解包**（见 6.2 的解包规则）：解包会把「整块被删」的唯一线索也抹掉，而这正是空块占位要表达的东西。

### 6.5 徽章

按连续高亮区挂 `Decoration.widget`，`side: -2`（排在删除 widget 的 `-1` 之前，使「旧 → 新」阅读顺序不被打断）。

**纯 CSS hover，不挂 JS 事件**：viewer 是无插件、无事务的裸 `EditorView`，引入 mouseenter/leave 就要自管清理与竞态。

锚点零尺寸且自带 `position: relative`：viewer body 挂在宿主文档区，不保证有定位上下文。

`marks-changed` / `attrs-changed` 不给徽章——界面没有对应形态，凭空造文案是猜。它们仍然高亮，只是没有标签。

## 七、已知边界

- **纯重排不是 move-aware diff。** `[p_old, h_old]` → `[h_new, p_new]` 时，类型不同的会按类型名配对正确落位；两个重排的**同类型**段落按位置配对，报出的范围仍然合法且落在它描述的内容上，但会比 move-aware 的 diff 报更多改动。
- **预算超限会降低精度。** Myers 达到编辑距离或 trace 内存上限时，中段降级为全删加全增，但坐标仍保持合法。
- **`Intl.Segmenter` 降级分支在有该 API 的运行时不可达**，只能直接调 `fallbackTokens` 测试。
