import { startSnapshotServer } from './server'

const port = Number(process.env.PORT ?? '3001')
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT')

const server = await startSnapshotServer({ port })
console.log(`Snapshot API and collaboration server listening on http://127.0.0.1:${server.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().then(() => process.exit(0)) })
}
