import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const pairs = [
  ['README.md', 'README.en.md'],
  ['docs/architecture.zh-CN.md', 'docs/architecture.en.md'],
  ['docs/contract.zh-CN.md', 'docs/contract.en.md'],
  ['docs/v2-extraction.zh-CN.md', 'docs/v2-extraction.en.md'],
  ['packages/v2-core/README.md', 'packages/v2-core/README.en.md'],
  ['packages/revision-history/README.zh-CN.md', 'packages/revision-history/README.md'],
  ['packages/revision-history/docs/diff-algorithm.md', 'packages/revision-history/docs/diff-algorithm.en.md'],
]

const failures = []
for (const [chinese, english] of pairs) {
  let zh = ''
  let en = ''
  try { zh = readFileSync(join(root, chinese), 'utf8') }
  catch { failures.push(`${chinese}: missing Chinese document`) }
  try { en = readFileSync(join(root, english), 'utf8') }
  catch { failures.push(`${english}: missing English document`) }
  if (zh && !zh.includes(basename(english))) failures.push(`${chinese}: missing link to ${basename(english)}`)
  if (en && !en.includes(basename(chinese))) failures.push(`${english}: missing link to ${basename(chinese)}`)
}

if (failures.length) {
  console.error('Bilingual docs check failed:\n' + failures.join('\n'))
  process.exitCode = 1
} else {
  console.log('Bilingual docs check passed')
}
