import type { ApiProfile } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'

interface ModelListItem {
  id?: unknown
}

interface ModelListResponse {
  data?: unknown
}

export function isLikelyImageGenerationModel(model: string): boolean {
  const modelName = model.trim().toLowerCase().split('/').pop() ?? ''
  return /^gpt-image(?:-|$)/.test(modelName) ||
    /^dall-e(?:-|$)/.test(modelName) ||
    /^imagen(?:-|$)/.test(modelName) ||
    /^gemini-.+-image(?:-|$)/.test(modelName) ||
    modelName.includes('nano-banana')
}

export async function listAvailableModels(
  profile: Pick<ApiProfile, 'baseUrl' | 'apiKey' | 'apiProxy'>,
  signal?: AbortSignal,
): Promise<string[]> {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig, profile.baseUrl)
  const response = await fetch(buildApiUrl(profile.baseUrl, 'models', proxyConfig, useApiProxy), {
    method: 'GET',
    signal,
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    const message = await getApiErrorMessage(response)
    throw new Error(`HTTP ${response.status}: ${message}`)
  }

  const payload = await response.json() as ModelListResponse
  const data = Array.isArray(payload.data) ? payload.data as ModelListItem[] : []
  const models = data
    .map((item) => typeof item?.id === 'string' ? item.id.trim() : '')
    .filter(Boolean)

  return [...new Set(models)]
}
