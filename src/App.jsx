import { useEffect, useState } from 'react'
import { api, clearToken, getToken } from './api'
import Login from './Login'
import Signup from './Signup'
import MentorHub from './MentorHub'
import Community from './Community'
import './App.css'

/* ---------- Small helpers ---------- */
function timeAgo(iso) {
  if (!iso) return 'not yet'
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return mins + ' min ago'
  const hours = Math.round(mins / 60)
  if (hours < 24) return hours + ' h ago'
  return Math.round(hours / 24) + ' days ago'
}

function ScoreRing({ score }) {
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference
  return (
    <svg className="ring" viewBox="0 0 140 140" role="img" aria-label={`Readiness score ${score} out of 100`}>
      <circle cx="70" cy="70" r={radius} className="ring-bg" />
      <circle
        cx="70"
        cy="70"
        r={radius}
        className="ring-fg"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 70 70)"
      />
      <text x="70" y="68" textAnchor="middle" className="ring-num">{score}</text>
      <text x="70" y="90" textAnchor="middle" className="ring-sub">out of 100</text>
    </svg>
  )
}

function JobCard({ job }) {
  return (
    <article className="job">
      <div className="job-head">
        <div>
          <h3>{job.title}</h3>
          <p className="company">
            {job.company} | {job.location || 'Location not listed'}
            {job.remote ? ' | Remote' : ''}
          </p>
        </div>
        <a className="btn" href={job.url} target="_blank" rel="noreferrer">
          View on {job.source}
        </a>
      </div>
      <p className="meta">Posted {timeAgo(job.posted_at)} | Source: {job.source}</p>
      {job.tags && (
        <p className="skills">
          {job.tags.split(',').slice(0, 6).map((t) => (
            <span key={t} className="chip">{t.trim()}</span>
          ))}
        </p>
      )}
    </article>
  )
}

/* ---------- Application tracker ---------- */
function Applications({ syncTick }) {
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)

  async function load() {
    try {
      const d = await api('/applications')
      setItems(d.applications)
    } catch (e) { setError(e.message) }
  }

  useEffect(() => { load() }, [syncTick])

  async function update(id, status, notes) {
    try {
      await api(`/applications/${id}`, { method: 'PATCH', body: { status, notes } })
      await load()
      setEditing(null)
    } catch (e) { setError(e.message) }
  }

  async function remove(id) {
    if (!window.confirm('Remove this application from your tracker?')) return
    try {
      await api(`/applications/${id}`, { method: 'DELETE' })
      await load()
    } catch (e) { setError(e.message) }
  }

  const counts = items.reduce((acc, i) => {
    acc[i.status] = (acc[i.status] || 0) + 1
    return acc
  }, {})

  return (
    <div>
      <div className="page-heading">
        <div>
          <h2>Application tracker</h2>
          <p className="muted">Turn interesting internships into a simple pipeline and keep your next action visible.</p>
        </div>
        <div className="stats-row">
          <div className="mini-stat"><strong>{items.length}</strong><span>Total</span></div>
          <div className="mini-stat"><strong>{counts.Applied || 0}</strong><span>Applied</span></div>
          <div className="mini-stat"><strong>{counts.Interview || 0}</strong><span>Interview</span></div>
          <div className="mini-stat"><strong>{counts.Offer || 0}</strong><span>Offers</span></div>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {items.length === 0 ? (
        <div className="empty-card">
          <h3>Your pipeline is empty</h3>
          <p className="muted">Go to Internships, choose a listing and mark it as Interested or Applied.</p>
        </div>
      ) : (
        <div className="application-list">
          {items.map((item) => (
            <article key={item.id} className="application-card">
              <div>
                <div className="job-head">
                  <div>
                    <h3>{item.title}</h3>
                    <p className="company">{item.company} · {item.location} · {item.mode}</p>
                  </div>
                  <span className={'status status-' + item.status.toLowerCase()}>{item.status}</span>
                </div>
                <p className="meta">{item.stipend} · Apply by {item.deadline}</p>
                {item.notes && <p className="notes">{item.notes}</p>}
              </div>

              {editing === item.id ? (
                <div className="edit-row">
                  <select
                    defaultValue={item.status}
                    id={'status-' + item.id}
                    aria-label="Application status"
                  >
                    {['Interested', 'Applied', 'Interview', 'Offer', 'Rejected', 'Withdrawn'].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <input
                    defaultValue={item.notes}
                    id={'notes-' + item.id}
                    placeholder="Optional note"
                    aria-label="Application note"
                  />
                  <button className="btn primary" onClick={() => update(
                    item.id,
                    document.getElementById('status-' + item.id).value,
                    document.getElementById('notes-' + item.id).value
                  )}>Save</button>
                  <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              ) : (
                <div className="actions">
                  <button className="btn" onClick={() => setEditing(item.id)}>Update</button>
                  <button className="btn danger" onClick={() => remove(item.id)}>Remove</button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- Interview preparation ---------- */
function InterviewPrep() {
  const [questions, setQuestions] = useState([])
  const [category, setCategory] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [index, setIndex] = useState(0)
  const [showGuide, setShowGuide] = useState(false)
  const [completed, setCompleted] = useState(() => Number(localStorage.getItem('careerready_interview_done') || 0))
  const [answer, setAnswer] = useState('')
  const [evaluation, setEvaluation] = useState(null)
  const [evaluating, setEvaluating] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    try { const d = await api(`/interview/questions?category=${encodeURIComponent(category)}&difficulty=${encodeURIComponent(difficulty)}`); setQuestions(d.questions); setIndex(0); setShowGuide(false); setAnswer(''); setEvaluation(null) }
    catch (e) { setError(e.message) }
  }
  useEffect(() => { load() }, [category, difficulty])
  const q = questions[index]
  async function evaluate(){ if(!answer.trim()) return; setEvaluating(true); setError(''); try{setEvaluation(await api('/ai/interview-evaluate',{method:'POST',body:{question:q.question,answer,targetRole:'Software Developer'}}))}catch(e){setError(e.message)}finally{setEvaluating(false)} }
  function listen(){ const SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR){setError('Your browser does not support speech recognition. You can type your answer instead.');return} const r=new SR();r.lang='en-IN';r.interimResults=false;r.onstart=()=>setListening(true);r.onend=()=>setListening(false);r.onresult=e=>setAnswer(v=>(v?' '+v:'')+e.results[0][0].transcript);r.start() }
  function next(){ setCompleted(n=>{const value=n+1;localStorage.setItem('careerready_interview_done',String(value));return value});setIndex(i=>(questions.length?(i+1)%questions.length:0));setShowGuide(false);setAnswer('');setEvaluation(null) }
  return <div><div className="page-heading"><div><span className="eyebrow">AI INTERVIEW LAB</span><h2>Practise like it is a real interview</h2><p className="muted">Answer by typing or speaking. AI evaluates observable communication signals such as clarity, relevance, structure, confidence and filler words. It does not claim to measure consciousness or mental state.</p></div><div className="practice-score"><strong>{completed}</strong><span>questions practised</span></div></div><div className="filters"><select value={category} onChange={e=>setCategory(e.target.value)}><option value="">All categories</option><option>HR</option><option>Technical</option><option>Situational</option></select><select value={difficulty} onChange={e=>setDifficulty(e.target.value)}><option value="">All levels</option><option>Easy</option><option>Medium</option><option>Hard</option></select></div>{error&&<p className="error">{error}</p>}{q&&<article className="interview-card"><div className="question-meta"><span className="chip">{q.category}</span><span className="chip">{q.difficulty}</span></div><p className="question-number">Question {index+1} of {questions.length}</p><h3>{q.question}</h3><textarea className="interview-answer" value={answer} onChange={e=>setAnswer(e.target.value)} placeholder="Answer here as if you were speaking to the interviewer..."/><div className="actions"><button className="btn" onClick={listen}>{listening?'Listening...':'🎙 Answer with microphone'}</button><button className="btn primary" disabled={evaluating||!answer.trim()} onClick={evaluate}>{evaluating?'AI is evaluating...':'Evaluate with AI'}</button></div>{evaluation&&<div className="ai-evaluation"><div className="evaluation-score"><strong>{evaluation.score}</strong><span>/100</span></div><div className="evaluation-grid"><div><b>Clarity</b><span>{evaluation.clarity}</span></div><div><b>Relevance</b><span>{evaluation.relevance}</span></div><div><b>Structure</b><span>{evaluation.structure}</span></div><div><b>Confidence signal</b><span>{evaluation.confidence_signal}</span></div><div><b>Filler words</b><span>{(evaluation.filler_words||[]).join(', ')||'None detected'}</span></div></div><h4>Strengths</h4><ul>{(evaluation.strengths||[]).map(x=><li key={x}>{x}</li>)}</ul><h4>Improve next time</h4><ul>{(evaluation.improvements||[]).map(x=><li key={x}>{x}</li>)}</ul>{evaluation.better_answer&&<><h4>Stronger answer example</h4><p>{evaluation.better_answer}</p></>}</div>}{!showGuide?<button className="btn" onClick={()=>setShowGuide(true)}>Reveal answer guide</button>:<div className="answer-guide"><strong>A strong answer should include:</strong><ul>{q.points.map(p=><li key={p}>{p}</li>)}</ul></div>}<div className="actions"><button className="btn" onClick={next}>I practised this → Next question</button></div></article>}</div>
}

/* ---------- Profile ---------- */
function Profile({ user, onUpdate }) {
  const [form, setForm] = useState({ name: user.name, branch: user.branch, year: user.year, phone:user.phone||'', location:user.location||'', bio:user.bio||'', skills:user.skills||'', interests:user.interests||'', linkedin:user.linkedin||'', github:user.github||'', portfolio:user.portfolio||'' })
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function save(e) {
    e.preventDefault()
    try {
      const d = await api('/profile', { method: 'PATCH', body: form })
      onUpdate(d.user)
      setMessage('Profile updated successfully.')
      setError('')
    } catch (e) { setError(e.message); setMessage('') }
  }

  return (
    <div className="profile-page">
      <h2>Your profile</h2>
      <p className="muted">Keep your academic details current so CareerReady can personalise listings and roadmaps.</p>
      <form className="profile-card" onSubmit={save}>
        <label>Full name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Email<input value={user.email} disabled /></label><label>Phone<input value={form.phone} onChange={(e)=>setForm({...form,phone:e.target.value})}/></label><label>Location<input value={form.location} onChange={(e)=>setForm({...form,location:e.target.value})}/></label>
        <label>Branch
          <select value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
            {['CSE', 'ECE', 'EEE', 'Mechanical', 'Civil', 'Other'].map((b) => <option key={b}>{b}</option>)}
          </select>
        </label>
        <label>Skills<input value={form.skills} onChange={(e)=>setForm({...form,skills:e.target.value})} placeholder="React, SQL, Python..."/></label>
        <label>Interests<input value={form.interests} onChange={(e)=>setForm({...form,interests:e.target.value})}/></label>
        <label>LinkedIn<input value={form.linkedin} onChange={(e)=>setForm({...form,linkedin:e.target.value})}/></label>
        <label>GitHub<input value={form.github} onChange={(e)=>setForm({...form,github:e.target.value})}/></label>
        <label>Portfolio<input value={form.portfolio} onChange={(e)=>setForm({...form,portfolio:e.target.value})}/></label>
        <label>Bio<textarea value={form.bio} onChange={(e)=>setForm({...form,bio:e.target.value})}/></label>
        <label>Year
          <select value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })}>
            {['1st year', '2nd year', '3rd year', '4th year', 'Graduate'].map((y) => <option key={y}>{y}</option>)}
          </select>
        </label>
        {error && <p className="error">{error}</p>}
        {message && <p className="success">{message}</p>}
        <button className="btn primary" type="submit">Save profile</button>
      </form>
    </div>
  )
}

/* ---------- Career Coach ---------- */
function CoachCard({ go, compact = false, syncTick }) {
  const [coach, setCoach] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api('/coach').then(setCoach).catch((e) => setError(e.message))
  }, [syncTick])

  if (error) return <p className="error">{error}</p>
  if (!coach) return <div className="coach-loading">Building your career plan...</div>

  const action = coach.action
  return (
    <section className={'coach-card' + (compact ? ' coach-card-compact' : '')}>
      <div className="coach-head">
        <div>
          <span className="coach-kicker">CAREER COACH</span>
          <h2>What should you do next?</h2>
          <p className="muted">CareerReady connects your assessment, target role, roadmap and applications to one next-best action.</p>
        </div>
        {!compact && coach.target && <span className="coach-target">Target: {coach.target.title}</span>}
      </div>

      <div className="next-action">
        <div className="next-icon">→</div>
        <div className="next-copy">
          <span className="eyebrow">YOUR NEXT BEST ACTION</span>
          <h3>{action.label || action.title}</h3>
          <p>{action.reason || action.detail}</p>
          <button className="btn primary" onClick={() => go(action.tab)}>{action.cta || 'Open now'}</button>
        </div>
      </div>

      {!compact && (
        <>
          <div className="coach-readiness-banner">
            <div>
              <span className="eyebrow">JOB-READINESS INDEX</span>
              <strong>{coach.jobReadiness}%</strong>
              <p>Built from assessment strength, roadmap progress and career evidence.</p>
            </div>
            <div className="mini-metrics">
              <span><b>{coach.roadmap.percent}%</b> roadmap</span>
              <span><b>{coach.evidenceScore}%</b> evidence</span>
            </div>
          </div>

          {coach.plan?.length > 0 && (
            <div className="coach-plan">
              <div className="panel-title"><strong>Your job-ready plan</strong><span>Prioritized for you</span></div>
              <div className="plan-list">
                {coach.plan.map((item) => (
                  <button className="plan-item" key={item.priority} onClick={() => go(item.tab)}>
                    <span className="plan-number">{item.priority}</span>
                    <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                    <b>→</b>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="coach-grid">
            <div className="coach-panel">
              <div className="panel-title"><strong>Skill gaps</strong><span>{coach.gaps.length} to work on</span></div>
              {coach.gaps.length === 0 ? (
                <p className="muted">No major role-specific gaps right now. Keep building evidence through projects and applications.</p>
              ) : coach.gaps.map((g) => (
                <div className="gap-row" key={g.category}>
                  <div><strong>{g.category}</strong><span>{g.score}% current · {g.importance}% role weight</span></div>
                  <div className="gap-track"><div className="gap-fill" style={{ width: g.score + '%' }} /></div>
                </div>
              ))}
            </div>
            <div className="coach-panel">
              <div className="panel-title"><strong>Readiness</strong><span>{coach.readiness.filter(c => c.taken).length}/3 assessed</span></div>
              {coach.readiness.map((c) => (
                <div className="coach-stat-row" key={c.category}>
                  <span>{c.category}</span><strong>{c.taken ? c.percent + '%' : 'Not taken'}</strong>
                </div>
              ))}
              <div className="coach-progress"><span>Roadmap</span><strong>{coach.roadmap.done}/{coach.roadmap.total}</strong></div>
            </div>
          </div>
          {coach.opportunities.length > 0 && (
            <div className="coach-opportunities">
              <div className="panel-title"><strong>Strong opportunity matches</strong><button className="link" onClick={() => go('internships')}>View all</button></div>
              <div className="coach-opportunity-list">
                {coach.opportunities.map((o) => (
                  <button className="coach-opportunity" key={o.id} onClick={() => go('internships')}>
                    <span><strong>{o.title}</strong><small>{o.company} · {o.mode}</small></span>
                    <b>{o.match}% match</b>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Coach({ go, syncTick }) {
  return (
    <div>
      <div className="page-heading">
        <div>
          <h2>Your personal career coach</h2>
          <p className="muted">A connected plan built from your readiness, target role, roadmap, opportunities and applications.</p>
        </div>
      </div>
      <CoachCard go={go} syncTick={syncTick} />
    </div>
  )
}

/* ---------- Dashboard ---------- */
function Dashboard({ user, go, syncTick }) {
  const [data, setData] = useState(null)
  const [insights, setInsights] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api('/readiness'), api('/insights')])
      .then(([readiness, stats]) => { setData(readiness); setInsights(stats) })
      .catch((e) => setError(e.message))
  }, [syncTick])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading your readiness score...</p>

  return (
    <div>
      <h2>Hi {user.name.split(' ')[0]}, here is where you stand</h2>
      <div className="hero">
        <ScoreRing score={data.score} />
        <div>
          <p className="level">{data.level}</p>
          <p className="muted">
            Score = 70% latest assessments, 15% saved internships (up to 3) and 15% roadmap progress.
          </p>
          <div className="actions">
            <button className="btn primary" onClick={() => go('assessment')}>Take an assessment</button>
            <button className="btn" onClick={() => go('paths')}>Explore career paths</button>
          </div>
        </div>
      </div>

      <CoachCard go={go} compact syncTick={syncTick} />

      {insights && (
        <div className="dashboard-stats">
          <div><strong>{insights.saved}</strong><span>Saved internships</span></div>
          <div><strong>{insights.totalApplications}</strong><span>Tracked applications</span></div>
          <div><strong>{insights.pipelineActive}</strong><span>Active opportunities</span></div>
          <div><strong>{insights.roadmap.done}/{insights.roadmap.total || 0}</strong><span>Roadmap steps</span></div>
        </div>
      )}

      <h3>Your target role</h3>
      {data.goal ? (
        <div className="goal-card">
          <div>
            <strong>{data.goal.title}</strong>
            <p className="muted">{data.goal.done} of {data.goal.total} roadmap steps done</p>
          </div>
          <div className="bar-track goal-bar">
            <div className="bar-fill" style={{ width: (data.goal.done / data.goal.total) * 100 + '%' }} />
          </div>
          <button className="btn" onClick={() => go('paths')}>Open roadmap</button>
        </div>
      ) : (
        <p className="muted">
          You have not chosen a role yet. <button className="link" onClick={() => go('paths')}>Pick one now</button>
        </p>
      )}

      <h3>Skill areas</h3>
      <div className="bars">
        {data.categories.map((c) => (
          <div key={c.category} className="bar-row">
            <span className="bar-label">{c.category}</span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: c.percent + '%' }} />
            </div>
            <span className="bar-value">{c.taken ? c.percent + '%' : 'Not taken'}</span>
          </div>
        ))}
      </div>

      <h3>What to do next</h3>
      <ul className="recs">
        {data.recommendations.map((r) => (
          <li key={r.category}>
            <strong>{r.category}</strong>
            <p>{r.message}</p>
            {r.resources.length > 0 && (
              <p className="resources">
                Free resources:{' '}
                {r.resources.map((res, i) => (
                  <span key={res.url}>
                    <a href={res.url} target="_blank" rel="noreferrer">{res.name}</a>
                    {i < r.resources.length - 1 ? ', ' : ''}
                  </span>
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------- Career paths ---------- */
function RoleDetail({ slug, back, jobsTick, syncTick }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api('/roles/' + slug).then(setData).catch((e) => setError(e.message))
  }, [slug, jobsTick, syncTick])

  async function toggle(id) {
    try {
      const r = await api(`/steps/${id}/toggle`, { method: 'POST' })
      setData((d) => ({ ...d, steps: d.steps.map((s) => (s.id === id ? { ...s, done: r.done } : s)) }))
    } catch (e) {
      setError(e.message)
    }
  }

  async function choose() {
    try {
      await api('/goal', { method: 'POST', body: { slug } })
      setData((d) => ({ ...d, role: { ...d.role, isGoal: true } }))
    } catch (e) {
      setError(e.message)
    }
  }

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading roadmap...</p>

  const { role, steps, jobs } = data
  const done = steps.filter((s) => s.done).length

  return (
    <div>
      <button className="link" onClick={back}>Back to all roles</button>
      <h2 className="role-title">{role.title}</h2>
      <p>{role.summary}</p>
      <p className="muted">
        Best for: {role.branch === 'All' ? 'any branch' : role.branch} | Your match: {role.fit}%
      </p>
      {role.gaps.length > 0 && (
        <p className="notice">
          Work on {role.gaps.join(' and ')} first. Your latest assessment score is low for this role.
        </p>
      )}
      <div className="actions">
        {role.isGoal ? (
          <span className="chip chosen-chip">This is your target role</span>
        ) : (
          <button className="btn primary" onClick={choose}>Make this my target role</button>
        )}
      </div>

      <h3>Roadmap: {done} of {steps.length} steps done</h3>
      <div className="bar-track goal-bar">
        <div className="bar-fill" style={{ width: (done / steps.length) * 100 + '%' }} />
      </div>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.id} className={s.done ? 'step done' : 'step'}>
            <label className="step-check">
              <input type="checkbox" checked={s.done} onChange={() => toggle(s.id)} />
              <span>
                <strong>{s.title}</strong>
                <span className="step-desc">{s.description}</span>
                <a href={s.resource_url} target="_blank" rel="noreferrer">Free resource: {s.resource_name}</a>
              </span>
            </label>
          </li>
        ))}
      </ol>

      <h3>Live openings that match this role</h3>
      {jobs.length === 0 ? (
        <p className="muted">
          No matching live jobs right now. This list updates by itself when new jobs arrive. Check the Internships tab for branch internships.
        </p>
      ) : (
        <div className="job-list">
          {jobs.map((j) => (
            <JobCard key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  )
}

function CareerPaths({ jobsTick, syncTick }) {
  const [roles, setRoles] = useState([])
  const [anyTaken, setAnyTaken] = useState(true)
  const [slug, setSlug] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api('/roles')
      .then((d) => {
        setRoles(d.roles)
        setAnyTaken(d.anyTaken)
      })
      .catch((e) => setError(e.message))
  }, [slug, syncTick])

  if (slug) return <RoleDetail slug={slug} back={() => setSlug(null)} jobsTick={jobsTick} syncTick={syncTick} />

  return (
    <div>
      <h2>Choose your career path</h2>
      <p className="muted">
        Roles are ranked by how well your assessment scores and branch match them. Open one to see the full roadmap.
      </p>
      {!anyTaken && (
        <p className="notice">Take the skill assessment first. Until then the match percentages only reflect your branch.</p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="role-grid">
        {roles.map((r) => (
          <article key={r.slug} className={'role-card' + (r.isGoal ? ' is-goal' : '')}>
            <div className="role-top">
              <h3>{r.title}</h3>
              <span className="match">{r.fit}% match</span>
            </div>
            <p>{r.summary}</p>
            <p className="meta">
              Best for {r.branch === 'All' ? 'any branch' : r.branch}
              {r.total > 0 && ` | ${r.done}/${r.total} steps done`}
            </p>
            {r.isGoal && <span className="chip chosen-chip">Your target role</span>}
            <button className="btn" onClick={() => setSlug(r.slug)}>View roadmap</button>
          </article>
        ))}
      </div>
    </div>
  )
}

/* ---------- Assessment ---------- */
function Assessment({ go }) {
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [results, setResults] = useState(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api('/questions').then((d) => setQuestions(d.questions)).catch((e) => setError(e.message))
  }, [])

  const answered = Object.keys(answers).length
  const categories = [...new Set(questions.map((q) => q.category))]

  async function submit() {
    setError('')
    setSubmitting(true)
    try {
      const data = await api('/assessment', { method: 'POST', body: { answers } })
      setResults(data.results)
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (results) {
    return (
      <div>
        <h2>Your results</h2>
        <div className="result-grid">
          {results.map((r) => (
            <div key={r.category} className="result-card">
              <p className="result-cat">{r.category}</p>
              <p className="result-score">{r.score} / {r.total}</p>
              <p className="muted">{r.percent}%</p>
            </div>
          ))}
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => go('paths')}>See roles that match me</button>
          <button className="btn" onClick={() => go('dashboard')}>Go to dashboard</button>
          <button
            className="btn"
            onClick={() => {
              setResults(null)
              setAnswers({})
            }}
          >
            Retake
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2>Skill assessment</h2>
      <p className="muted">{questions.length} questions across {categories.length} areas. Answer all of them to submit.</p>
      {error && <p className="error">{error}</p>}

      {categories.map((cat) => (
        <section key={cat} className="q-section">
          <h3>{cat}</h3>
          {questions
            .filter((q) => q.category === cat)
            .map((q, index) => (
              <fieldset key={q.id} className="question">
                <legend>{index + 1}. {q.text}</legend>
                {q.options.map((opt, i) => (
                  <label key={i} className={'option' + (answers[q.id] === i ? ' chosen' : '')}>
                    <input
                      type="radio"
                      name={'q' + q.id}
                      checked={answers[q.id] === i}
                      onChange={() => setAnswers({ ...answers, [q.id]: i })}
                    />
                    {opt}
                  </label>
                ))}
              </fieldset>
            ))}
        </section>
      ))}

      <div className="submit-bar">
        <span>{answered} of {questions.length} answered</span>
        <button className="btn primary" onClick={submit} disabled={answered < questions.length || submitting}>
          {submitting ? 'Submitting...' : 'Submit answers'}
        </button>
      </div>
    </div>
  )
}

/* ---------- Live jobs ---------- */
function LiveJobs({ jobsTick }) {
  const [jobs, setJobs] = useState([])
  const [status, setStatus] = useState({})
  const [search, setSearch] = useState('')
  const [remoteOnly, setRemoteOnly] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const query = `?search=${encodeURIComponent(search)}${remoteOnly ? '&remote=1' : ''}`
    api('/live-jobs' + query)
      .then((d) => {
        setJobs(d.jobs)
        setStatus(d.status)
      })
      .catch((e) => setError(e.message))
  }, [search, remoteOnly, jobsTick])

  async function refresh() {
    setChecking(true)
    setMessage('')
    try {
      const d = await api('/live-jobs/refresh', { method: 'POST' })
      setMessage(d.message)
    } catch (e) {
      setError(e.message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div>
      <h2>Live jobs</h2>
      <p className="muted">
        Collected from free public job feeds. New jobs appear here by themselves, without refreshing the page.
      </p>
      <p className="feed-status">
        {Object.entries(status).map(([name, s]) => (
          <span key={name} className={'feed ' + (s.ok === false ? 'bad' : 's' + (s.ok ? 'ok' : 'wait'))}>
            {name}: {s.ok === false ? 'unavailable' : s.ok ? 'checked ' + timeAgo(s.lastRun) : 'waiting'}
          </span>
        ))}
      </p>
      <div className="filters live-filters">
        <input
          placeholder="Search jobs, for example react or python"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search live jobs"
        />
        <label className="check">
          <input type="checkbox" checked={remoteOnly} onChange={(e) => setRemoteOnly(e.target.checked)} />
          Remote only
        </label>
        <button className="btn" onClick={refresh} disabled={checking}>
          {checking ? 'Checking...' : 'Check for new jobs'}
        </button>
      </div>
      {message && <p className="notice">{message}</p>}
      {error && <p className="error">{error}</p>}
      {jobs.length === 0 && <p className="muted">No jobs loaded yet. The server loads them when it starts, so try again in a minute.</p>}
      <div className="job-list">
        {jobs.map((j) => (
          <JobCard key={j.id} job={j} />
        ))}
      </div>
      <p className="muted small-print">
        Jobs come from Arbeitnow (mostly Europe and remote roles) and Remotive (remote roles, shown with a delay). Always
        apply on the original site.
      </p>
    </div>
  )
}

/* ---------- Internships ---------- */
function Internships({ user, syncTick }) {
  const [list, setList] = useState([])
  const [search, setSearch] = useState('')
  const [branch, setBranch] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const query = `?search=${encodeURIComponent(search)}&branch=${encodeURIComponent(branch)}`
    api('/internships' + query)
      .then((d) => setList(d.internships))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [search, branch, syncTick])

  async function toggleSave(id) {
    try {
      const data = await api(`/internships/${id}/save`, { method: 'POST' })
      setList((current) => current.map((i) => (i.id === id ? { ...i, saved: data.saved } : i)))
    } catch (e) {
      setError(e.message)
    }
  }

  async function trackApplication(id, status) {
    try {
      await api(`/internships/${id}/application`, { method: 'POST', body: { status } })
      setList((current) => current.map((i) => (i.id === id ? { ...i, application_status: status } : i)))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div>
      <h2>Internships</h2>
      <p className="muted">Sample listings stored in the project database, covering every branch.</p>
      <div className="filters">
        <input
          placeholder="Search by title, company or skill"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search internships"
        />
        <select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Filter by branch">
          <option value="">All branches</option>
          <option value={user.branch}>My branch ({user.branch})</option>
          {['CSE', 'ECE', 'EEE', 'Mechanical', 'Civil']
            .filter((b) => b !== user.branch)
            .map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Loading...</p>}
      {!loading && list.length === 0 && <p className="muted">No internships match. Try a different search.</p>}

      <div className="job-list">
        {list.map((i) => (
          <article key={i.id} className="job">
            <div className="job-head">
              <div>
                <h3>{i.title}</h3>
                <p className="company">{i.company} | {i.location} | {i.mode}</p>
              </div>
              <button className={'btn' + (i.saved ? ' saved' : '')} onClick={() => toggleSave(i.id)}>
                {i.saved ? 'Saved' : 'Save'}
              </button>
            </div>
            <p>{i.description}</p>
            <p className="meta">
              {i.stipend} | Apply by {i.deadline} | Branch: {i.branch}
            </p>
            <p className="skills">
              {i.skills.split(',').map((s) => (
                <span key={s} className="chip">{s.trim()}</span>
              ))}
            </p>
            <div className="job-footer">
              <label className="track-control">
                <span>Application</span>
                <select
                  value={i.application_status || 'Not tracked'}
                  onChange={(e) => e.target.value !== 'Not tracked' && trackApplication(i.id, e.target.value)}
                  aria-label={`Track ${i.title}`}
                >
                  <option>Not tracked</option>
                  {['Interested', 'Applied', 'Interview', 'Offer', 'Rejected', 'Withdrawn'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              {i.application_status && <span className="muted">Tracked in Applications</span>}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

/* ---------- Resume Intelligence ---------- */
function ResumeIntelligence({ go, syncTick }) {
  const [data, setData] = useState(null)
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [aiReview, setAiReview] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)

  useEffect(() => {
    api('/resume').then(d => { setData(d); setContent(d.content || '') }).catch(e => setError(e.message))
  }, [syncTick])

  async function save() {
    setSaving(true); setSaved(false); setError('')
    try { const d = await api('/resume', { method:'POST', body:{content} }); setData(d); setSaved(true) }
    catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  async function aiReviewResume(){ setAiBusy(true); setError(''); try{setAiReview(await api('/ai/resume-review',{method:'POST',body:{content}}))}catch(e){setError(e.message)}finally{setAiBusy(false)} }

  if (!data) return <p className="muted">Loading resume intelligence...</p>
  return (
    <div>
      <div className="page-heading">
        <div><h2>Resume Intelligence</h2><p className="muted">See how your resume aligns with your target career and which gaps to fix before applying.</p></div>
      </div>
      <div className="resume-layout">
        <section className="resume-editor panel">
          <div className="panel-title"><strong>Your resume content</strong><span>Paste text from your resume</span></div>
          <textarea value={content} onChange={e=>setContent(e.target.value)} placeholder="Paste your resume text here... Include skills, projects, internships, education and achievements." />
          <div className="resume-actions"><button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save & match'}</button><button className="btn" onClick={aiReviewResume} disabled={aiBusy||!content.trim()}>{aiBusy?'AI reviewing...':'AI deep review'}</button>{saved && <span className="success">Saved and matched.</span>}</div>
          {error && <p className="error">{error}</p>}
        </section>
        <section className="resume-score panel">
          <span className="eyebrow">RESUME MATCH</span>
          <strong className="big-score">{data.score}%</strong>
          <p className="muted">{data.target ? `Alignment with ${data.target}` : 'Choose a target role to unlock role-specific matching.'}</p>
          <div className="score-track"><div style={{width:data.score+'%'}} /></div>
          <div className="match-columns"><div><strong>{data.matched.length}</strong><span>matched keywords</span></div><div><strong>{data.missing.length}</strong><span>missing keywords</span></div></div>
        </section>
      </div>
      <div className="resume-grid">
        <section className="panel"><div className="panel-title"><strong>What is working</strong></div>{data.matched.length ? data.matched.map(x=><span className="chip" key={x}>{x}</span>) : <p className="muted">No role keywords detected yet.</p>}</section>
        <section className="panel"><div className="panel-title"><strong>What to improve</strong></div>{data.missing.length ? data.missing.map(x=><span className="chip warning" key={x}>{x}</span>) : <p className="muted">No major keyword gaps detected.</p>}</section>
      </div>
      {aiReview&&<section className="panel resume-suggestions"><div className="panel-title"><strong>AI recruiter review · {aiReview.score}/100</strong><span>{aiReview.summary}</span></div>{aiReview.missing_skills?.length>0&&<p><strong>Missing skills:</strong> {aiReview.missing_skills.join(', ')}</p>}{aiReview.project_ideas?.length>0&&<><h4>Projects to close your gaps</h4>{aiReview.project_ideas.map(x=><div className="suggestion" key={x.title}><span>↗</span><p><strong>{x.title}</strong><br/>{x.why}<br/><small>Skills: {x.skills?.join(', ')}</small></p></div>)}</>}</section>}<section className="panel resume-suggestions"><div className="panel-title"><strong>Rule-based personalized improvements</strong><span>Prioritized before applying</span></div>{data.suggestions.map((x,i)=><div className="suggestion" key={i}><span>{i+1}</span><p>{x}</p></div>)}</section>
      <section className="panel"><div className="panel-title"><strong>Best-fit internships</strong><button className="link" onClick={()=>go('internships')}>View all</button></div><JobMatchList go={go}/></section>
    </div>
  )
}

function JobMatchList({ go }) {
  const [data,setData]=useState(null)
  useEffect(()=>{api('/job-matches').then(setData).catch(()=>setData({matches:[]}))},[])
  if (!data) return <p className="muted">Finding your strongest matches...</p>
  if (!data.matches.length) return <p className="muted">Complete your resume and target role to see matches.</p>
  return <div className="match-list">{data.matches.map(m=><button className="match-card" key={m.id} onClick={()=>go('internships')}><span><strong>{m.title}</strong><small>{m.company} · {m.location} · {m.mode}</small><small>Matches: {m.matchedSkills.join(', ') || 'Profile signals'}{m.missingSkills.length ? ` · Missing: ${m.missingSkills.join(', ')}` : ''}</small></span><b>{m.match}%</b></button>)}</div>
}

/* ---------- App shell ---------- */
export default function App() {
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(Boolean(getToken()))
  const [authView, setAuthView] = useState('login')
  const [tab, setTab] = useState('dashboard')
  const [jobsTick, setJobsTick] = useState(0) // changes when new live jobs arrive
  const [syncTick, setSyncTick] = useState(0) // changes when your data changes in another tab
  const [online, setOnline] = useState(0)
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!getToken()) return
    api('/me')
      .then((d) => setUser(d.user))
      .catch(() => clearToken())
      .finally(() => setChecking(false))
  }, [])

  // One live connection to the server. It pushes updates the moment they happen.
  useEffect(() => {
    if (!user) return
    const source = new EventSource('/api/events?token=' + encodeURIComponent(getToken()))
    source.addEventListener('jobs', (e) => {
      const { added } = JSON.parse(e.data)
      setJobsTick((t) => t + 1)
      setToast(`${added} new job${added === 1 ? '' : 's'} just arrived`)
    })
    source.addEventListener('sync', () => setSyncTick((t) => t + 1))
    source.addEventListener('profile', (e) => setUser(JSON.parse(e.data).user))
    source.addEventListener('online', (e) => setOnline(JSON.parse(e.data).count))
    return () => source.close()
  }, [user])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  function updateUser(nextUser) {
    setUser(nextUser)
    setSyncTick((t) => t + 1)
  }

  async function logout() {
    try {
      await api('/logout', { method: 'POST' })
    } catch {
      // ignore: we are logging out anyway
    }
    clearToken()
    setUser(null)
    setTab('dashboard')
    setAuthView('login')
  }

  if (checking) return <p className="muted center">Loading...</p>

  if (!user) {
    return authView === 'login' ? (
      <Login onAuth={setUser} switchToSignup={() => setAuthView('signup')} />
    ) : (
      <Signup onAuth={setUser} switchToLogin={() => setAuthView('login')} />
    )
  }

  const tabs = [
    ['dashboard', 'Dashboard'],
    ['coach', 'Career Coach'],
    ['resume', 'Resume & Match'],
    ['paths', 'Career paths'],
    ['assessment', 'Assessment'],
    ['jobs', 'Live jobs'],
    ['internships', 'Internships'],
    ['applications', 'Applications'],
    ['interview', 'Interview prep'],
    ['community', 'Peer Community'],
    ['mentors', user.role === 'admin' ? 'Admin Panel' : user.role === 'mentor' ? 'Mentor Workspace' : 'Find a Mentor'],
    ['profile', 'Profile'],
  ]

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">CareerReady</span>
        <nav>
          {tabs.map(([key, label]) => (
            <button key={key} className={'tab' + (tab === key ? ' active' : '')} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="who">
          {online > 0 && (
            <span className="online" title="Students using CareerReady right now">
              <span className="dot" /> {online} online
            </span>
          )}
          <span>{user.name} ({user.branch}, {user.year})</span>
          <button className="btn small" onClick={logout}>Log out</button>
        </div>
      </header>
      <main className="content">
        {tab === 'dashboard' && <Dashboard user={user} go={setTab} syncTick={syncTick} />}
        {tab === 'coach' && <Coach go={setTab} syncTick={syncTick} />}
        {tab === 'resume' && <ResumeIntelligence go={setTab} syncTick={syncTick} />}
        {tab === 'paths' && <CareerPaths jobsTick={jobsTick} syncTick={syncTick} />}
        {tab === 'assessment' && <Assessment go={setTab} />}
        {tab === 'jobs' && <LiveJobs jobsTick={jobsTick} />}
        {tab === 'internships' && <Internships user={user} syncTick={syncTick} />}
        {tab === 'applications' && <Applications syncTick={syncTick} />}
        {tab === 'interview' && <InterviewPrep />}
        {tab === 'community' && <Community />}
        {tab === 'mentors' && <MentorHub user={user} />}
        {tab === 'profile' && <Profile user={user} onUpdate={updateUser} />}
      </main>
      {toast && (
        <button className="toast" onClick={() => { setTab('jobs'); setToast('') }}>
          {toast}. Click to view.
        </button>
      )}
    </div>
  )
}
