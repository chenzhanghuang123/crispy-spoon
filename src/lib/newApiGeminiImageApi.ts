import type { ApiProfile, TaskParams } from '../types'
import {
  assertImageInputPayloadSize,
  createLinkedAbortController,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
  normalizeBase64Image,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'

export type NewApiGeminiImageSize = '1K' | '2K' | '4K'

interface NewApiGeminiInlineData {
  mimeType?: unknown
  mime_type?: unknown
  data?: unknown
}

interface NewApiGeminiPart {
  text?: unknown
  inlineData?: NewApiGeminiInlineData
  inline_data?: NewApiGeminiInlineData
}

interface NewApiGeminiResponse {
  candidates?: Array<{
    content?: { parts?: NewApiGeminiPart[] }
    finishReason?: unknown
    finish_reason?: unknown
  }>
}

interface ParsedDataUrl {
  mimeType: string
  data: string
}

const SUPPORTED_ASPECT_RATIOS = [
  { label: '1:1', value: 1 },
  { label: '2:3', value: 2 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '3:4', value: 3 / 4 },
  { label: '4:3', value: 4 / 3 },
  { label: '4:5', value: 4 / 5 },
  { label: '5:4', value: 5 / 4 },
  { label: '9:16', value: 9 / 16 },
  { label: '16:9', value: 16 / 9 },
  { label: '21:9', value: 21 / 9 },
] as const

function parseDimensions(size: string): { width: number; height: number } | null {
  const match = size.trim().match(/^(\d+)\s*[xX\u00d7]\s*(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null
}

export function getNewApiGeminiImageSize(size: string): NewApiGeminiImageSize {
  const dimensions = parseDimensions(size)
  if (!dimensions) return '1K'
  const pixels = dimensions.width * dimensions.height
  if (pixels > 4_194_304 || Math.max(dimensions.width, dimensions.height) > 2_048) return '4K'
  if (pixels > 1_572_864 || Math.max(dimensions.width, dimensions.height) > 1_536) return '2K'
  return '1K'
}

export function getNewApiGeminiAspectRatio(size: string): string {
  const dimensions = parseDimensions(size)
  if (!dimensions) return '1:1'
  const ratio = dimensions.width / dimensions.height
  return SUPPORTED_ASPECT_RATIOS
    .map((item) => ({ ...item, distance: Math.abs(item.value - ratio) / item.value }))
    .sort((left, right) => left.distance - right.distance)[0]?.label ?? '1:1'
}

function getNewApiRootUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
    .replace(/\/v1beta\/models\/[^/?]+:generateContent$/i, '')
    .replace(/\/(?:v1|v1beta)$/i, '')
  if (!normalized) throw new Error('New API Gemini 缺少 API URL')
  return normalized
}

function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const commaIndex = dataUrl.indexOf(',')
  const metadata = commaIndex >= 0 ? dataUrl.slice(0, commaIndex) : ''
  const data = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : ''
  const mimeType = metadata.match(/^data:([^;,]+)/i)?.[1] || 'image/png'
  if (!metadata.startsWith('data:') || !/;base64(?:;|$)/i.test(metadata) || !data.trim()) {
    throw new Error('New API Gemini 参考图必须是有效的 Base64 data URL')
  }
  return { mimeType, data: data.replace(/\s/g, '') }
}

function getOutputFormat(mimeType: string): TaskParams['output_format'] {
  if (mimeType.toLowerCase() === 'image/jpeg') return 'jpeg'
  if (mimeType.toLowerCase() === 'image/webp') return 'webp'
  return 'png'
}

function collectImages(payload: NewApiGeminiResponse) {
  return (payload.candidates ?? []).flatMap((candidate) =>
    (candidate.content?.parts ?? []).flatMap((part) => {
      const inlineData = part.inlineData ?? part.inline_data
      const data = typeof inlineData?.data === 'string' ? inlineData.data.trim() : ''
      if (!data) return []
      const rawMimeType = inlineData?.mimeType ?? inlineData?.mime_type
      const mimeType = typeof rawMimeType === 'string' && rawMimeType.trim() ? rawMimeType.trim() : 'image/png'
      return [{
        dataUrl: normalizeBase64Image(data, mimeType),
        outputFormat: getOutputFormat(mimeType),
      }]
    }),
  )
}

function getNoImageMessage(payload: NewApiGeminiResponse): string {
  const candidates = payload.candidates ?? []
  const responseText = candidates
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => typeof part.text === 'string' ? part.text.trim() : '')
    .filter(Boolean)
    .join('\n')
  const finishReason = candidates
    .map((candidate) => candidate.finishReason ?? candidate.finish_reason)
    .find((value): value is string => typeof value === 'string' && Boolean(value))
  return [
    'New API Gemini 请求成功，但响应中没有图片数据。',
    finishReason ? `完成原因：${finishReason}` : '',
    responseText,
  ].filter(Boolean).join('\n')
}

async function requestNewApiGeminiImage(
  opts: CallApiOptions,
  profile: ApiProfile,
  signal: AbortSignal,
) {
  if (opts.maskDataUrl) {
    throw new Error('New API Gemini 支持普通参考图编辑，但不支持独立遮罩编辑；请移除遮罩后重试。')
  }

  assertImageInputPayloadSize(opts.inputImageDataUrls.reduce(
    (total, dataUrl) => total + getDataUrlDecodedByteSize(dataUrl),
    0,
  ))

  const imageSize = getNewApiGeminiImageSize(opts.params.size)
  const aspectRatio = getNewApiGeminiAspectRatio(opts.params.size)
  const parts: Array<Record<string, unknown>> = [
    { text: opts.prompt },
    ...opts.inputImageDataUrls.map((dataUrl) => ({ inlineData: parseDataUrl(dataUrl) })),
  ]
  const model = profile.model.trim()
  const url = `${getNewApiRootUrl(profile.baseUrl)}/v1beta/models/${encodeURIComponent(model)}:generateContent/`
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio, imageSize },
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`New API Gemini HTTP ${response.status}: ${await getApiErrorMessage(response)}`)
  }

  const payload = await response.json() as NewApiGeminiResponse
  const images = collectImages(payload)
  if (!images.length) throw new Error(getNoImageMessage(payload))
  return images
}

export async function callNewApiGeminiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const requestCount = Math.min(4, Math.max(1, Math.trunc(opts.params.n || 1)))
  const linkedAbort = createLinkedAbortController(profile.timeout, opts.signal)
  try {
    const results = await Promise.all(Array.from(
      { length: requestCount },
      () => requestNewApiGeminiImage(opts, profile, linkedAbort.controller.signal),
    ))
    const images = results.flat()
    const outputFormats = images.map((image) => image.outputFormat)
    const commonOutputFormat = outputFormats.every((format) => format === outputFormats[0])
      ? outputFormats[0]
      : undefined
    return {
      images: images.map((image) => image.dataUrl),
      actualParams: {
        ...(commonOutputFormat ? { output_format: commonOutputFormat } : {}),
        quality: 'high',
        output_compression: null,
        n: images.length,
      },
      actualParamsList: images.map((image) => ({
        output_format: image.outputFormat,
        quality: 'high',
        output_compression: null,
        n: 1,
      })),
    }
  } finally {
    linkedAbort.cleanup()
  }
}
