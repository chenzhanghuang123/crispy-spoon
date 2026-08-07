import type { ApiProfile, AppSettings } from '../types'

export const API_CREDENTIALS_STORAGE_KEY = 'czh-image-studio-api-credentials-v1'

interface RememberedApiCredential {
  id: string
  provider: string
  baseUrl: string
  model: string
  apiMode: string
  apiKey: string
}

interface RememberedApiCredentials {
  version: 1
  profiles: RememberedApiCredential[]
  updatedAt: number
}

function getStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function normalizeConnectionValue(value: string) {
  return value.trim().replace(/\/+$/, '').toLocaleLowerCase()
}

function getConnectionKey(profile: Pick<ApiProfile, 'provider' | 'baseUrl' | 'model' | 'apiMode'>) {
  return JSON.stringify([
    profile.provider,
    normalizeConnectionValue(profile.baseUrl),
    profile.model.trim().toLocaleLowerCase(),
    profile.apiMode,
  ])
}

function isUsableApiKey(value: string) {
  const trimmed = value.trim()
  return Boolean(trimmed) && !/^\{[^}]+\}$/.test(trimmed)
}

function readRememberedApiCredentials(): RememberedApiCredentials | null {
  const storage = getStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(API_CREDENTIALS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RememberedApiCredentials> | null
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.profiles)) return null
    return {
      version: 1,
      profiles: parsed.profiles.filter((item): item is RememberedApiCredential => (
        Boolean(item) &&
        typeof item.id === 'string' &&
        typeof item.provider === 'string' &&
        typeof item.baseUrl === 'string' &&
        typeof item.model === 'string' &&
        typeof item.apiMode === 'string' &&
        typeof item.apiKey === 'string' &&
        isUsableApiKey(item.apiKey)
      )),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    }
  } catch {
    return null
  }
}

export function rememberApiCredentials(settings: Pick<AppSettings, 'profiles'>) {
  const storage = getStorage()
  if (!storage) return
  const profiles = settings.profiles
    .filter((profile) => isUsableApiKey(profile.apiKey))
    .map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiMode: profile.apiMode,
      apiKey: profile.apiKey,
    }))
  try {
    if (!profiles.length) {
      storage.removeItem(API_CREDENTIALS_STORAGE_KEY)
      return
    }
    storage.setItem(API_CREDENTIALS_STORAGE_KEY, JSON.stringify({
      version: 1,
      profiles,
      updatedAt: Date.now(),
    } satisfies RememberedApiCredentials))
  } catch {
    // 浏览器禁止或空间不足时，主 Zustand 配置仍会继续保存。
  }
}

export function restoreRememberedApiCredentials(settings: AppSettings): AppSettings {
  const remembered = readRememberedApiCredentials()
  if (!remembered?.profiles.length) return settings
  const byId = new Map(remembered.profiles.map((profile) => [profile.id, profile]))
  const byConnection = new Map(remembered.profiles.map((profile) => [getConnectionKey(profile as ApiProfile), profile]))
  let changed = false
  const profiles = settings.profiles.map((profile) => {
    if (isUsableApiKey(profile.apiKey)) return profile
    const saved = byId.get(profile.id) ?? byConnection.get(getConnectionKey(profile))
    if (!saved?.apiKey) return profile
    changed = true
    return { ...profile, apiKey: saved.apiKey }
  })
  if (!changed) return settings
  const activeProfile = profiles.find((profile) => profile.id === settings.activeProfileId) ?? profiles[0]
  return {
    ...settings,
    profiles,
    apiKey: isUsableApiKey(settings.apiKey) ? settings.apiKey : activeProfile?.apiKey ?? settings.apiKey,
  }
}

export function clearRememberedApiCredentials() {
  const storage = getStorage()
  if (!storage) return
  try {
    storage.removeItem(API_CREDENTIALS_STORAGE_KEY)
  } catch {
    // 忽略浏览器存储异常。
  }
}

export function requestPersistentBrowserStorage() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return
    void navigator.storage.persist().catch(() => {})
  } catch {
    // 持久存储不是必需能力。
  }
}
