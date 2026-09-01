import type { ApiProfile, TaskParams } from '../types'
import { dataUrlToBlob } from './canvasImage'
import {
  DEFAULT_NIAOTV_BASE_URL,
  DEFAULT_NIAOTV_DIRECT_BASE_URL,
  DEFAULT_NIAOTV_MODEL,
} from './apiProfiles'
import {
  assertImageInputPayloadSize,
  createLinkedAbortController,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'
import {
  getAvailableNiaoTvModel,
  getNiaoTvApiBaseUrl,
  getNiaoTvModelParameterValues,
  getNiaoTvProviderConfig,
  getNiaoTvTokenBalance,
  isNiaoTvBananaModel,
  quoteNiaoTvGeneration,
  type NiaoTvProviderModel,
} from './niaoTvApi'
import { normalizeImageSize } from './size'

interface PreparedNiaoTvRequest {
  model: NiaoTvProviderModel
  modelId: string
  operation: 'image_generation' | 'image_edit'
  quantity: number
  size?: string
  quality?: TaskParams['quality']
  imageSize?: string
  aspectRatio?: string
}

interface ParsedNiaoTvImage {
  dataUrl: string
  outputFormat: TaskParams['output_format']
}

const NIAOTV_MAX_REFERENCE_IMAGES = 6
const NIAOTV_MIN_TIMEOUT_SECONDS = 420
const FALLBACK_BANANA_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const FALLBACK_BANANA_SIZES = ['1K', '2K', '4K']
const RETRYABLE_GENERATION_STATUSES = new Set([403, 408, 429, 500, 502, 503, 504])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `niaotv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function parseDimensions(size: string): { width: number; height: number } | null {
  const match = size.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null
}

function chooseClosestDimensions(requested: string, values: string[]): string {
  if (values.includes(requested)) return requested
  const requestedDimensions = parseDimensions(requested)
  const candidates = values
    .map((value) => ({ value, dimensions: parseDimensions(value) }))
    .filter((item): item is { value: string; dimensions: { width: number; height: number } } => Boolean(item.dimensions))
  if (!requestedDimensions || !candidates.length) return values.includes('auto') ? 'auto' : values[0] || '1024x1024'

  const requestedRatio = requestedDimensions.width / requestedDimensions.height
  const requestedPixels = requestedDimensions.width * requestedDimensions.height
  return candidates
    .map((item) => {
      const ratio = item.dimensions.width / item.dimensions.height
      const pixels = item.dimensions.width * item.dimensions.height
      return {
        value: item.value,
        score: Math.abs(Math.log(ratio / requestedRatio)) * 4 + Math.abs(Math.log(pixels / requestedPixels)),
      }
    })
    .sort((left, right) => left.score - right.score)[0]?.value ?? candidates[0].value
}

function getGptSize(model: NiaoTvProviderModel, requested: string): string {
  const values = getNiaoTvModelParameterValues(model, 'size')
  const normalized = requested.trim().toLowerCase() === 'auto'
    ? 'auto'
    : normalizeImageSize(requested) || '1024x1024'
  if (!values.length) return normalized === 'auto' ? 'auto' : normalized
  return chooseClosestDimensions(normalized, values)
}

function getGptQuality(model: NiaoTvProviderModel, requested: TaskParams['quality']): TaskParams['quality'] {
  const values = getNiaoTvModelParameterValues(model, 'quality')
  if (!values.length || values.includes(requested)) return requested
  const fallback = typeof model.defaults?.quality === 'string' ? model.defaults.quality : 'medium'
  return (values.includes(fallback) ? fallback : values[0] || 'medium') as TaskParams['quality']
}

function getBananaImageSize(model: NiaoTvProviderModel, requested: string): string {
  const values = getNiaoTvModelParameterValues(model, 'image_size')
  const allowed = values.length ? values : FALLBACK_BANANA_SIZES
  const fallback = typeof model.defaults?.image_size === 'string' ? model.defaults.image_size : '1K'
  const dimensions = parseDimensions(requested)
  if (!dimensions) return allowed.includes(fallback) ? fallback : allowed[0] || '1K'

  const pixels = dimensions.width * dimensions.height
  const tier = pixels > 4_194_304 || Math.max(dimensions.width, dimensions.height) > 2048
    ? '4K'
    : pixels > 1_572_864 || Math.max(dimensions.width, dimensions.height) > 1536
      ? '2K'
      : '1K'
  if (allowed.includes(tier)) return tier
  const numericTier = Number(tier[0])
  return allowed
    .map((value) => ({ value, distance: Math.abs(Number(value[0]) - numericTier) }))
    .sort((left, right) => left.distance - right.distance)[0]?.value ?? allowed[0] ?? '1K'
}

function getBananaAspectRatio(model: NiaoTvProviderModel, requested: string): string {
  const values = getNiaoTvModelParameterValues(model, 'aspect_ratio')
  const allowed = values.length ? values : FALLBACK_BANANA_RATIOS
  const fallback = typeof model.defaults?.aspect_ratio === 'string' ? model.defaults.aspect_ratio : '1:1'
  const dimensions = parseDimensions(requested)
  if (!dimensions) return allowed.includes(fallback) ? fallback : allowed[0] || '1:1'

  const requestedRatio = dimensions.width / dimensions.height
  return allowed
    .map((value) => {
      const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)
      const ratio = match ? Number(match[1]) / Number(match[2]) : 1
      return { value, distance: Math.abs(Math.log(ratio / requestedRatio)) }
    })
    .sort((left, right) => left.distance - right.distance)[0]?.value ?? '1:1'
}

function getNormalizedString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

async function prepareNiaoTvRequest(
  opts: CallApiOptions,
  profile: ApiProfile,
  signal: AbortSignal,
): Promise<PreparedNiaoTvRequest> {
  if (opts.maskDataUrl) {
    throw new Error('NiaoTV AI 当前不接受独立遮罩参数，请移除遮罩后使用普通参考图编辑。')
  }
  if (opts.inputImageDataUrls.length > NIAOTV_MAX_REFERENCE_IMAGES) {
    throw new Error(`NiaoTV AI 最多支持 ${NIAOTV_MAX_REFERENCE_IMAGES} 张参考图。`)
  }

  assertImageInputPayloadSize(opts.inputImageDataUrls.reduce(
    (total, dataUrl) => total + getDataUrlDecodedByteSize(dataUrl),
    0,
  ))

  const config = await getNiaoTvProviderConfig(profile, signal)
  if (config.generation_allowed === false) throw new Error('NiaoTV AI 当前账户暂不允许创建生图任务。')

  const modelId = profile.model.trim() || DEFAULT_NIAOTV_MODEL
  const operation = opts.inputImageDataUrls.length ? 'image_edit' : 'image_generation'
  const model = getAvailableNiaoTvModel(config, modelId, operation === 'image_edit')
  const modelReferenceLimit = Number(model.input_limits?.max_reference_images)
  if (Number.isFinite(modelReferenceLimit) && opts.inputImageDataUrls.length > modelReferenceLimit) {
    throw new Error(`NiaoTV AI 模型 ${model.display_name || model.id} 最多支持 ${modelReferenceLimit} 张参考图。`)
  }

  const quantity = Math.min(4, Math.max(1, Math.trunc(opts.params.n || 1)))
  const banana = isNiaoTvBananaModel(modelId)
  const imageSize = banana ? getBananaImageSize(model, opts.params.size) : undefined
  const aspectRatio = banana ? getBananaAspectRatio(model, opts.params.size) : undefined
  const size = banana ? undefined : getGptSize(model, opts.params.size)
  const quality = banana ? undefined : getGptQuality(model, opts.params.quality)
  const quoteBody: Record<string, unknown> = banana
    ? { model: modelId, operation, image_size: imageSize, aspect_ratio: aspectRatio }
    : { model: modelId, operation, size, quality, quantity }
  const quote = await quoteNiaoTvGeneration(profile, quoteBody, signal)
  if (quote.generation_allowed === false) {
    throw new Error('NiaoTV AI 当前积分或任务状态不允许提交这次生成。')
  }

  const normalized = quote.normalized_parameters ?? {}
  const normalizedSize = banana ? undefined : getNormalizedString(normalized.size, size || '1024x1024')
  const normalizedQuality = banana
    ? undefined
    : getNormalizedString(normalized.quality, quality || 'medium') as TaskParams['quality']
  const normalizedImageSize = banana ? getNormalizedString(normalized.image_size, imageSize || '1K') : undefined
  const normalizedAspectRatio = banana ? getNormalizedString(normalized.aspect_ratio, aspectRatio || '1:1') : undefined

  const balance = await getNiaoTvTokenBalance(profile, signal)
  if (balance.availability !== 'available' && balance.availability !== 'unlimited') {
    throw new Error(`NiaoTV AI 积分账户当前不可用${balance.unavailable_reason ? `：${balance.unavailable_reason}` : '。'}`)
  }
  const estimatedTokens = typeof quote.total_tokens === 'number'
    ? quote.total_tokens * (banana ? quantity : 1)
    : null
  if (
    balance.availability !== 'unlimited' &&
    typeof balance.remaining_tokens === 'number' &&
    estimatedTokens !== null &&
    balance.remaining_tokens < estimatedTokens
  ) {
    throw new Error(`NiaoTV AI 积分不足：本次预计需要 ${estimatedTokens}，当前剩余 ${balance.remaining_tokens}。`)
  }

  return {
    model,
    modelId,
    operation,
    quantity,
    size: normalizedSize,
    quality: normalizedQuality,
    imageSize: normalizedImageSize,
    aspectRatio: normalizedAspectRatio,
  }
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/i)
  if (!match) throw new Error('NiaoTV AI 参考图必须是有效的 Base64 图片。')
  return { mimeType: match[1], data: match[2].replace(/\s/g, '') }
}

function detectImageMime(base64: string, fallback = 'image/png'): string {
  try {
    const binary = atob(base64.replace(/\s/g, '').slice(0, 32))
    const bytes = Array.from(binary, (character) => character.charCodeAt(0) & 0xff)
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP') return 'image/webp'
  } catch {
    // Use the documented fallback MIME when the signature cannot be decoded.
  }
  return fallback
}

function outputFormatFromMime(mimeType: string): TaskParams['output_format'] {
  if (mimeType.toLowerCase() === 'image/jpeg') return 'jpeg'
  if (mimeType.toLowerCase() === 'image/webp') return 'webp'
  return 'png'
}

function collectBananaImages(payload: unknown): ParsedNiaoTvImage[] {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return []
  const images: ParsedNiaoTvImage[] = []
  for (const candidate of payload.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue
    for (const part of candidate.content.parts) {
      if (!isRecord(part)) continue
      const inlineData = isRecord(part.inlineData) ? part.inlineData : isRecord(part.inline_data) ? part.inline_data : null
      const data = typeof inlineData?.data === 'string' ? inlineData.data.replace(/\s/g, '') : ''
      if (!data) continue
      const mimeType = typeof inlineData?.mimeType === 'string'
        ? inlineData.mimeType
        : typeof inlineData?.mime_type === 'string'
          ? inlineData.mime_type
          : detectImageMime(data)
      images.push({ dataUrl: `data:${mimeType};base64,${data}`, outputFormat: outputFormatFromMime(mimeType) })
    }
  }
  return images
}

async function collectGptImages(payload: unknown, signal: AbortSignal): Promise<ParsedNiaoTvImage[]> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return []
  const images: ParsedNiaoTvImage[] = []
  for (const item of payload.data) {
    if (!isRecord(item)) continue
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
      const data = item.b64_json.replace(/\s/g, '')
      const mimeType = detectImageMime(data)
      images.push({ dataUrl: `data:${mimeType};base64,${data}`, outputFormat: outputFormatFromMime(mimeType) })
    } else if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
      const dataUrl = await fetchImageUrlAsDataUrl(item.url, 'image/png', signal)
      const mimeType = dataUrl.match(/^data:([^;,]+)/i)?.[1] || 'image/png'
      images.push({ dataUrl, outputFormat: outputFormatFromMime(mimeType) })
    }
  }
  return images
}

function getGenerationBaseUrls(profile: ApiProfile): string[] {
  const configured = getNiaoTvApiBaseUrl(profile.baseUrl)
  try {
    const host = new URL(configured).hostname.toLowerCase()
    if (host === 'ai-proxy.niaotv.art') return [DEFAULT_NIAOTV_DIRECT_BASE_URL, configured]
    if (host === 'ai-direct.niaotv.art') return [configured, DEFAULT_NIAOTV_BASE_URL]
  } catch {
    // A custom base URL is still allowed and will be used as provided.
  }
  return [configured]
}

async function fetchNiaoTvGeneration(
  profile: ApiProfile,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const bases = getGenerationBaseUrls(profile)
  let lastError: unknown
  for (let index = 0; index < bases.length; index += 1) {
    try {
      const response = await fetch(`${bases[index]}${path}`, { ...init, signal, cache: 'no-store' })
      if (response.ok || !RETRYABLE_GENERATION_STATUSES.has(response.status) || index === bases.length - 1) return response
      lastError = new Error(`NiaoTV AI HTTP ${response.status}: ${await getApiErrorMessage(response)}`)
    } catch (error) {
      lastError = error
      if (signal.aborted || index === bases.length - 1) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('NiaoTV AI 生图请求失败')
}

async function createGptEditFormData(opts: CallApiOptions, prepared: PreparedNiaoTvRequest): Promise<FormData> {
  const formData = new FormData()
  formData.append('model', prepared.modelId)
  formData.append('prompt', opts.prompt)
  formData.append('size', prepared.size || '1024x1024')
  formData.append('quality', prepared.quality || 'medium')
  formData.append('n', String(prepared.quantity))
  for (let index = 0; index < opts.inputImageDataUrls.length; index += 1) {
    const blob = await dataUrlToBlob(opts.inputImageDataUrls[index])
    const extension = blob.type.split('/')[1] || 'png'
    formData.append('image', blob, `reference-${index + 1}.${extension}`)
  }
  return formData
}

async function requestGptImages(
  opts: CallApiOptions,
  profile: ApiProfile,
  prepared: PreparedNiaoTvRequest,
  signal: AbortSignal,
): Promise<ParsedNiaoTvImage[]> {
  const isEdit = prepared.operation === 'image_edit'
  const idempotencyKey = createIdempotencyKey()
  const response = await fetchNiaoTvGeneration(
    profile,
    isEdit ? '/v1/images/edits' : '/v1/images/generations',
    isEdit
      ? {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${profile.apiKey}`,
            'Idempotency-Key': idempotencyKey,
          },
          body: await createGptEditFormData(opts, prepared),
        }
      : {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${profile.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            model: prepared.modelId,
            prompt: opts.prompt,
            size: prepared.size,
            quality: prepared.quality,
            n: prepared.quantity,
          }),
        },
    signal,
  )
  if (!response.ok) throw new Error(`NiaoTV AI HTTP ${response.status}: ${await getApiErrorMessage(response)}`)
  const payload = await response.json() as unknown
  const images = await collectGptImages(payload, signal)
  if (!images.length) throw new Error('NiaoTV AI 请求成功，但 GPT Image 2 响应中没有图片数据。')
  return images
}

async function requestBananaImages(
  opts: CallApiOptions,
  profile: ApiProfile,
  prepared: PreparedNiaoTvRequest,
  signal: AbortSignal,
): Promise<ParsedNiaoTvImage[]> {
  const parts: Array<Record<string, unknown>> = [
    { text: opts.prompt },
    ...opts.inputImageDataUrls.map((dataUrl) => ({ inlineData: parseDataUrl(dataUrl) })),
  ]
  const imageConfig = {
    aspectRatio: prepared.aspectRatio,
    imageSize: prepared.imageSize,
  }
  const response = await fetchNiaoTvGeneration(
    profile,
    `/v1beta/models/${encodeURIComponent(prepared.modelId)}:generateContent`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': createIdempotencyKey(),
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig,
          responseFormat: {
            image: {
              mimeType: 'image/png',
              ...imageConfig,
            },
          },
        },
      }),
    },
    signal,
  )
  if (!response.ok) throw new Error(`NiaoTV AI HTTP ${response.status}: ${await getApiErrorMessage(response)}`)
  const images = collectBananaImages(await response.json() as unknown)
  if (!images.length) throw new Error('NiaoTV AI 请求成功，但 Nano Banana 响应中没有图片数据。')
  return images
}

export async function callNiaoTvImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const linkedAbort = createLinkedAbortController(Math.max(NIAOTV_MIN_TIMEOUT_SECONDS, profile.timeout), opts.signal)
  try {
    const prepared = await prepareNiaoTvRequest(opts, profile, linkedAbort.controller.signal)
    const banana = isNiaoTvBananaModel(prepared.modelId)
    const batches = banana
      ? await Promise.all(Array.from(
          { length: prepared.quantity },
          () => requestBananaImages(opts, profile, prepared, linkedAbort.controller.signal),
        ))
      : [await requestGptImages(opts, profile, prepared, linkedAbort.controller.signal)]
    const images = batches.flat()
    const commonFormat = images.every((image) => image.outputFormat === images[0]?.outputFormat)
      ? images[0]?.outputFormat
      : undefined
    const actualParams: Partial<TaskParams> = {
      ...(banana ? {} : { size: prepared.size, quality: prepared.quality }),
      ...(commonFormat ? { output_format: commonFormat } : {}),
      output_compression: null,
      n: images.length,
    }
    return {
      images: images.map((image) => image.dataUrl),
      actualParams,
      actualParamsList: images.map((image) => ({
        ...(banana ? {} : { size: prepared.size, quality: prepared.quality }),
        output_format: image.outputFormat,
        output_compression: null,
        n: 1,
      })),
    }
  } finally {
    linkedAbort.cleanup()
  }
}
