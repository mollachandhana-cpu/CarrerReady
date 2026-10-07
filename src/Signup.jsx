import { useState } from 'react'
import { api, setToken } from './api'

const BRANCHES = ['CSE', 'ECE', 'EEE', 'Mechanical', 'Civil', 'Other']
const YEARS = ['1st year', '2nd year', '3rd year', '4th year']

export default function Signup({ onAuth, switchToLogin }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', branch: 'CSE', year: '3rd year' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function update(field) {
    return (e) => setForm({ ...form, [field]: e.target.value })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await api('/signup', { method: 'POST', body: form })
      setToken(data.token)
      onAuth(data.user)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-intro">
        <h1>CareerReady</h1>
        <p>Create your account to take skill assessments and get a readiness score.</p>
      </div>
      <form className="auth-card" onSubmit={handleSubmit}>
        <h2>Create account</h2>
        {error && <p className="error" role="alert">{error}</p>}
        <label>
          Full name
          <input value={form.name} onChange={update('name')} required autoComplete="name" />
        </label>
        <label>
          Email
          <input type="email" value={form.email} onChange={update('email')} required autoComplete="email" />
        </label>
        <label>
          Password (at least 8 characters)
          <input type="password" value={form.password} onChange={update('password')} required minLength={8} autoComplete="new-password" />
        </label>
        <div className="row">
          <label>
            Branch
            <select value={form.branch} onChange={update('branch')}>
              {BRANCHES.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </label>
          <label>
            Year
            <select value={form.year} onChange={update('year')}>
              {YEARS.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
          </label>
        </div>
        <button className="btn primary" type="submit" disabled={loading}>
          {loading ? 'Creating account...' : 'Create account'}
        </button>
        <p className="switch">
          Already registered?{' '}
          <button type="button" className="link" onClick={switchToLogin}>
            Log in
          </button>
        </p>
      </form>
    </div>
  )
}
