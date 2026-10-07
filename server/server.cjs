require('./env.cjs') // loads .env before anything reads process.env
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const db = require('./database.cjs')

const app = express()
const PORT = Number(process.env.PORT || 6000)
const HOST = process.env.HOST || '0.0.0.0'
const isProduction = process.env.NODE_ENV === 'production'

app.disable('x-powered-by')
// In production the site and API share one origin, so cross-origin access stays off unless CORS_ORIGIN is set.
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((v) => v.trim()) : !isProduction }))
app.use(express.json({ limit: '200kb' }))


/* =====================================================
   Helpers
   ===================================================== */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return salt + ':' + hash
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  const test = crypto.scryptSync(password, salt, 64)
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test)
}

// Non-blocking variants: scryptSync would freeze every request and SSE heartbeat while it runs.
const scryptAsync = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))))
async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  return salt + ':' + (await scryptAsync(password, salt)).toString('hex')
}
async function verifyPasswordAsync(password, stored) {
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), await scryptAsync(password, salt))
}

// Session tokens are stored hashed, so a leaked database file cannot be used to log in.
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex')

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex')
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(sha(token), userId)
  return token
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  const user = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.branch, u.year, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND datetime(s.created_at) >= datetime('now', '-30 days') AND COALESCE(u.status, 'active') = 'active'`
    )
    .get(sha(token))
  if (!user) {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(sha(token))
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' })
  }
  req.user = user
  next()
}

/* =====================================================
   Real-time: Server-Sent Events
   Every logged-in browser keeps one open connection.
   ===================================================== */
const clients = new Map() // userId -> Set of open responses

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(event, data) {
  for (const set of clients.values()) for (const res of set) sendEvent(res, event, data)
}

function pushToUser(userId, event, data) {
  const set = clients.get(userId)
  if (set) for (const res of set) sendEvent(res, event, data)
}

app.get('/api/events', (req, res) => {
  // EventSource cannot send headers, so the token comes in the URL
  const user = db
    .prepare("SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND datetime(s.created_at) >= datetime('now', '-30 days') AND COALESCE(u.status, 'active') = 'active'")
    .get(sha(req.query.token || ''))
  if (!user) return res.status(401).end()

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('retry: 5000\n\n')

  if (!clients.has(user.id)) clients.set(user.id, new Set())
  clients.get(user.id).add(res)
  broadcast('online', { count: clients.size })

  const heartbeat = setInterval(() => res.write(':\n\n'), 25000)
  req.on('close', () => {
    clearInterval(heartbeat)
    const set = clients.get(user.id)
    if (set) {
      set.delete(res)
      if (set.size === 0) clients.delete(user.id)
    }
    broadcast('online', { count: clients.size })
  })
})

/* =====================================================
   Extra features (XP, leaderboard, resume check, mock interview, demo data)
   ===================================================== */
require('./launch.cjs')({ app, db, auth, pushToUser, hashPassword: hashPasswordAsync }) // first, so its safer routes win
require('./extras.cjs')({ app, db, auth, pushToUser, broadcast, hashPassword })
require('./production-integrations.cjs').registerProductionIntegrations({ app, db, auth, pushToUser, broadcast, hashPassword, requireRole: (roles) => roles })
const remoteBackup = require('./remote-backup.cjs').start(db) // free-tier persistence (no-op unless BACKUP_* env is set)

/* =====================================================
   Live jobs from free public feeds
   - Arbeitnow: free, no key, updated about hourly (mostly Europe and remote)
   - Remotive: free, no key, remote jobs. Their rules: link back to the job
     page, name Remotive as the source, and fetch rarely (about 4 times a day).
   ===================================================== */
async function fetchArbeitnow() {
  const res = await fetch('https://www.arbeitnow.com/api/job-board-api', {
    headers: { 'User-Agent': 'CareerReady-college-project' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error('Arbeitnow returned status ' + res.status)
  const json = await res.json()
  return (json.data || []).slice(0, 100).map((j) => ({
    ext: 'arbeitnow:' + j.slug,
    source: 'Arbeitnow',
    title: j.title,
    company: j.company_name,
    location: j.location || '',
    remote: j.remote ? 1 : 0,
    url: j.url,
    tags: (j.tags || []).join(', '),
    posted: new Date((j.created_at || Date.now() / 1000) * 1000).toISOString(),
  }))
}

async function fetchRemotive() {
  const res = await fetch('https://remotive.com/api/remote-jobs?category=software-dev&limit=50', {
    headers: { 'User-Agent': 'CareerReady-college-project' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error('Remotive returned status ' + res.status)
  const json = await res.json()
  return (json.jobs || []).map((j) => ({
    ext: 'remotive:' + j.id,
    source: 'Remotive',
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || 'Remote',
    remote: 1,
    url: j.url,
    tags: (j.tags || []).join(', '),
    posted: j.publication_date ? new Date(j.publication_date).toISOString() : new Date().toISOString(),
  }))
}

const SOURCES = {
  Arbeitnow: { gap: 30 * 60 * 1000, fn: fetchArbeitnow },
  Remotive: { gap: 6 * 60 * 60 * 1000, fn: fetchRemotive }, // keeps us well under their daily limit
}
const liveStatus = {
  Arbeitnow: { ok: null, lastRun: null, error: '' },
  Remotive: { ok: null, lastRun: null, error: '' },
}

const insertJob = db.prepare(
  'INSERT OR IGNORE INTO live_jobs (ext_id, source, title, company, location, remote, url, tags, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
)

function saveJobs(jobs) {
  let added = 0
  db.transaction(() => {
    for (const j of jobs) {
      added += insertJob.run(j.ext, j.source, j.title, j.company, j.location, j.remote, j.url, j.tags, j.posted).changes
    }
  })()
  // keep only the newest 500 jobs
  db.prepare('DELETE FROM live_jobs WHERE id NOT IN (SELECT id FROM live_jobs ORDER BY posted_at DESC LIMIT 500)').run()
  return added
}

let fetching = false
async function fetchLive() {
  if (fetching) return { added: 0, checked: 0 }
  fetching = true
  let added = 0
  let checked = 0
  try {
    for (const [name, source] of Object.entries(SOURCES)) {
      const status = liveStatus[name]
      if (status.lastRun && Date.now() - new Date(status.lastRun).getTime() < source.gap) continue
      checked += 1
      try {
        added += saveJobs(await source.fn())
        status.ok = true
        status.error = ''
      } catch (err) {
        status.ok = false
        status.error = err.message
        console.log(`[live jobs] ${name} failed: ${err.message}`)
      }
      status.lastRun = new Date().toISOString()
    }
  } finally {
    fetching = false
  }
  if (added > 0) {
    console.log(`[live jobs] ${added} new jobs`)
    broadcast('jobs', { added }) // tells every open browser instantly
  }
  return { added, checked }
}

app.get('/api/live-jobs', auth, (req, res) => {
  const search = '%' + (req.query.search || '').trim() + '%'
  const remote = req.query.remote === '1' ? 1 : 0
  const rows = db
    .prepare(
      `SELECT * FROM live_jobs
       WHERE (title LIKE ? OR company LIKE ? OR tags LIKE ?) AND (? = 0 OR remote = 1)
       ORDER BY posted_at DESC LIMIT 60`
    )
    .all(search, search, search, remote)
  res.json({ jobs: rows.map((r) => ({ ...r, remote: Boolean(r.remote) })), status: liveStatus })
})

app.post('/api/live-jobs/refresh', auth, async (req, res) => {
  const { added, checked } = await fetchLive()
  if (checked === 0) {
    return res.json({ message: 'The job feeds were checked recently. Please try again in a few minutes.' })
  }
  res.json({ message: added > 0 ? `Found ${added} new jobs.` : 'Checked the feeds. No new jobs right now.' })
})

/* =====================================================
   Readiness (rule-based, no AI)
   ===================================================== */
const CATEGORIES = ['Programming', 'Aptitude', 'Communication']

const RESOURCES = {
  Programming: [
    { name: 'freeCodeCamp', url: 'https://www.freecodecamp.org' },
    { name: 'GeeksforGeeks', url: 'https://www.geeksforgeeks.org' },
  ],
  Aptitude: [{ name: 'IndiaBIX practice questions', url: 'https://www.indiabix.com' }],
  Communication: [
    { name: 'BBC Learning English', url: 'https://www.bbc.co.uk/learningenglish' },
    { name: 'NPTEL courses', url: 'https://nptel.ac.in' },
  ],
}

function goalProgress(userId) {
  const row = db
    .prepare(
      `SELECT r.slug, r.title,
              (SELECT COUNT(*) FROM roadmap_steps WHERE role_id = r.id) AS total,
              (SELECT COUNT(*) FROM user_progress p JOIN roadmap_steps s ON s.id = p.step_id
                WHERE p.user_id = g.user_id AND s.role_id = r.id) AS done
       FROM user_goals g JOIN roles r ON r.id = g.role_id WHERE g.user_id = ?`
    )
    .get(userId)
  return row || null
}

function computeReadiness(userId) {
  const rows = db
    .prepare(
      `SELECT category, score, total FROM assessments
       WHERE id IN (SELECT MAX(id) FROM assessments WHERE user_id = ? GROUP BY category)`
    )
    .all(userId)

  const categories = CATEGORIES.map((category) => {
    const row = rows.find((r) => r.category === category)
    return {
      category,
      taken: Boolean(row),
      percent: row ? Math.round((row.score / row.total) * 100) : 0,
    }
  })

  const savedCount = db.prepare('SELECT COUNT(*) AS n FROM saved WHERE user_id = ?').get(userId).n
  const goal = goalProgress(userId)

  // Rule: 70% assessments + 15% saved internships (up to 3) + 15% roadmap progress
  const average = categories.reduce((sum, c) => sum + c.percent, 0) / CATEGORIES.length
  const roadmap = goal && goal.total > 0 ? goal.done / goal.total : 0
  const score = Math.round(average * 0.7 + (Math.min(savedCount, 3) / 3) * 15 + roadmap * 15)

  let level = 'Getting started'
  if (score >= 70) level = 'Industry ready'
  else if (score >= 40) level = 'Building up'

  const recommendations = categories.map((c) => {
    let message
    if (!c.taken) message = `Take the ${c.category} assessment to see where you stand.`
    else if (c.percent < 50) message = `${c.category} needs work. Revise the basics and practise a little every day.`
    else if (c.percent < 80) message = `${c.category} is decent. Solve more practice questions to move higher.`
    else message = `${c.category} is strong. Keep it sharp with mock interviews.`
    return {
      category: c.category,
      message,
      resources: c.taken && c.percent >= 80 ? [] : RESOURCES[c.category],
    }
  })

  if (!goal) {
    recommendations.push({
      category: 'Career path',
      message: 'Choose a target role in Career paths to get a step-by-step roadmap.',
      resources: [],
    })
  }
  if (savedCount === 0) {
    recommendations.push({
      category: 'Internships',
      message: 'Save at least 3 internships that match your branch.',
      resources: [],
    })
  }

  return { score, level, categories, savedCount, goal, recommendations }
}

/* =====================================================
   Career roles and roadmaps
   ===================================================== */
const WEIGHT_NAMES = ['Programming', 'Aptitude', 'Communication']

// Fit = weighted assessment percentages + a bonus when the role matches the student's branch
function roleFit(role, categories, branch) {
  const weights = JSON.parse(role.weights)
  const percent = Object.fromEntries(categories.map((c) => [c.category, c.percent]))
  const base = WEIGHT_NAMES.reduce((sum, name, i) => sum + (percent[name] || 0) * weights[i], 0) / 100
  const bonus = role.branch === branch ? 15 : role.branch === 'All' ? 5 : 0
  const fit = Math.min(100, Math.round(base * 0.85 + bonus))

  // Skills that matter for this role (weight 30+) where the student scored under 60
  const gaps = categories
    .filter((c) => c.taken && c.percent < 60 && weights[WEIGHT_NAMES.indexOf(c.category)] >= 30)
    .map((c) => c.category)
  return { fit, gaps }
}

function jobsForRole(role) {
  const keywords = role.keywords.split(',').map((k) => k.trim()).filter(Boolean)
  if (keywords.length === 0) return []
  const where = keywords.map(() => '(title LIKE ? OR tags LIKE ?)').join(' OR ')
  const params = keywords.flatMap((k) => ['%' + k + '%', '%' + k + '%'])
  return db
    .prepare(`SELECT * FROM live_jobs WHERE ${where} ORDER BY posted_at DESC LIMIT 8`)
    .all(...params)
    .map((r) => ({ ...r, remote: Boolean(r.remote) }))
}

/* =====================================================
   Career Coach + Resume Intelligence
   ===================================================== */
function resumeText(userId) {
  return db.prepare('SELECT content FROM resumes WHERE user_id = ?').get(userId)?.content || ''
}

function normalizeWords(text) {
  return new Set((text || '').toLowerCase().replace(/[^a-z0-9+#.\- ]/g, ' ').split(/\s+/).filter(w => w.length > 2))
}

function resumeAnalysis(userId) {
  const text = resumeText(userId)
  const readiness = computeReadiness(userId)
  const goal = readiness.goal ? db.prepare('SELECT * FROM roles WHERE slug = ?').get(readiness.goal.slug) : null
  const keywords = goal ? goal.keywords.split(',').map(x => x.trim()).filter(Boolean) : []
  const words = normalizeWords(text)
  const matched = keywords.filter(k => text.toLowerCase().includes(k.toLowerCase()))
  const missing = keywords.filter(k => !text.toLowerCase().includes(k.toLowerCase()))
  const completeness = text.trim().length ? Math.min(100, Math.round(text.trim().length / 12)) : 0
  const keywordScore = keywords.length ? Math.round((matched.length / keywords.length) * 100) : 0
  const score = text.trim() ? Math.round(keywordScore * 0.65 + completeness * 0.35) : 0
  const suggestions = []
  if (!text.trim()) suggestions.push('Add your resume text or paste your resume content to start the analysis.')
  if (missing.length) suggestions.push(`Add evidence or projects that demonstrate: ${missing.slice(0, 5).join(', ')}.`)
  if (text.trim().length < 500) suggestions.push('Add concise project impact, technologies used and measurable outcomes.')
  if (!/project|intern|experience/i.test(text)) suggestions.push('Include projects, internships or practical experience relevant to your target role.')
  return { hasResume: Boolean(text.trim()), score, target: goal ? goal.title : null, matched, missing, suggestions, content: text }
}

function opportunityMatches(userId) {
  const readiness = computeReadiness(userId)
  const goal = readiness.goal ? db.prepare('SELECT * FROM roles WHERE slug = ?').get(readiness.goal.slug) : null
  const resume = resumeAnalysis(userId)
  const rows = db.prepare('SELECT * FROM internships ORDER BY deadline ASC').all()
  const branch = reqUserBranch(userId)
  return rows.map(i => {
    const skills = i.skills.split(',').map(x => x.trim()).filter(Boolean)
    const skillMatches = skills.filter(skill => resume.content.toLowerCase().includes(skill.toLowerCase()) || readiness.categories.some(c => c.category.toLowerCase().includes(skill.toLowerCase())))
    const branchFit = i.branch === 'All' || i.branch === branch ? 20 : 0
    const roleFitScore = goal && goal.keywords.split(',').some(k => (i.title + ' ' + i.skills).toLowerCase().includes(k.trim().toLowerCase())) ? 25 : 0
    const resumeFit = skills.length ? Math.round((skillMatches.length / skills.length) * 55) : 0
    const match = Math.min(100, resumeFit + branchFit + roleFitScore)
    return { id: i.id, title: i.title, company: i.company, location: i.location, mode: i.mode, skills: i.skills, match, matchedSkills: skillMatches, missingSkills: skills.filter(x => !skillMatches.includes(x)) }
  }).sort((a,b) => b.match-a.match).slice(0,6)
}

function reqUserBranch(userId) {
  return db.prepare('SELECT branch FROM users WHERE id = ?').get(userId)?.branch || 'Other'
}

function computeCoach(userId) {
  const readiness = computeReadiness(userId)
  const goal = readiness.goal ? db.prepare('SELECT * FROM roles WHERE slug = ?').get(readiness.goal.slug) : null
  const resume = resumeAnalysis(userId)
  const applications = db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE user_id = ?`).get(userId).n
  const interviews = db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND status = 'Interview'`).get(userId).n
  const evidenceScore = Math.min(100, Math.round((Math.min(applications,5)/5)*60 + (Math.min(interviews,2)/2)*40))
  const jobReadiness = Math.round(readiness.score * 0.65 + (goal ? 15 : 0) + resume.score * 0.15 + evidenceScore * 0.05)
  const plan = []
  if (!readiness.categories.some(c => !c.taken)) {
    const gap = readiness.categories.filter(c => c.percent < 60).sort((a,b)=>a.percent-b.percent)[0]
    if (gap) plan.push({priority:1,title:`Improve ${gap.category}`,detail:`Current level is ${gap.percent}%. Use the assessment resources and practise until you reach 70%+.` ,tab:'assessment'})
  } else plan.push({priority:1,title:'Complete your readiness assessments',detail:'Finish the missing assessment so CareerReady can personalize your plan.',tab:'assessment'})
  if (!goal) plan.push({priority:plan.length+1,title:'Choose a target career',detail:'Pick a role to unlock a role-specific roadmap and matching.',tab:'paths'})
  else if (readiness.goal.total > 0 && readiness.goal.done < readiness.goal.total) plan.push({priority:plan.length+1,title:'Continue your roadmap',detail:`You have completed ${readiness.goal.done} of ${readiness.goal.total} steps for ${readiness.goal.title}.`,tab:'paths'})
  if (!resume.hasResume) plan.push({priority:plan.length+1,title:'Build your resume profile',detail:'Add your resume content so CareerReady can compare it with your target role.',tab:'resume'})
  else if (resume.score < 70) plan.push({priority:plan.length+1,title:'Improve your resume match',detail:`Your current role-keyword score is ${resume.score}%. Close the missing-skill gaps before applying broadly.`,tab:'resume'})
  if (plan.length < 3) plan.push({priority:plan.length+1,title:'Review matched opportunities',detail:'Use your readiness and resume fit to prioritize the strongest internships.',tab:'internships'})
  return { ...readiness, target: goal ? {title:goal.title, slug:goal.slug} : null, evidenceScore, jobReadiness:Math.min(100,jobReadiness), resume, plan:plan.slice(0,3), opportunities: opportunityMatches(userId).slice(0,3), action: plan[0] || {label:'Review your dashboard',reason:'Keep your profile and career plan up to date.',cta:'Open dashboard',tab:'dashboard'} }
}

app.get('/api/coach', auth, (req,res) => res.json(computeCoach(req.user.id)))
app.get('/api/resume', auth, (req,res) => res.json(resumeAnalysis(req.user.id)))
app.post('/api/resume', auth, (req,res) => {
  const content = String(req.body.content || '').slice(0, 30000)
  db.prepare(`INSERT INTO resumes (user_id, content) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET content=excluded.content, updated_at=CURRENT_TIMESTAMP`).run(req.user.id, content)
  pushToUser(req.user.id, 'sync', {what:'resume'})
  res.json(resumeAnalysis(req.user.id))
})
app.get('/api/job-matches', auth, (req,res) => res.json({matches: opportunityMatches(req.user.id), resume: resumeAnalysis(req.user.id)}))

app.get('/api/roles', auth, (req, res) => {
  const readiness = computeReadiness(req.user.id)
  const anyTaken = readiness.categories.some((c) => c.taken)
  const goalSlug = readiness.goal ? readiness.goal.slug : null

  const progress = db
    .prepare(
      `SELECT s.role_id, COUNT(*) AS total, SUM(CASE WHEN p.user_id IS NULL THEN 0 ELSE 1 END) AS done
       FROM roadmap_steps s LEFT JOIN user_progress p ON p.step_id = s.id AND p.user_id = ?
       GROUP BY s.role_id`
    )
    .all(req.user.id)

  const roles = db
    .prepare('SELECT * FROM roles')
    .all()
    .map((role) => {
      const { fit, gaps } = roleFit(role, readiness.categories, req.user.branch)
      const p = progress.find((x) => x.role_id === role.id) || { total: 0, done: 0 }
      return {
        slug: role.slug,
        title: role.title,
        branch: role.branch,
        summary: role.summary,
        fit,
        gaps,
        total: p.total,
        done: p.done,
        isGoal: role.slug === goalSlug,
      }
    })
    .sort((a, b) => b.fit - a.fit)

  res.json({ roles, anyTaken })
})

app.get('/api/roles/:slug', auth, (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE slug = ?').get(req.params.slug)
  if (!role) return res.status(404).json({ error: 'Role not found.' })

  const readiness = computeReadiness(req.user.id)
  const { fit, gaps } = roleFit(role, readiness.categories, req.user.branch)
  const goal = db.prepare('SELECT role_id FROM user_goals WHERE user_id = ?').get(req.user.id)

  const steps = db
    .prepare(
      `SELECT s.id, s.step_order, s.title, s.description, s.resource_name, s.resource_url,
              CASE WHEN p.user_id IS NULL THEN 0 ELSE 1 END AS done
       FROM roadmap_steps s LEFT JOIN user_progress p ON p.step_id = s.id AND p.user_id = ?
       WHERE s.role_id = ? ORDER BY s.step_order`
    )
    .all(req.user.id, role.id)
    .map((s) => ({ ...s, done: Boolean(s.done) }))

  res.json({
    role: {
      slug: role.slug,
      title: role.title,
      branch: role.branch,
      summary: role.summary,
      fit,
      gaps,
      isGoal: Boolean(goal && goal.role_id === role.id),
    },
    steps,
    jobs: jobsForRole(role),
  })
})

app.post('/api/goal', auth, (req, res) => {
  const role = db.prepare('SELECT id FROM roles WHERE slug = ?').get(req.body.slug)
  if (!role) return res.status(404).json({ error: 'Role not found.' })
  db.prepare(
    `INSERT INTO user_goals (user_id, role_id) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET role_id = excluded.role_id, chosen_at = CURRENT_TIMESTAMP`
  ).run(req.user.id, role.id)
  pushToUser(req.user.id, 'sync', { what: 'goal' }) // updates the student's other open tabs
  res.json({ ok: true })
})

app.post('/api/steps/:id/toggle', auth, (req, res) => {
  const stepId = Number(req.params.id)
  const step = db.prepare('SELECT id FROM roadmap_steps WHERE id = ?').get(stepId)
  if (!step) return res.status(404).json({ error: 'Step not found.' })

  const existing = db.prepare('SELECT 1 FROM user_progress WHERE user_id = ? AND step_id = ?').get(req.user.id, stepId)
  if (existing) {
    db.prepare('DELETE FROM user_progress WHERE user_id = ? AND step_id = ?').run(req.user.id, stepId)
  } else {
    db.prepare('INSERT INTO user_progress (user_id, step_id) VALUES (?, ?)').run(req.user.id, stepId)
  }
  pushToUser(req.user.id, 'sync', { what: 'progress' })
  res.json({ done: !existing })
})

/* =====================================================
   Auth routes
   ===================================================== */
app.post('/api/signup', (req, res) => {
  const { name, email, password, branch, year } = req.body
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' })
  if (!email.includes('@')) return res.status(400).json({ error: 'Enter a valid email address.' })
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' })

  const cleanEmail = email.trim().toLowerCase()
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)
  if (exists) return res.status(409).json({ error: 'An account with this email already exists.' })

  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, branch, year) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), cleanEmail, hashPassword(password), branch || 'Other', year || '1st year')

  const user = { id: info.lastInsertRowid, name: name.trim(), email: cleanEmail, branch: branch || 'Other', year: year || '1st year', role: 'student', status: 'active' }
  res.json({ token: createSession(user.id), user })
})

app.post('/api/login', async (req, res, next) => {
  try {
  const { email, password } = req.body
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return res.status(400).json({ error: 'Enter your email and password.' })

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase())
  if (!row || !(await verifyPasswordAsync(password, row.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' })
  }
  const user = { id: row.id, name: row.name, email: row.email, branch: row.branch, year: row.year, role: row.role || 'student', status: row.status || 'active' }
  res.json({ token: createSession(user.id), user })
  } catch (err) { next(err) }
})

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }))

app.post('/api/logout', auth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  db.prepare('DELETE FROM sessions WHERE token = ?').run(sha(token))
  res.json({ ok: true })
})

/* =====================================================
   Assessment routes
   ===================================================== */
app.get('/api/questions', auth, (req, res) => {
  const rows = db.prepare('SELECT id, category, text, options FROM questions ORDER BY id').all()
  res.json({ questions: rows.map((q) => ({ ...q, options: JSON.parse(q.options) })) })
})

app.post('/api/assessment', auth, (req, res) => {
  const answers = req.body.answers || {}
  const questions = db.prepare('SELECT * FROM questions').all()
  const byCategory = {}

  for (const q of questions) {
    if (answers[q.id] === undefined) continue
    if (!byCategory[q.category]) byCategory[q.category] = { score: 0, total: 0 }
    byCategory[q.category].total += 1
    if (Number(answers[q.id]) === q.answer) byCategory[q.category].score += 1
  }

  const insert = db.prepare('INSERT INTO assessments (user_id, category, score, total) VALUES (?, ?, ?, ?)')
  const results = []
  for (const category of Object.keys(byCategory)) {
    const { score, total } = byCategory[category]
    insert.run(req.user.id, category, score, total)
    results.push({ category, score, total, percent: Math.round((score / total) * 100) })
  }

  if (results.length === 0) return res.status(400).json({ error: 'Answer at least one question first.' })
  pushToUser(req.user.id, 'sync', { what: 'assessment' })
  res.json({ results })
})

app.get('/api/readiness', auth, (req, res) => res.json(computeReadiness(req.user.id)))

/* =====================================================
   Internship routes
   ===================================================== */
app.get('/api/internships', auth, (req, res) => {
  const search = '%' + (req.query.search || '').trim() + '%'
  const branch = req.query.branch || ''

  const rows = db
    .prepare(
      `SELECT i.*,
              CASE WHEN s.user_id IS NULL THEN 0 ELSE 1 END AS saved,
              COALESCE(a.status, '') AS application_status
       FROM internships i
       LEFT JOIN saved s ON s.internship_id = i.id AND s.user_id = ?
       LEFT JOIN applications a ON a.internship_id = i.id AND a.user_id = ?
       WHERE (i.title LIKE ? OR i.company LIKE ? OR i.skills LIKE ?)
         AND (? = '' OR i.branch = ? OR i.branch = 'All')
       ORDER BY i.id`
    )
    .all(req.user.id, req.user.id, search, search, search, branch, branch)

  res.json({ internships: rows.map((r) => ({ ...r, saved: Boolean(r.saved) })) })
})

app.post('/api/internships/:id/save', auth, (req, res) => {
  const internshipId = Number(req.params.id)
  const exists = db.prepare('SELECT id FROM internships WHERE id = ?').get(internshipId)
  if (!exists) return res.status(404).json({ error: 'Internship not found.' })

  const already = db.prepare('SELECT 1 FROM saved WHERE user_id = ? AND internship_id = ?').get(req.user.id, internshipId)
  if (already) {
    db.prepare('DELETE FROM saved WHERE user_id = ? AND internship_id = ?').run(req.user.id, internshipId)
    pushToUser(req.user.id, 'sync', { what: 'saved' })
    return res.json({ saved: false })
  }
  db.prepare('INSERT INTO saved (user_id, internship_id) VALUES (?, ?)').run(req.user.id, internshipId)
  pushToUser(req.user.id, 'sync', { what: 'saved' })
  res.json({ saved: true })
})

/* =====================================================
   Production frontend + health
   ===================================================== */
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'careerready-api', environment: process.env.NODE_ENV || 'development' }))

const distPath = require('path').join(__dirname, '..', 'dist')
if (require('fs').existsSync(distPath)) {
  // Hashed build assets can be cached for a year; HTML must always be revalidated so deploys take effect immediately.
  app.use(express.static(distPath, {
    maxAge: 0,
    setHeaders(res, filePath) {
      if (!isProduction) return
      if (filePath.includes(require('path').sep + 'assets' + require('path').sep)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      else if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
      else res.setHeader('Cache-Control', 'public, max-age=86400')
    },
  }))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(require('path').join(distPath, 'index.html'))
  })
}

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Something went wrong on the server.' })
})

db.prepare("DELETE FROM sessions WHERE datetime(created_at) < datetime('now', '-30 days')").run()

// Indexes for the columns the app filters on. Each is wrapped so one bad name can never stop the server booting.
for (const sql of [
  'CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_assessments_user ON assessments(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_conn_mentor ON mentor_connections(mentor_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_conn_student ON mentor_connections(student_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_msessions_mentor ON mentor_sessions(mentor_id, starts_at)',
  'CREATE INDEX IF NOT EXISTS idx_msessions_student ON mentor_sessions(student_id, starts_at)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_student ON mentor_tasks(student_id)',
  'CREATE INDEX IF NOT EXISTS idx_evals_student ON mentor_evaluations(student_id)',
  'CREATE INDEX IF NOT EXISTS idx_replies_post ON community_replies(post_id)',
  'CREATE INDEX IF NOT EXISTS idx_slots_mentor ON mentor_slots(mentor_id, status, starts_at)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_posted ON live_jobs(posted_at)',
]) {
  try { db.exec(sql) } catch (e) { console.warn('[index] skipped:', e.message) }
}

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason))

const server = app.listen(PORT, HOST, () => {
  console.log(`CareerReady running on ${HOST}:${PORT}`)
  fetchLive() // load jobs right away
  setInterval(fetchLive, 10 * 60 * 1000).unref() // each feed has its own minimum gap
})

// Render sends SIGTERM on every deploy/restart: stop accepting traffic, then close SQLite so the WAL is checkpointed.
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${signal} received, closing...`)
  for (const set of clients.values()) for (const res of set) { try { res.end() } catch {} }
  server.close(async () => {
    try { await remoteBackup.flush() } catch (e) { console.error('[shutdown] remote backup failed:', e.message) }
    try { db.close() } catch (e) { console.error('[shutdown] db close failed:', e.message) }
    process.exit(0)
  })
  setTimeout(() => { try { db.close() } catch {} process.exit(1) }, 10000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
