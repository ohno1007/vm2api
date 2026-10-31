import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { CODEX_CLI_VERSION, CODEX_CLI_ARCHIVE_SHA256, CODEX_CLI_BINARY_SHA256 } from '../src/lib/vm/codex-cli-config.mjs'

const dest = path.resolve(process.argv[2] || 'share/codex-cli')
fs.mkdirSync(dest, { recursive: true })
const tmp = fs.mkdtempSync(path.join(dest, '.download-'))
async function digest(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
try {
  const url = `https://github.com/openai/codex/releases/download/rust-v${CODEX_CLI_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz`
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
  if (!response.ok) throw new Error(`codex_download_http_${response.status}`)
  const archive = path.join(tmp, 'codex.tar.gz')
  await pipeline(response.body, fs.createWriteStream(archive, { mode: 0o600 }))
  if (await digest(archive) !== CODEX_CLI_ARCHIVE_SHA256) throw new Error('codex_archive_digest_mismatch')
  execFileSync('tar', ['xzf', archive, '-C', tmp, 'codex-x86_64-unknown-linux-musl'])
  const bin = path.join(tmp, 'codex-x86_64-unknown-linux-musl')
  if (await digest(bin) !== CODEX_CLI_BINARY_SHA256) throw new Error('codex_binary_digest_mismatch')
  fs.chmodSync(bin, 0o755)
  fs.renameSync(bin, path.join(dest, 'codex'))
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ version: CODEX_CLI_VERSION, sha256: CODEX_CLI_BINARY_SHA256 }), { mode: 0o644 })
  console.log(JSON.stringify({ ok: true, version: CODEX_CLI_VERSION, bytes: fs.statSync(path.join(dest, 'codex')).size }))
} finally {
  for (const name of ['codex.tar.gz', 'codex-x86_64-unknown-linux-musl']) fs.rmSync(path.join(tmp, name), { force: true })
  fs.rmdirSync(tmp)
}
