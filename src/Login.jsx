import { useState } from 'react'
import { api, setToken } from './api'

export default function Login({ onAuth, switchToSignup }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await api('/login', { method: 'POST', body: { email, password } })
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
        <p>Find out how ready you are for industry, fix the gaps, and track internships that fit your branch.</p>
      </div>
      <form className="auth-card" onSubmit={handleSubmit}>
        <h2>Log in</h2>
        {error && <p className="error" role="alert">{error}</p>}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        <button className="btn primary" type="submit" disabled={loading}>
          {loading ? 'Logging in...' : 'Log in'}
        </button>
        <p className="switch">
          <a href="/api/pages/forgot">Forgot your password?</a>
        </p>
        <p className="switch">
          New here?{' '}
          <button type="button" className="link" onClick={switchToSignup}>
            Create an account
          </button>
        </p>
      </form>
    </div>
  )
}
