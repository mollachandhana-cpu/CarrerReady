const crypto = require('crypto')

const ai = require('./ai.cjs')

function registerProductionIntegrations({ app, db, auth, pushToUser, requireRole }) {
  // Safe migration layer: existing databases can be upgraded without deleting data.
  const addColumn = (table, column, type) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((x) => x.name)
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
  addColumn('users', 'role', "TEXT NOT NULL DEFAULT 'student'")
  addColumn('users', 'phone', "TEXT NOT NULL DEFAULT ''")
  addColumn('users', 'location', "TEXT NOT NULL DEFAULT ''")
  addColumn('users', 'bio', "TEXT NOT NULL DEFAULT ''")
  addColumn('users', 'skills', "TEXT NOT NULL DEFAULT ''")
  addColumn('users', 'interests', "TEXT NOT NULL DEFAULT ''")
  addColumn('users', 'linkedin', "TEXT NOT NULL DEFAULT ''")
  addColumn('users', 'github', "TEXT NOT NULL DEFAULT ''")
  addColumn('users', 'portfolio', "TEXT NOT NULL DEFAULT ''")
  addColumn('users', 'status', "TEXT NOT NULL DEFAULT 'active'")

  db.exec(`
    CREATE TABLE IF NOT EXISTS mentor_profiles (
      user_id INTEGER PRIMARY KEY,
      headline TEXT NOT NULL DEFAULT '',
      expertise TEXT NOT NULL DEFAULT '',
      experience_years INTEGER NOT NULL DEFAULT 0,
      company TEXT NOT NULL DEFAULT '',
      linkedin TEXT NOT NULL DEFAULT '',
      hourly_rate INTEGER NOT NULL DEFAULT 0,
      availability TEXT NOT NULL DEFAULT 'Flexible',
      verification_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS mentor_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(mentor_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS mentor_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      meeting_url TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS mentor_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      session_id INTEGER,
      category TEXT NOT NULL,
      score INTEGER NOT NULL,
      strengths TEXT NOT NULL DEFAULT '',
      improvements TEXT NOT NULL DEFAULT '',
      action_plan TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS mentor_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS mentor_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'assigned',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS community_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS community_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS community_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      reporter_id INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  function userWithRole(id) {
    return db.prepare(`SELECT id,name,email,branch,year,role,phone,location,bio,skills,interests,linkedin,github,portfolio,status FROM users WHERE id=?`).get(id)
  }
  function safeRole(req, roles) { return roles.includes(req.user.role) }
  const isConnected = (mentorId, studentId) => Boolean(db.prepare("SELECT 1 FROM mentor_connections WHERE mentor_id=? AND student_id=? AND status='accepted'").get(mentorId, Number(studentId)))

  async function sendSms(to, body) {
    if (!to || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) return false
    try {
      const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')
      const form = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Body: body })
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, { method:'POST', headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/x-www-form-urlencoded'}, body:form })
      return r.ok
    } catch { return false }
  }

  app.get('/api/profile', auth, (req, res) => res.json({ user: userWithRole(req.user.id) }))
  app.patch('/api/profile', auth, (req, res) => {
    // Only fields that were sent are changed, each with a length cap and format check.
    const limits = { name: 80, branch: 60, year: 30, phone: 20, location: 100, bio: 1000, skills: 500, interests: 500, linkedin: 250, github: 250, portfolio: 250 }
    const urlFields = ['linkedin', 'github', 'portfolio']
    const updates = []
    for (const [k, max] of Object.entries(limits)) {
      if (typeof req.body?.[k] !== 'string') continue
      const v = req.body[k].trim().slice(0, max)
      if (k === 'name' && !v) return res.status(400).json({ error: 'Name cannot be empty.' })
      if (urlFields.includes(k) && v && !/^https?:\/\//i.test(v)) return res.status(400).json({ error: `${k} must be a link starting with https://` })
      if (k === 'phone' && v && !/^\+?[\d\s()-]{7,20}$/.test(v)) return res.status(400).json({ error: 'Enter a valid phone number, e.g. +91 98765 43210.' })
      updates.push([k, v])
    }
    if (updates.length) db.prepare(`UPDATE users SET ${updates.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...updates.map(([, v]) => v), req.user.id)
    const user = userWithRole(req.user.id)
    pushToUser(req.user.id, 'profile', { user })
    res.json({ user })
  })

  app.get('/api/mentors', auth, (req, res) => {
    const rows = db.prepare(`
      SELECT u.id,u.name,u.email,u.location,u.linkedin,u.github,u.bio,u.branch,
             mp.headline,mp.expertise,mp.experience_years,mp.company,mp.hourly_rate,mp.availability,mp.verification_status
      FROM users u JOIN mentor_profiles mp ON mp.user_id=u.id
      WHERE u.role='mentor' AND u.status='active' AND mp.verification_status='approved'
      ORDER BY mp.experience_years DESC,u.name
    `).all()
    res.json({ mentors: rows })
  })

  app.post('/api/mentor/apply', auth, (req, res) => {
    const { headline='', expertise='', experienceYears=0, company='', linkedin='', hourlyRate=0, availability='Flexible' } = req.body
    db.prepare(`UPDATE users SET role='mentor', status='active' WHERE id=?`).run(req.user.id)
    db.prepare(`INSERT INTO mentor_profiles(user_id,headline,expertise,experience_years,company,linkedin,hourly_rate,availability,verification_status)
      VALUES(?,?,?,?,?,?,?,?, 'pending')
      ON CONFLICT(user_id) DO UPDATE SET headline=excluded.headline,expertise=excluded.expertise,experience_years=excluded.experience_years,company=excluded.company,linkedin=excluded.linkedin,hourly_rate=excluded.hourly_rate,availability=excluded.availability`).run(req.user.id,headline,expertise,Number(experienceYears)||0,company,linkedin,Number(hourlyRate)||0,availability)
    res.json({ status:'pending', message:'Mentor application submitted. An administrator must verify your profile before students can book you.' })
  })

  app.get('/api/mentor/me', auth, (req, res) => {
    if (!safeRole(req,['mentor'])) return res.status(403).json({error:'Mentor access required.'})
    const profile = db.prepare('SELECT * FROM mentor_profiles WHERE user_id=?').get(req.user.id)
    const students = db.prepare(`SELECT mc.*,u.name,u.email,u.branch,u.year,u.skills,u.interests FROM mentor_connections mc JOIN users u ON u.id=mc.student_id WHERE mc.mentor_id=? ORDER BY mc.created_at DESC`).all(req.user.id)
    const sessions = db.prepare(`SELECT ms.*,u.name student_name FROM mentor_sessions ms JOIN users u ON u.id=ms.student_id WHERE ms.mentor_id=? ORDER BY ms.starts_at DESC`).all(req.user.id)
    const resources = db.prepare('SELECT * FROM mentor_resources WHERE mentor_id=? ORDER BY created_at DESC').all(req.user.id)
    const tasks = db.prepare(`SELECT mt.*,u.name student_name FROM mentor_tasks mt JOIN users u ON u.id=mt.student_id WHERE mt.mentor_id=? ORDER BY mt.created_at DESC`).all(req.user.id)
    res.json({ profile, students, sessions, resources, tasks })
  })

  app.post('/api/mentors/:id/connect', auth, (req, res) => {
    if (req.user.role === 'mentor') return res.status(400).json({error:'Mentors cannot request themselves.'})
    const mentor = db.prepare(`SELECT u.id FROM users u JOIN mentor_profiles mp ON mp.user_id=u.id WHERE u.id=? AND u.role='mentor' AND mp.verification_status='approved'`).get(Number(req.params.id))
    if (!mentor) return res.status(404).json({error:'Verified mentor not found.'})
    db.prepare(`INSERT INTO mentor_connections(mentor_id,student_id,message) VALUES(?,?,?) ON CONFLICT(mentor_id,student_id) DO UPDATE SET message=excluded.message,status='pending',updated_at=CURRENT_TIMESTAMP`).run(mentor.id,req.user.id,String(req.body.message||'').trim())
    pushToUser(mentor.id,'mentor-request',{studentId:req.user.id})
    const mentorUser=db.prepare('SELECT phone,name FROM users WHERE id=?').get(mentor.id)
    sendSms(mentorUser?.phone, `CareerReady: ${req.user.name} requested mentorship. Open your mentor workspace to review.`)
    res.json({ok:true,status:'pending'})
  })

  app.post('/api/mentor/connections/:id/status', auth, (req, res) => {
    if (!safeRole(req,['mentor'])) return res.status(403).json({error:'Mentor access required.'})
    const status = ['accepted','declined','completed'].includes(req.body.status) ? req.body.status : null
    if (!status) return res.status(400).json({error:'Invalid connection status.'})
    const row = db.prepare('SELECT * FROM mentor_connections WHERE id=? AND mentor_id=?').get(Number(req.params.id),req.user.id)
    if (!row) return res.status(404).json({error:'Connection not found.'})
    db.prepare('UPDATE mentor_connections SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,row.id)
    pushToUser(row.student_id,'mentor-update',{status})
    res.json({ok:true,status})
  })

  app.post('/api/mentor/sessions', auth, (req,res) => {
    if (!safeRole(req,['mentor'])) return res.status(403).json({error:'Mentor access required.'})
    const {studentId,startsAt,endsAt,meetingUrl='',topic=''}=req.body
    if (!studentId || !startsAt || !endsAt) return res.status(400).json({error:'Student, start time and end time are required.'})
    const connection=db.prepare(`SELECT 1 FROM mentor_connections WHERE mentor_id=? AND student_id=? AND status='accepted'`).get(req.user.id,Number(studentId))
    if(!connection) return res.status(403).json({error:'Accept the mentorship connection before scheduling a session.'})
    const startDate=new Date(startsAt), endDate=new Date(endsAt)
    if(Number.isNaN(startDate.getTime())||Number.isNaN(endDate.getTime())||endDate<=startDate) return res.status(400).json({error:'Enter a valid start and end time (end must be after start).'})
    if(startDate.getTime()<Date.now()) return res.status(400).json({error:'Sessions must be scheduled in the future.'})
    if(meetingUrl && !/^https:\/\//i.test(String(meetingUrl))) return res.status(400).json({error:'Meeting link must start with https://'})
    const info=db.prepare('INSERT INTO mentor_sessions(mentor_id,student_id,starts_at,ends_at,meeting_url,topic) VALUES(?,?,?,?,?,?)').run(req.user.id,Number(studentId),startDate.toISOString(),endDate.toISOString(),String(meetingUrl).slice(0,300),String(topic).slice(0,200))
    pushToUser(Number(studentId),'mentor-session',{sessionId:info.lastInsertRowid})
    const studentUser=db.prepare('SELECT phone FROM users WHERE id=?').get(Number(studentId))
    sendSms(studentUser?.phone, `CareerReady mentor session scheduled: ${topic||'Mentorship session'} at ${startsAt}.`)
    res.json({id:info.lastInsertRowid})
  })

  app.post('/api/mentor/evaluations', auth, (req,res) => {
    if (!safeRole(req,['mentor'])) return res.status(403).json({error:'Mentor access required.'})
    const {studentId,sessionId=null,category='Mentor review',score=0,strengths='',improvements='',actionPlan=''}=req.body
    if(!studentId || !category) return res.status(400).json({error:'Student and category are required.'})
    if(!isConnected(req.user.id,studentId)) return res.status(403).json({error:'You can only evaluate students connected to you.'})
    if(sessionId!==null && sessionId!==undefined && !db.prepare('SELECT 1 FROM mentor_sessions WHERE id=? AND mentor_id=? AND student_id=?').get(Number(sessionId),req.user.id,Number(studentId))) return res.status(400).json({error:'That session does not belong to this student.'})
    const info=db.prepare('INSERT INTO mentor_evaluations(mentor_id,student_id,session_id,category,score,strengths,improvements,action_plan) VALUES(?,?,?,?,?,?,?,?)').run(req.user.id,Number(studentId),sessionId==null?null:Number(sessionId),String(category).slice(0,80),Math.max(0,Math.min(100,Number(score)||0)),String(strengths).slice(0,2000),String(improvements).slice(0,2000),String(actionPlan).slice(0,2000))
    pushToUser(Number(studentId),'mentor-evaluation',{id:info.lastInsertRowid})
    res.json({id:info.lastInsertRowid})
  })

  app.post('/api/mentor/tasks', auth, (req,res) => {
    if (!safeRole(req,['mentor'])) return res.status(403).json({error:'Mentor access required.'})
    const {studentId,title,description='',dueDate=null}=req.body
    if(!studentId || !title) return res.status(400).json({error:'Student and title are required.'})
    if(!isConnected(req.user.id,studentId)) return res.status(403).json({error:'You can only assign tasks to students connected to you.'})
    const info=db.prepare('INSERT INTO mentor_tasks(mentor_id,student_id,title,description,due_date) VALUES(?,?,?,?,?)').run(req.user.id,Number(studentId),String(title).slice(0,200),String(description).slice(0,2000),dueDate?String(dueDate).slice(0,30):null)
    pushToUser(Number(studentId),'mentor-task',{id:info.lastInsertRowid})
    res.json({id:info.lastInsertRowid})
  })

  app.get('/api/mentor/student/:id', auth, (req,res) => {
    if(!safeRole(req,['mentor'])) return res.status(403).json({error:'Mentor access required.'})
    const studentId=Number(req.params.id)
    const connected=db.prepare(`SELECT 1 FROM mentor_connections WHERE mentor_id=? AND student_id=? AND status='accepted'`).get(req.user.id,studentId)
    if(!connected) return res.status(403).json({error:'You can only review students connected to you.'})
    const student=userWithRole(studentId)
    const assessments=db.prepare('SELECT category,score,total,taken_at FROM assessments WHERE user_id=? ORDER BY taken_at DESC').all(studentId)
    const resume=db.prepare('SELECT content,updated_at FROM resumes WHERE user_id=?').get(studentId)
    const evaluations=db.prepare('SELECT * FROM mentor_evaluations WHERE mentor_id=? AND student_id=? ORDER BY created_at DESC').all(req.user.id,studentId)
    const applications=db.prepare(`SELECT a.*,i.title,i.company FROM applications a JOIN internships i ON i.id=a.internship_id WHERE a.user_id=? ORDER BY a.updated_at DESC`).all(studentId)
    const tasks=db.prepare('SELECT * FROM mentor_tasks WHERE mentor_id=? AND student_id=? ORDER BY created_at DESC').all(req.user.id,studentId)
    res.json({student,assessments,resume,evaluations,applications,tasks})
  })

  app.post('/api/mentor/resources', auth, (req,res) => {
    if(!safeRole(req,['mentor'])) return res.status(403).json({error:'Mentor access required.'})
    const {title,description='',url}=req.body
    if(!title||!url) return res.status(400).json({error:'Title and URL are required.'})
    const info=db.prepare('INSERT INTO mentor_resources(mentor_id,title,description,url) VALUES(?,?,?,?)').run(req.user.id,title,description,url)
    res.json({id:info.lastInsertRowid})
  })

  app.get('/api/my-mentor', auth, (req,res) => {
    const rows=db.prepare(`SELECT mc.*,u.id mentor_id,u.name,u.email,u.location,u.bio,mp.headline,mp.expertise,mp.company FROM mentor_connections mc JOIN users u ON u.id=mc.mentor_id JOIN mentor_profiles mp ON mp.user_id=u.id WHERE mc.student_id=? ORDER BY mc.updated_at DESC`).all(req.user.id)
    const evaluations=db.prepare(`SELECT me.*,u.name mentor_name FROM mentor_evaluations me JOIN users u ON u.id=me.mentor_id WHERE me.student_id=? ORDER BY me.created_at DESC`).all(req.user.id)
    const tasks=db.prepare('SELECT * FROM mentor_tasks WHERE student_id=? ORDER BY created_at DESC').all(req.user.id)
    const sessions=db.prepare(`SELECT ms.*,u.name mentor_name FROM mentor_sessions ms JOIN users u ON u.id=ms.mentor_id WHERE ms.student_id=? ORDER BY ms.starts_at DESC`).all(req.user.id)
    res.json({connections:rows,evaluations,tasks,sessions})
  })

  app.post('/api/mentor/tasks/:id/complete', auth, (req,res) => {
    const row=db.prepare('SELECT * FROM mentor_tasks WHERE id=? AND student_id=?').get(Number(req.params.id),req.user.id)
    if(!row) return res.status(404).json({error:'Task not found.'})
    db.prepare("UPDATE mentor_tasks SET status='completed' WHERE id=?").run(row.id)
    pushToUser(row.mentor_id,'mentor-task-update',{id:row.id})
    res.json({ok:true})
  })

  app.get('/api/community', auth, (req,res) => {
    const posts=db.prepare(`SELECT cp.*,u.name,u.branch,u.year,(SELECT COUNT(*) FROM community_replies cr WHERE cr.post_id=cp.id) replies FROM community_posts cp JOIN users u ON u.id=cp.user_id ORDER BY cp.created_at DESC LIMIT 80`).all()
    res.json({posts})
  })
  app.post('/api/community', auth, (req,res) => {
    const {title,body,category='General'}=req.body
    if(!title||!body) return res.status(400).json({error:'Title and body are required.'})
    const info=db.prepare('INSERT INTO community_posts(user_id,category,title,body) VALUES(?,?,?,?)').run(req.user.id,title.trim(),body.trim(),category)
    broadcast('community',{id:info.lastInsertRowid})
    res.json({id:info.lastInsertRowid})
  })
  app.get('/api/community/:id', auth, (req,res) => {
    const post=db.prepare(`SELECT cp.*,u.name,u.branch,u.year FROM community_posts cp JOIN users u ON u.id=cp.user_id WHERE cp.id=?`).get(Number(req.params.id))
    if(!post) return res.status(404).json({error:'Discussion not found.'})
    const replies=db.prepare(`SELECT cr.*,u.name,u.branch,u.year FROM community_replies cr JOIN users u ON u.id=cr.user_id WHERE cr.post_id=? ORDER BY cr.created_at`).all(post.id)
    res.json({post,replies})
  })
  app.post('/api/community/:id/replies', auth, (req,res) => {
    if(!req.body.body) return res.status(400).json({error:'Reply cannot be empty.'})
    const post=db.prepare('SELECT id FROM community_posts WHERE id=?').get(Number(req.params.id))
    if(!post) return res.status(404).json({error:'Discussion not found.'})
    const info=db.prepare('INSERT INTO community_replies(post_id,user_id,body) VALUES(?,?,?)').run(post.id,req.user.id,req.body.body.trim())
    res.json({id:info.lastInsertRowid})
  })
  app.post('/api/community/:id/like', auth, (req,res) => { db.prepare('UPDATE community_posts SET likes=likes+1 WHERE id=?').run(Number(req.params.id)); res.json({ok:true}) })
  app.post('/api/community/:id/report', auth, (req,res) => { db.prepare('INSERT INTO community_reports(post_id,reporter_id,reason) VALUES(?,?,?)').run(Number(req.params.id),req.user.id,String(req.body.reason||'')); res.json({ok:true}) })

  app.post('/api/ai/resume-review', auth, async (req,res) => {
    if(!ai.enabled()) return res.status(503).json({error:'AI is not configured. Add GEMINI_API_KEY (free at aistudio.google.com) or OPENAI_API_KEY to the server environment.'})
    const content=String(req.body.content||'').slice(0,20000)
    if(!content.trim()) return res.status(400).json({error:'Resume text is required.'})
    const goal=db.prepare(`SELECT r.title FROM user_goals g JOIN roles r ON r.id=g.role_id WHERE g.user_id=?`).get(req.user.id)
    const target=goal?.title||'Software Developer'
    const prompt=`Act as a senior recruiter and career coach. Review this resume for a student targeting ${target}. Return strict JSON with score (0-100), summary, strengths (array), missing_skills (array), missing_keywords (array), impact_improvements (array), project_ideas (array of objects with title,why,skills), and red_flags (array). Do not invent experience. Resume:
${content}`
    try{const text=await ai.askText(prompt);let parsed;try{parsed=ai.parseJson(text)}catch{parsed={score:0,summary:'The AI response was not valid JSON. Try again.',strengths:[],missing_skills:[],missing_keywords:[],impact_improvements:[],project_ideas:[],red_flags:[]}}res.json(parsed)}catch(err){res.status(502).json({error:ai.userMessage(err)})}
  })

  app.post('/api/ai/interview-evaluate', auth, async (req,res) => {
    if(!ai.enabled()) return res.status(503).json({error:'AI is not configured. Add GEMINI_API_KEY (free at aistudio.google.com) or OPENAI_API_KEY to the server environment.'})
    const {question,answer,targetRole='Software Developer'}=req.body
    if(!question||!answer) return res.status(400).json({error:'Question and answer are required.'})
    const prompt=`You are an interview coach. Evaluate this student interview answer for target role ${targetRole}. Return strict JSON with score (0-100), clarity, relevance, structure, confidence_signal, filler_words, strengths (array), improvements (array), better_answer (string), and hiring_signal (one of strong, promising, needs_work). Do not infer mental health or consciousness. Evaluate only observable language quality and interview communication. Question: ${question}\nAnswer: ${answer}`
    try {
      const text=await ai.askText(prompt)
      let parsed
      try { parsed=ai.parseJson(text) } catch { parsed={score:0,clarity:'Unavailable',relevance:'Unavailable',structure:'Unavailable',confidence_signal:'Unavailable',filler_words:[],strengths:[],improvements:['AI returned an invalid evaluation. Try again.'],better_answer:'',hiring_signal:'needs_work'} }
      res.json(parsed)
    } catch(err){ res.status(502).json({error:ai.userMessage(err)}) }
  })

  app.get('/api/integrations/status', auth, (req,res) => res.json({openai:ai.provider()==='openai',gemini:ai.provider()==='gemini',ai:ai.enabled(),twilio:Boolean(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN),googleCalendar:Boolean(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET),stripe:Boolean(process.env.STRIPE_SECRET_KEY)}))
  app.get('/api/admin/mentor-applications', auth, (req,res) => {
    if(req.user.role!=='admin') return res.status(403).json({error:'Admin access required.'})
    const rows=db.prepare(`SELECT u.id,u.name,u.email,u.phone,mp.* FROM users u JOIN mentor_profiles mp ON mp.user_id=u.id WHERE mp.verification_status='pending' ORDER BY mp.created_at DESC`).all()
    res.json({applications:rows})
  })
  app.post('/api/admin/mentor-applications/:id', auth, (req,res) => {
    if(req.user.role!=='admin') return res.status(403).json({error:'Admin access required.'})
    const status=['approved','rejected'].includes(req.body.status)?req.body.status:null
    if(!status) return res.status(400).json({error:'Status must be approved or rejected.'})
    db.prepare('UPDATE mentor_profiles SET verification_status=? WHERE user_id=?').run(status,Number(req.params.id))
    res.json({ok:true,status})
  })
}

module.exports = { registerProductionIntegrations }
