import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

/* ---------- small helpers ---------- */
const when = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}
const isPast = (iso) => new Date(iso).getTime() < Date.now()
const safeUrl = (url) => (/^https?:\/\//i.test(url || '') ? url : '')

function Note({ text, error }) {
  return text ? <p className={error ? 'error' : 'success'}>{text}</p> : null
}

function Stars({ value, count }) {
  if (!count) return <span className="muted">New mentor</span>
  return <span className="stars">{'★'.repeat(Math.round(value))}{'☆'.repeat(5 - Math.round(value))} <small>{value} ({count})</small></span>
}

function Modal({ onClose, children }) {
  return (
    <div className="modal-backdrop">
      <div className="panel modal">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        {children}
      </div>
    </div>
  )
}

/* ---------- email verification banner ---------- */
function VerifyBanner() {
  const [account, setAccount] = useState(null)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    api('/account').then(setAccount).catch(() => {})
  }, [])
  if (!account || account.emailVerified) return null
  return (
    <div className="panel notice-bar">
      <strong>Verify your email.</strong> Mentor features unlock once you confirm the link we emailed you.{' '}
      <button
        className="btn small"
        onClick={async () => {
          try {
            await api('/verify-email/resend', { method: 'POST' })
            setMsg('Verification email sent.')
          } catch (e) {
            setMsg(e.message)
          }
        }}
      >
        Resend email
      </button>{' '}
      <span className="muted">{msg}</span>
    </div>
  )
}

/* ---------- mentor application ---------- */
function MentorApplication() {
  const [form, setForm] = useState({ headline: '', expertise: '', experienceYears: 0, company: '', linkedin: '', hourlyRate: 0, availability: 'Weekday evenings', inviteCode: '' })
  const [msg, setMsg] = useState('')
  const [bad, setBad] = useState(false)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  async function submit(e) {
    e.preventDefault()
    setMsg('')
    try {
      const d = await api('/mentor/apply', { method: 'POST', body: form })
      setBad(false)
      setMsg(d.message)
    } catch (err) {
      setBad(true)
      setMsg(err.message)
    }
  }

  return (
    <form className="panel mentor-form" onSubmit={submit}>
      <div className="panel-title"><strong>Become a CareerReady mentor</strong><span>Verified before students can see you</span></div>
      <p className="muted">Working engineers, alumni and faculty can mentor students. We check your professional profile first. Invited by an administrator? Add your invite code.</p>
      <div className="row">
        <label>Headline<input value={form.headline} onChange={set('headline')} placeholder="Backend engineer at Acme" required /></label>
        <label>Expertise<input value={form.expertise} onChange={set('expertise')} placeholder="Node.js, system design, interviews" required /></label>
      </div>
      <div className="row">
        <label>Company<input value={form.company} onChange={set('company')} /></label>
        <label>Years of experience<input type="number" min="0" max="60" value={form.experienceYears} onChange={set('experienceYears')} /></label>
      </div>
      <div className="row">
        <label>LinkedIn profile URL<input type="url" value={form.linkedin} onChange={set('linkedin')} placeholder="https://www.linkedin.com/in/..." required /></label>
        <label>Availability<input value={form.availability} onChange={set('availability')} /></label>
      </div>
      <label>Invite code (optional)<input value={form.inviteCode} onChange={set('inviteCode')} /></label>
      <button className="btn primary" type="submit">Submit application</button>
      <Note text={msg} error={bad} />
    </form>
  )
}

/* =====================================================================
   STUDENT VIEW
   ===================================================================== */
function BookingModal({ mentor, onClose, onBooked }) {
  const [slots, setSlots] = useState(null)
  const [topic, setTopic] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api(`/mentors/${mentor.mentor_id}/slots`).then((d) => setSlots(d.slots)).catch((e) => setMsg(e.message))
  }, [mentor.mentor_id])

  async function book(slot) {
    setMsg('')
    try {
      await api(`/slots/${slot.id}/book`, { method: 'POST', body: { topic } })
      onBooked()
      onClose()
    } catch (e) {
      setMsg(e.message)
    }
  }

  return (
    <Modal onClose={onClose}>
      <h3>Book {mentor.name}</h3>
      <input placeholder="What do you want to work on? (e.g. resume review)" value={topic} onChange={(e) => setTopic(e.target.value)} />
      {slots === null && <p className="muted">Loading times…</p>}
      {slots && !slots.length && <p className="muted">This mentor has no open times right now. Check back soon.</p>}
      <div className="slot-grid">
        {(slots || []).map((s) => (
          <button className="btn" key={s.id} onClick={() => book(s)}>{when(s.starts_at)}</button>
        ))}
      </div>
      <Note text={msg} error />
      <p className="muted">A private video room link is created automatically and emailed to you both.</p>
    </Modal>
  )
}

function ReviewForm({ session, onDone }) {
  const [rating, setRating] = useState(5)
  const [comment, setComment] = useState('')
  const [msg, setMsg] = useState('')
  async function submit() {
    try {
      await api(`/sessions/${session.id}/review`, { method: 'POST', body: { rating, comment } })
      onDone()
    } catch (e) {
      setMsg(e.message)
    }
  }
  return (
    <div className="review-box">
      <strong>Rate this session</strong>
      <select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
        {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n > 1 ? 's' : ''}</option>)}
      </select>
      <input placeholder="Optional comment for future students" value={comment} onChange={(e) => setComment(e.target.value)} />
      <button className="btn small primary" onClick={submit}>Submit rating</button>
      <Note text={msg} error />
    </div>
  )
}

function MyMentorship({ mine, reload, goFind }) {
  const [booking, setBooking] = useState(null)
  const [msg, setMsg] = useState('')
  const upcoming = mine.sessions.filter((s) => s.status === 'scheduled' && !isPast(s.ends_at))
  const past = mine.sessions.filter((s) => s.status !== 'cancelled' && !upcoming.includes(s))

  async function act(path, options, okText) {
    setMsg('')
    try {
      await api(path, options)
      if (okText) setMsg(okText)
      reload()
    } catch (e) {
      setMsg(e.message)
    }
  }

  return (
    <div>
      <Note text={msg} />
      <section className="panel">
        <div className="panel-title"><strong>Your mentors</strong><span>Requests and connections</span></div>
        {!mine.connections.length && <p className="muted">You have not requested a mentor yet. <button className="link" onClick={goFind}>Find a mentor</button></p>}
        {mine.connections.map((c) => (
          <div className="list-row" key={c.id}>
            <span><strong>{c.name}</strong><small>{c.headline}{c.company ? ' · ' + c.company : ''}</small></span>
            <span className="row-actions">
              <b className={'pill pill-' + c.status}>{c.status}</b>
              {c.status === 'accepted' && <button className="btn small primary" onClick={() => setBooking(c)}>Book a session</button>}
            </span>
          </div>
        ))}
      </section>

      <div className="mentor-work-grid">
        <section className="panel">
          <div className="panel-title"><strong>Upcoming sessions</strong><span>Video link opens in a new tab</span></div>
          {!upcoming.length && <p className="muted">Nothing booked yet.</p>}
          {upcoming.map((s) => (
            <div className="list-row" key={s.id}>
              <span><strong>{s.topic || 'Mentorship session'}</strong><small>{s.mentor_name} · {when(s.starts_at)}</small></span>
              <span className="row-actions">
                {safeUrl(s.meeting_url) && <a className="btn small primary" href={s.meeting_url} target="_blank" rel="noopener noreferrer">Join</a>}
                <button className="btn small danger" onClick={() => act(`/sessions/${s.id}/cancel`, { method: 'POST' }, 'Session cancelled.')}>Cancel</button>
              </span>
            </div>
          ))}
        </section>

        <section className="panel">
          <div className="panel-title"><strong>Tasks from your mentor</strong><span>Accountability</span></div>
          {!mine.tasks.length && <p className="muted">No tasks assigned yet.</p>}
          {mine.tasks.map((t) => (
            <div className="list-row" key={t.id}>
              <span><strong>{t.title}</strong><small>{t.description}{t.due_date ? ' · due ' + t.due_date : ''}</small></span>
              {t.status === 'completed' ? <b className="pill pill-accepted">done</b> : <button className="btn small" onClick={() => act(`/mentor/tasks/${t.id}/complete`, { method: 'POST' })}>Mark done</button>}
            </div>
          ))}
        </section>
      </div>

      {past.length > 0 && (
        <section className="panel">
          <div className="panel-title"><strong>Past sessions</strong><span>Rate them to help other students</span></div>
          {past.map((s) => (
            <div key={s.id} className="list-row column">
              <span><strong>{s.topic || 'Mentorship session'}</strong><small>{s.mentor_name} · {when(s.starts_at)}</small></span>
              {s.my_rating ? <span className="stars">{'★'.repeat(s.my_rating)} <small>your rating</small></span> : <ReviewForm session={s} onDone={reload} />}
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-title"><strong>Mentor feedback</strong><span>Scored evaluations</span></div>
        {!mine.evaluations.length && <p className="muted">Evaluations from your mentor will appear here.</p>}
        {mine.evaluations.map((ev) => (
          <div className="eval-card" key={ev.id}>
            <strong>{ev.category} · {ev.score}/100</strong> <small className="muted">{ev.mentor_name} · {when(ev.created_at)}</small>
            {ev.strengths && <p><b>Strengths:</b> {ev.strengths}</p>}
            {ev.improvements && <p><b>To improve:</b> {ev.improvements}</p>}
            {ev.action_plan && <p><b>Action plan:</b> {ev.action_plan}</p>}
          </div>
        ))}
      </section>

      {mine.resources.length > 0 && (
        <section className="panel">
          <div className="panel-title"><strong>Resources from your mentors</strong><span>Curated links</span></div>
          {mine.resources.map((r) => (
            <div className="list-row" key={r.id}>
              <span><strong>{safeUrl(r.url) ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a> : r.title}</strong><small>{r.description} · {r.mentor_name}</small></span>
            </div>
          ))}
        </section>
      )}

      {booking && <BookingModal mentor={booking} onClose={() => setBooking(null)} onBooked={reload} />}
    </div>
  )
}

function FindMentor({ mentors, mine, reload }) {
  const [selected, setSelected] = useState(null)
  const [reviews, setReviews] = useState([])
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState('')
  const statusOf = Object.fromEntries(mine.connections.map((c) => [c.mentor_id, c.status]))

  async function open(m) {
    setSelected(m)
    setMessage('')
    setStatus('')
    setReviews([])
    api(`/mentors/${m.id}/reviews`).then((d) => setReviews(d.reviews)).catch(() => {})
  }

  async function send() {
    try {
      await api(`/mentors/${selected.id}/connect`, { method: 'POST', body: { message } })
      setStatus('Request sent. You will be notified when the mentor responds.')
      reload()
    } catch (e) {
      setStatus(e.message)
    }
  }

  return (
    <div>
      <div className="mentor-grid">
        {mentors.map((m) => (
          <article className="mentor-card" key={m.id}>
            <div className="mentor-avatar">{m.name.slice(0, 1)}</div>
            <h3>{m.name}</h3>
            <p className="mentor-headline">{m.headline}</p>
            <p className="muted">{m.expertise}</p>
            <p className="muted">{m.experience_years} yrs · {m.company || 'Independent'}</p>
            <Stars value={m.avg_rating} count={m.review_count} />
            <p className="muted">{m.open_slots ? `${m.open_slots} open times` : 'No open times yet'}{m.sessions_done ? ` · ${m.sessions_done} sessions` : ''}</p>
            {statusOf[m.id] ? <b className={'pill pill-' + statusOf[m.id]}>{statusOf[m.id]}</b> : <button className="btn primary" onClick={() => open(m)}>Request mentorship</button>}
          </article>
        ))}
      </div>
      {!mentors.length && <div className="panel"><p>No verified mentors are available yet. If you are a working engineer, you can apply below.</p></div>}

      {selected && (
        <Modal onClose={() => setSelected(null)}>
          <h3>Request {selected.name}</h3>
          <p className="muted">{selected.headline}</p>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What do you want this mentor to help you achieve?" />
          <button className="btn primary" onClick={send}>Send request</button>
          <Note text={status} error={!status.startsWith('Request sent')} />
          {reviews.length > 0 && (
            <div>
              <strong>What students say</strong>
              {reviews.map((r, i) => <p key={i} className="muted">{'★'.repeat(r.rating)} {r.comment || ''} <small>— {r.name}</small></p>)}
            </div>
          )}
        </Modal>
      )}
      <MentorApplication />
    </div>
  )
}

function StudentView() {
  const [mentors, setMentors] = useState([])
  const [mine, setMine] = useState(null)
  const [tab, setTab] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [m, my] = await Promise.all([api('/mentors'), api('/my-mentor')])
      setMentors(m.mentors)
      setMine(my)
      setTab((t) => t || (my.connections.length ? 'mine' : 'find'))
    } catch (e) {
      setError(e.message)
    }
  }, [])
  useEffect(() => { load() }, [load])

  if (error) return <div className="panel"><p className="error">{error}</p></div>
  if (!mine) return <p className="muted">Loading…</p>
  return (
    <div>
      <div className="section-heading">
        <div>
          <span className="eyebrow">HUMAN MENTORSHIP</span>
          <h2>Work with a real mentor</h2>
          <p className="muted">CareerReady gives you AI guidance. A verified human mentor adds judgement, accountability and honest feedback.</p>
        </div>
        <button className="btn small" onClick={load}>Refresh</button>
      </div>
      <VerifyBanner />
      <div className="inline-tabs">
        <button className={'tab' + (tab === 'mine' ? ' active' : '')} onClick={() => setTab('mine')}>My mentorship</button>
        <button className={'tab' + (tab === 'find' ? ' active' : '')} onClick={() => setTab('find')}>Find a mentor</button>
      </div>
      {tab === 'mine' ? <MyMentorship mine={mine} reload={load} goFind={() => setTab('find')} /> : <FindMentor mentors={mentors} mine={mine} reload={load} />}
    </div>
  )
}

/* =====================================================================
   MENTOR VIEW
   ===================================================================== */
function StudentDetail({ studentId, onClose }) {
  const [info, setInfo] = useState(null)
  const [brief, setBrief] = useState(null)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    api(`/mentor/student/${studentId}`).then(setInfo).catch((e) => setMsg(e.message))
  }, [studentId])

  async function makeBrief() {
    setMsg('Generating brief…')
    try {
      setBrief(await api(`/mentor/student/${studentId}/brief`))
      setMsg('')
    } catch (e) {
      setMsg(e.message)
    }
  }

  const list = (items) => <ul>{(items || []).map((x, i) => <li key={i}>{typeof x === 'string' ? x : JSON.stringify(x)}</li>)}</ul>

  return (
    <Modal onClose={onClose}>
      {!info && <p className="muted">{msg || 'Loading…'}</p>}
      {info && (
        <div>
          <h3>{info.student.name}</h3>
          <p className="muted">{info.student.branch} · {info.student.year}{info.student.skills ? ' · Skills: ' + info.student.skills : ''}</p>
          <div className="panel-title"><strong>Assessment evidence</strong></div>
          {!info.assessments.length && <p className="muted">No assessments taken yet.</p>}
          {info.assessments.map((a, i) => <p key={i}>{a.category}: <b>{a.score}/{a.total}</b> <small className="muted">{when(a.taken_at)}</small></p>)}
          <div className="panel-title"><strong>Resume</strong></div>
          <pre className="resume-box">{info.resume?.content ? info.resume.content.slice(0, 1500) : 'No resume saved yet.'}</pre>
          <div className="panel-title"><strong>Applications</strong></div>
          {!info.applications.length && <p className="muted">None yet.</p>}
          {info.applications.map((a) => <p key={a.id}>{a.title} · {a.company} <b className="pill">{a.status}</b></p>)}
          <button className="btn" onClick={makeBrief}>Generate AI session brief</button>
          <Note text={msg} error />
          {brief && (
            <div className="eval-card">
              <p>{brief.summary}</p>
              <b>Strengths</b>{list(brief.strengths)}
              <b>Gaps</b>{list(brief.gaps)}
              <b>Suggested focus</b>{list(brief.suggested_focus)}
              <b>Questions to ask</b>{list(brief.questions_to_ask)}
              <small className="muted">AI-generated from the student's saved data. Use your own judgement.</small>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function MentorView() {
  const [data, setData] = useState(null)
  const [slots, setSlots] = useState([])
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [detail, setDetail] = useState(null)
  const [slotForm, setSlotForm] = useState({ startsAt: '', durationMin: 45, weeks: 1 })
  const [evalForm, setEvalForm] = useState({ studentId: '', category: 'Career readiness', score: 80, strengths: '', improvements: '', actionPlan: '' })
  const [task, setTask] = useState({ studentId: '', title: '', description: '', dueDate: '' })
  const [resource, setResource] = useState({ title: '', description: '', url: '' })

  const load = useCallback(async () => {
    try {
      const [me, sl] = await Promise.all([api('/mentor/me'), api('/mentor/slots')])
      setData(me)
      setSlots(sl.slots)
    } catch (e) {
      setError(e.message)
    }
  }, [])
  useEffect(() => { load() }, [load])

  async function act(path, options, okText) {
    setMsg('')
    try {
      await api(path, options)
      setMsg(okText || 'Done.')
      load()
    } catch (e) {
      setMsg(e.message)
    }
  }

  if (error) return <div className="panel"><p className="error">{error}</p></div>
  if (!data) return <p className="muted">Loading…</p>

  const pending = data.students.filter((s) => s.status === 'pending')
  const accepted = data.students.filter((s) => s.status === 'accepted')
  const upcoming = data.sessions.filter((s) => s.status === 'scheduled')

  return (
    <div>
      <div className="section-heading">
        <div>
          <span className="eyebrow">MENTOR WORKSPACE</span>
          <h2>Mentor Command Center</h2>
          <p className="muted">Accept students, publish your availability, run sessions and leave evidence-based feedback.</p>
        </div>
        <button className="btn small" onClick={load}>Refresh</button>
      </div>
      <VerifyBanner />
      <Note text={msg} error={/not|must|only|cannot|invalid|required|sorry/i.test(msg)} />

      <div className="stats-grid">
        <div className="stat-card"><small>Pending requests</small><strong>{pending.length}</strong></div>
        <div className="stat-card"><small>Active students</small><strong>{accepted.length}</strong></div>
        <div className="stat-card"><small>Upcoming sessions</small><strong>{upcoming.length}</strong></div>
        <div className="stat-card"><small>Open slots</small><strong>{slots.filter((s) => s.status === 'open').length}</strong></div>
      </div>

      {pending.length > 0 && (
        <section className="panel">
          <div className="panel-title"><strong>Student requests</strong><span>Waiting for you</span></div>
          {pending.map((s) => (
            <div className="list-row" key={s.id}>
              <span><strong>{s.name}</strong><small>{s.branch} · {s.year}{s.message ? ' — “' + s.message + '”' : ''}</small></span>
              <span className="row-actions">
                <button className="btn small primary" onClick={() => act(`/mentor/connections/${s.id}/status`, { method: 'POST', body: { status: 'accepted' } }, 'Student accepted.')}>Accept</button>
                <button className="btn small danger" onClick={() => act(`/mentor/connections/${s.id}/status`, { method: 'POST', body: { status: 'declined' } }, 'Request declined.')}>Decline</button>
              </span>
            </div>
          ))}
        </section>
      )}

      <div className="mentor-work-grid">
        <section className="panel">
          <div className="panel-title"><strong>Your students</strong><span>Click to review evidence</span></div>
          {!accepted.length && <p className="muted">No active students yet.</p>}
          {accepted.map((s) => (
            <button className="student-row" key={s.id} onClick={() => setDetail(s.student_id)}>
              <span><strong>{s.name}</strong><small>{s.branch} · {s.year}</small></span>
              <b>Review</b>
            </button>
          ))}
        </section>

        <section className="panel">
          <div className="panel-title"><strong>Add availability</strong><span>Students book these times</span></div>
          <input type="datetime-local" value={slotForm.startsAt} onChange={(e) => setSlotForm({ ...slotForm, startsAt: e.target.value })} />
          <div className="row">
            <select value={slotForm.durationMin} onChange={(e) => setSlotForm({ ...slotForm, durationMin: e.target.value })}>
              {[30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </select>
            <select value={slotForm.weeks} onChange={(e) => setSlotForm({ ...slotForm, weeks: e.target.value })}>
              {[1, 2, 4, 8].map((w) => <option key={w} value={w}>{w === 1 ? 'Just once' : `Repeat weekly × ${w}`}</option>)}
            </select>
          </div>
          <button
            className="btn primary"
            onClick={() => {
              if (!slotForm.startsAt) return setMsg('Pick a start date and time first.')
              act('/mentor/slots', { method: 'POST', body: { ...slotForm, startsAt: new Date(slotForm.startsAt).toISOString() } }, 'Availability added.')
            }}
          >
            Add slot
          </button>
          <div className="slot-list">
            {slots.map((s) => (
              <div className="list-row" key={s.id}>
                <span><strong>{when(s.starts_at)}</strong><small>{s.status === 'booked' ? 'Booked by ' + (s.student_name || 'a student') : 'Open'}</small></span>
                {s.status === 'open' && <button className="btn small danger" onClick={() => act(`/mentor/slots/${s.id}`, { method: 'DELETE' }, 'Slot removed.')}>Remove</button>}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-title"><strong>Sessions</strong><span>Join, complete or cancel</span></div>
        {!data.sessions.length && <p className="muted">No sessions yet. They appear here when students book your slots.</p>}
        {data.sessions.map((s) => (
          <div className="list-row" key={s.id}>
            <span><strong>{s.topic || 'Mentorship session'}</strong><small>{s.student_name} · {when(s.starts_at)} · {s.status}</small></span>
            {s.status === 'scheduled' && (
              <span className="row-actions">
                {safeUrl(s.meeting_url) && <a className="btn small primary" href={s.meeting_url} target="_blank" rel="noopener noreferrer">Join</a>}
                {isPast(s.starts_at) && <button className="btn small" onClick={() => act(`/mentor/sessions/${s.id}/complete`, { method: 'POST' }, 'Marked complete.')}>Mark complete</button>}
                {!isPast(s.starts_at) && <button className="btn small danger" onClick={() => act(`/sessions/${s.id}/cancel`, { method: 'POST' }, 'Session cancelled.')}>Cancel</button>}
              </span>
            )}
          </div>
        ))}
      </section>

      <div className="mentor-work-grid">
        <section className="panel">
          <div className="panel-title"><strong>Evaluate a student</strong><span>Scored feedback</span></div>
          <select value={evalForm.studentId} onChange={(e) => setEvalForm({ ...evalForm, studentId: e.target.value })}>
            <option value="">Select student</option>
            {accepted.map((s) => <option value={s.student_id} key={s.student_id}>{s.name}</option>)}
          </select>
          <input placeholder="Category" value={evalForm.category} onChange={(e) => setEvalForm({ ...evalForm, category: e.target.value })} />
          <input type="number" min="0" max="100" value={evalForm.score} onChange={(e) => setEvalForm({ ...evalForm, score: e.target.value })} />
          <textarea placeholder="Strengths" value={evalForm.strengths} onChange={(e) => setEvalForm({ ...evalForm, strengths: e.target.value })} />
          <textarea placeholder="Improvements" value={evalForm.improvements} onChange={(e) => setEvalForm({ ...evalForm, improvements: e.target.value })} />
          <textarea placeholder="Action plan" value={evalForm.actionPlan} onChange={(e) => setEvalForm({ ...evalForm, actionPlan: e.target.value })} />
          <button className="btn primary" onClick={() => act('/mentor/evaluations', { method: 'POST', body: evalForm }, 'Evaluation saved.')}>Save evaluation</button>
        </section>

        <section className="panel">
          <div className="panel-title"><strong>Assign a task</strong><span>Accountability</span></div>
          <select value={task.studentId} onChange={(e) => setTask({ ...task, studentId: e.target.value })}>
            <option value="">Select student</option>
            {accepted.map((s) => <option value={s.student_id} key={s.student_id}>{s.name}</option>)}
          </select>
          <input placeholder="Task title" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} />
          <input type="date" value={task.dueDate} onChange={(e) => setTask({ ...task, dueDate: e.target.value })} />
          <textarea placeholder="Instructions" value={task.description} onChange={(e) => setTask({ ...task, description: e.target.value })} />
          <button className="btn primary" onClick={() => act('/mentor/tasks', { method: 'POST', body: task }, 'Task assigned.')}>Assign task</button>

          <div className="panel-title" style={{ marginTop: 18 }}><strong>Share a resource</strong><span>Visible to your students</span></div>
          <input placeholder="Title" value={resource.title} onChange={(e) => setResource({ ...resource, title: e.target.value })} />
          <input placeholder="https://…" value={resource.url} onChange={(e) => setResource({ ...resource, url: e.target.value })} />
          <input placeholder="Short description" value={resource.description} onChange={(e) => setResource({ ...resource, description: e.target.value })} />
          <button className="btn" onClick={() => act('/mentor/resources', { method: 'POST', body: resource }, 'Resource shared.')}>Share resource</button>
        </section>
      </div>

      {detail && <StudentDetail studentId={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

/* =====================================================================
   ADMIN VIEW
   ===================================================================== */
function AdminView() {
  const [d, setD] = useState(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [note, setNote] = useState({})

  const load = useCallback(async () => {
    try {
      setD(await api('/admin/overview'))
    } catch (e) {
      setError(e.message)
    }
  }, [])
  useEffect(() => { load() }, [load])

  async function act(path, options, okText) {
    setMsg('')
    try {
      const r = await api(path, options)
      setMsg(okText ? okText(r) : 'Done.')
      load()
    } catch (e) {
      setMsg(e.message)
    }
  }

  if (error) return <div className="panel"><p className="error">{error}</p></div>
  if (!d) return <p className="muted">Loading…</p>

  return (
    <div>
      <div className="section-heading">
        <div>
          <span className="eyebrow">ADMIN</span>
          <h2>Admin Panel</h2>
          <p className="muted">Verify mentors, invite people you trust and keep the community safe.</p>
        </div>
        <button className="btn small" onClick={load}>Refresh</button>
      </div>
      <Note text={msg} />
      <div className="stats-grid">
        <div className="stat-card"><small>Users</small><strong>{d.counts.users}</strong></div>
        <div className="stat-card"><small>Verified mentors</small><strong>{d.counts.mentors}</strong></div>
        <div className="stat-card"><small>Sessions booked</small><strong>{d.counts.sessions}</strong></div>
        <div className="stat-card"><small>Reviews</small><strong>{d.counts.reviews}</strong></div>
      </div>

      <section className="panel">
        <div className="panel-title"><strong>Mentor applications</strong><span>Check their LinkedIn before approving</span></div>
        {!d.pending.length && <p className="muted">No applications waiting.</p>}
        {d.pending.map((a) => (
          <div className="list-row column" key={a.id}>
            <span><strong>{a.name}</strong> <small>{a.email}</small></span>
            <span>{a.headline} · {a.company || 'Independent'} · {a.experience_years} yrs</span>
            <span className="muted">{a.expertise}</span>
            <a href={a.linkedin} target="_blank" rel="noopener noreferrer">{a.linkedin}</a>
            <input placeholder="Optional note to the applicant" value={note[a.id] || ''} onChange={(e) => setNote({ ...note, [a.id]: e.target.value })} />
            <span className="row-actions">
              <button className="btn small primary" onClick={() => act(`/admin/mentor-applications/${a.id}`, { method: 'POST', body: { status: 'approved', note: note[a.id] } }, () => 'Mentor approved.')}>Approve</button>
              <button className="btn small danger" onClick={() => act(`/admin/mentor-applications/${a.id}`, { method: 'POST', body: { status: 'rejected', note: note[a.id] } }, () => 'Application rejected.')}>Reject</button>
            </span>
          </div>
        ))}
      </section>

      <div className="mentor-work-grid">
        <section className="panel">
          <div className="panel-title"><strong>Invite a mentor</strong><span>Skips the review queue</span></div>
          <input type="email" placeholder="Mentor email (optional, locks the code to them)" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          <button className="btn primary" onClick={() => act('/admin/invites', { method: 'POST', body: { email: inviteEmail } }, (r) => `Invite code: ${r.code}`)}>Create invite</button>
          {d.invites.map((i) => <p key={i.code} className="muted"><code>{i.code}</code> {i.email || 'open'} · {i.used_by ? 'used' : 'unused'}</p>)}
        </section>

        <section className="panel">
          <div className="panel-title"><strong>Reported posts</strong><span>Community moderation</span></div>
          {!d.reports.length && <p className="muted">No reports.</p>}
          {d.reports.map((r) => (
            <div className="list-row column" key={r.report_id}>
              <span><strong>{r.title}</strong></span>
              <span className="muted">{r.body.slice(0, 160)}</span>
              <span className="muted">Reason: {r.reason || '—'}</span>
              <button className="btn small danger" onClick={() => act(`/admin/community/${r.post_id}`, { method: 'DELETE' }, () => 'Post removed.')}>Remove post</button>
            </div>
          ))}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title"><strong>Recent users</strong><span>Suspend abusive accounts</span></div>
        {d.users.map((u) => (
          <div className="list-row" key={u.id}>
            <span><strong>{u.name}</strong><small>{u.email} · {u.role}{u.email_verified ? '' : ' · unverified'}</small></span>
            {u.role !== 'admin' && (
              <button className="btn small" onClick={() => act(`/admin/users/${u.id}/status`, { method: 'POST', body: { status: u.status === 'suspended' ? 'active' : 'suspended' } }, () => 'Updated.')}>
                {u.status === 'suspended' ? 'Reinstate' : 'Suspend'}
              </button>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}

/* ---------- entry point: picks the right view for the role ---------- */
export default function MentorHub({ user }) {
  if (user.role === 'admin') return <AdminView />
  if (user.role === 'mentor') return <MentorView />
  return <StudentView />
}
