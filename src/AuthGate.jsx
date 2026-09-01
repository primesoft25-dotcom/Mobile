import { useState } from 'react'
import { ArrowUpRight, LockKeyhole, Sparkles } from 'lucide-react'
import { useAuth } from './context/AuthContext.jsx'
import { api } from './lib/api.js'

export default function AuthGate({ children }) {
  const { user, loading, login } = useAuth()
  const [email, setEmail] = useState('partner@auroramobility.dev')
  const [password, setPassword] = useState('AuroraDevOnly-2026!')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [mode, setMode] = useState('login')
  const [notice, setNotice] = useState('')

  if (loading) return <div className="auth-loading"><Sparkles size={21} /><span>Restoring secure Aurora session…</span></div>
  if (user) return children

  async function submit(event) {
    event.preventDefault(); setSubmitting(true); setError('')
    try { if (mode === 'register') { await api.register({ email, password, displayName: email.split('@')[0], role: 'retail' }); setNotice('Account created. You can now sign in.'); setMode('login') } else if (mode === 'recover') { await api.requestPasswordReset(email); setNotice('If an account exists, recovery instructions have been sent.') } else await login(email, password) } catch (err) { setError(err.message) } finally { setSubmitting(false) }
  }

  return <main className="auth-screen"><div className="auth-card glass"><div className="auth-brand"><div className="brand-mark"><Sparkles size={17} /></div><span>AURORA<small>MOBILITY</small></span></div><div className="eyebrow"><LockKeyhole size={12} /> SECURE CUSTOMER ACCESS</div><h1>{mode === 'recover' ? 'Recover access.' : mode === 'register' ? 'Create account.' : 'Welcome back.'}</h1><p>{mode === 'recover' ? 'We’ll send a secure, time-limited reset link if the account exists.' : 'Sign in to restore your role-based workspace and live inventory session.'}</p><form onSubmit={submit}><label>Work email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>{mode !== 'recover' && <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength="12" /></label>}{error && <div className="auth-error">{error}</div>}{notice && <div className="auth-notice">{notice}</div>}<button className="primary-btn auth-submit" disabled={submitting}>{submitting ? 'Working…' : mode === 'recover' ? 'Send recovery link' : mode === 'register' ? 'Create retail account' : 'Enter workspace'} <ArrowUpRight size={15} /></button></form><div className="auth-links">{mode === 'login' && <><button onClick={() => { setMode('recover'); setError(''); setNotice('') }}>Forgot password?</button><button onClick={() => { setMode('register'); setError(''); setNotice('') }}>Create retail account</button></>}{mode !== 'login' && <button onClick={() => { setMode('login'); setError(''); setNotice('') }}>Back to sign in</button>}</div><small className="auth-note">Development seed: partner@auroramobility.dev</small></div></main>
}
