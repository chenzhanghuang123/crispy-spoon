import type { AmazonImageKind, AmazonPromptDraft } from './amazonPrompt'
import type { AmazonStyleDensityMode, EtsyShotPhotographyDecision } from '../types'
import { calculateImageSize, type SizeTier } from './size'
import { getAmazonMarketplace, type AmazonMarketplaceId } from './amazonMarketplaces'

export type AmazonPlannerMode = 'listing' | 'aplus' | 'etsy'
export type { AmazonStyleDensityMode } from '../types'
export type APlusContentType = 'standard' | 'standard-large' | 'premium' | 'mobile'
export type APlusModuleKind =
  | 'header-banner'
  | 'single-image'
  | 'highlight-tile'
  | 'hero-banner'
  | 'feature-image'
  | 'brand-story'
  | 'logo'
  | 'comparison-thumbnail'

export const A_PLUS_CONTENT_TYPES: APlusContentType[] = ['standard-large', 'standard', 'premium', 'mobile']
export const MIN_A_PLUS_MODULE_COUNT = 1
export const MAX_A_PLUS_MODULE_COUNT = 12

const A_PLUS_MODULE_KINDS: APlusModuleKind[] = [
  'header-banner',
  'single-image',
  'highlight-tile',
  'hero-banner',
  'feature-image',
  'brand-story',
  'logo',
  'comparison-thumbnail',
]

export interface ListingParseResult {
  title: string
  bullets: string[]
  inferred: Partial<AmazonPromptDraft>
}

export interface AmazonImagePlan {
  slot: string
  label: string
  kind?: AmazonImageKind
  planMarkdown: string
  prompt: string
  negativePrompt: string
  photographyDecision?: EtsyShotPhotographyDecision
}

export interface AmazonAPlusModuleSpec {
  contentType: APlusContentType | 'optional'
  slot: string
  label: string
  displayLabel: string
  moduleType: APlusModuleKind
  uploadWidth: number
  uploadHeight: number
  objective: string
}

export interface AmazonAPlusPlan {
  slot: string
  label: string
  moduleType: APlusModuleKind
  uploadSize: string
  generationSize: string
  planMarkdown: string
  textTitle: string
  textBody: string
  prompt: string
  negativePrompt: string
}

export const STANDARD_A_PLUS_MODULE_SPECS: AmazonAPlusModuleSpec[] = [
  {
    contentType: 'standard',
    slot: 'A+S01',
    label: 'Header Banner',
    displayLabel: '顶部横幅',
    moduleType: 'header-banner',
    uploadWidth: 970,
    uploadHeight: 300,
    objective: '用横幅建立品牌质感和核心产品利益点。',
  },
  ...Array.from({ length: 3 }, (_, index) => ({
    contentType: 'standard' as const,
    slot: `A+S0${index + 2}`,
    label: `Single Image ${index + 1}`,
    displayLabel: `大图模块 ${index + 1}`,
    moduleType: 'single-image' as const,
    uploadWidth: 970,
    uploadHeight: 600,
    objective: '用单图模块讲清一个关键卖点或使用场景。',
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    contentType: 'standard' as const,
    slot: `A+S0${index + 5}`,
    label: `Highlight Tile ${index + 1}`,
    displayLabel: `卖点方块 ${index + 1}`,
    moduleType: 'highlight-tile' as const,
    uploadWidth: 220,
    uploadHeight: 220,
    objective: '用方形图块快速呈现一个产品亮点。',
  })),
]

export const STANDARD_LARGE_A_PLUS_MODULE_SPECS: AmazonAPlusModuleSpec[] = [
  {
    contentType: 'standard-large',
    slot: 'A+L01',
    label: 'Header Banner',
    displayLabel: '顶部横幅',
    moduleType: 'header-banner',
    uploadWidth: 970,
    uploadHeight: 300,
    objective: '用横幅建立品牌质感和核心产品利益点。',
  },
  ...Array.from({ length: 4 }, (_, index) => ({
    contentType: 'standard-large' as const,
    slot: `A+L0${index + 2}`,
    label: `Single Image ${index + 1}`,
    displayLabel: `大图模块 ${index + 1}`,
    moduleType: 'single-image' as const,
    uploadWidth: 970,
    uploadHeight: 600,
    objective: '用整张大图讲清一个关键卖点、使用场景或细节证据。',
  })),
]

export const PREMIUM_A_PLUS_MODULE_SPECS: AmazonAPlusModuleSpec[] = [
  {
    contentType: 'premium',
    slot: 'A+P01',
    label: 'Hero Banner',
    displayLabel: '高级首屏横幅',
    moduleType: 'hero-banner',
    uploadWidth: 1464,
    uploadHeight: 600,
    objective: '用高级横幅建立首屏视觉冲击和品牌氛围。',
  },
  ...Array.from({ length: 3 }, (_, index) => ({
    contentType: 'premium' as const,
    slot: `A+P0${index + 2}`,
    label: `Feature Image ${index + 1}`,
    displayLabel: `高级大图模块 ${index + 1}`,
    moduleType: 'feature-image' as const,
    uploadWidth: 970,
    uploadHeight: 600,
    objective: '用大图模块展示核心功能、材质或真实场景。',
  })),
  ...Array.from({ length: 2 }, (_, index) => ({
    contentType: 'premium' as const,
    slot: `A+P0${index + 5}`,
    label: `Brand Story ${index + 1}`,
    displayLabel: `品牌故事 ${index + 1}`,
    moduleType: 'brand-story' as const,
    uploadWidth: 463,
    uploadHeight: 625,
    objective: '用竖版品牌故事模块强化信任和使用想象。',
  })),
]

export const MOBILE_A_PLUS_MODULE_SPECS: AmazonAPlusModuleSpec[] = [
  {
    contentType: 'mobile',
    slot: 'A+M01',
    label: 'Mobile Hero',
    displayLabel: '手机首屏',
    moduleType: 'hero-banner',
    uploadWidth: 600,
    uploadHeight: 450,
    objective: '用移动端首屏图建立产品核心卖点和清晰视觉吸引力。',
  },
  ...Array.from({ length: 4 }, (_, index) => ({
    contentType: 'mobile' as const,
    slot: `A+M0${index + 2}`,
    label: `Mobile Feature ${index + 1}`,
    displayLabel: `手机卖点图 ${index + 1}`,
    moduleType: 'feature-image' as const,
    uploadWidth: 600,
    uploadHeight: 450,
    objective: '用移动端友好的 4:3 图片讲清一个关键卖点、细节证据或使用场景。',
  })),
]

export const OPTIONAL_A_PLUS_MODULE_SPECS: AmazonAPlusModuleSpec[] = [
  {
    contentType: 'optional',
    slot: 'A+LOGO',
    label: 'Logo Image',
    displayLabel: '品牌 Logo',
    moduleType: 'logo',
    uploadWidth: 600,
    uploadHeight: 180,
    objective: '用于已有品牌标志素材，不默认生成虚构 Logo。',
  },
  {
    contentType: 'optional',
    slot: 'A+CMP',
    label: 'Comparison Thumbnail',
    displayLabel: '对比缩略图',
    moduleType: 'comparison-thumbnail',
    uploadWidth: 150,
    uploadHeight: 300,
    objective: '用于同品牌 SKU 对比，不默认生成不确定对比信息。',
  },
]

const CJK_ON_IMAGE_TEXT_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
const STYLE_REFERENCE_GUARD = [
  'Style reference rule:',
  '- The last input image is a hidden style reference selected by the user.',
  '- Use it only for color palette, lighting, contrast, material finish, typography feel, and overall visual polish.',
  '- The selected visual style text block is higher priority than any conflicting aesthetic language in the image task or series style guide.',
  '- Do not copy any placeholder words, fixed layout, color swatch positions, exact composition, product arrangement, product count, props, scene, or information density from the style reference board.',
  '- Follow the image task, layout density, and negative prompt sections for the actual content and arrangement.',
].join('\n')

const ETSY_ADAPTIVE_STYLE_REFERENCE_GUARD = [
  'Etsy style reference rule:',
  '- The last input image is a hidden style reference selected by the user.',
  '- Use it only for the surrounding set-design language, supporting palette, prop styling, contrast character, and cohesive campaign polish.',
  '- The AI photographer capture decision is higher priority for camera position, product orientation, shot scale, optics, exposure, focus plane, lighting geometry, reflection control, and the actual scene content.',
  '- Never let the style reference change the product material, finish, color, geometry, proportions, components, quantity, text, logo, or verified details.',
  '- Do not copy its placeholder words, fixed layout, swatch positions, exact composition, product arrangement, product count, props, or scene.',
].join('\n')

export const DEFAULT_LISTING_IMAGE_COUNT = 7
export const MIN_LISTING_IMAGE_COUNT = 7
export const MAX_LISTING_IMAGE_COUNT = 12
export const LISTING_IMAGE_COUNT_OPTIONS = Array.from(
  { length: MAX_LISTING_IMAGE_COUNT - MIN_LISTING_IMAGE_COUNT + 1 },
  (_, index) => MIN_LISTING_IMAGE_COUNT + index,
)

export function normalizeListingImageCount(value: unknown): number {
  const count = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : DEFAULT_LISTING_IMAGE_COUNT
  if (!Number.isFinite(count)) return DEFAULT_LISTING_IMAGE_COUNT
  return Math.min(MAX_LISTING_IMAGE_COUNT, Math.max(MIN_LISTING_IMAGE_COUNT, Math.trunc(count)))
}

export function getAmazonListingImageSlots(count: unknown = DEFAULT_LISTING_IMAGE_COUNT): string[] {
  const normalizedCount = normalizeListingImageCount(count)
  return [
    'MAIN',
    ...Array.from({ length: normalizedCount - 1 }, (_, index) => `PT${String(index + 1).padStart(2, '0')}`),
  ]
}

export const ETSY_ORIGINAL_SHOT_COUNT = 10
export const ETSY_ADDITIONAL_SHOT_COUNT = 5
export const ETSY_SHOT_COUNT = ETSY_ORIGINAL_SHOT_COUNT + ETSY_ADDITIONAL_SHOT_COUNT
export const ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS = 'Shot on Hasselblad X2D 100C, 100mm lens, f/2.8, 8k resolution, photorealistic, hyper-detailed, cinematic lighting, volumetric light, raytracing, global illumination, 1:1 aspect ratio'

export const ETSY_ADDITIONAL_SHOT_BRIEFS = [
  {
    slot: 'E11',
    label: '吸睛首页图',
    planRequirement: '打造一张能在 Etsy 搜索缩略图中立刻抓住买家视线的首屏主图：产品必须一眼可识别、主体占比明确、层次干净、情绪强烈且具高级手作品牌感；场景必须依据该产品的视觉 DNA 定制，不使用文字贴纸、促销角标或通用模板。',
    promptRequirement: 'Create a scroll-stopping Etsy cover image that remains instantly readable at small search-thumbnail size. The exact product must be the unmistakable visual hero with immediate category recognition, premium handmade desirability, clean hierarchy, and no text or promotional graphics.',
    compositionRequirement: 'Choose the most truthful selling angle for the product category: straight-on for flat or framed work, a controlled three-quarter angle for dimensional objects, or overhead only for products genuinely sold as flat lays. Keep the complete product visible, undistorted, uncropped, and approximately 70-82% of the frame. Use no more than two quiet supporting props, never overlapping the product.',
    cameraRequirement: 'Phase One XF IQ4 150MP with Schneider Kreuznach 80mm LS lens, ISO 50, f/8, 1/125s, tripod, perspective correction, full-product sharpness, natural medium-format depth and micro-contrast.',
    lightingRequirement: 'Broncolor Scoro lighting with a large diffused key shaped to the real material, soft controlled fill, narrow separation light only when needed, black flags for edge definition, and reflection control that preserves true color and texture without glare.',
    finishRequirement: 'Premium but believable commercial photography, clean tonal separation, realistic contact shadows, accurate white balance, refined retouching, no HDR halos, no CGI sheen, and a final 150-pixel thumbnail legibility check.',
    negativeRequirement: 'weak thumbnail impact, tiny product, cropped product, warped geometry, wrong proportions, confusing focal point, generic stock scene, excessive props, text overlay, promotional badge, CGI render, artificial haze',
  },
  {
    slot: 'E12',
    label: '尺寸规格图',
    planRequirement: '制作清晰、优雅、可信的尺寸与比例图，只能使用用户资料中已验证的尺寸、容量、重量或规格；以简洁测量线、比例参照和易读层级减少购买疑虑。若缺少数字尺寸，不得编造，改用真实通用参照表达比例，并在中文策划中注明需要卖家确认数字。',
    promptRequirement: 'Create a precise premium size and scale image that removes purchase uncertainty. Display only dimensions, capacity, weight, quantity, and specifications explicitly verified in the product facts. Never infer, round, convert, or invent a number.',
    compositionRequirement: 'Use a straight-on or true orthographic product view with corrected verticals, the complete product at approximately 62-72% of the frame, generous clean margins, thin measurement lines, restrained arrowheads, and a maximum of three verified labels. Keep labels outside the product silhouette. If no numeric size is verified, omit all numbers and use one universally recognizable scale reference instead.',
    cameraRequirement: 'Phase One XF IQ4 150MP with Schneider Kreuznach 80mm LS lens, ISO 50, f/11, tripod, calibrated camera height, zero keystone distortion, edge-to-edge sharpness, and accurate product proportions.',
    lightingRequirement: 'Large even diffused studio source with symmetric fill, subtle grounding shadow, cross-polarization or flagged reflection control when appropriate, neutral color management, and no dramatic rim light or volumetric atmosphere.',
    finishRequirement: 'Luxury editorial infographic discipline with crisp geometry, high contrast, ample negative space, clean readable numerals, and truthful scale. Prioritize specification clarity over mood, cinematic effects, or decorative styling.',
    negativeRequirement: 'invented dimensions, incorrect numerals, false measurements, unreadable labels, warped proportions, perspective distortion, cluttered infographic, misleading scale, shallow depth of field, dramatic haze, decorative props, CGI render',
  },
  {
    slot: 'E13',
    label: '匠心细节价值图',
    planRequirement: '用顶级微距商业摄影证明产品价值，聚焦最能支撑价格与品质感的材质、纹理、手工痕迹、连接结构或表面工艺；通过精准控光、焦点堆栈和细腻高光建立买家信任，但绝不虚构不存在的工艺。',
    promptRequirement: 'Create a world-class craftsmanship and value-proof macro photograph. Reveal one verified material, texture, handmade detail, joinery, surface treatment, or construction feature that most strongly supports quality and price without inventing craftsmanship.',
    compositionRequirement: 'Build one decisive macro composition around the verified detail, with enough surrounding product context to identify where that detail belongs. Keep critical edges and construction relationships intact; do not isolate, enlarge, duplicate, or redesign the feature.',
    cameraRequirement: 'Phase One XF IQ4 150MP with Schneider Kreuznach 120mm Macro LS lens, ISO 50, f/11, geared tripod head, calibrated focus stack across the complete feature, and natural high-resolution microtexture without digital oversharpening.',
    lightingRequirement: 'Broncolor Picolite or tightly flagged strip light for controlled raking texture, broad soft fill, negative fill for sculptural depth, polarizer rotation tuned to preserve intentional material highlights, and no clipped reflections.',
    finishRequirement: 'Truthful tactile detail, precise focus-stack transitions, restrained local contrast, clean dust-free retouching, natural grain and pores, controlled highlights, and no beauty-filter smoothing or exaggerated texture.',
    negativeRequirement: 'plastic texture, fake craftsmanship, invented construction, duplicated detail, enlarged feature, smeared texture, harsh glare, clipped metal highlights, shallow focus hiding the feature, oversharpening, CGI render',
  },
  {
    slot: 'E14',
    label: '买家代入场景图',
    planRequirement: '让目标 Etsy 买家立即想象拥有和使用产品后的生活：选择最匹配受众、用途与审美的真实高端场景，展示可信的人体或空间比例、使用方式和情绪价值，同时保证产品仍是画面第一主角。',
    promptRequirement: 'Create an aspirational buyer-self-projection lifestyle photograph tailored to the exact Etsy audience and verified real use case. Show believable human or spatial scale, authentic interaction, and emotional reward while keeping the exact product as the clear visual hero.',
    compositionRequirement: 'Use a natural editorial composition with the product clearly visible at approximately 28-45% of the frame, placed at a strong focal point, unobstructed, and shown at verified real-world scale. A person may provide context but must remain secondary, naturally posed, and never cover or handle the product implausibly.',
    cameraRequirement: 'Hasselblad X2D 100C with XCD 55V lens, ISO 64, f/5.6, 1/125s, eye-level natural perspective, controlled depth of field that keeps the entire product sharp while allowing only gentle environmental separation.',
    lightingRequirement: 'Shape existing window or environmental light with a large diffused key, subtle bounce fill, negative fill for dimensionality, and a discreet motivated edge light. Match direction, color temperature, contact shadows, and reflections so the product belongs physically in the scene.',
    finishRequirement: 'High-end editorial realism with natural skin and material color, believable room scale, quiet styling, no stock-photo posing, no overproduced cinematic haze, and no background element competing with the product.',
    negativeRequirement: 'generic lifestyle stock photo, product hidden by props, implausible use, wrong audience, distorted anatomy, inaccurate scale, product too small, excessive background blur, cinematic haze, fake interior, CGI render',
  },
  {
    slot: 'E15',
    label: '送礼决策收口图',
    planRequirement: '用送礼、纪念时刻或购买决策收口场景推动收藏与下单：优先呈现真实可验证的包装、套装内容、个性化能力或适用场合；若这些信息未提供，则改为展示最能消除犹豫的多用途、完整套装或情绪故事，绝不杜撰礼盒、配件和定制选项。',
    promptRequirement: 'Create a final conversion-closing photograph around verified gift intent, a meaningful occasion, or the strongest remaining purchase-decision proof. Show packaging, included pieces, personalization, or gifting details only when explicitly verified; otherwise use a truthful keepsake, complete-set, versatility, or emotional-value composition.',
    compositionRequirement: 'Keep the exact product complete, unobstructed, and approximately 55-70% of the frame. Build one restrained emotional cue around it with no more than two verified or neutral supporting elements. Do not add a box, ribbon, card, accessory, duplicate product, or personalization unless supplied in the product facts or references.',
    cameraRequirement: 'Phase One XF IQ4 150MP with Schneider Kreuznach 80mm LS lens, ISO 50, f/8, 1/125s, tripod, corrected perspective, complete-product sharpness, and realistic scale.',
    lightingRequirement: 'Use a large soft key with controlled falloff, shaped fill, subtle warm-neutral practical ambience only when motivated by the scene, flagged specular control, and a clean separation edge without theatrical beams or haze.',
    finishRequirement: 'Refined emotional commerce photography with quiet luxury, believable materials, accurate product color, natural contact shadows, disciplined props, and a decisive product-first hierarchy that closes the sale without sentimentality or staged gift clichés.',
    negativeRequirement: 'invented gift box, ribbon, greeting card, invented accessories, unsupported personalization, fake claims, duplicate product, sentimental clutter, product too small, theatrical lighting, artificial haze, CGI render',
  },
] as const

const ETSY_LEGACY_ADDITIONAL_PRODUCTION_STANDARD = [
  'Premium production standard for this appended shot: art-directed by a world-class Etsy conversion strategist and luxury commercial photographer.',
  'Use a flagship medium-format campaign workflow, museum-grade product styling, category-appropriate elite optics, precise focus control, and a bespoke physical set derived from the product Visual DNA.',
  'Light with a masterfully controlled multi-light studio setup: large diffused key, shaped fill, subtle separation or rim light, negative fill where useful, accurate color management, and highlight control tailored to the real material and finish.',
].join(' ')

const ETSY_LEGACY_ADDITIONAL_PROMPT_REQUIREMENTS = [
  'Mandatory role: create a scroll-stopping Etsy cover image that remains instantly readable at small search-thumbnail size. Give the exact product unmistakable visual dominance, a powerful but refined focal hierarchy, premium handmade-brand desire, and a bespoke product-specific scene. Do not use text overlays, promotional graphics, badges, or a generic marketplace template.',
  'Mandatory role: create an elegant, conversion-focused size and scale image. Show only verified dimensions, capacity, weight, quantity, or specifications supplied in the product facts; never invent a number. Use refined measurement lines, clean spatial hierarchy, accurate proportions, and a believable universal scale cue when numeric dimensions are unavailable.',
  'Mandatory role: create a world-class craftsmanship and value-proof macro image. Reveal the verified material, texture, handmade evidence, finish, joinery, surface treatment, or construction detail that most strongly justifies quality and price. Use meticulous focus stacking, controlled specular highlights, tactile micro-contrast, and truthful detail without inventing craftsmanship.',
  'Mandatory role: create an aspirational buyer-self-projection lifestyle image tailored to the exact Etsy audience and real use case. Show believable human or spatial scale, authentic interaction, emotional reward, and a premium editorial environment while keeping the exact product as the undisputed hero.',
  'Mandatory role: create a final conversion-closing image built around gift intent, a meaningful occasion, or the strongest remaining purchase-decision proof. Show packaging, included pieces, personalization, or gifting details only when verified. Otherwise adapt to a truthful versatility, complete-set, keepsake, or emotional-story composition that removes buyer hesitation without inventing extras.',
]

function getEtsyAdditionalShotBrief(slot?: string | null) {
  const normalizedSlot = slot?.trim().toUpperCase()
  return ETSY_ADDITIONAL_SHOT_BRIEFS.find((brief) => brief.slot === normalizedSlot)
}

function stripLegacyEtsyAdditionalPromptBoilerplate(prompt: string): string {
  const legacyBlocks = [
    ...ETSY_ADDITIONAL_SHOT_BRIEFS.map((brief) => brief.promptRequirement),
    ...ETSY_LEGACY_ADDITIONAL_PROMPT_REQUIREMENTS,
    ETSY_LEGACY_ADDITIONAL_PRODUCTION_STANDARD,
    `Mandatory technical photography parameters: ${ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS}.`,
    `${ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS}.`,
    ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS,
  ]

  return legacyBlocks
    .reduce((value, block) => value.split(block).join(' '), prompt)
    .replace(/\s+/g, ' ')
    .trim()
}

function getEtsyVisualDnaBlock(seriesStyleGuide?: string | null): string {
  return seriesStyleGuide?.trim().split(/\n\s*\n/, 1)[0]?.trim() ?? ''
}

function mergeEtsyNegativePrompts(...values: Array<string | undefined>): string {
  const seen = new Set<string>()
  return values
    .flatMap((value) => value?.split(',') ?? [])
    .map((value) => value.trim())
    .filter((value) => {
      if (!value) return false
      const key = value.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(', ')
}

function formatEtsyPhotographyDecision(decision: EtsyShotPhotographyDecision): string {
  return [
    `Why this is right for this product: ${decision.productSuitability}`,
    `Viewpoint: ${decision.angleFamily} — ${decision.angle}`,
    `Shot scale and framing: ${decision.shotScale} — ${decision.framing}`,
    `Camera system: ${decision.cameraSystem}`,
    `Lens: ${decision.lensClass} — ${decision.lens}`,
    `Exposure and support: ${decision.exposure}`,
    `Focus strategy: ${decision.focusStrategy}`,
    `Lighting family: ${decision.lightingFamily}`,
    `Lighting execution: ${decision.lighting}`,
    `Scene family: ${decision.sceneFamily}`,
    `Scene execution: ${decision.scene}`,
    `Difference from the other fourteen shots: ${decision.differentiation}`,
  ].join('\n')
}

export function getEtsyImageSlots(): string[] {
  return Array.from({ length: ETSY_SHOT_COUNT }, (_, index) => `E${String(index + 1).padStart(2, '0')}`)
}

export function formatAmazonListingSlotRange(count: unknown = DEFAULT_LISTING_IMAGE_COUNT): string {
  const slots = getAmazonListingImageSlots(count)
  const tailSlots = slots.slice(1)
  if (!tailSlots.length) return slots[0] ?? 'MAIN'
  return `MAIN + ${tailSlots[0]}-${tailSlots[tailSlots.length - 1]}`
}

export function isAmazonListingMainSlot(slot?: string | null): boolean {
  return slot?.trim().toUpperCase() === 'MAIN'
}

export function normalizeOnImageCopy(copy: string, marketplaceId?: AmazonMarketplaceId): string {
  const marketplace = getAmazonMarketplace(marketplaceId)
  return copy
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (marketplace.allowsCjkVisibleCopy || !CJK_ON_IMAGE_TEXT_RE.test(line)))
    .join('\n')
}

function getStyleDensityGuide(mode: AmazonStyleDensityMode = 'rich', marketplaceId?: AmazonMarketplaceId): string {
  const marketplace = getAmazonMarketplace(marketplaceId)
  if (mode === 'minimal') {
    return [
      'Layout density:',
      '- Use a refined minimal Amazon layout with fewer callouts, generous balanced spacing, light icon or line treatment, and restrained visible copy.',
      `- Any customer-facing copy visible in the image must be concise, natural ${marketplace.onImageCopyLanguage} for ${marketplace.domain}.`,
      '- Keep the product and one or two strongest messages dominant, with clean hierarchy and no clutter.',
    ].join('\n')
  }

  return [
    'Layout density:',
    '- Use a polished, information-rich Amazon gallery layout when the selected image type benefits from explanation.',
    `- Build clear hierarchy with mobile-readable ${marketplace.onImageCopyLanguage} copy for ${marketplace.domain}, multiple well-spaced callouts, detail crops, comparison areas, measurement arrows, or use-case zones as appropriate.`,
    '- Keep the composition premium and organized; information-rich should still be readable, balanced, and uncluttered.',
  ].join('\n')
}

function formatPromptBlock(options: {
  prompt: string
  negativePrompt?: string
  seriesStyleGuide?: string | null
  styleReferenceAttached?: boolean
  styleDensityMode?: AmazonStyleDensityMode
  marketplaceId?: AmazonMarketplaceId
  selectedVisualStyle?: {
    label: string
    description: string
    palette: string[]
  } | null
  includeDensityGuide?: boolean
  etsyAdaptivePhotography?: boolean
}) {
  const selectedVisualStyle = options.styleReferenceAttached ? options.selectedVisualStyle : null
  const selectedStyleBlock = selectedVisualStyle
    ? options.etsyAdaptivePhotography
      ? [
        'Selected Etsy campaign style (surrounding art direction only):',
        `- Style reference: ${selectedVisualStyle.label}.`,
        `- Style direction: ${selectedVisualStyle.description}`,
        selectedVisualStyle.palette.length ? `- Supporting palette anchors: ${selectedVisualStyle.palette.join(', ')}.` : '',
        '- Apply this style to the environment and campaign finish without overriding the product-specific capture decision or altering the real product.',
      ].filter(Boolean).join('\n')
      : [
        'Selected visual style (highest priority):',
        `- Style reference: ${selectedVisualStyle.label}.`,
        `- Style direction: ${selectedVisualStyle.description}`,
        selectedVisualStyle.palette.length ? `- Palette anchors: ${selectedVisualStyle.palette.join(', ')}.` : '',
        '- This selected visual style is the highest-priority visual system for background, palette, typography, lighting, decorative accents, material finish, and information-panel styling.',
        '- If the image task prompt or Series style guide contains a conflicting aesthetic, background mood, color palette, typography direction, or decorative accent, override that conflict with this selected visual style while preserving product facts and required copy.',
      ].filter(Boolean).join('\n')
    : ''
  const seriesStyleGuideLabel = selectedStyleBlock
    ? 'Series style guide (lower priority than the selected visual style):'
    : 'Series style guide:'
  const sections = [
    options.prompt.trim(),
    selectedStyleBlock,
    options.seriesStyleGuide?.trim()
      ? `${seriesStyleGuideLabel}\n${options.seriesStyleGuide.trim()}`
      : '',
    options.styleReferenceAttached && options.includeDensityGuide !== false ? getStyleDensityGuide(options.styleDensityMode, options.marketplaceId) : '',
    options.negativePrompt?.trim()
      ? `Negative prompt:\n${options.negativePrompt.trim()}`
      : '',
    options.styleReferenceAttached
      ? options.etsyAdaptivePhotography ? ETSY_ADAPTIVE_STYLE_REFERENCE_GUARD : STYLE_REFERENCE_GUARD
      : '',
  ].filter(Boolean)

  return sections.join('\n\n')
}

export function buildAmazonPlanPrompt(plan: Pick<AmazonImagePlan, 'prompt' | 'negativePrompt'> & {
  seriesStyleGuide?: string | null
  styleReferenceAttached?: boolean
  styleDensityMode?: AmazonStyleDensityMode
  marketplaceId?: AmazonMarketplaceId
  selectedVisualStyle?: {
    label: string
    description: string
    palette: string[]
  } | null
}): string {
  return formatPromptBlock(plan)
}

export function buildEtsyPlanPrompt(plan: Pick<AmazonImagePlan, 'prompt' | 'negativePrompt' | 'photographyDecision'> & {
  slot?: string | null
  seriesStyleGuide?: string | null
  styleReferenceAttached?: boolean
  styleDensityMode?: AmazonStyleDensityMode
  selectedVisualStyle?: {
    label: string
    description: string
    palette: string[]
  } | null
}): string {
  const additionalBrief = getEtsyAdditionalShotBrief(plan.slot)
  if (plan.photographyDecision) {
    const visualDnaBlock = getEtsyVisualDnaBlock(plan.seriesStyleGuide)
    const productSpecificPlan = stripLegacyEtsyAdditionalPromptBoilerplate(plan.prompt)
    return formatPromptBlock({
      ...plan,
      prompt: [
        `Create one production-ready Etsy campaign photograph${plan.slot ? ` for ${plan.slot}${additionalBrief ? ` ${additionalBrief.label}` : ''}` : ''}.`,
        [
          'PRODUCT REFERENCE LOCK (absolute priority):',
          '- Treat the supplied product reference image or images as the sole authority for product geometry, proportions, construction, motif placement, material boundaries, color, finish, quantity, and scale.',
          '- Rebuild only the environment around the product. Match the referenced product as closely as possible instead of reinterpreting it from text.',
          '- Preserve exact relative sizes and positions of every visible component. Do not enlarge the hero detail, simplify the silhouette, move decorative elements, alter spacing, or make the product more symmetrical.',
          '- The selected style reference controls only the surrounding art direction; it must never alter the product itself.',
        ].join('\n'),
        visualDnaBlock ? `VERIFIED PRODUCT FACTS:\n${visualDnaBlock}` : '',
        additionalBrief ? `SHOT OBJECTIVE:\n${additionalBrief.promptRequirement}` : '',
        productSpecificPlan ? `PRODUCT-SPECIFIC SCENE PLAN:\n${productSpecificPlan}` : '',
        `AI PHOTOGRAPHER'S PRODUCT-SPECIFIC CAPTURE DECISION:\n${formatEtsyPhotographyDecision(plan.photographyDecision)}`,
        additionalBrief ? `CONVERSION COMPOSITION GUARDRAILS:\n${additionalBrief.compositionRequirement}` : '',
        additionalBrief ? `FINISH AND QUALITY CONTROL:\n${additionalBrief.finishRequirement}` : 'FINISH AND QUALITY CONTROL:\nWorld-class commissioned commercial photography, physically believable optics and light, accurate color management, natural contact shadows, disciplined retouching, and no generic AI-rendered appearance.',
        'FINAL PRODUCT CHECK: product identity, geometry, component positions, dimensions, material, color, finish, and quantity must match the product references before any aesthetic consideration. The result must look like a real commissioned photograph, not a 3D render or generic AI image.',
        'No marketplace badges, fake reviews, prices, coupons, sale stickers, watermarks, QR codes, or UI screenshots.',
      ].filter(Boolean).join('\n\n'),
      negativePrompt: mergeEtsyNegativePrompts(
        plan.negativePrompt,
        additionalBrief?.negativeRequirement,
        'altered product geometry, changed component placement, enlarged motif, redesigned product, wrong material, wrong color, wrong quantity, floating object, malformed edges, AI artifacts',
      ),
      seriesStyleGuide: null,
      marketplaceId: undefined,
      includeDensityGuide: false,
      etsyAdaptivePhotography: true,
    })
  }

  if (additionalBrief) {
    const visualDnaBlock = getEtsyVisualDnaBlock(plan.seriesStyleGuide)
    const productSpecificPlan = stripLegacyEtsyAdditionalPromptBoilerplate(plan.prompt)
    return formatPromptBlock({
      ...plan,
      prompt: [
        `Create one production-ready Etsy conversion image for ${additionalBrief.slot} ${additionalBrief.label}.`,
        visualDnaBlock ? `VERIFIED PRODUCT FACTS:\n${visualDnaBlock}` : '',
        `SHOT OBJECTIVE:\n${additionalBrief.promptRequirement}`,
        productSpecificPlan ? `PRODUCT-SPECIFIC SCENE PLAN:\n${productSpecificPlan}` : '',
        `COMPOSITION:\n${additionalBrief.compositionRequirement}`,
        `CAMERA AND OPTICS:\n${additionalBrief.cameraRequirement}`,
        `LIGHTING:\n${additionalBrief.lightingRequirement}`,
        `FINISH AND QUALITY CONTROL:\n${additionalBrief.finishRequirement}`,
        'Legacy plan fallback: preserve the supplied product references exactly and render a real commissioned photograph, not a 3D render or generic AI image.',
      ].filter(Boolean).join('\n\n'),
      negativePrompt: mergeEtsyNegativePrompts(plan.negativePrompt, additionalBrief.negativeRequirement),
      seriesStyleGuide: null,
      marketplaceId: undefined,
      includeDensityGuide: false,
    })
  }

  return formatPromptBlock({
    ...plan,
    prompt: [
      'Create one ultra-high-end Etsy product photoshoot image.',
      plan.seriesStyleGuide?.trim()
        ? `Visual DNA Lock (must preserve the real product exactly):\n${plan.seriesStyleGuide.trim()}`
        : '',
      plan.prompt.trim(),
      `Mandatory technical photography parameters: ${ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS}.`,
      'Do not redesign, recolor, resize, relabel, or materially alter the product. Keep materials, colors, texture, silhouette, proportions, accessories, logo/text, and finish consistent with the product facts/reference images.',
      'No marketplace badges, fake reviews, prices, coupons, sale stickers, watermarks, QR codes, or UI screenshots.',
    ].filter(Boolean).join('\n\n'),
    seriesStyleGuide: null,
    marketplaceId: undefined,
    includeDensityGuide: false,
  })
}

function formatAPlusUploadSize(spec: Pick<AmazonAPlusModuleSpec, 'uploadWidth' | 'uploadHeight'>): string {
  return `${spec.uploadWidth}x${spec.uploadHeight}`
}

function getSafeAPlusRatio(width: number, height: number): string {
  const ratio = width / height
  if (ratio > 3) return '3:1'
  if (ratio < 1 / 3) return '1:3'
  return `${width}:${height}`
}

function getAPlusGenerationSizeFromDimensions(width: number, height: number, tier: SizeTier): string {
  return calculateImageSize(tier, getSafeAPlusRatio(width, height)) ?? (tier === '4K' ? '2880x2880' : '2048x2048')
}

function getAPlusModuleSlotPrefix(type: APlusContentType): string {
  switch (type) {
    case 'premium':
      return 'A+P'
    case 'mobile':
      return 'A+M'
    case 'standard-large':
      return 'A+L'
    default:
      return 'A+S'
  }
}

function isAPlusModuleKind(value: unknown): value is APlusModuleKind {
  return typeof value === 'string' && A_PLUS_MODULE_KINDS.includes(value as APlusModuleKind)
}

function getAPlusModuleTypeText(type: APlusContentType, moduleType: APlusModuleKind, ordinal: number) {
  const suffix = ordinal > 1 || !['header-banner', 'hero-banner', 'logo', 'comparison-thumbnail'].includes(moduleType)
    ? ` ${ordinal}`
    : ''

  switch (moduleType) {
    case 'header-banner':
      return {
        label: `Header Banner${suffix}`,
        displayLabel: `顶部横幅${suffix}`,
      }
    case 'single-image':
      return {
        label: `Single Image${suffix}`,
        displayLabel: `大图模块${suffix}`,
      }
    case 'highlight-tile':
      return {
        label: `Highlight Tile${suffix}`,
        displayLabel: `卖点方块${suffix}`,
      }
    case 'hero-banner':
      return type === 'mobile'
        ? {
            label: `Mobile Hero${suffix}`,
            displayLabel: `手机首屏${suffix}`,
          }
        : {
            label: `Hero Banner${suffix}`,
            displayLabel: `高级首屏横幅${suffix}`,
          }
    case 'feature-image':
      return type === 'mobile'
        ? {
            label: `Mobile Feature${suffix}`,
            displayLabel: `手机卖点图${suffix}`,
          }
        : {
            label: `Feature Image${suffix}`,
            displayLabel: `高级大图模块${suffix}`,
          }
    case 'brand-story':
      return {
        label: `Brand Story${suffix}`,
        displayLabel: `品牌故事${suffix}`,
      }
    case 'logo':
      return {
        label: `Logo Image${suffix}`,
        displayLabel: `品牌 Logo${suffix}`,
      }
    case 'comparison-thumbnail':
      return {
        label: `Comparison Thumbnail${suffix}`,
        displayLabel: `对比缩略图${suffix}`,
      }
    default:
      return {
        label: `A+ Module${suffix}`,
        displayLabel: `A+ 模块${suffix}`,
      }
  }
}

function cloneAPlusModuleSpec(spec: AmazonAPlusModuleSpec): AmazonAPlusModuleSpec {
  return { ...spec }
}

function normalizeAPlusDimension(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.trunc(numeric)
}

export function normalizeAPlusModuleSpecs(
  type: APlusContentType,
  specs?: Array<Partial<AmazonAPlusModuleSpec>> | null,
): AmazonAPlusModuleSpec[] {
  const fallbackSpecs = getAPlusModuleSpecs(type)
  const sourceSpecs = Array.isArray(specs) && specs.length ? specs : fallbackSpecs
  const fallbackByModuleType = new Map(fallbackSpecs.map((spec) => [spec.moduleType, spec]))
  const moduleTypeCounts = new Map<APlusModuleKind, number>()
  const normalizedSource = sourceSpecs
    .slice(0, MAX_A_PLUS_MODULE_COUNT)
    .filter((spec) => isAPlusModuleKind(spec.moduleType))

  const safeSource = normalizedSource.length ? normalizedSource : fallbackSpecs
  return safeSource.slice(0, MAX_A_PLUS_MODULE_COUNT).map((spec, index) => {
    const fallback = fallbackByModuleType.get(spec.moduleType as APlusModuleKind) ?? fallbackSpecs[index] ?? fallbackSpecs[0]
    const moduleType = isAPlusModuleKind(spec.moduleType) ? spec.moduleType : fallback.moduleType
    const nextOrdinal = (moduleTypeCounts.get(moduleType) ?? 0) + 1
    moduleTypeCounts.set(moduleType, nextOrdinal)
    const text = getAPlusModuleTypeText(type, moduleType, nextOrdinal)
    return {
      contentType: type,
      slot: `${getAPlusModuleSlotPrefix(type)}${String(index + 1).padStart(2, '0')}`,
      label: text.label,
      displayLabel: text.displayLabel,
      moduleType,
      uploadWidth: normalizeAPlusDimension(spec.uploadWidth, fallback.uploadWidth),
      uploadHeight: normalizeAPlusDimension(spec.uploadHeight, fallback.uploadHeight),
      objective: typeof spec.objective === 'string' && spec.objective.trim() ? spec.objective : fallback.objective,
    }
  })
}

export function insertAPlusModuleSpecAfter(
  type: APlusContentType,
  specs: Array<Partial<AmazonAPlusModuleSpec>>,
  index: number,
): AmazonAPlusModuleSpec[] {
  const normalizedSpecs = normalizeAPlusModuleSpecs(type, specs)
  if (normalizedSpecs.length >= MAX_A_PLUS_MODULE_COUNT) return normalizedSpecs
  const insertIndex = Math.min(Math.max(index, 0), normalizedSpecs.length - 1)
  const source = normalizedSpecs[insertIndex] ?? normalizedSpecs[normalizedSpecs.length - 1]
  return normalizeAPlusModuleSpecs(type, [
    ...normalizedSpecs.slice(0, insertIndex + 1),
    cloneAPlusModuleSpec(source),
    ...normalizedSpecs.slice(insertIndex + 1),
  ])
}

export function removeAPlusModuleSpecAt(
  type: APlusContentType,
  specs: Array<Partial<AmazonAPlusModuleSpec>>,
  index: number,
): AmazonAPlusModuleSpec[] {
  const normalizedSpecs = normalizeAPlusModuleSpecs(type, specs)
  if (normalizedSpecs.length <= MIN_A_PLUS_MODULE_COUNT) return normalizedSpecs
  const removeIndex = Math.min(Math.max(index, 0), normalizedSpecs.length - 1)
  return normalizeAPlusModuleSpecs(type, normalizedSpecs.filter((_, itemIndex) => itemIndex !== removeIndex))
}

export function areAPlusModuleSpecsEquivalent(
  left: Array<Partial<AmazonAPlusModuleSpec>>,
  right: Array<Partial<AmazonAPlusModuleSpec>>,
): boolean {
  if (left.length !== right.length) return false
  return left.every((spec, index) => {
    const other = right[index]
    return spec.moduleType === other?.moduleType &&
      spec.uploadWidth === other.uploadWidth &&
      spec.uploadHeight === other.uploadHeight
  })
}

export function getAPlusModuleSpecs(type: APlusContentType): AmazonAPlusModuleSpec[] {
  switch (type) {
    case 'premium':
      return PREMIUM_A_PLUS_MODULE_SPECS.map(cloneAPlusModuleSpec)
    case 'mobile':
      return MOBILE_A_PLUS_MODULE_SPECS.map(cloneAPlusModuleSpec)
    case 'standard-large':
      return STANDARD_LARGE_A_PLUS_MODULE_SPECS.map(cloneAPlusModuleSpec)
    default:
      return STANDARD_A_PLUS_MODULE_SPECS.map(cloneAPlusModuleSpec)
  }
}

export function findAPlusModuleSpec(slot: string): AmazonAPlusModuleSpec | undefined {
  return [...STANDARD_A_PLUS_MODULE_SPECS, ...STANDARD_LARGE_A_PLUS_MODULE_SPECS, ...PREMIUM_A_PLUS_MODULE_SPECS, ...MOBILE_A_PLUS_MODULE_SPECS, ...OPTIONAL_A_PLUS_MODULE_SPECS]
    .find((spec) => spec.slot === slot)
}

export function getAPlusContentTypeLabel(type: APlusContentType): string {
  switch (type) {
    case 'premium':
      return '高级A+'
    case 'mobile':
      return '手机A+'
    case 'standard-large':
      return '普通A+'
    default:
      return '标准A+'
  }
}

export function getAPlusModuleDisplayName(module: (Pick<AmazonAPlusPlan, 'slot' | 'moduleType'> | Pick<AmazonAPlusModuleSpec, 'slot' | 'moduleType'>) & { displayLabel?: string }): string {
  if (module.displayLabel) return module.displayLabel
  const spec = findAPlusModuleSpec(module.slot)
  if (spec && spec.moduleType === module.moduleType) return spec.displayLabel

  switch (module.moduleType) {
    case 'header-banner':
      return '顶部横幅'
    case 'single-image':
      return '大图模块'
    case 'highlight-tile':
      return '卖点方块'
    case 'hero-banner':
      return '高级首屏横幅'
    case 'feature-image':
      return '高级大图模块'
    case 'brand-story':
      return '品牌故事'
    case 'logo':
      return '品牌 Logo'
    case 'comparison-thumbnail':
      return '对比缩略图'
    default:
      return 'A+ 模块'
  }
}

export function getAPlusModuleEnglishName(module: Pick<AmazonAPlusPlan, 'slot' | 'label' | 'moduleType'> | Pick<AmazonAPlusModuleSpec, 'slot' | 'label' | 'moduleType'>): string {
  const spec = findAPlusModuleSpec(module.slot)
  if (spec && spec.moduleType === module.moduleType) return spec.label
  return module.label ?? module.moduleType
}

export function isAPlusTextModule(module: Pick<AmazonAPlusPlan, 'moduleType'> | Pick<AmazonAPlusModuleSpec, 'moduleType'>): boolean {
  return module.moduleType === 'highlight-tile'
}

export function formatAPlusModuleText(plan: Pick<AmazonAPlusPlan, 'textTitle' | 'textBody'>): string {
  return [plan.textTitle.trim(), plan.textBody.trim()].filter(Boolean).join('\n\n')
}

export function getAPlusModuleUploadSize(spec: Pick<AmazonAPlusModuleSpec, 'uploadWidth' | 'uploadHeight'>): string {
  return formatAPlusUploadSize(spec)
}

export function getAPlusModuleGenerationSize(spec: Pick<AmazonAPlusModuleSpec, 'uploadWidth' | 'uploadHeight'>, tier: SizeTier): string {
  return getAPlusGenerationSizeFromDimensions(spec.uploadWidth, spec.uploadHeight, tier)
}

export function getAPlusPlanGenerationSize(plan: Pick<AmazonAPlusPlan, 'slot' | 'uploadSize'>, tier: SizeTier): string {
  const match = plan.uploadSize.match(/^(\d+)x(\d+)$/)
  if (match) return getAPlusGenerationSizeFromDimensions(Number(match[1]), Number(match[2]), tier)

  const spec = findAPlusModuleSpec(plan.slot)
  if (spec) return getAPlusModuleGenerationSize(spec, tier)
  return tier === '4K' ? '2880x2880' : '2048x2048'
}

export function withAPlusGenerationSizes(plans: AmazonAPlusPlan[], tier: SizeTier): AmazonAPlusPlan[] {
  return plans.map((plan) => ({
    ...plan,
    generationSize: getAPlusPlanGenerationSize(plan, tier),
  }))
}

export function buildAmazonAPlusPlanPrompt(plan: Pick<AmazonAPlusPlan, 'prompt' | 'negativePrompt'> & {
  seriesStyleGuide?: string | null
  styleReferenceAttached?: boolean
  styleDensityMode?: AmazonStyleDensityMode
  marketplaceId?: AmazonMarketplaceId
  selectedVisualStyle?: {
    label: string
    description: string
    palette: string[]
  } | null
}): string {
  return formatPromptBlock(plan)
}
