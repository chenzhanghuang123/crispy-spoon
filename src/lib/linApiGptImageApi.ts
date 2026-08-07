import type { ApiProfile, TaskParams } from '../types'
import { DEFAULT_LINAPI_GPT_BASE_URL, DEFAULT_LINAPI_GPT_MODEL } from './apiProfiles'
import {
  assertImageInputPayloadSize,
  createLinkedAbortController,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
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

function getLinApiGptEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '') || DEFAULT_LINAPI_GPT_BASE_URL
  return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`
}

function createMessageContent(prompt: string, inputImageDataUrls: string[]): unknown {
  if (!inputImageDataUrls.length) return prompt
  return [
    { type: 'text', text: prompt },
    ...inputImageDataUrls.map((dataUrl) => ({
      type: 'image_url',
      image_url: { url: dataUrl },
    })),
  ]
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

export async function callLinApiGptImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (opts.maskDataUrl) {
    throw new Error('LinAPI GPT 生图支持普通参考图编辑，但暂不支持独立遮罩编辑；请移除遮罩后重试。')
  }

  assertImageInputPayloadSize(opts.inputImageDataUrls.reduce(
    (total, dataUrl) => total + getDataUrlDecodedByteSize(dataUrl),
    0,
  ))

  const requestSize = getLinApiGptImageSize(opts.params.size)
  const requestQuality = opts.params.quality === 'high' ? 'hd' : 'standard'
  const requestCount = Math.min(10, Math.max(1, Math.trunc(opts.params.n || 1)))
  const responseFormat = profile.responseFormatB64Json ? 'b64_json' : 'url'
  const fallbackMime = MIME_MAP[opts.params.output_format] || 'image/png'
  const linkedAbort = createLinkedAbortController(profile.timeout, opts.signal)

  try {
    const response = await fetch(getLinApiGptEndpoint(profile.baseUrl), {
      method: 'POST',
      signal: linkedAbort.controller.signal,
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({
        model: profile.model.trim() || DEFAULT_LINAPI_GPT_MODEL,
        messages: [{
          role: 'user',
          content: createMessageContent(opts.prompt, opts.inputImageDataUrls),
        }],
        temperature: 0.7,
        size: requestSize,
        quality: requestQuality,
        style: 'vivid',
        n: requestCount,
        response_format: responseFormat,
      }),
    })

    if (!response.ok) {
      throw new Error(`LinAPI GPT HTTP ${response.status}: ${await getApiErrorMessage(response)}`)
    }

    const parsed = await parseLinApiGptResponse(await response.json(), fallbackMime, linkedAbort.controller.signal)
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
