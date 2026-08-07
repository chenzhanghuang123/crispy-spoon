import type { ApiProfile, TaskParams } from '../types'
import { DEFAULT_LINAPI_BASE_URL, DEFAULT_LINAPI_MODEL } from './apiProfiles'
import {
  assertImageInputPayloadSize,
  createLinkedAbortController,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
  normalizeBase64Image,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'

export type LinApiImageSize = '1K' | '2K' | '4K'

interface LinApiInlineData {
  mimeType?: unknown
  data?: unknown
}

interface LinApiPart {
  text?: unknown
  inlineData?: LinApiInlineData
  inline_data?: LinApiInlineData
}

interface LinApiCandidate {
  content?: {
    parts?: LinApiPart[]
  }
  finishReason?: unknown
}

interface LinApiResponse {
  candidates?: LinApiCandidate[]
}

interface ParsedDataUrl {
  mimeType: string
  data: string
}

const LINAPI_RATIOS = [
  { label: '1:1', value: 1 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '3:4', value: 3 / 4 },
  { label: '4:3', value: 4 / 3 },
] as const

function normalizeLinApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '') || DEFAULT_LINAPI_BASE_URL
  return trimmed.replace(/\/v1beta$/i, '')
}

function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const commaIndex = dataUrl.indexOf(',')
  const metadata = commaIndex >= 0 ? dataUrl.slice(0, commaIndex) : ''
  const data = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : ''
  const mimeType = metadata.match(/^data:([^;,]+)/i)?.[1] || 'image/png'
  if (!metadata.startsWith('data:') || !/;base64(?:;|$)/i.test(metadata) || !data.trim()) {
    throw new Error('LinAPI 参考图必须是有效的 Base64 data URL')
  }
  return {
    mimeType,
    data: data.replace(/\s/g, ''),
  }
}

function parseDimensions(size: string): { width: number; height: number } | null {
  const match = size.trim().match(/^(\d+)\s*[xX\u00d7]\s*(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null
}

function getModelSizeSuffix(model: string): LinApiImageSize | null {
  const match = model.trim().match(/-(2K|4K)$/i)
  return match ? match[1].toUpperCase() as LinApiImageSize : null
}

export function getLinApiImageSize(size: string, model: string): LinApiImageSize {
  const dimensions = parseDimensions(size)
  if (!dimensions) return getModelSizeSuffix(model) ?? '1K'

  const pixels = dimensions.width * dimensions.height
  if (pixels > 4_194_304 || Math.max(dimensions.width, dimensions.height) > 2_048) return '4K'
  if (pixels > 1_572_864 || Math.max(dimensions.width, dimensions.height) > 1_536) return '2K'
  return '1K'
}

export function getLinApiAspectRatio(size: string): string {
  const dimensions = parseDimensions(size)
  if (!dimensions) return '1:1'
  const ratio = dimensions.width / dimensions.height
  return LINAPI_RATIOS
    .map((item) => ({ ...item, distance: Math.abs(item.value - ratio) / item.value }))
    .sort((left, right) => left.distance - right.distance)[0]?.label ?? '1:1'
}

export function getLinApiRequestModel(model: string, imageSize: LinApiImageSize): string {
  const configured = model.trim() || DEFAULT_LINAPI_MODEL
  const baseModel = configured.replace(/-(?:2K|4K)$/i, '')
  return imageSize === '1K' ? baseModel : `${baseModel}-${imageSize}`
}

function getOutputFormat(mimeType: string): TaskParams['output_format'] {
  if (mimeType.toLowerCase() === 'image/jpeg') return 'jpeg'
  if (mimeType.toLowerCase() === 'image/webp') return 'webp'
  return 'png'
}

function getEncodedImageSize(data: string, mimeType: string): string | undefined {
  let binary: string
  try {
    binary = atob(data.replace(/\s/g, ''))
  } catch {
    return undefined
  }
  const byte = (index: number) => binary.charCodeAt(index) & 0xff

  if (mimeType.toLowerCase() === 'image/png' && binary.length >= 24) {
    const width = byte(16) * 0x1000000 + byte(17) * 0x10000 + byte(18) * 0x100 + byte(19)
    const height = byte(20) * 0x1000000 + byte(21) * 0x10000 + byte(22) * 0x100 + byte(23)
    return width > 0 && height > 0 ? `${width}x${height}` : undefined
  }

  if (mimeType.toLowerCase() === 'image/jpeg' && binary.length >= 4 && byte(0) === 0xff && byte(1) === 0xd8) {
    const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
    let offset = 2
    while (offset + 8 < binary.length) {
      if (byte(offset) !== 0xff) {
        offset += 1
        continue
      }
      while (offset < binary.length && byte(offset) === 0xff) offset += 1
      const marker = byte(offset)
      offset += 1
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 1 >= binary.length) break
      const segmentLength = byte(offset) * 0x100 + byte(offset + 1)
      if (segmentLength < 2 || offset + segmentLength > binary.length) break
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        const height = byte(offset + 3) * 0x100 + byte(offset + 4)
        const width = byte(offset + 5) * 0x100 + byte(offset + 6)
        return width > 0 && height > 0 ? `${width}x${height}` : undefined
      }
      offset += segmentLength
    }
  }

  return undefined
}

interface LinApiGeneratedImage {
  dataUrl: string
  outputFormat: TaskParams['output_format']
  size?: string
}

function collectImages(payload: LinApiResponse): LinApiGeneratedImage[] {
  const images: LinApiGeneratedImage[] = []
  for (const candidate of payload.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inlineData = part.inlineData ?? part.inline_data
      const data = typeof inlineData?.data === 'string' ? inlineData.data.trim() : ''
      if (!data) continue
      const mimeType = typeof inlineData?.mimeType === 'string' && inlineData.mimeType.trim()
        ? inlineData.mimeType.trim()
        : 'image/png'
      images.push({
        dataUrl: normalizeBase64Image(data, mimeType),
        outputFormat: getOutputFormat(mimeType),
        size: getEncodedImageSize(data, mimeType),
      })
    }
  }
  return images
}

function getNoImageMessage(payload: LinApiResponse): string {
  const candidates = payload.candidates ?? []
  const responseText = candidates
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => typeof part.text === 'string' ? part.text.trim() : '')
    .filter(Boolean)
    .join('\n')
  const finishReason = candidates
    .map((candidate) => typeof candidate.finishReason === 'string' ? candidate.finishReason : '')
    .find(Boolean)
  return [
    'LinAPI 请求成功，但响应中没有图片数据。',
    finishReason ? `完成原因：${finishReason}` : '',
    responseText,
  ].filter(Boolean).join('\n')
}

async function requestLinApiImage(
  opts: CallApiOptions,
  profile: ApiProfile,
  signal: AbortSignal,
): Promise<LinApiGeneratedImage[]> {
  if (opts.maskDataUrl) {
    throw new Error('LinAPI 当前支持普通参考图编辑，但不支持独立遮罩编辑；请移除遮罩后重试。')
  }

  assertImageInputPayloadSize(opts.inputImageDataUrls.reduce(
    (total, dataUrl) => total + getDataUrlDecodedByteSize(dataUrl),
    0,
  ))

  const imageSize = getLinApiImageSize(opts.params.size, profile.model)
  const aspectRatio = getLinApiAspectRatio(opts.params.size)
  const requestModel = getLinApiRequestModel(profile.model, imageSize)
  const parts: Array<Record<string, unknown>> = [
    { text: opts.prompt },
    ...opts.inputImageDataUrls.map((dataUrl) => ({ inlineData: parseDataUrl(dataUrl) })),
  ]
  const url = `${normalizeLinApiBaseUrl(profile.baseUrl)}/v1beta/models/${encodeURIComponent(requestModel)}:generateContent`
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        imageConfig: {
          aspectRatio,
          imageSize,
        },
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`LinAPI HTTP ${response.status}: ${await getApiErrorMessage(response)}`)
  }

  const payload = await response.json() as LinApiResponse
  const images = collectImages(payload)
  if (!images.length) throw new Error(getNoImageMessage(payload))
  return images
}

export async function callLinApiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const requestCount = Math.min(4, Math.max(1, Math.trunc(opts.params.n || 1)))
  const linkedAbort = createLinkedAbortController(profile.timeout, opts.signal)
  try {
    const results = await Promise.all(Array.from(
      { length: requestCount },
      () => requestLinApiImage(opts, profile, linkedAbort.controller.signal),
    ))
    const images = results.flat()
    const outputFormats = images.map((image) => image.outputFormat)
    const commonOutputFormat = outputFormats.every((format) => format === outputFormats[0])
      ? outputFormats[0]
      : undefined
    const actualSizes = images.map((image) => image.size)
    const commonActualSize = actualSizes[0] && actualSizes.every((size) => size === actualSizes[0])
      ? actualSizes[0]
      : undefined
    return {
      images: images.map((image) => image.dataUrl),
      actualParams: {
        ...(commonOutputFormat ? { output_format: commonOutputFormat } : {}),
        ...(commonActualSize ? { size: commonActualSize } : {}),
        quality: 'high',
        output_compression: null,
        n: images.length,
      },
      actualParamsList: images.map((image) => ({
        output_format: image.outputFormat,
        ...(image.size ? { size: image.size } : {}),
        quality: 'high',
        output_compression: null,
        n: 1,
      })),
    }
  } finally {
    linkedAbort.cleanup()
  }
}
