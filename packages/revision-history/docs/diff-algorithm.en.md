# Revision-history diff algorithm

English · [简体中文](diff-algorithm.md)

This document explains the diff logic under `src/diff/`: how two ProseMirror documents become highlighted decorations with optional attribution.

Corresponding modules: `tokenize.ts`, `diff-documents.ts`, `attribution.ts`, `change-groups.ts`, and `diff-decorations.ts`.

[Outline](https://github.com/outline/outline) is a design reference for inline/block diff presentation. CJK tokenization, position budgets, and the attribution index are this project's V2 practice. This package does not vendor [Outline's BSL 1.1 source](https://github.com/outline/outline/blob/main/LICENSE). The server-side attribution sections below describe **host integration requirements**: the public backend exposes an optional `IntervalPort`, while the local demo has no source of per-position authorship.

## Overview

```text
compared doc ──┐
               ├─→ diffDocuments ─→ RevisionChange[]
selected doc ──┘        │
                        ├── pairChildren    Structural pairing (budgeted Myers)
                        ├── pairRewrites    Second-pass rewrite pairing
                        ├── compareInline   Inline token comparison
                        └── ChangeBuilder   Merge adjacent changes of one kind

RevisionChange[] ─┐
                  ├─→ groupChanges ─→ ChangeGroup[] ─→ one hover badge per group
attribution ──────┘   (same author, same kind, touching ranges)
```

## 1. Why not `diffWordsWithSpace`

A general-purpose `diffWordsWithSpace` often cannot find sufficiently fine boundaries in Chinese:

```text
Input:  这是一段很长的文字内容旧尾 → 这是一段很长的文字内容新尾
Output: -"这是一段很长的文字内容旧尾"  ← entire passage
        +"这是一段很长的文字内容新尾"  ← entire passage
```

Its tokenizer mainly splits at whitespace and Latin word boundaries. CJK text often has neither, so **a whole CJK passage becomes one token**, even though English still splits as expected. Copying that behavior would color the entire passage. This implementation pairs structure, compares words, and uses a different tokenizer.

## 2. Tokenization: `tokenize.ts`

It uses native `Intl.Segmenter` with ICU support, with no additional diff dependency:

```typescript
new Intl.Segmenter(undefined, { granularity: 'word' })
```

**Passing `undefined` for locale is deliberate.** A word boundary is a property of the text, not the reader. Locale-dependent segmentation could show different change counts to two readers comparing the same revisions.

**Whitespace remains a separate token.** Tokens are mapped back to document positions; dropping whitespace would shift every later position.

**Fallback.** Where `Intl.Segmenter` is unavailable, `fallbackTokens` splits CJK by character and keeps other runs whole. It is lossless (`join('') === input`), so positions stay exact even if the diff is coarser.

The fallback uses Unicode script escapes such as `\p{Script=Han}` instead of literal code point ranges. An earlier literal U+F900 boundary normalized under NFC to U+8C48, shifting the range by about 29,000 code points and sweeping Hangul syllables into the CJK branch. Retyping the literal could reproduce the bug. A script escape is stable under normalization and describes its intent.

## 3. Structural pairing: `diff-documents.ts`

### 3.1 First pass, `pairChildren`

The shared `diffSequence` compares node identity and produces `equal`, `insert`, and `delete` pairs. Identity includes type and content, so a node is `equal` only when the whole node matches. `diffSequence` removes common prefixes and suffixes before running Myers with edit-distance and trace-memory budgets. If a budget is exceeded, the middle degrades to delete-all/add-all so a large unrelated comparison does not monopolize the main thread.

### 3.2 Second pass, `pairRewrites`

**This is what enables word-level changes.** An edited paragraph is different on both sides of the first pass and initially appears as separate `delete` and `insert` entries. Without pairing them as a rewrite, inline comparison never runs and the entire paragraph changes color.

Within one consecutive run of non-`equal` entries, the second pass pairs eligible deleted and inserted nodes as `changed` so it can compare inside them recursively. Two constraints matter:

- **Stay within one consecutive unmatched run.** A rewrite near the top must not steal a node from an unrelated block below.
- **Require the same type name.** A paragraph must not become a rewritten heading. Compare `.type.name` rather than `NodeType` object identity: documents from different schema generations can have distinct objects for the same type name.

**Preserve the right document's order.** `compareChildren` computes positions by accumulating `rightPosition += after.nodeSize`, which is correct only when the pairing list follows the right document's child order. An earlier two-phase assembly appended all `changed` entries before remaining unmatched entries. Inserting a heading above an edited paragraph then painted the heading's change on the paragraph and vice versa without throwing. The current logic replaces the original `insert` entry in place and drops the matching `delete`; the `changed` entry consumes the same position budget as that `insert`.

### 3.3 Inline comparison, `compareInline`

For a `changed` pair, inline content is tokenized and compared with the same `diffSequence`.

**Token identity deliberately excludes marks.** A word that becomes bold can still pair with itself and report `marks-changed` instead of a deletion plus insertion.

**Inline atoms**, such as mentions and images, are single tokens whose size is `nodeSize` (1 for an inline atom). They have no internal structure to compare.

**Text token size is measured in UTF-16 code units**, matching ProseMirror text positions. `Intl.Segmenter` does not split a surrogate pair, so a token cannot end halfway through a code point.

### 3.4 `ChangeBuilder` merges adjacent changes

Adjacent changes of the same kind become one range instead of a string of fragments. The merge rule includes kind, touching positions, and the same `typeName`. Type must participate because zero-width deletions can share a position: merging an inline-atom deletion with a text deletion would mislabel one of them.

`flush` clears `pending` before pushing it, so repeated calls are idempotent. Changes do not leak across blocks: the final inline token ends one position before its block's closing boundary, and the next block's content does not touch it.

## 4. Representing deletions

Deleted content has **nothing left in the current document to decorate**. A deletion therefore has:

- `from === to`: a zero-width position;
- `deletedText`: plain text for accessibility and fallback;
- `deletedContent: Fragment`: marks and node structure preserved.

Rendering inserts a read-only widget at that position, as described in section 6.

## 5. Attribution

### 5.1 Data source

If a host provides per-position attribution, it should derive its ranges from **the same Yjs state decode** as canonical content. That shared origin is required for correct coordinates; decoding separately across a canonicalization change could silently assign a range to the wrong text. The public backend accepts ranges through optional `IntervalPort` and does not extract real user identities.

Ranges use ProseMirror positions in the canonical document. **Leaf nodes occupy one position** (`nodeSize = isLeaf ? 1 : 2 + content.size`). An earlier extractor counted an opening and closing position for every Yjs `XmlElement`, adding one extra position for each image, mention, rule, or hard break. Errors accumulated until `textBetween` could run out of range.

### 5.2 Three shapes: `attribution.ts`

```text
{ kind: 'ranges', ranges: [{ from, to, author }] }   Per-position attribution
{ kind: 'whole', author }                            Whole-document attribution for restore
null                                                 No attribution: unsigned, neutral color
```

`ranges` is an **interval quantity**: it says which positions were newly added since the preceding revision and who added them. It does not claim to identify the author of every surviving character. A host using the source system's extraction approach should use the preceding revision's Yjs state vector as baseline and claim only items whose `clock` follows it. An item crossing that baseline must be split by clock: Yjs can merge adjacent consecutive items from one client, and failing to split can lose attribution for text appended after the preceding revision.

This makes `ranges` and list-level `collaborators` complementary: one gives changed positions, the other gives participants. A diff badge asks **who made this particular change**; lifetime authorship answers a different question.

`null` **does not fall back to revision-level `createdBy`**. That field says who saved the revision, which does not prove who wrote its text. Under interval semantics, a pure deletion or title-only revision can legitimately add no positions and yield `null`. Missing color is a presentation issue; a wrong author is a factual error.

`whole` handles restore: the restored revision's state is a **byte-for-byte copy** of an earlier version. Deriving per-character authorship from those bytes would show original authors, while the new revision was produced by the person who performed restore. Sidebar and body badge should describe the same action.

A tagged union keeps “whole document belongs to one actor” distinct from “attribution unavailable”. In `createAttributionIndex`, `ranges` uses binary search, `whole` returns one author regardless of position, and `null` always returns none. A position outside every range returns `null`, never the nearest author's range.

### 5.3 Groups: `change-groups.ts`

Word-level splitting can create several neighboring changes for one edit, separated by unchanged words or spaces. Showing a badge for every fragment crowds a single sentence. Changes merge only when **all three** rules hold:

- **Same author.** Combining different people's changes would misattribute them.
- **Same kind.** A replacement contains a deletion and insertion at the same position; they need distinct “deleted” and “inserted” badges.
- **Touching positions.** Two changes separated by unchanged content remain separate.

Grouping asks the index through `authorAt` instead of reading raw `ranges` directly. Parsing and indexing have different validation rules; an invalid `to <= from` range might be present in detail input but intentionally absent from the index.

## 6. Rendering: `diff-decorations.ts`

### 6.1 CSS class layers

`--inserted` / `--deleted` represent inline changes, while `--node-inserted` / `--node-deleted` represent blocks.

- **Deletion replaces the inline treatment.** A deleted block gets `--node-deleted`, without `--deleted`. A strike-through over an image or table is meaningless and obscures content; an injected block also needs its own size constraint.
- **Insertion adds a block hook.** A block insertion carries both `--inserted` and `--node-inserted`. It is still the editor's own content, already laid out by its node view. The block class is an extra styling hook; preserving `--inserted` also keeps existing host selectors working.

The wrapper tag determines deletion class: `widgetTag` returns `span` only for inline content. Decide after unwrapping the deleted content. A single nonempty paragraph becomes inline content; deciding from the original block would place inline content inside a block `div` and classify it incorrectly.

### 6.2 Deletion widget

The widget serializes `deletedContent` through the schema's own `DOMSerializer`. Bold text, links, list items, and table cells then retain their marks and structure; plain-text rendering would silently discard them.

The wrapper depends on context: `span` for inline content; `tr`, `td`, or `li` for applicable parent `tableRole` / `group`; otherwise `div`. Putting block content inside a `span` gives the browser unpredictable reflow. A single deleted nonempty paragraph is unwrapped as inline content so it reads as part of a sentence.

If serialization throws because an older compared schema lacks a serializer here, the widget falls back to plain text. One unsupported historical node should not destroy the whole overlay.

### 6.3 Size constraint for deleted blocks

A deleted image, attachment, or other block atom could render at its **natural size**, overflow the body, and cover nearby text. Inline strike-through and text coloring do not describe it well. Deleted blocks therefore use maximum-height constraints, `object-fit`, and an `outline` rather than text coloring.

### 6.4 Empty-block visibility

A deleted empty paragraph can serialize as `<div></div>` and become invisible. The UI needs a visible placeholder to communicate that an empty block was deleted. After serialization, the renderer asks whether the output occupies visual space; empty output receives `--empty`, whose styles add minimum size and a dashed border. Textless but visible elements such as `img` and `hr` are excluded from that classification.

The placeholder **does not invent prose** such as “deleted an empty paragraph”, which could be mistaken for former document content. An empty paragraph is not unwrapped: unwrapping would erase the only structural clue the placeholder must express.

### 6.5 Badges

Each consecutive highlighted group gets a `Decoration.widget` with `side: -2`, before a deletion widget's `-1`, preserving old-to-new reading order.

Hover uses **CSS only**, without JavaScript mouse events. The viewer is a bare `EditorView` without plugins or transactions; JavaScript hover state would add cleanup and race conditions. The badge anchor has zero dimensions and its own `position: relative` because the host document area may not establish a positioning context.

`marks-changed` and `attrs-changed` remain highlighted but receive no badge; the UI has no faithful label for those forms, so it does not invent one.

## 7. Known boundaries

- **Pure reordering is not move-aware.** In `[p_old, h_old] → [h_new, p_new]`, differing node types pair by name and land correctly. Reordered paragraphs of the same type pair by position; their reported ranges remain valid and point at described content, but a move-aware diff would report fewer changes.
- **A budget overrun reduces precision.** When Myers reaches its edit-distance or trace-memory budget, the middle becomes delete-all/add-all while positions remain valid.
- **The `Intl.Segmenter` fallback cannot be reached through normal execution in an environment that has that API.** Test `fallbackTokens` directly.
