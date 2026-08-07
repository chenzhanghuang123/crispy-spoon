import {
  createContext,
  type FormEvent,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  ACCESS_PASSWORD_HASH,
  getAccessLockSeconds,
  MAX_ACCESS_FAILURES,
  registerAccessFailure,
  sha256Hex,
  type AccessFailureState,
} from '../lib/accessControl'
import { EyeIcon, EyeOffIcon, LockIcon } from './icons'

const SESSION_ACCESS_KEY = 'czh-access-session-v1'
const PERSISTENT_ACCESS_KEY = 'czh-access-persistent-v1'
const FAILURE_STATE_KEY = 'czh-access-failures-v1'
const REMEMBER_ACCESS_MS = 7 * 24 * 60 * 60 * 1000

interface AccessGateContextValue {
  lock: () => void
}

const AccessGateContext = createContext<AccessGateContextValue | null>(null)

function hasStoredAccess(): boolean {
  try {
    if (sessionStorage.getItem(SESSION_ACCESS_KEY) === ACCESS_PASSWORD_HASH) return true

    const stored = localStorage.getItem(PERSISTENT_ACCESS_KEY)
    if (!stored) return false

    const parsed = JSON.parse(stored) as { hash?: string; expiresAt?: number }
    if (parsed.hash === ACCESS_PASSWORD_HASH && Number(parsed.expiresAt) > Date.now()) return true

    localStorage.removeItem(PERSISTENT_ACCESS_KEY)
  } catch {
    return false
  }

  return false
}

function readFailureState(): AccessFailureState {
  try {
    const stored = localStorage.getItem(FAILURE_STATE_KEY)
    if (!stored) return { failures: 0, lockedUntil: 0 }

    const parsed = JSON.parse(stored) as Partial<AccessFailureState>
    return {
      failures: Number.isFinite(parsed.failures) ? Number(parsed.failures) : 0,
      lockedUntil: Number.isFinite(parsed.lockedUntil) ? Number(parsed.lockedUntil) : 0,
    }
  } catch {
    return { failures: 0, lockedUntil: 0 }
  }
}

function persistFailureState(state: AccessFailureState) {
  try {
    if (state.failures === 0 && state.lockedUntil === 0) {
      localStorage.removeItem(FAILURE_STATE_KEY)
      return
    }

    localStorage.setItem(FAILURE_STATE_KEY, JSON.stringify(state))
  } catch {
    // Storage can be unavailable in privacy modes; the gate still works for this tab.
  }
}

export function useAccessGate(): AccessGateContextValue {
  const context = useContext(AccessGateContext)
  if (!context) throw new Error('useAccessGate must be used within AccessGate')
  return context
}

export default function AccessGate({ children }: PropsWithChildren) {
  const [unlocked, setUnlocked] = useState(hasStoredAccess)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [failureState, setFailureState] = useState(readFailureState)
  const [now, setNow] = useState(Date.now)

  const lockSeconds = getAccessLockSeconds(failureState.lockedUntil, now)
  const isLocked = lockSeconds > 0

  useEffect(() => {
    if (!isLocked) return

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isLocked])

  useEffect(() => {
    if (failureState.lockedUntil === 0 || failureState.lockedUntil > now) return

    const resetState = { failures: 0, lockedUntil: 0 }
    setFailureState(resetState)
    persistFailureState(resetState)
    setError('')
  }, [failureState.lockedUntil, now])

  const lock = useCallback(() => {
    try {
      sessionStorage.removeItem(SESSION_ACCESS_KEY)
      localStorage.removeItem(PERSISTENT_ACCESS_KEY)
    } catch {
      // Ignore storage failures and lock the current tab.
    }

    setPassword('')
    setRemember(false)
    setError('')
    setUnlocked(false)
  }, [])

  const contextValue = useMemo(() => ({ lock }), [lock])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password || submitting || isLocked) return

    setSubmitting(true)
    setError('')

    try {
      const passwordHash = await sha256Hex(password)

      if (passwordHash === ACCESS_PASSWORD_HASH) {
        const resetState = { failures: 0, lockedUntil: 0 }
        setFailureState(resetState)
        persistFailureState(resetState)

        try {
          sessionStorage.setItem(SESSION_ACCESS_KEY, ACCESS_PASSWORD_HASH)
          if (remember) {
            localStorage.setItem(
              PERSISTENT_ACCESS_KEY,
              JSON.stringify({ hash: ACCESS_PASSWORD_HASH, expiresAt: Date.now() + REMEMBER_ACCESS_MS }),
            )
          }
        } catch {
          // The unlocked state remains valid for the current page session.
        }

        setPassword('')
        setUnlocked(true)
        return
      }

      const nextFailureState = registerAccessFailure(failureState, Date.now())
      setFailureState(nextFailureState)
      persistFailureState(nextFailureState)
      setNow(Date.now())
      setPassword('')

      if (nextFailureState.lockedUntil > Date.now()) {
        setError('尝试次数过多，请稍后重试。')
      } else {
        setError(`密码错误，还可尝试 ${MAX_ACCESS_FAILURES - nextFailureState.failures} 次。`)
      }
    } catch {
      setError('当前浏览器无法完成安全校验，请更换现代浏览器。')
    } finally {
      setSubmitting(false)
    }
  }

  if (unlocked) {
    return <AccessGateContext.Provider value={contextValue}>{children}</AccessGateContext.Provider>
  }

  return (
    <main className="min-h-[100dvh] bg-[#080a0f] text-gray-100">
      <div className="h-1 bg-amber-400" />
      <div className="mx-auto flex min-h-[calc(100dvh-4px)] w-full max-w-7xl flex-col px-5 sm:px-8">
        <header className="flex h-16 items-center border-b border-white/10">
          <span className="text-sm font-semibold text-gray-100">CZH 图片工作台</span>
        </header>

        <section className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[420px] rounded-lg border border-white/10 bg-[#11141a] p-6 shadow-2xl shadow-black/40 sm:p-8">
            <div className="mb-7 flex h-11 w-11 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/10 text-amber-300">
              <LockIcon className="h-5 w-5" />
            </div>

            <h1 className="text-2xl font-semibold text-white">访问验证</h1>
            <p className="mt-2 text-sm leading-6 text-gray-400">请输入密码进入工作台。</p>

            <form className="mt-7" onSubmit={handleSubmit}>
              <label className="text-sm font-medium text-gray-200" htmlFor="access-password">
                访问密码
              </label>
              <div className="relative mt-2">
                <input
                  id="access-password"
                  autoComplete="current-password"
                  autoFocus
                  className="h-12 w-full rounded-lg border border-white/10 bg-[#090b10] px-4 pr-12 text-base text-white outline-none transition-colors placeholder:text-gray-600 focus:border-amber-400/70 focus:ring-2 focus:ring-amber-400/15 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isLocked || submitting}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="输入访问密码"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                />
                <button
                  type="button"
                  className="absolute right-1.5 top-1.5 flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-200"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  title={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOffIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
                </button>
              </div>

              <div className="mt-4 flex min-h-6 items-center justify-between gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-400">
                  <input
                    checked={remember}
                    className="h-4 w-4 accent-amber-400"
                    disabled={isLocked || submitting}
                    onChange={(event) => setRemember(event.target.checked)}
                    type="checkbox"
                  />
                  在此设备保持登录 7 天
                </label>
              </div>

              <div className="mt-2 min-h-6 text-sm text-red-300" aria-live="polite">
                {isLocked ? `请在 ${lockSeconds} 秒后重试。` : error}
              </div>

              <button
                type="submit"
                className="mt-3 flex h-12 w-full items-center justify-center rounded-lg bg-amber-400 px-4 text-sm font-semibold text-gray-950 transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
                disabled={!password || submitting || isLocked}
              >
                {submitting ? '正在验证...' : '进入工作台'}
              </button>
            </form>
          </div>
        </section>
      </div>
    </main>
  )
}
