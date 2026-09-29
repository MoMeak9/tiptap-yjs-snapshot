import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const skipped = new Set(['.git', '.data', 'node_modules', 'dist', 'coverage'])
const extensions = /\.(?:ts|tsx|js|mjs|json|md|css|scss)$/i
const forbidden = [
  { label: 'internal organization or package name', pattern: /bilibili|@bilibili\//i },
  { label: 'internal editor namespace', pattern: /eva3(?:-|_|\b)/i },
  { label: 'internal service route', pattern: /sunflower-api/i },
  { label: 'private key', pattern: /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'credential-shaped token', pattern: /\b(?:gho_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/ },
]

const failures = []
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue
    // Archify browser-check sidecars are local, ignored QA evidence, not public artifacts.
    if (entry.name.includes('.visual-check.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      visit(path)
    } else if (entry.isFile() && extensions.test(entry.name) &&
               entry.name !== 'package-lock.json' && entry.name !== 'check-public-surface.mjs') {
      const lines = readFileSync(path, 'utf8').split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        for (const rule of forbidden) {
          if (rule.pattern.test(lines[index])) {
            failures.push(`${relative(root, path)}:${index + 1}: ${rule.label}`)
          }
        }
      }
    }
  }
}

visit(root)
if (failures.length) {
  console.error('Public surface check failed:\n' + failures.join('\n'))
  process.exitCode = 1
} else {
  console.log('Public surface check passed')
}
