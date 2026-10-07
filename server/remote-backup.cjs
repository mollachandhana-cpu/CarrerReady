'use strict'
/* =====================================================================
   Free-tier persistence: keep an ENCRYPTED copy of the SQLite database in a
   private GitHub repo, and restore it when the server starts with no database.

   Needed because Render Free web services have no persistent disk: the local
   filesystem is wiped on every restart/redeploy/idle spin-down.

   Env (all three required, otherwise this module does nothing):
     BACKUP_GITHUB_REPO   owner/name of a PRIVATE repo (must already have a branch)
     BACKUP_GITHUB_TOKEN  fine-grained token: that repo only, Contents = read & write
     BACKUP_KEY           secret passphrase (16+ chars) used to encrypt the snapshot
   Optional: BACKUP_GITHUB_PATH, BACKUP_GITHUB_BRANCH, BACKUP_MIN_INTERVAL_SEC (default 600)
   ===================================================================== */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')

const MAGIC = Buffer.from('CRB1')
const SQLITE_HEADER = 'SQLite format 3\0'

const cfg = () => ({
  repo: (process.env.BACKUP_GITHUB_REPO || '').trim(),
  token: (process.env.BACKUP_GITHUB_TOKEN || '').trim(),
  key: process.env.BACKUP_KEY || '',
  file: (process.env.BACKUP_GITHUB_PATH || 'careerready.db.enc').trim(),
  branch: (process.env.BACKUP_GITHUB_BRANCH || 'main').trim(),
  api: (process.env.BACKUP_API_BASE || 'https://api.github.com').replace(/\/$/, ''),
  minGapMs: Math.max(0, Number(process.env.BACKUP_MIN_INTERVAL_SEC || 600)) * 1000,
  dataDir: process.env.DATA_DIR || __dirname,
})
const enabled = (c) => Boolean(c.repo && c.token && c.key.length >= 16)
const dbPath = (c) => path.join(c.dataDir, 'careerready.db')
const statusPath = (c) => path.join(c.dataDir, '.remote-backup-status')

/* ---------- encryption: gzip, then AES-256-GCM ---------- */
let keyCache = null
const deriveKey = (pass) => (keyCache && keyCache.pass === pass ? keyCache.key : (keyCache = { pass, key: crypto.scryptSync(pass, 'careerready-backup-v1', 32) }).key)

function encrypt(plain, pass) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pass), iv)
  const body = Buffer.concat([cipher.update(zlib.gzipSync(plain)), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}
function decrypt(buf, pass) {
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('snapshot is not a CareerReady backup')
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass), buf.subarray(4, 16))
  decipher.setAuthTag(buf.subarray(16, 32))
  const plain = zlib.gunzipSync(Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()])) // throws on wrong key / tampering
  if (plain.subarray(0, 16).toString('latin1') !== SQLITE_HEADER) throw new Error('decrypted data is not a SQLite database')
  return plain
}

/* ---------- GitHub Contents API ---------- */
const headers = (c, accept = 'application/vnd.github+json') => ({
  Authorization: 'Bearer ' + c.token, Accept: accept, 'User-Agent': 'careerready-backup', 'X-GitHub-Api-Version': '2022-11-28',
})
const fileUrl = (c) => `${c.api}/repos/${c.repo}/contents/${c.file.split('/').map(encodeURIComponent).join('/')}`
const httpError = (what, res) => Object.assign(new Error(`${what} failed (HTTP ${res.status})`), { status: res.status })

// -> { sha, bytes } or null when the snapshot does not exist yet
async function getRemote(c, { needBytes = true } = {}) {
  const res = await fetch(`${fileUrl(c)}?ref=${encodeURIComponent(c.branch)}`, { headers: headers(c) })
  if (res.status === 404) return null
  if (!res.ok) throw httpError('GitHub read', res)
  const meta = await res.json()
  if (!needBytes) return { sha: meta.sha }
  let bytes
  if (meta.content && meta.encoding === 'base64') bytes = Buffer.from(meta.content, 'base64')
  else { // files over 1 MB come back without inline content
    const raw = await fetch(`${fileUrl(c)}?ref=${encodeURIComponent(c.branch)}`, { headers: headers(c, 'application/vnd.github.raw+json') })
    if (!raw.ok) throw httpError('GitHub raw read', raw)
    bytes = Buffer.from(await raw.arrayBuffer())
  }
  return { sha: meta.sha, bytes }
}
async function putRemote(c, bytes, sha) {
  const body = { message: 'backup ' + new Date().toISOString(), content: bytes.toString('base64'), branch: c.branch }
  if (sha) body.sha = sha
  const res = await fetch(fileUrl(c), { method: 'PUT', headers: { ...headers(c), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw httpError('GitHub write', res)
  return (await res.json()).content.sha
}

/* ---------- restore (runs BEFORE the server opens the database) ---------- */
async function restore() {
  const c = cfg()
  if (!enabled(c)) { console.log('[restore] remote backup not configured; skipping.'); return 'disabled' }
  fs.mkdirSync(c.dataDir, { recursive: true })
  try { fs.unlinkSync(statusPath(c)) } catch {}
  if (fs.existsSync(dbPath(c))) { fs.writeFileSync(statusPath(c), 'present'); console.log('[restore] local database already present; not restoring.'); return 'present' }

  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const remote = await getRemote(c)
      if (!remote) { fs.writeFileSync(statusPath(c), 'empty'); console.log('[restore] no remote snapshot yet; starting with a new database.'); return 'empty' }
      const plain = decrypt(remote.bytes, c.key)
      const tmp = dbPath(c) + '.restoring'
      fs.writeFileSync(tmp, plain)
      for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath(c) + ext) } catch {} }
      fs.renameSync(tmp, dbPath(c))
      fs.writeFileSync(statusPath(c), 'restored')
      console.log(`[restore] restored database from ${c.repo} (${plain.length} bytes).`)
      return 'restored'
    } catch (e) {
      lastErr = e
      if (/not a CareerReady backup|not a SQLite|unable to authenticate|Unsupported state/i.test(e.message)) break // retrying cannot fix a wrong key
      await new Promise((r) => setTimeout(r, attempt * 1500))
    }
  }
  fs.writeFileSync(statusPath(c), 'failed')
  console.error(`[restore] FAILED: ${lastErr && lastErr.message}. Remote uploads are disabled for this run so the saved snapshot is not overwritten.`)
  return 'failed'
}

/* ---------- ongoing upload (runs inside the server) ---------- */
function start(db) {
  const none = { flush: async () => {} }
  const c = cfg()
  if (!enabled(c)) { console.log('[remote-backup] off (set BACKUP_GITHUB_REPO, BACKUP_GITHUB_TOKEN and a 16+ char BACKUP_KEY to keep data on a free plan).'); return none }
  let status = ''
  try { status = fs.readFileSync(statusPath(c), 'utf8').trim() } catch {}
  if (!['restored', 'empty', 'present'].includes(status)) {
    console.error(`[remote-backup] DISABLED: restore did not complete (status "${status || 'missing'}"). Start with "npm start" so the restore step runs first.`)
    return none
  }

  let sha, lastHash = null, lastUpload = 0, busy = false, dirty = status === 'empty' // first run: create the remote snapshot soon
  const mtime = () => ['', '-wal'].reduce((m, ext) => { try { return Math.max(m, fs.statSync(dbPath(c) + ext).mtimeMs) } catch { return m } }, 0)
  let lastSeen = mtime()

  async function upload() {
    if (busy) return
    busy = true
    const tmp = path.join(c.dataDir, 'remote-backup.tmp.db')
    try {
      await db.backup(tmp) // consistent snapshot while the app keeps running
      const plain = fs.readFileSync(tmp)
      const hash = crypto.createHash('sha256').update(plain).digest('hex')
      if (hash === lastHash) { dirty = false; return }
      const bytes = encrypt(plain, c.key)
      if (sha === undefined) { const r = await getRemote(c, { needBytes: false }); sha = r ? r.sha : null }
      try { sha = await putRemote(c, bytes, sha || undefined) }
      catch (e) { // another instance wrote meanwhile (overlapping deploy): take its sha and retry once
        if (e.status !== 409 && e.status !== 422) throw e
        const r = await getRemote(c, { needBytes: false })
        sha = await putRemote(c, bytes, r ? r.sha : undefined)
      }
      lastHash = hash; lastUpload = Date.now(); dirty = false
      console.log(`[remote-backup] saved ${bytes.length} bytes to ${c.repo}`)
    } catch (e) {
      dirty = true
      console.error('[remote-backup] upload failed:', e.message)
    } finally {
      try { fs.unlinkSync(tmp) } catch {}
      busy = false
    }
  }

  const tick = async () => {
    const m = mtime()
    if ((m !== lastSeen || dirty) && Date.now() - lastUpload >= c.minGapMs) { lastSeen = m; await upload() }
  }
  setInterval(tick, 60 * 1000).unref()
  console.log(`[remote-backup] on: ${c.repo} (status: ${status}).`)
  return {
    tick, // exported for tests
    // Called on SIGTERM: save anything not yet uploaded, ignoring the minimum gap.
    flush: async () => {
      if (mtime() === lastSeen && !dirty) return
      await Promise.race([upload(), new Promise((r) => setTimeout(r, 7000))])
    },
  }
}

module.exports = { restore, start, encrypt, decrypt }
