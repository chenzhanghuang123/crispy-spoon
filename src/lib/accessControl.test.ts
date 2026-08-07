import { describe, expect, it } from 'vitest'
import {
  ACCESS_LOCKOUT_MS,
  getAccessLockSeconds,
  MAX_ACCESS_FAILURES,
  registerAccessFailure,
  sha256Hex,
} from './accessControl'

describe('accessControl', () => {
  it('hashes passwords with SHA-256', async () => {
    await expect(sha256Hex('password')).resolves.toBe(
      '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
    )
  })

  it('locks after the maximum number of failed attempts', () => {
    const now = 1_000
    let state = { failures: 0, lockedUntil: 0 }

    for (let attempt = 0; attempt < MAX_ACCESS_FAILURES; attempt += 1) {
      state = registerAccessFailure(state, now)
    }

    expect(state).toEqual({ failures: 0, lockedUntil: now + ACCESS_LOCKOUT_MS })
    expect(getAccessLockSeconds(state.lockedUntil, now)).toBe(30)
  })
})
