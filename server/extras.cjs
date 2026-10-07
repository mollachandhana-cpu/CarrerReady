module.exports = function extras({ app, db, auth, pushToUser, broadcast, hashPassword }) {
  const APPLICATION_STATUSES = ['Interested', 'Applied', 'Interview', 'Offer', 'Rejected', 'Withdrawn']

  // Lightweight analytics used by the enhanced dashboard.
  app.get('/api/insights', auth, (req, res) => {
    const userId = req.user.id
    const applications = db.prepare(`
      SELECT a.status, COUNT(*) AS count
      FROM applications a
      WHERE a.user_id = ?
      GROUP BY a.status
    `).all(userId)
    const saved = db.prepare('SELECT COUNT(*) AS count FROM saved WHERE user_id = ?').get(userId).count
    const assessments = db.prepare(`
      SELECT category, score, total, taken_at
      FROM assessments
      WHERE user_id = ?
      AND id IN (SELECT MAX(id) FROM assessments WHERE user_id = ? GROUP BY category)
      ORDER BY category
    `).all(userId, userId)
    const progress = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN p.user_id IS NULL THEN 0 ELSE 1 END) AS done
      FROM user_goals g
      JOIN roadmap_steps s ON s.role_id = g.role_id
      LEFT JOIN user_progress p ON p.step_id = s.id AND p.user_id = g.user_id
      WHERE g.user_id = ?
    `).get(userId)
    const statusMap = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0]))
    for (const row of applications) statusMap[row.status] = row.count
    const totalApplications = Object.values(statusMap).reduce((a, b) => a + b, 0)
    const success = statusMap.Offer + statusMap.Interview
    res.json({
      saved,
      applications: statusMap,
      totalApplications,
      pipelineActive: success,
      assessments,
      roadmap: { total: progress?.total || 0, done: progress?.done || 0 },
    })
  })

  // Career Coach: turns existing CareerReady data into a personalized next-best-action loop.
  app.get('/api/coach', auth, (req, res) => {
    const userId = req.user.id
    const readiness = (() => {
      const rows = db.prepare(`
        SELECT category, score, total FROM assessments
        WHERE id IN (SELECT MAX(id) FROM assessments WHERE user_id = ? GROUP BY category)
      `).all(userId)
      return ['Programming', 'Aptitude', 'Communication'].map((category) => {
        const row = rows.find((r) => r.category === category)
        return { category, taken: Boolean(row), percent: row ? Math.round((row.score / row.total) * 100) : 0 }
      })
    })()

    const goal = db.prepare(`
      SELECT r.id, r.slug, r.title, r.branch, r.weights, r.keywords
      FROM user_goals g JOIN roles r ON r.id = g.role_id
      WHERE g.user_id = ?
    `).get(userId)

    const saved = db.prepare('SELECT COUNT(*) AS n FROM saved WHERE user_id = ?').get(userId).n
    const applications = db.prepare(`
      SELECT a.id, a.status, a.updated_at, i.title, i.company, i.skills, i.deadline
      FROM applications a JOIN internships i ON i.id = a.internship_id
      WHERE a.user_id = ? ORDER BY a.updated_at DESC
    `).all(userId)

    const progress = goal ? db.prepare(`
      SELECT s.id, s.step_order, s.title, s.description, s.resource_name, s.resource_url,
             CASE WHEN p.user_id IS NULL THEN 0 ELSE 1 END AS done
      FROM roadmap_steps s
      LEFT JOIN user_progress p ON p.step_id = s.id AND p.user_id = ?
      WHERE s.role_id = ? ORDER BY s.step_order
    `).all(userId, goal.id).map((s) => ({ ...s, done: Boolean(s.done) })) : []

    const gaps = goal
      ? (() => {
          const weights = JSON.parse(goal.weights)
          const names = ['Programming', 'Aptitude', 'Communication']
          return readiness
            .map((c, i) => ({
              category: c.category,
              score: c.percent,
              importance: weights[i],
              gap: Math.max(0, 100 - c.percent),
            }))
            .filter((g) => g.importance >= 30 && (!readiness.find((c) => c.category === g.category)?.taken || g.score < 75))
            .sort((a, b) => (b.gap * b.importance) - (a.gap * a.importance))
        })()
      : []

    const targetKeywords = goal ? goal.keywords.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : []
    const internships = db.prepare('SELECT * FROM internships ORDER BY id').all()
    const matched = internships.map((item) => {
      const skills = item.skills.split(',').map((x) => x.trim().toLowerCase())
      const keywordHits = targetKeywords.filter((k) =>
        item.title.toLowerCase().includes(k) || item.skills.toLowerCase().includes(k)
      ).length
      const branchFit = item.branch === req.user.branch || item.branch === 'All' ? 18 : 0
      const skillHits = goal ? skills.filter((skill) => targetKeywords.some((k) => skill.includes(k) || k.includes(skill))).length : 0
      const score = Math.min(98, 42 + keywordHits * 14 + skillHits * 8 + branchFit)
      return { ...item, match: score }
    })
      .filter((item) => item.match >= 55)
      .sort((a, b) => b.match - a.match)
      .slice(0, 3)

    let action
    if (!readiness.every((c) => c.taken)) {
      const missing = readiness.filter((c) => !c.taken).map((c) => c.category)
      action = {
        type: 'assessment',
        label: 'Complete your readiness assessment',
        reason: `You still need your ${missing.join(' and ')} assessment${missing.length > 1 ? 's' : ''} before CareerReady can personalize your plan.`,
        cta: 'Take assessment',
        tab: 'assessment',
      }
    } else if (!goal) {
      action = {
        type: 'role',
        label: 'Choose your target career',
        reason: 'A target role lets CareerReady turn your assessment into a role-specific skill-gap analysis and roadmap.',
        cta: 'Explore career paths',
        tab: 'paths',
      }
    } else if (gaps.length) {
      const gap = gaps[0]
      action = {
        type: 'skill-gap',
        label: `Improve ${gap.category}`,
        reason: `${gap.category} is ${gap.score}%, while it has ${gap.importance}% importance for ${goal.title}. Closing this gap is your highest-impact preparation step.`,
        cta: 'Open roadmap',
        tab: 'paths',
      }
    } else {
      const nextStep = progress.find((s) => !s.done)
      const interview = applications.find((a) => a.status === 'Interview')
      const interested = applications.find((a) => a.status === 'Interested')
      if (interview) {
        action = {
          type: 'interview',
          label: `Prepare for ${interview.company}`,
          reason: `You have an active interview-stage application for ${interview.title}. Practice before your next interaction.`,
          cta: 'Open interview prep',
          tab: 'interview',
        }
      } else if (interested) {
        action = {
          type: 'application',
          label: `Apply to ${interested.title}`,
          reason: `You marked this opportunity as Interested. Turning it into an application keeps your career pipeline moving.`,
          cta: 'Open applications',
          tab: 'applications',
        }
      } else if (nextStep) {
        action = {
          type: 'roadmap',
          label: nextStep.title,
          reason: `This is the next unfinished step in your ${goal.title} roadmap.`,
          cta: 'Continue roadmap',
          tab: 'paths',
        }
      } else if (matched.length) {
        action = {
          type: 'opportunity',
          label: `Review your ${matched.length} strongest opportunities`,
          reason: `Your profile is ready enough to focus on real opportunities instead of only preparing.`,
          cta: 'View internships',
          tab: 'internships',
        }
      } else {
        action = {
          type: 'interview',
          label: 'Practise interview questions',
          reason: 'Your core roadmap is complete. Keep interview readiness sharp while you continue applying.',
          cta: 'Start interview prep',
          tab: 'interview',
        }
      }
    }

    const roadmapDone = progress.filter((s) => s.done).length
    const roadmapPercent = progress.length ? Math.round((roadmapDone / progress.length) * 100) : 0
    const assessedPercent = Math.round(readiness.reduce((sum, c) => sum + c.percent, 0) / readiness.length)
    const evidenceSignals = [goal ? 1 : 0, applications.length > 0 ? 1 : 0, saved > 0 ? 1 : 0, roadmapDone > 0 ? 1 : 0]
    const evidenceScore = Math.round((evidenceSignals.reduce((a, b) => a + b, 0) / evidenceSignals.length) * 100)
    const jobReadiness = Math.round(assessedPercent * 0.55 + roadmapPercent * 0.3 + evidenceScore * 0.15)

    const plan = []
    if (gaps.length) {
      plan.push({ priority: 1, title: `Close your ${gaps[0].category} gap`, detail: `${gaps[0].category} is ${gaps[0].score}% against a ${gaps[0].importance}% role importance.`, tab: 'paths' })
    }
    const nextStep = progress.find((s) => !s.done)
    if (nextStep) {
      plan.push({ priority: 2, title: nextStep.title, detail: nextStep.description, tab: 'paths' })
    }
    if (matched.length) {
      plan.push({ priority: 3, title: `Review your top ${matched.length} opportunity matches`, detail: `${matched[0].title} at ${matched[0].company} is currently your strongest match at ${matched[0].match}%.`, tab: 'internships' })
    }

    res.json({
      target: goal ? { title: goal.title, slug: goal.slug } : null,
      readiness,
      gaps,
      action,
      roadmap: { total: progress.length, done: roadmapDone, percent: roadmapPercent, nextStep: nextStep || null },
      jobReadiness,
      evidenceScore,
      plan: plan.slice(0, 3),
      opportunities: matched.map((i) => ({ id: i.id, title: i.title, company: i.company, location: i.location, mode: i.mode, skills: i.skills, deadline: i.deadline, match: i.match })),
      applications: applications.slice(0, 5).map((a) => ({ id: a.id, status: a.status, title: a.title, company: a.company, updated_at: a.updated_at })),
    })
  })

  // Application tracker: turns saved internship listings into a real pipeline.
  app.get('/api/applications', auth, (req, res) => {
    const rows = db.prepare(`
      SELECT a.*, i.title, i.company, i.location, i.mode, i.stipend, i.deadline, i.skills
      FROM applications a
      JOIN internships i ON i.id = a.internship_id
      WHERE a.user_id = ?
      ORDER BY
        CASE a.status
          WHEN 'Interview' THEN 1
          WHEN 'Applied' THEN 2
          WHEN 'Offer' THEN 3
          WHEN 'Interested' THEN 4
          ELSE 5
        END,
        COALESCE(a.updated_at, '') DESC
    `).all(req.user.id)
    res.json({ applications: rows })
  })

  app.post('/api/internships/:id/application', auth, (req, res) => {
    const internshipId = Number(req.params.id)
    const internship = db.prepare('SELECT id FROM internships WHERE id = ?').get(internshipId)
    if (!internship) return res.status(404).json({ error: 'Internship not found.' })

    const status = APPLICATION_STATUSES.includes(req.body.status) ? req.body.status : 'Interested'
    const notes = String(req.body.notes || '').slice(0, 2000)
    const appliedAt = status === 'Applied' || status === 'Interview' || status === 'Offer'
      ? new Date().toISOString()
      : null

    db.prepare(`
      INSERT INTO applications (user_id, internship_id, status, notes, applied_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, internship_id) DO UPDATE SET
        status = excluded.status,
        notes = excluded.notes,
        applied_at = COALESCE(applications.applied_at, excluded.applied_at),
        updated_at = CURRENT_TIMESTAMP
    `).run(req.user.id, internshipId, status, notes, appliedAt)

    pushToUser(req.user.id, 'sync', { what: 'application' })
    res.json({ ok: true, status })
  })

  app.patch('/api/applications/:id', auth, (req, res) => {
    const id = Number(req.params.id)
    const existing = db.prepare('SELECT * FROM applications WHERE id = ? AND user_id = ?').get(id, req.user.id)
    if (!existing) return res.status(404).json({ error: 'Application not found.' })

    const status = APPLICATION_STATUSES.includes(req.body.status) ? req.body.status : existing.status
    const notes = req.body.notes === undefined ? existing.notes : String(req.body.notes).slice(0, 2000)
    const appliedAt = existing.applied_at || (
      ['Applied', 'Interview', 'Offer'].includes(status) ? new Date().toISOString() : null
    )
    db.prepare(`
      UPDATE applications
      SET status = ?, notes = ?, applied_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(status, notes, appliedAt, id, req.user.id)
    pushToUser(req.user.id, 'sync', { what: 'application' })
    res.json({ ok: true })
  })

  app.delete('/api/applications/:id', auth, (req, res) => {
    const id = Number(req.params.id)
    db.prepare('DELETE FROM applications WHERE id = ? AND user_id = ?').run(id, req.user.id)
    pushToUser(req.user.id, 'sync', { what: 'application' })
    res.json({ ok: true })
  })

  // Profile editing keeps the original account/auth model intact.
  app.patch('/api/profile', auth, (req, res) => {
    const name = String(req.body.name || '').trim()
    const branch = String(req.body.branch || 'Other').trim()
    const year = String(req.body.year || '1st year').trim()
    if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name.' })
    db.prepare(`UPDATE users SET name=?,branch=?,year=?,phone=?,location=?,bio=?,skills=?,interests=?,linkedin=?,github=?,portfolio=? WHERE id=?`).run(
      name.slice(0,100), branch.slice(0,50), year.slice(0,30), String(req.body.phone||'').slice(0,30), String(req.body.location||'').slice(0,120), String(req.body.bio||'').slice(0,1200), String(req.body.skills||'').slice(0,800), String(req.body.interests||'').slice(0,500), String(req.body.linkedin||'').slice(0,300), String(req.body.github||'').slice(0,300), String(req.body.portfolio||'').slice(0,300), req.user.id)
    const user = db.prepare('SELECT id,name,email,branch,year,role,status,phone,location,bio,skills,interests,linkedin,github,portfolio FROM users WHERE id=?').get(req.user.id)
    pushToUser(req.user.id, 'profile', { user })
    res.json({ user })
  })

  // Interview-prep content is deliberately local/rule-based, so the project works without an AI key.
  const interviewQuestions = [
    { id: 1, category: 'HR', difficulty: 'Easy', question: 'Tell me about yourself.', points: ['Education or current year', 'One or two relevant skills', 'A project or achievement', 'What role you are targeting'] },
    { id: 2, category: 'HR', difficulty: 'Medium', question: 'Why should we hire you as a fresher?', points: ['Specific strengths', 'Evidence from projects', 'Learning mindset', 'How you can contribute'] },
    { id: 3, category: 'Technical', difficulty: 'Easy', question: 'Explain the difference between an array and a linked list.', points: ['Contiguous vs linked storage', 'Index access', 'Insertion/deletion trade-offs', 'A practical use case'] },
    { id: 4, category: 'Technical', difficulty: 'Medium', question: 'What happens when you enter a URL in a browser?', points: ['DNS lookup', 'TCP/TLS connection', 'HTTP request/response', 'Browser rendering'] },
    { id: 5, category: 'Technical', difficulty: 'Medium', question: 'What is a REST API?', points: ['Resource-oriented endpoints', 'HTTP methods', 'Stateless requests', 'JSON or similar representations'] },
    { id: 6, category: 'Situational', difficulty: 'Medium', question: 'Describe a time you had to solve a difficult problem in a project.', points: ['Situation', 'Your specific task', 'Actions and reasoning', 'Measurable result or lesson'] },
    { id: 7, category: 'HR', difficulty: 'Medium', question: 'What is one weakness you are actively improving?', points: ['A genuine but manageable weakness', 'Concrete improvement method', 'Recent progress', 'What you are doing next'] },
    { id: 8, category: 'Technical', difficulty: 'Hard', question: 'How would you improve a slow database query?', points: ['Inspect query plan', 'Indexes', 'Reduce unnecessary data', 'Schema/query improvements', 'Measure before and after'] },
  ]

  app.get('/api/interview/questions', auth, (req, res) => {
    const category = String(req.query.category || '')
    const difficulty = String(req.query.difficulty || '')
    const rows = interviewQuestions.filter((q) =>
      (!category || q.category === category) && (!difficulty || q.difficulty === difficulty)
    )
    res.json({ questions: rows.length ? rows : interviewQuestions })
  })

  app.get('/api/interview/categories', auth, (req, res) => {
    res.json({
      categories: [...new Set(interviewQuestions.map((q) => q.category))],
      difficulties: [...new Set(interviewQuestions.map((q) => q.difficulty))],
    })
  })
}
