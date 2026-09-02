import { storeImage } from './db'

export interface StylePreset {
  id: string
  label: string
  description: string
  etsyPhotographyDescription: string
  fileName: string
  palette: string[]
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'clean-tech',
    label: '清爽科技',
    description: '冷色光感、干净层级、精准标注，适合电子、工具、办公类产品。',
    etsyPhotographyDescription: 'Cool clean illumination, crisp neutral whites, restrained cyan and teal accents in the physical set, precise tonal separation, and an uncluttered premium studio finish.',
    fileName: 'clean-tech.png',
    palette: ['#F8FAFC', '#E0F2FE', '#38BDF8', '#0F172A', '#94A3B8', '#14B8A6'],
  },
  {
    id: 'natural-warm',
    label: '自然暖调',
    description: '柔和日光、自然材质、温暖背景，适合家居、母婴、户外生活类产品。',
    etsyPhotographyDescription: 'Soft natural daylight, warm neutral surroundings, tactile real materials, gentle contrast, and a calm handcrafted editorial finish.',
    fileName: 'natural-warm.png',
    palette: ['#FFF8ED', '#F4D6A6', '#C58A45', '#2F3A2F', '#8FA478', '#E76F51'],
  },
  {
    id: 'premium-contrast',
    label: '高级对比',
    description: '深浅对比、金属质感、编辑感聚焦，适合高客单、礼品、精品配件。',
    etsyPhotographyDescription: 'Refined light-dark contrast, controlled specular highlights, focused editorial composition, restrained warm-metal accents, and a premium collectible finish.',
    fileName: 'premium-contrast.png',
    palette: ['#F5F5F4', '#D6D3D1', '#A8A29E', '#111827', '#C8A24A', '#7C2D12'],
  },
  {
    id: 'bright-retail',
    label: '明亮零售',
    description: '明快色块、清晰卖点区域、购物页友好，适合快消、厨房、运动配件。',
    etsyPhotographyDescription: 'Bright even commercial light, clean high-key surfaces, lively but restrained color accents, clear product separation, and an approachable polished retail finish.',
    fileName: 'bright-retail.png',
    palette: ['#FFFFFF', '#FEF3C7', '#F97316', '#2563EB', '#16A34A', '#111827'],
  },
]

export const DEFAULT_STYLE_PRESET_ID = STYLE_PRESETS[0]?.id ?? ''

function getBaseUrl() {
  const base = import.meta.env.BASE_URL || './'
  return base.endsWith('/') ? base : `${base}/`
}

export function getStylePresetById(id: string | null | undefined): StylePreset | null {
  if (!id) return null
  return STYLE_PRESETS.find((preset) => preset.id === id) ?? null
}

export function getStylePresetAssetUrl(preset: Pick<StylePreset, 'fileName'>): string {
  return `${getBaseUrl()}style-presets/${preset.fileName}`
}

function escapeSvgText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function getStylePresetFallbackDataUrl(preset: Pick<StylePreset, 'label' | 'description' | 'palette'>): string {
  const palette = preset.palette.length ? preset.palette : ['#0F172A', '#334155', '#94A3B8', '#F8FAFC']
  const colors = Array.from({ length: 6 }, (_, index) => palette[index % palette.length]!)
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="840" height="840" viewBox="0 0 840 840">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${colors[0]}"/>
          <stop offset="1" stop-color="${colors[3]}"/>
        </linearGradient>
        <filter id="shadow"><feDropShadow dx="0" dy="16" stdDeviation="22" flood-opacity="0.24"/></filter>
      </defs>
      <rect width="840" height="840" fill="url(#bg)"/>
      <circle cx="690" cy="150" r="180" fill="${colors[1]}" opacity="0.32"/>
      <circle cx="120" cy="720" r="220" fill="${colors[4]}" opacity="0.28"/>
      <rect x="76" y="82" width="688" height="676" rx="44" fill="#0B0F19" fill-opacity="0.78" stroke="#FFFFFF" stroke-opacity="0.18" filter="url(#shadow)"/>
      <rect x="116" y="128" width="608" height="320" rx="30" fill="#FFFFFF" fill-opacity="0.1"/>
      <circle cx="420" cy="286" r="116" fill="${colors[2]}" opacity="0.92"/>
      <circle cx="420" cy="286" r="72" fill="${colors[5]}" opacity="0.82"/>
      <path d="M250 410 C330 334 510 334 590 410" fill="none" stroke="#FFFFFF" stroke-opacity="0.66" stroke-width="16" stroke-linecap="round"/>
      <text x="116" y="520" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="42" font-weight="700">${escapeSvgText(preset.label)}</text>
      <text x="116" y="572" fill="#FFFFFF" fill-opacity="0.68" font-family="Arial, sans-serif" font-size="22" letter-spacing="3">BUILT-IN VISUAL STYLE</text>
      ${colors.map((color, index) => `<rect x="${116 + index * 92}" y="672" width="72" height="34" rx="12" fill="${color}" stroke="#FFFFFF" stroke-opacity="0.3"/>`).join('')}
    </svg>
  `.trim()
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}

export async function loadStylePresetDataUrl(presetId: string, signal?: AbortSignal): Promise<string> {
  const preset = getStylePresetById(presetId)
  if (!preset) throw new Error('预设风格不存在')

  try {
    const response = await fetch(getStylePresetAssetUrl(preset), {
      cache: 'force-cache',
      signal,
    })
    if (!response.ok) throw new Error(`预设风格图加载失败：HTTP ${response.status}`)
    const blob = await response.blob()
    if (!blob.type.startsWith('image/')) throw new Error('预设风格图不是有效图片')
    return blobToDataUrl(blob)
  } catch (error) {
    if (signal?.aborted) throw error
    return getStylePresetFallbackDataUrl(preset)
  }
}

export async function ensureStylePresetImageStored(presetId: string, signal?: AbortSignal): Promise<{
  preset: StylePreset
  imageId: string
  dataUrl: string
}> {
  const preset = getStylePresetById(presetId)
  if (!preset) throw new Error('预设风格不存在')

  const dataUrl = await loadStylePresetDataUrl(preset.id, signal)
  const imageId = await storeImage(dataUrl, 'preset')
  return { preset, imageId, dataUrl }
}
