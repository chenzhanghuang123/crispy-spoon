export const ACCESS_PASSWORD_HASH = '8f3a500bdba99f3ba694b51f6e8b1089beb36bdc8a8a179108b7041773f4276f'
export const MAX_ACCESS_FAILURES = 5
export const ACCESS_LOCKOUT_MS = 30_000

export interface AccessFailureState {
  failures: number
  lockedUntil: number
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function registerAccessFailure(
  current: AccessFailureState,
  now: number,
): AccessFailureState {
  if (current.lockedUntil > now) return current

  const failures = current.failures + 1
  if (failures >= MAX_ACCESS_FAILURES) {
    return { failures: 0, lockedUntil: now + ACCESS_LOCKOUT_MS }
  }

  return { failures, lockedUntil: 0 }
}

export function getAccessLockSeconds(lockedUntil: number, now: number): number {
  return Math.max(0, Math.ceil((lockedUntil - now) / 1000))
}
