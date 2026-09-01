import type { ApiProfile } from '../types'
import { DEFAULT_NIAOTV_BASE_URL } from './apiProfiles'
import { getApiErrorMessage } from './imageApiShared'

export type NiaoTvProtocol = 'openai_images' | 'google_genai'

export interface NiaoTvParameterDefinition {
  values?: unknown[]
  min?: unknown
  max?: unknown
}

export interface NiaoTvProviderModel {
  id: string
  display_name?: string
  protocol?: NiaoTvProtocol | string
  available?: boolean
  operations?: string[]
  defaults?: Record<string, unknown>
  parameters?: Record<string, NiaoTvParameterDefinition | unknown>
  input_limits?: {
    max_reference_images?: number
  }
}

export interface NiaoTvProviderConfig {
  object?: string
  config_version?: string
  max_generation_tokens?: number
  generation_allowed?: boolean
  models?: NiaoTvProviderModel[]
}

export interface NiaoTvQuote {
  cost_known?: boolean
  estimated?: boolean
  total_tokens?: number
  generation_allowed?: boolean
  normalized_parameters?: Record<string, unknown>
}

export interface NiaoTvTokenBalance {
  object?: string
  scope?: string
  api_key_id?: string
  used_tokens?: number
  remaining_tokens?: number | null
  availability?: 'available' | 'unlimited' | string
  unavailable_reason?: string | null
  observed_at?: string
}

export interface NiaoTvUsageItem {
  object?: string
  task_id?: string
  request_id?: string
  model?: string
  status?: string
  tokens?: number
  final?: boolean
  occurred_at?: string
}

export interface NiaoTvUsageList {
  object?: string
  scope?: string
  api_key_id?: string
  used_tokens?: number
  total?: number
  limit?: number
  offset?: number
  data?: NiaoTvUsageItem[]
}

export interface NiaoTvAccountOverview {
  balance: NiaoTvTokenBalance
  usage: NiaoTvUsageList
}

export function getNiaoTvApiBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
    .replace(/\/v1\/(?:provider(?:\/config(?:\/quote)?)?|account\/(?:token-balance|usage)|images\/(?:generations|edits))$/i, '')
    .replace(/\/v1$/i, '')
  return normalized || DEFAULT_NIAOTV_BASE_URL
}

export function isNiaoTvBananaModel(model: string): boolean {
  return model === 'gemini-3-pro-image' || model === 'gemini-3.1-flash-image'
}

function getParameterValues(model: NiaoTvProviderModel, name: string): string[] {
  const definition = model.parameters?.[name]
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return []
  const values = (definition as NiaoTvParameterDefinition).values
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []
}

export function getNiaoTvModelParameterValues(model: NiaoTvProviderModel, name: string): string[] {
  return getParameterValues(model, name)
}

async function requestNiaoTvJson<T>(
  profile: Pick<ApiProfile, 'baseUrl' | 'apiKey'>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${getNiaoTvApiBaseUrl(profile.baseUrl)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`NiaoTV AI HTTP ${response.status}: ${await getApiErrorMessage(response)}`)
  }

  return response.json() as Promise<T>
}

export async function getNiaoTvProviderConfig(
  profile: Pick<ApiProfile, 'baseUrl' | 'apiKey'>,
  signal?: AbortSignal,
): Promise<NiaoTvProviderConfig> {
  return requestNiaoTvJson(profile, '/v1/provider/config', { signal })
}

export function getAvailableNiaoTvModel(config: NiaoTvProviderConfig, modelId: string, needsEdit = false): NiaoTvProviderModel {
  const model = (config.models ?? []).find((item) => item.id === modelId)
  if (!model) throw new Error(`NiaoTV AI 当前配置中没有模型 ${modelId}`)
  if (model.available !== true) throw new Error(`NiaoTV AI 模型 ${model.display_name || model.id} 当前不可用`)

  const expectedProtocol: NiaoTvProtocol = isNiaoTvBananaModel(modelId) ? 'google_genai' : 'openai_images'
  if (model.protocol !== expectedProtocol) {
    throw new Error(`NiaoTV AI 模型 ${model.id} 的协议配置异常`)
  }

  const operation = needsEdit ? 'image_edit' : 'image_generation'
  if (!(model.operations ?? []).includes(operation)) {
    throw new Error(`NiaoTV AI 模型 ${model.display_name || model.id} 当前不支持${needsEdit ? '参考图编辑' : '文生图'}`)
  }

  return model
}

export async function quoteNiaoTvGeneration(
  profile: Pick<ApiProfile, 'baseUrl' | 'apiKey'>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<NiaoTvQuote> {
  return requestNiaoTvJson(profile, '/v1/provider/config/quote', {
    method: 'POST',
    signal,
    body: JSON.stringify(body),
  })
}

export async function getNiaoTvTokenBalance(
  profile: Pick<ApiProfile, 'baseUrl' | 'apiKey'>,
  signal?: AbortSignal,
): Promise<NiaoTvTokenBalance> {
  return requestNiaoTvJson(profile, '/v1/account/token-balance', { signal })
}

export async function getNiaoTvUsage(
  profile: Pick<ApiProfile, 'baseUrl' | 'apiKey'>,
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<NiaoTvUsageList> {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)))
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  return requestNiaoTvJson(profile, `/v1/account/usage?limit=${limit}&offset=${offset}`, { signal: options.signal })
}

export async function getNiaoTvAccountOverview(
  profile: Pick<ApiProfile, 'baseUrl' | 'apiKey'>,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<NiaoTvAccountOverview> {
  const [balance, usage] = await Promise.all([
    getNiaoTvTokenBalance(profile, options.signal),
    getNiaoTvUsage(profile, { limit: options.limit ?? 20, signal: options.signal }),
  ])
  return { balance, usage }
}
