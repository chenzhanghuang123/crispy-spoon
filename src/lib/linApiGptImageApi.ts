import type { ApiProfile, TaskParams } from '../types'
import { DEFAULT_LINAPI_GPT_BASE_URL, DEFAULT_LINAPI_GPT_MODEL } from './apiProfiles'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from './canvasImage'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  createLinkedAbortController,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  isDataUrl,
  isHttpUrl,
  MIME_MAP,
  normalizeBase64Image,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'

type ImageCandidate =
  | { kind: 'url', value: string }
  | { kind: 'base64', value: string }

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])
const DEFAULT_RETRY_DELAY_MS = 750
const MAX_RETRY_DELAY_MS = 3000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function getLinApiGptImageSize(size: string): '1024x1024' | '1536x1024' | '1024x1536' {
  const match = size.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return '1024x1024'

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '1024x1024'
  if (width > height) return '1536x1024'
  if (height > width) return '1024x1536'
  return '1024x1024'
}

function getLinApiGptBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '') || DEFAULT_LINAPI_GPT_BASE_URL
  return normalized.replace(/\/(?:chat\/completions|images\/generations|images\/edits)$/i, '')
}

function getLinApiGptEndpoint(baseUrl: string, path: 'images/generations' | 'images/edits'): string {
  return `${getLinApiGptBaseUrl(baseUrl)}/${path}`
}

function addUrlCandidate(value: unknown, candidates: ImageCandidate[]) {
  if (isHttpUrl(value) || isDataUrl(value)) candidates.push({ kind: 'url', value: value.trim() })
}

function addBase64Candidate(value: unknown, candidates: ImageCandidate[]) {
  if (typeof value === 'string' && value.trim()) candidates.push({ kind: 'base64', value: value.trim() })
}

function collectTextCandidates(value: string, candidates: ImageCandidate[]) {
  const trimmed = value.trim()
  if (!trimmed) return
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) {
    addUrlCandidate(trimmed, candidates)
    return
  }

  const markdownPattern = /!\[[^\]]*\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/gi
  for (const match of trimmed.matchAll(markdownPattern)) addUrlCandidate(match[1], candidates)

  const dataUrlPattern = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi
  for (const match of trimmed.matchAll(dataUrlPattern)) addUrlCandidate(match[0].replace(/\s/g, ''), candidates)

  const httpUrlPattern = /https?:\/\/[^\s<>"']+/gi
  for (const match of trimmed.matchAll(httpUrlPattern)) {
    addUrlCandidate(match[0].replace(/[),.;]+$/, ''), candidates)
  }
}

function collectContentCandidates(value: unknown, candidates: ImageCandidate[]) {
  if (typeof value === 'string') {
    collectTextCandidates(value, candidates)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectContentCandidates(item, candidates))
    return
  }
  if (!isRecord(value)) return

  addUrlCandidate(value.url, candidates)
  addBase64Candidate(value.b64_json, candidates)

  const imageUrl = value.image_url ?? value.imageUrl
  if (typeof imageUrl === 'string') addUrlCandidate(imageUrl, candidates)
  else if (isRecord(imageUrl)) addUrlCandidate(imageUrl.url, candidates)

  if ('content' in value) collectContentCandidates(value.content, candidates)
  if ('images' in value) collectContentCandidates(value.images, candidates)
  if (typeof value.text === 'string') collectTextCandidates(value.text, candidates)
}

function collectImageCandidates(payload: unknown): ImageCandidate[] {
  if (!isRecord(payload)) return []
  const candidates: ImageCandidate[] = []

  if (Array.isArray(payload.data)) {
    for (const item of payload.data) collectContentCandidates(item, candidates)
  }
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      if (!isRecord(choice)) continue
      collectContentCandidates(choice.message, candidates)
    }
  }
  collectContentCandidates(payload.images, candidates)

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function createNonJsonError(text: string): Error {
  const snippet = text.trim().replace(/\s+/g, ' ').slice(0, 500)
  const err = new Error(`LinAPI GPT 返回了非 JSON 响应，请稍后重试或检查服务商状态。${snippet ? `响应片段：${snippet}` : ''}`)
  ;(err as Error & { rawResponsePayload?: string }).rawResponsePayload = text.slice(0, 5000)
  return err
}

async function readLinApiGptJson(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw createNonJsonError(text)
  }
}

async function parseLinApiGptResponse(
  payload: unknown,
  fallbackMime: string,
  signal?: AbortSignal,
): Promise<Pick<CallApiResult, 'images' | 'rawImageUrls'>> {
  const candidates = collectImageCandidates(payload)
  if (!candidates.length) {
    const err = new Error('LinAPI GPT 请求成功，但响应中没有可识别的图片数据。请在任务详情中查看原始响应。')
    ;(err as Error & { rawResponsePayload?: string }).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const images: string[] = []
  const rawImageUrls = candidates
    .filter((candidate): candidate is Extract<ImageCandidate, { kind: 'url' }> => candidate.kind === 'url' && isHttpUrl(candidate.value))
    .map((candidate) => candidate.value)
    .filter((url, index, urls) => urls.indexOf(url) === index)
  const seenImages = new Set<string>()
  try {
    for (const candidate of candidates) {
      const image = candidate.kind === 'base64'
        ? normalizeBase64Image(candidate.value, fallbackMime)
        : await fetchImageUrlAsDataUrl(candidate.value, fallbackMime, signal)
      if (!seenImages.has(image)) {
        seenImages.add(image)
        images.push(image)
      }
    }
  } catch (err) {
    if (err instanceof Error) {
      if (rawImageUrls.length) (err as Error & { rawImageUrls?: string[] }).rawImageUrls = rawImageUrls
      ;(err as Error & { rawResponsePayload?: string }).rawResponsePayload = JSON.stringify(payload, null, 2)
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('LinAPI GPT 响应中没有可用的图片数据。请在任务详情中查看原始响应。')
    ;(err as Error & { rawResponsePayload?: string }).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  return { images, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

function getRetryDelayMs(response: Response): number {
  const retryAfter = Number(response.headers.get('retry-after') ?? '')
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS)
  return DEFAULT_RETRY_DELAY_MS
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

async function fetchLinApiGptWithRetry(input: RequestInfo | URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let lastNetworkError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(input, init)
      if (response.ok || !RETRYABLE_STATUS_CODES.has(response.status) || attempt === 1) return response
      await sleep(getRetryDelayMs(response), signal)
    } catch (err) {
      lastNetworkError = err
      if (attempt === 1 || signal.aborted) throw err
      await sleep(DEFAULT_RETRY_DELAY_MS, signal)
    }
  }
  throw lastNetworkError instanceof Error ? lastNetworkError : new Error(String(lastNetworkError ?? 'LinAPI GPT 请求失败'))
}

async function createEditFormData(opts: CallApiOptions, profile: ApiProfile, requestSize: string, requestQuality: string, requestCount: number, responseFormat: string): Promise<FormData> {
  const formData = new FormData()
  formData.append('model', profile.model.trim() || DEFAULT_LINAPI_GPT_MODEL)
  formData.append('prompt', opts.prompt)
  formData.append('size', requestSize)
  formData.append('quality', requestQuality)
  formData.append('style', 'vivid')
  formData.append('n', String(requestCount))
  formData.append('response_format', responseFormat)

  const imageBlobs: Blob[] = []
  for (let i = 0; i < opts.inputImageDataUrls.length; i += 1) {
    const dataUrl = opts.inputImageDataUrls[i]
    const blob = opts.maskDataUrl && i === 0 ? await imageDataUrlToPngBlob(dataUrl) : await dataUrlToBlob(dataUrl)
    imageBlobs.push(blob)
  }

  const maskBlob = opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
  if (opts.maskDataUrl) {
    assertMaskEditFileSize('遮罩主图文件', imageBlobs[0]?.size ?? 0)
    assertMaskEditFileSize('遮罩文件', maskBlob?.size ?? 0)
  }
  assertImageInputPayloadSize(imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0))

  for (let i = 0; i < imageBlobs.length; i += 1) {
    const blob = imageBlobs[i]
    const ext = blob.type.split('/')[1] || 'png'
    formData.append('image[]', blob, `input-${i + 1}.${ext}`)
  }
  if (maskBlob) formData.append('mask', maskBlob, 'mask.png')

  return formData
}

export async function callLinApiGptImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const requestSize = getLinApiGptImageSize(opts.params.size)
  const requestQuality = opts.params.quality === 'high' ? 'hd' : 'standard'
  const requestCount = Math.min(10, Math.max(1, Math.trunc(opts.params.n || 1)))
  const responseFormat = profile.responseFormatB64Json ? 'b64_json' : 'url'
  const fallbackMime = MIME_MAP[opts.params.output_format] || 'image/png'
  const linkedAbort = createLinkedAbortController(profile.timeout, opts.signal)
  const isEdit = opts.inputImageDataUrls.length > 0

  try {
    const endpoint = getLinApiGptEndpoint(profile.baseUrl, isEdit ? 'images/edits' : 'images/generations')
    const requestInit: RequestInit = isEdit
      ? {
          method: 'POST',
          signal: linkedAbort.controller.signal,
          headers: { Authorization: `Bearer ${profile.apiKey}` },
          cache: 'no-store',
          body: await createEditFormData(opts, profile, requestSize, requestQuality, requestCount, responseFormat),
        }
      : {
          method: 'POST',
          signal: linkedAbort.controller.signal,
          headers: {
            Authorization: `Bearer ${profile.apiKey}`,
            'Content-Type': 'application/json',
          },
          cache: 'no-store',
          body: JSON.stringify({
            model: profile.model.trim() || DEFAULT_LINAPI_GPT_MODEL,
            prompt: opts.prompt,
            size: requestSize,
            quality: requestQuality,
            style: 'vivid',
            n: requestCount,
            response_format: responseFormat,
          }),
        }

    const response = await fetchLinApiGptWithRetry(endpoint, requestInit, linkedAbort.controller.signal)
    if (!response.ok) {
      throw new Error(`LinAPI GPT HTTP ${response.status}: ${await getApiErrorMessage(response)}`)
    }

    const parsed = await parseLinApiGptResponse(await readLinApiGptJson(response), fallbackMime, linkedAbort.controller.signal)
    const actualParams: Partial<TaskParams> = {
      size: requestSize,
      quality: requestQuality === 'hd' ? 'high' : opts.params.quality,
      output_format: opts.params.output_format,
      output_compression: null,
      n: parsed.images.length,
    }
    return {
      ...parsed,
      actualParams,
      actualParamsList: parsed.images.map(() => ({ ...actualParams, n: 1 })),
    }
  } finally {
    linkedAbort.cleanup()
  }
}
