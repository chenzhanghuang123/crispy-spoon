import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import {
  API_CREDENTIALS_STORAGE_KEY,
  clearRememberedApiCredentials,
  rememberApiCredentials,
  restoreRememberedApiCredentials,
} from './apiCredentialStorage'

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API credential persistence', () => {
  it('restores an API key after the main persisted settings lose it', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    const keyedProfile = createDefaultOpenAIProfile({
      id: 'image-api',
      apiKey: 'saved-once-key',
      baseUrl: 'http://localhost:4604/v1',
      model: 'gpt',
    })
    const keyedSettings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [keyedProfile],
      activeProfileId: keyedProfile.id,
    })
    rememberApiCredentials(keyedSettings)

    const restored = restoreRememberedApiCredentials(normalizeSettings({
      ...keyedSettings,
      apiKey: '',
      profiles: [{ ...keyedProfile, apiKey: '' }],
    }))

    expect(restored.profiles[0]?.apiKey).toBe('saved-once-key')
    expect(restored.apiKey).toBe('saved-once-key')
    expect(storage.getItem(API_CREDENTIALS_STORAGE_KEY)).toContain('saved-once-key')
  })

  it('can remove the remembered key when the user clears configuration', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    const profile = createDefaultOpenAIProfile({ apiKey: 'saved-key' })
    rememberApiCredentials(normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile] }))

    clearRememberedApiCredentials()

    expect(storage.getItem(API_CREDENTIALS_STORAGE_KEY)).toBeNull()
  })
})
