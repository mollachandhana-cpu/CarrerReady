'use strict'
/* =====================================================================
   CareerReady "launch" module
   Everything needed to run the platform with REAL mentors and real users:
   - security headers + rate limiting
   - email verification, password reset, email/SMS notifications
   - mentor invites + admin verification panel
   - mentor availability slots, student booking, auto video-meeting links
   - session reviews and mentor ratings
   - optional OpenAI "student brief" for mentors
   This file is registered BEFORE production-integrations.cjs, so the safer
   versions of a few routes here take priority over the older ones.
   ===================================================================== */
const crypto = require('crypto')
const ai = require('./ai.cjs')

function registerLaunch({ app, db, auth, pushToUser, hashPassword }) {
  const isProduction = process.env.NODE_ENV === 'production'
  const APP_URL = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
    const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  
  const emailEnabled = Boolean(process.env.SMTP_HOST || process.env.RESEND_API_KEY)
  const nowIso = () => new Date().toISOString()
  const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex')
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const clean = (v, max) => String(v ?? '').trim().slice(0, max)

  if (isProduction) app.set('trust proxy', 1) // Render/Railway/Fly sit behind a proxy
  if (isProduction && !emailEnabled) console.warn('[launch] No email provider configured (set RESEND_API_KEY or SMTP_*): verification and reset emails cannot be sent.')

  /* ---------------- Database additions (safe to run repeatedly) ---------------- */
  const addColumn = (table, column, type) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((x) => x.name)
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
  // Columns this module relies on (production-integrations.cjs adds the same ones later; adding twice is safe).
  addColumn('users', 'role', "TEXT NOT NULL DEFAULT 'student'")
  addColumn('users', 'phone', "TEXT NOT NULL DEFAULT ''")
  addColumn('users', 'status', "TEXT NOT NULL DEFAULT 'active'")
  // Existing users stay verified (DEFAULT 1) so nobody is locked out by this upgrade.
  addColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 1')
  addColumn('mentor_sessions', 'slot_id', 'INTEGER')
  addColumn('mentor_profiles', 'review_note', "TEXT NOT NULL DEFAULT ''")
  if (ADMIN_EMAIL) {
    const adminRow = db.prepare('SELECT id, role FROM users WHERE lower(email)=?').get(ADMIN_EMAIL)
    console.log(`[db] ${db.name} users=${db.prepare('SELECT COUNT(*) n FROM users').get().n}`)
    if (adminRow && adminRow.role !== 'admin') db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminRow.id)
    console.log(`[admin] ${ADMIN_EMAIL}: ${adminRow ? (adminRow.role === 'admin' ? 'already admin' : 'promoted to admin') : 'account not in this database yet; it will be promoted on its first authenticated request'}`)

    // The account can appear after boot (fresh/empty DB, or it signs up later), so also promote it,
    // deterministically, the first time its own valid, verified, active session is used.
    let adminSettled = false
    const adminSessionUser = db.prepare(
      `SELECT u.id, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND datetime(s.created_at) >= datetime('now','-30 days')
         AND lower(u.email) = ? AND COALESCE(u.status,'active') = 'active' AND u.email_verified = 1`
    )
    app.use('/api', (req, res, next) => {
      if (!adminSettled) {
        const token = (req.headers.authorization || '').replace('Bearer ', '')
        const u = token ? adminSessionUser.get(sha(token), ADMIN_EMAIL) : null
        if (u) {
          if (u.role !== 'admin') {
            db.prepare("UPDATE users SET role='admin' WHERE id=?").run(u.id)
            console.log(`[admin] ${ADMIN_EMAIL}: promoted to admin on authenticated request`)
          }
          adminSettled = true
        }
      }
      next()
    })
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mentor_invites (
      code TEXT PRIMARY KEY,
      email TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL,
      used_by INTEGER,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS mentor_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      student_id INTEGER,
      UNIQUE(mentor_id, starts_at)
    );
    CREATE TABLE IF NOT EXISTS session_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL UNIQUE,
      mentor_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const audit = (actorId, action, detail = '') => db.prepare('INSERT INTO audit_log(actor_id,action,detail) VALUES(?,?,?)').run(actorId || null, action, String(detail).slice(0, 500))

  // Repair: the old flow made people "mentor" the moment they applied. Only approved profiles may keep that role.
  db.prepare(`UPDATE users SET role='student' WHERE role='mentor' AND id NOT IN (SELECT user_id FROM mentor_profiles WHERE verification_status='approved')`).run()
  // Housekeeping: drop expired sessions and tokens now and once a day.
  const housekeeping = () => {
    db.prepare("DELETE FROM sessions WHERE datetime(created_at) < datetime('now','-30 days')").run()
    db.prepare('DELETE FROM email_tokens WHERE expires_at < ?').run(nowIso())
  }
  housekeeping()
  setInterval(housekeeping, 24 * 3600 * 1000).unref()

  /* ---------------- Security headers ---------------- */
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    })
    if (isProduction) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
    next()
  })

  /* ---------------- Rate limiting (in memory, no package needed) ---------------- */
  const hits = new Map()
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k) }, 10 * 60 * 1000).unref()
  const limit = (name, max, windowMs, keyFn) => (req, res, next) => {
    const key = name + ':' + (keyFn ? keyFn(req) : req.ip)
    const t = Date.now()
    let e = hits.get(key)
    if (!e || e.reset < t) { e = { n: 0, reset: t + windowMs }; hits.set(key, e) }
    e.n += 1
    if (e.n > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - t) / 1000)))
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' })
    }
    next()
  }
  const byToken = (req) => req.headers.authorization || req.ip
  app.use('/api/login', limit('login', 10, 15 * 60 * 1000, (req) => req.ip + ':' + clean(req.body?.email, 200).toLowerCase()))
  app.use('/api/signup', limit('signup', 30, 60 * 60 * 1000))
  app.use('/api/password', limit('password', 8, 60 * 60 * 1000))
  app.use('/api/verify-email/resend', limit('resend', 5, 60 * 60 * 1000, byToken))
  app.use('/api/ai', limit('ai', 20, 60 * 60 * 1000, byToken))
  app.use('/api/mentor/student', limit('brief', 20, 60 * 60 * 1000, byToken))
  app.post('/api/community', limit('post', 15, 60 * 60 * 1000, byToken))
  app.post('/api/community/:id/replies', limit('reply', 40, 60 * 60 * 1000, byToken))
  app.post('/api/mentors/:id/connect', limit('connect', 10, 24 * 3600 * 1000, byToken))

  // Suspended accounts cannot log in.
  app.post('/api/login', (req, res, next) => {
    const row = db.prepare('SELECT status FROM users WHERE email=?').get(clean(req.body?.email, 200).toLowerCase())
    if (row && row.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended. Contact support.' })
    next()
  })

  /* ---------------- Notifications: email, SMS, live push ---------------- */
  let transporter = null
  function getMailer() {
    if (transporter !== null) return transporter
    transporter = false
    if (!emailEnabled) return transporter
    try {
      const nodemailer = require('nodemailer')
      const port = Number(process.env.SMTP_PORT || 587)
      transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined })
    } catch { console.warn('[launch] SMTP_HOST is set but the "nodemailer" package is missing. Run: npm install nodemailer') }
    return transporter
  }
  async function sendEmail(to, subject, text) {
    if (!to) return false
    // HTTPS email API (works even where outbound SMTP ports are blocked).
    if (process.env.RESEND_API_KEY) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
          signal: AbortSignal.timeout(15000),
        })
        if (!r.ok) console.error('[launch] Resend rejected the email:', r.status, (await r.text()).slice(0, 200))
        return r.ok
      } catch (e) { console.error('[launch] Resend email failed:', e.message); return false }
    }
    const t = getMailer()
    if (!t) { if (!isProduction) console.log(`\n[email not sent - SMTP off]\nTo: ${to}\nSubject: ${subject}\n${text}\n`); return false }
    try { await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text }); return true } catch (e) { console.error('[launch] email failed:', e.message); return false }
  }
  async function sendSms(to, body) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = process.env
    if (!to || !sid || !token || !from) return false
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: to, From: from, Body: body }) })
      return r.ok
    } catch { return false }
  }
  function notify(userId, subject, text) {
    const u = db.prepare('SELECT email,phone FROM users WHERE id=?').get(userId)
    if (!u) return
    sendEmail(u.email, subject, text + `\n\n- CareerReady\n${APP_URL}`)
    if (u.phone) sendSms(u.phone, `CareerReady: ${subject}`)
  }
  function newToken(userId, purpose, hours) {
    const raw = crypto.randomBytes(32).toString('hex')
    db.prepare('DELETE FROM email_tokens WHERE user_id=? AND purpose=?').run(userId, purpose)
    db.prepare('INSERT INTO email_tokens(token_hash,user_id,purpose,expires_at) VALUES(?,?,?,?)').run(sha(raw), userId, purpose, new Date(Date.now() + hours * 3600 * 1000).toISOString())
    return raw
  }
  function useToken(raw, purpose) {
    const row = db.prepare('SELECT * FROM email_tokens WHERE token_hash=? AND purpose=?').get(sha(raw || ''), purpose)
    if (!row || row.expires_at < nowIso()) return null
    db.prepare('DELETE FROM email_tokens WHERE token_hash=?').run(row.token_hash)
    return row.user_id
  }
  function sendVerification(user) {
    const token = newToken(user.id, 'verify', 48)
    return sendEmail(user.email, 'Verify your CareerReady email', `Hi ${user.name},\n\nConfirm your email address to unlock mentor features:\n${APP_URL}/api/verify-email?token=${token}\n\nThis link works for 48 hours.`)
  }

  /* ---------------- Sign up (stronger rules + email verification) ---------------- */
  app.post('/api/signup', async (req, res, next) => {
   try {
    const name = clean(req.body?.name, 80)
    const email = clean(req.body?.email, 200).toLowerCase()
    const password = String(req.body?.password || '')
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' })
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' })
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
    if (password.length > 200) return res.status(400).json({ error: 'Password is too long.' })
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'An account with this email already exists.' })
    const branch = clean(req.body?.branch, 60) || 'Other'
    const year = clean(req.body?.year, 30) || '1st year'
    const passwordHash = await hashPassword(password)
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'An account with this email already exists.' })
    const info = db.prepare('INSERT INTO users (name,email,password_hash,branch,year,email_verified) VALUES (?,?,?,?,?,?)').run(name, email, passwordHash, branch, year, emailEnabled ? 0 : 1)
    const user = { id: Number(info.lastInsertRowid), name, email, branch, year, role: 'student', status: 'active' }
    const token = crypto.randomBytes(24).toString('hex')
    db.prepare('INSERT INTO sessions (token,user_id) VALUES (?,?)').run(sha(token), user.id)
    if (emailEnabled) sendVerification(user)
    res.json({ token, user: { ...user, emailVerified: !emailEnabled } })
   } catch (err) { next(err) }
  })

  app.get('/api/verify-email', (req, res) => {
    const userId = useToken(String(req.query.token || ''), 'verify')
    if (userId) db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(userId)
    res.type('html').send(page(userId ? 'Email verified' : 'Link expired', userId ? '<p>Your email is verified. You can close this tab and return to CareerReady.</p>' : '<p>This verification link is invalid or has expired. Log in and request a new one.</p>', `<p><a href="${esc(APP_URL)}">Open CareerReady</a></p>`))
  })
  app.post('/api/verify-email/resend', auth, (req, res) => {
    const u = db.prepare('SELECT id,name,email,email_verified FROM users WHERE id=?').get(req.user.id)
    if (u.email_verified) return res.json({ ok: true, alreadyVerified: true })
    sendVerification(u)
    res.json({ ok: true })
  })
  app.get('/api/account', auth, (req, res) => {
    const u = db.prepare('SELECT email_verified FROM users WHERE id=?').get(req.user.id)
    res.json({ emailVerified: Boolean(u.email_verified), emailEnabled, integrations: { ai: ai.enabled(), sms: Boolean(process.env.TWILIO_ACCOUNT_SID) } })
  })

  /* ---------------- Password reset (works without touching React) ---------------- */
  function page(title, body, extra = '', script = '', nonce = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - CareerReady</title><style>body{font-family:system-ui,sans-serif;background:#f4f7fb;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:1px solid #dde5f0;border-radius:16px;padding:28px;width:min(420px,92vw)}h1{margin-top:0;font-size:1.4rem}input,button{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;border-radius:10px;border:1px solid #cdd7e5;font:inherit}button{background:#3157e8;color:#fff;border:0;font-weight:700;cursor:pointer}#msg{min-height:1.4em}</style></head><body><main><h1>${esc(title)}</h1>${body}${extra}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`
  }
  function formPage(res, title, fields, endpoint, doneText) {
    const nonce = crypto.randomBytes(12).toString('base64')
    res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'`)
    const script = `document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();var m=document.getElementById('msg');m.textContent='Working...';var body={};new FormData(e.target).forEach(function(v,k){body[k]=v});try{var r=await fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});var d=await r.json();m.textContent=r.ok?${JSON.stringify(doneText)}:(d.error||'Something went wrong.');if(r.ok)e.target.reset()}catch(x){m.textContent='Network error.'}})`
    res.type('html').send(page(title, `<form id="f">${fields}<button type="submit">Continue</button></form><p id="msg"></p>`, `<p><a href="${esc(APP_URL)}">Back to CareerReady</a></p>`, script, nonce))
  }
  app.get('/api/pages/forgot', (req, res) => formPage(res, 'Forgot password', '<input type="email" name="email" placeholder="Your account email" required>', '/api/password/forgot', 'If that email has an account, a reset link is on its way.'))
  app.get('/api/pages/reset', (req, res) => formPage(res, 'Choose a new password', `<input type="password" name="password" placeholder="New password (min 8 characters)" minlength="8" required><input type="hidden" name="token" value="${esc(String(req.query.token || ''))}">`, '/api/password/reset', 'Password updated. You can log in now.'))
  app.post('/api/password/forgot', (req, res) => {
    const u = db.prepare('SELECT id,name,email FROM users WHERE email=?').get(clean(req.body?.email, 200).toLowerCase())
    if (u) {
      const token = newToken(u.id, 'reset', 1)
      sendEmail(u.email, 'Reset your CareerReady password', `Hi ${u.name},\n\nChoose a new password here (valid for 1 hour):\n${APP_URL}/api/pages/reset?token=${token}\n\nIf you did not ask for this, ignore this email.`)
    }
    res.json({ ok: true }) // same answer whether or not the account exists
  })
  app.post('/api/password/reset', async (req, res, next) => {
   try {
    const password = String(req.body?.password || '')
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
    const userId = useToken(String(req.body?.token || ''), 'reset')
    if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired.' })
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password), userId)
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId) // sign out everywhere
    audit(userId, 'password_reset')
    res.json({ ok: true })
   } catch (err) { next(err) }
  })

  /* ---------------- Mentor application (invite codes, no early role) ---------------- */
  app.post('/api/mentor/apply', auth, (req, res) => {
    const u = db.prepare('SELECT id,name,email,role,email_verified FROM users WHERE id=?').get(req.user.id)
    if (u.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot become mentors. Use a separate account.' })
    if (!u.email_verified) return res.status(403).json({ error: 'Verify your email address first (check your inbox).' })
    const b = req.body || {}
    const headline = clean(b.headline, 120), expertise = clean(b.expertise, 300), company = clean(b.company, 120)
    const linkedin = clean(b.linkedin, 250), availability = clean(b.availability, 120) || 'Flexible'
    const experienceYears = Math.max(0, Math.min(60, Math.round(Number(b.experienceYears) || 0)))
    const hourlyRate = Math.max(0, Math.min(5000, Math.round(Number(b.hourlyRate) || 0)))
    if (headline.length < 5 || expertise.length < 3) return res.status(400).json({ error: 'Add a headline and your areas of expertise.' })
    if (!/^https?:\/\//i.test(linkedin)) return res.status(400).json({ error: 'A LinkedIn (or professional profile) URL starting with https:// is required so we can verify you.' })
    const code = clean(b.inviteCode, 40).toUpperCase()
    let invite = null
    if (code) {
      invite = db.prepare('SELECT * FROM mentor_invites WHERE code=? AND used_by IS NULL').get(code)
      if (!invite) return res.status(400).json({ error: 'That invite code is invalid or already used.' })
      if (invite.email && invite.email.toLowerCase() !== u.email.toLowerCase()) return res.status(400).json({ error: 'That invite was issued to a different email address.' })
    }
    const existing = db.prepare('SELECT verification_status FROM mentor_profiles WHERE user_id=?').get(u.id)
    const status = invite || existing?.verification_status === 'approved' ? 'approved' : 'pending'
    db.prepare(`INSERT INTO mentor_profiles(user_id,headline,expertise,experience_years,company,linkedin,hourly_rate,availability,verification_status)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET headline=excluded.headline,expertise=excluded.expertise,experience_years=excluded.experience_years,company=excluded.company,linkedin=excluded.linkedin,hourly_rate=excluded.hourly_rate,availability=excluded.availability,verification_status=excluded.verification_status`)
      .run(u.id, headline, expertise, experienceYears, company, linkedin, hourlyRate, availability, status)
    if (invite) db.prepare('UPDATE mentor_invites SET used_by=?,used_at=? WHERE code=?').run(u.id, nowIso(), code)
    if (status === 'approved') db.prepare("UPDATE users SET role='mentor' WHERE id=?").run(u.id)
    else for (const a of db.prepare("SELECT id FROM users WHERE role='admin'").all()) notify(a.id, 'New mentor application', `${u.name} (${u.email}) applied to be a mentor. Review it in the Admin Panel.`)
    audit(u.id, 'mentor_apply', status)
    res.json({ status, message: status === 'approved' ? 'Your invite was accepted. Log out and back in to open your Mentor Workspace.' : 'Application submitted. An administrator will verify your profile before students can book you.' })
  })

  /* ---------------- Admin panel ---------------- */
  const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required.' }))
  app.get('/api/admin/overview', auth, adminOnly, (req, res) => {
    const count = (sql) => db.prepare(sql).get().n
    res.json({
      counts: {
        users: count('SELECT COUNT(*) n FROM users'),
        students: count("SELECT COUNT(*) n FROM users WHERE role='student'"),
        mentors: count("SELECT COUNT(*) n FROM users WHERE role='mentor'"),
        sessions: count('SELECT COUNT(*) n FROM mentor_sessions'),
        reviews: count('SELECT COUNT(*) n FROM session_reviews'),
      },
      pending: db.prepare(`SELECT u.id,u.name,u.email,mp.headline,mp.expertise,mp.experience_years,mp.company,mp.linkedin FROM mentor_profiles mp JOIN users u ON u.id=mp.user_id WHERE mp.verification_status='pending' ORDER BY mp.created_at`).all(),
      invites: db.prepare('SELECT code,email,used_by,created_at FROM mentor_invites ORDER BY created_at DESC LIMIT 30').all(),
      reports: db.prepare(`SELECT r.id report_id,r.reason,p.id post_id,p.title,p.body FROM community_reports r JOIN community_posts p ON p.id=r.post_id ORDER BY r.created_at DESC LIMIT 30`).all(),
      users: db.prepare('SELECT id,name,email,role,status,email_verified,created_at FROM users ORDER BY id DESC LIMIT 60').all(),
    })
  })
  app.get('/api/admin/mentor-applications', auth, adminOnly, (req, res) => {
    res.json({ applications: db.prepare(`SELECT u.id,u.name,u.email,u.phone,mp.* FROM users u JOIN mentor_profiles mp ON mp.user_id=u.id WHERE mp.verification_status='pending' ORDER BY mp.created_at DESC`).all() })
  })
  app.post('/api/admin/mentor-applications/:id', auth, adminOnly, (req, res) => {
    const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : null
    if (!status) return res.status(400).json({ error: 'Status must be approved or rejected.' })
    const id = Number(req.params.id)
    const target = db.prepare('SELECT id,name,role FROM users WHERE id=?').get(id)
    const profile = db.prepare('SELECT 1 FROM mentor_profiles WHERE user_id=?').get(id)
    if (!target || !profile) return res.status(404).json({ error: 'Application not found.' })
    if (target.role === 'admin') return res.status(400).json({ error: 'Cannot change an admin account.' })
    const note = clean(req.body?.note, 400)
    db.prepare('UPDATE mentor_profiles SET verification_status=?,review_note=? WHERE user_id=?').run(status, note, id)
    db.prepare('UPDATE users SET role=? WHERE id=?').run(status === 'approved' ? 'mentor' : 'student', id)
    audit(req.user.id, 'mentor_' + status, `user ${id}`)
    notify(id, status === 'approved' ? 'Your mentor profile is approved' : 'Your mentor application was not approved', status === 'approved' ? 'Congratulations! Log out and back in to open your Mentor Workspace and add availability.' : `Thanks for applying.${note ? ' Note from the reviewer: ' + note : ''}`)
    res.json({ ok: true, status })
  })
  app.post('/api/admin/invites', auth, adminOnly, (req, res) => {
    const email = clean(req.body?.email, 200).toLowerCase()
    const code = crypto.randomBytes(5).toString('hex').toUpperCase()
    db.prepare('INSERT INTO mentor_invites(code,email,created_by) VALUES(?,?,?)').run(code, email, req.user.id)
    if (email) sendEmail(email, 'You are invited to mentor on CareerReady', `You have been invited to mentor engineering students.\n\n1. Create an account at ${APP_URL} using this email address\n2. Open "Find a Mentor" and fill in the mentor form\n3. Enter invite code: ${code}`)
    audit(req.user.id, 'invite_created', email || 'open invite')
    res.json({ code })
  })
  app.post('/api/admin/users/:id/status', auth, adminOnly, (req, res) => {
    const id = Number(req.params.id)
    const status = ['active', 'suspended'].includes(req.body?.status) ? req.body.status : null
    if (!status) return res.status(400).json({ error: 'Status must be active or suspended.' })
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot suspend your own account.' })
    db.prepare('UPDATE users SET status=? WHERE id=?').run(status, id)
    if (status === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id=?').run(id)
    audit(req.user.id, 'user_' + status, `user ${id}`)
    res.json({ ok: true })
  })
  app.delete('/api/admin/community/:id', auth, adminOnly, (req, res) => {
    const id = Number(req.params.id)
    db.prepare('DELETE FROM community_replies WHERE post_id=?').run(id)
    db.prepare('DELETE FROM community_reports WHERE post_id=?').run(id)
    db.prepare('DELETE FROM community_posts WHERE id=?').run(id)
    audit(req.user.id, 'post_removed', `post ${id}`)
    res.json({ ok: true })
  })

  /* ---------------- Mentor directory with ratings (no email exposed) ---------------- */
  app.get('/api/mentors', auth, (req, res) => {
    const mentors = db.prepare(`
      SELECT u.id,u.name,u.location,u.linkedin,u.bio,u.branch,
             mp.headline,mp.expertise,mp.experience_years,mp.company,mp.hourly_rate,mp.availability,
             (SELECT ROUND(AVG(rating),1) FROM session_reviews sr WHERE sr.mentor_id=u.id) avg_rating,
             (SELECT COUNT(*) FROM session_reviews sr WHERE sr.mentor_id=u.id) review_count,
             (SELECT COUNT(*) FROM mentor_sessions ms WHERE ms.mentor_id=u.id AND ms.status='completed') sessions_done,
             (SELECT COUNT(*) FROM mentor_slots s WHERE s.mentor_id=u.id AND s.status='open' AND s.starts_at>?) open_slots
      FROM users u JOIN mentor_profiles mp ON mp.user_id=u.id
      WHERE u.role='mentor' AND u.status='active' AND mp.verification_status='approved'
      ORDER BY open_slots>0 DESC, review_count DESC, mp.experience_years DESC, u.name`).all(nowIso())
    res.json({ mentors })
  })
  app.get('/api/mentors/:id/reviews', auth, (req, res) => {
    const reviews = db.prepare(`SELECT sr.rating,sr.comment,sr.created_at,u.name FROM session_reviews sr JOIN users u ON u.id=sr.student_id WHERE sr.mentor_id=? ORDER BY sr.created_at DESC LIMIT 10`).all(Number(req.params.id))
    res.json({ reviews: reviews.map((r) => ({ ...r, name: String(r.name).split(' ')[0] })) })
  })

  /* ---------------- Availability slots and booking ---------------- */
  const isApprovedMentor = (req) => req.user.role === 'mentor' && db.prepare("SELECT 1 FROM mentor_profiles WHERE user_id=? AND verification_status='approved'").get(req.user.id)
  const mentorOnly = (req, res, next) => (isApprovedMentor(req) ? next() : res.status(403).json({ error: 'Verified mentor access required.' }))

  app.get('/api/mentor/slots', auth, mentorOnly, (req, res) => {
    res.json({ slots: db.prepare(`SELECT s.*,u.name student_name FROM mentor_slots s LEFT JOIN users u ON u.id=s.student_id WHERE s.mentor_id=? AND s.ends_at>? ORDER BY s.starts_at LIMIT 100`).all(req.user.id, nowIso()) })
  })
  app.post('/api/mentor/slots', auth, mentorOnly, (req, res) => {
    const start = new Date(req.body?.startsAt)
    const minutes = Math.max(15, Math.min(180, Math.round(Number(req.body?.durationMin) || 45)))
    const weeks = Math.max(1, Math.min(8, Math.round(Number(req.body?.weeks) || 1)))
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Pick a valid start date and time.' })
    if (start.getTime() < Date.now() + 30 * 60 * 1000) return res.status(400).json({ error: 'Slots must start at least 30 minutes from now.' })
    if (start.getTime() > Date.now() + 120 * 24 * 3600 * 1000) return res.status(400).json({ error: 'Slots can be at most 120 days ahead.' })
    let created = 0
    for (let w = 0; w < weeks; w++) {
      const s = new Date(start.getTime() + w * 7 * 24 * 3600 * 1000)
      const e = new Date(s.getTime() + minutes * 60 * 1000)
      created += db.prepare('INSERT OR IGNORE INTO mentor_slots(mentor_id,starts_at,ends_at) VALUES(?,?,?)').run(req.user.id, s.toISOString(), e.toISOString()).changes
    }
    res.json({ created })
  })
  app.delete('/api/mentor/slots/:id', auth, mentorOnly, (req, res) => {
    const r = db.prepare("DELETE FROM mentor_slots WHERE id=? AND mentor_id=? AND status='open'").run(Number(req.params.id), req.user.id)
    if (!r.changes) return res.status(404).json({ error: 'Open slot not found. Booked slots must be cancelled as sessions.' })
    res.json({ ok: true })
  })
  app.get('/api/mentors/:id/slots', auth, (req, res) => {
    res.json({ slots: db.prepare("SELECT id,starts_at,ends_at FROM mentor_slots WHERE mentor_id=? AND status='open' AND starts_at>? ORDER BY starts_at LIMIT 40").all(Number(req.params.id), nowIso()) })
  })
  app.post('/api/slots/:id/book', auth, (req, res) => {
    if (req.user.role !== 'student') return res.status(403).json({ error: 'Only students can book sessions.' })
    const slot = db.prepare('SELECT * FROM mentor_slots WHERE id=?').get(Number(req.params.id))
    if (!slot) return res.status(404).json({ error: 'Slot not found.' })
    const connected = db.prepare("SELECT 1 FROM mentor_connections WHERE mentor_id=? AND student_id=? AND status='accepted'").get(slot.mentor_id, req.user.id)
    if (!connected) return res.status(403).json({ error: 'Request this mentor and wait for them to accept before booking.' })
    const upcoming = db.prepare("SELECT COUNT(*) n FROM mentor_sessions WHERE student_id=? AND status='scheduled' AND starts_at>?").get(req.user.id, nowIso()).n
    if (upcoming >= 3) return res.status(400).json({ error: 'You already have 3 upcoming sessions. Complete or cancel one first.' })
    const claimed = db.prepare("UPDATE mentor_slots SET status='booked',student_id=? WHERE id=? AND status='open' AND starts_at>?").run(req.user.id, slot.id, nowIso())
    if (claimed.changes !== 1) return res.status(409).json({ error: 'Sorry, that slot was just taken. Pick another.' })
    const topic = clean(req.body?.topic, 200) || 'Mentorship session'
    // Free, no-account video room. Mentors can replace the link later if they prefer Meet/Zoom.
    const meetingUrl = 'https://meet.jit.si/CareerReady-' + crypto.randomBytes(9).toString('hex')
    const info = db.prepare('INSERT INTO mentor_sessions(mentor_id,student_id,starts_at,ends_at,meeting_url,topic,slot_id) VALUES(?,?,?,?,?,?,?)').run(slot.mentor_id, req.user.id, slot.starts_at, slot.ends_at, meetingUrl, topic, slot.id)
    const when = new Date(slot.starts_at).toUTCString()
    notify(slot.mentor_id, 'New session booked', `${req.user.name} booked "${topic}" on ${when}.\nJoin link: ${meetingUrl}`)
    notify(req.user.id, 'Your mentor session is booked', `"${topic}" on ${when}.\nJoin link: ${meetingUrl}`)
    pushToUser(slot.mentor_id, 'mentor-session', { sessionId: info.lastInsertRowid })
    res.json({ id: Number(info.lastInsertRowid), meetingUrl })
  })
  app.post('/api/sessions/:id/cancel', auth, (req, res) => {
    const s = db.prepare('SELECT * FROM mentor_sessions WHERE id=? AND (student_id=? OR mentor_id=?)').get(Number(req.params.id), req.user.id, req.user.id)
    if (!s) return res.status(404).json({ error: 'Session not found.' })
    if (s.status !== 'scheduled' || s.starts_at < nowIso()) return res.status(400).json({ error: 'Only upcoming sessions can be cancelled.' })
    db.prepare("UPDATE mentor_sessions SET status='cancelled' WHERE id=?").run(s.id)
    if (s.slot_id) db.prepare("UPDATE mentor_slots SET status='open',student_id=NULL WHERE id=?").run(s.slot_id)
    const other = req.user.id === s.mentor_id ? s.student_id : s.mentor_id
    notify(other, 'A mentor session was cancelled', `${req.user.name} cancelled "${s.topic}" scheduled for ${new Date(s.starts_at).toUTCString()}.`)
    pushToUser(other, 'mentor-session', { sessionId: s.id })
    res.json({ ok: true })
  })
  app.post('/api/mentor/sessions/:id/complete', auth, mentorOnly, (req, res) => {
    const s = db.prepare("SELECT * FROM mentor_sessions WHERE id=? AND mentor_id=? AND status='scheduled'").get(Number(req.params.id), req.user.id)
    if (!s) return res.status(404).json({ error: 'Scheduled session not found.' })
    if (s.starts_at > nowIso()) return res.status(400).json({ error: 'You can mark a session complete once it has started.' })
    db.prepare("UPDATE mentor_sessions SET status='completed' WHERE id=?").run(s.id)
    notify(s.student_id, 'How was your mentor session?', 'Your session is marked complete. Open CareerReady to leave a quick rating for your mentor.')
    pushToUser(s.student_id, 'mentor-session', { sessionId: s.id })
    res.json({ ok: true })
  })
  app.post('/api/sessions/:id/review', auth, (req, res) => {
    const s = db.prepare('SELECT * FROM mentor_sessions WHERE id=? AND student_id=?').get(Number(req.params.id), req.user.id)
    if (!s) return res.status(404).json({ error: 'Session not found.' })
    if (s.status === 'cancelled' || s.ends_at > nowIso()) return res.status(400).json({ error: 'You can review a session after it has finished.' })
    const rating = Math.round(Number(req.body?.rating))
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Rating must be from 1 to 5.' })
    if (db.prepare('SELECT 1 FROM session_reviews WHERE session_id=?').get(s.id)) return res.status(409).json({ error: 'You already reviewed this session.' })
    db.prepare('INSERT INTO session_reviews(session_id,mentor_id,student_id,rating,comment) VALUES(?,?,?,?,?)').run(s.id, s.mentor_id, req.user.id, rating, clean(req.body?.comment, 600))
    db.prepare("UPDATE mentor_sessions SET status='completed' WHERE id=?").run(s.id)
    res.json({ ok: true })
  })

  // Student's whole mentorship view in one call (the old endpoint was never shown in the UI).
  app.get('/api/my-mentor', auth, (req, res) => {
    const connections = db.prepare(`SELECT mc.id,mc.mentor_id,mc.status,mc.message,u.name,u.location,u.bio,mp.headline,mp.expertise,mp.company FROM mentor_connections mc JOIN users u ON u.id=mc.mentor_id JOIN mentor_profiles mp ON mp.user_id=u.id WHERE mc.student_id=? ORDER BY mc.updated_at DESC`).all(req.user.id)
    const sessions = db.prepare(`SELECT ms.*,u.name mentor_name,(SELECT rating FROM session_reviews sr WHERE sr.session_id=ms.id) my_rating FROM mentor_sessions ms JOIN users u ON u.id=ms.mentor_id WHERE ms.student_id=? ORDER BY ms.starts_at DESC LIMIT 50`).all(req.user.id)
    const tasks = db.prepare(`SELECT mt.*,u.name mentor_name FROM mentor_tasks mt JOIN users u ON u.id=mt.mentor_id WHERE mt.student_id=? ORDER BY mt.created_at DESC`).all(req.user.id)
    const evaluations = db.prepare(`SELECT me.*,u.name mentor_name FROM mentor_evaluations me JOIN users u ON u.id=me.mentor_id WHERE me.student_id=? ORDER BY me.created_at DESC`).all(req.user.id)
    const resources = db.prepare(`SELECT r.id,r.title,r.description,r.url,u.name mentor_name FROM mentor_resources r JOIN users u ON u.id=r.mentor_id WHERE r.mentor_id IN (SELECT mentor_id FROM mentor_connections WHERE student_id=? AND status='accepted') ORDER BY r.created_at DESC`).all(req.user.id)
    res.json({ connections, sessions, tasks, evaluations, resources })
  })

  // Resource links must be web links (blocks javascript: URLs).
  app.post('/api/mentor/resources', auth, (req, res, next) => {
    if (!/^https?:\/\//i.test(String(req.body?.url || ''))) return res.status(400).json({ error: 'Resource link must start with http:// or https://' })
    next()
  })

  /* ---------------- Optional OpenAI brief for mentors ---------------- */
  const askOpenAI = async (prompt) => ai.parseJson(await ai.askText(prompt)) // name kept; works with Gemini or OpenAI
  app.get('/api/mentor/student/:id/brief', auth, mentorOnly, async (req, res) => {
    if (!ai.enabled()) return res.status(503).json({ error: 'AI briefs are off. Add GEMINI_API_KEY or OPENAI_API_KEY on the server to enable them.' })
    const studentId = Number(req.params.id)
    if (!db.prepare("SELECT 1 FROM mentor_connections WHERE mentor_id=? AND student_id=? AND status='accepted'").get(req.user.id, studentId)) return res.status(403).json({ error: 'You can only review students connected to you.' })
    const s = db.prepare('SELECT name,branch,year,skills,interests FROM users WHERE id=?').get(studentId)
    const assessments = db.prepare('SELECT category,score,total FROM assessments WHERE user_id=? ORDER BY taken_at DESC LIMIT 6').all(studentId)
    const resume = db.prepare('SELECT content FROM resumes WHERE user_id=?').get(studentId)
    const prompt = `You help a human career mentor prepare for a session. Using ONLY the data below, return strict JSON with: summary (string), strengths (array), gaps (array), suggested_focus (array of 3 items), questions_to_ask (array of 4 questions). Do not guess personality, health or background beyond the data.\nStudent: ${JSON.stringify(s)}\nAssessments: ${JSON.stringify(assessments)}\nResume:\n${String(resume?.content || 'No resume uploaded.').slice(0, 8000)}`
    try { res.json(await askOpenAI(prompt)) } catch (e) { res.status(502).json({ error: e.name === 'SyntaxError' ? 'The AI returned an unreadable answer. Try again.' : ai.userMessage(e) }) }
  })

  /* ---------------- One like per person ---------------- */
  db.exec('CREATE TABLE IF NOT EXISTS community_likes (post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (post_id, user_id))')
  app.post('/api/community/:id/like', auth, (req, res) => {
    const id = Number(req.params.id)
    if (!db.prepare('SELECT 1 FROM community_posts WHERE id=?').get(id)) return res.status(404).json({ error: 'Post not found.' })
    const added = db.prepare('INSERT OR IGNORE INTO community_likes(post_id,user_id) VALUES(?,?)').run(id, req.user.id).changes
    if (added) db.prepare('UPDATE community_posts SET likes=likes+1 WHERE id=?').run(id)
    res.json({ ok: true, liked: Boolean(added) })
  })

  /* ---------------- Database backups ----------------
     Nightly consistent snapshot (keeps the newest 7) next to the database, plus an admin-only download.
     A snapshot on the same disk does NOT protect you from losing the disk: download one regularly. */
  const fs = require('fs')
  const path = require('path')
  const backupDir = path.join(process.env.DATA_DIR || __dirname, 'backups')
  async function makeBackup() {
    fs.mkdirSync(backupDir, { recursive: true })
    const file = path.join(backupDir, 'careerready-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db')
    await db.backup(file)
    const old = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort().slice(0, -7)
    for (const f of old) { try { fs.unlinkSync(path.join(backupDir, f)) } catch {} }
    return file
  }
  const runBackup = () => makeBackup().then((f) => console.log('[backup] saved', path.basename(f))).catch((e) => console.error('[backup] failed:', e.message))
  if (isProduction) { setTimeout(runBackup, 60 * 1000).unref(); setInterval(runBackup, 24 * 3600 * 1000).unref() }
  app.get('/api/admin/backup', auth, adminOnly, limit('backup', 5, 60 * 60 * 1000, byToken), async (req, res, next) => {
    try {
      const file = await makeBackup()
      audit(req.user.id, 'backup_download')
      res.download(file)
    } catch (e) { next(e) }
  })

  console.log(`[launch] ready. email=${emailEnabled ? 'on' : 'off'} sms=${process.env.TWILIO_ACCOUNT_SID ? 'on' : 'off'} ai=${ai.provider() || 'off'}`)
}

module.exports = registerLaunch
