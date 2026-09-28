import { startSnapshotServer } from './server'

const port = Number(process.env.PORT ?? '3001')
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT')
const dataDir = process.env.DATA_DIR?.trim()
if (process.env.DATA_DIR !== undefined && !dataDir) throw new Error('Invalid DATA_DIR')
const allowedOrigins = process.env.FRONTEND_ORIGINS?.split(',').map(origin => origin.trim())

const server = await startSnapshotServer({ port, dataDir, allowedOrigins })
console.log(`Snapshot API and collaboration server listening on http://127.0.0.1:${server.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().then(() => process.exit(0)) })
}
