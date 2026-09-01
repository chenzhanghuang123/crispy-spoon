import type { ApiProfile, EtsyListingDetails, EtsyVisualDna } from '../types'
import { DEFAULT_CHAT_MODEL, DEFAULT_RESPONSES_MODEL, isOfficialDeepSeekPlannerProfile } from './apiProfiles'
import { formatAmazonAPlusReferenceMaterial, formatAmazonListingReferenceMaterial } from './amazonKnowledge'
import {
  getAmazonMarketplace,
  normalizeAmazonMarketplaceId,
  type AmazonMarketplaceId,
} from './amazonMarketplaces'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import type { AmazonPromptDraft } from './amazonPrompt'
import {
  DEFAULT_LISTING_IMAGE_COUNT,
  ETSY_ORIGINAL_SHOT_COUNT,
  ETSY_SHOT_COUNT,
  ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS,
  getAmazonListingImageSlots,
  getEtsyImageSlots,
  getAPlusContentTypeLabel,
  getAPlusModuleGenerationSize,
  getAPlusModuleUploadSize,
  normalizeListingImageCount,
  normalizeAPlusModuleSpecs,
  type APlusContentType,
  type AmazonAPlusModuleSpec,
  type AmazonAPlusPlan,
  type AmazonImagePlan,
  type AmazonPlannerMode,
  type ListingParseResult,
} from './listingPlanner'
import { isEventStreamResponse, looksLikeServerSentEvents, readJsonServerSentEvents, readJsonServerSentEventText } from './serverSentEvents'
import type { SizeTier } from './size'

interface PlannerApiPayload {
  product?: {
    title?: unknown
    category?: unknown
    brand?: unknown
    color?: unknown
    material?: unknown
    audience?: unknown
    packageIncludes?: unknown
  }
  sellingPoints?: unknown
  seriesStyleGuide?: unknown
  visualDna?: Partial<Record<keyof EtsyVisualDna, unknown>>
  imagePlans?: Array<Partial<AmazonImagePlan>>
  aPlusPlans?: Array<Partial<AmazonAPlusPlan>>
}

interface EtsyListingApiPayload {
  marketInsightsZh?: unknown
  primaryCategoryEn?: unknown
  primaryCategoryZh?: unknown
  alternativeCategoryEn?: unknown
  alternativeCategoryZh?: unknown
  categoryRationaleZh?: unknown
  titleEn?: unknown
  titleZh?: unknown
  descriptionEn?: unknown
  descriptionZh?: unknown
  tags?: unknown
}

const DEEPSEEK_TEXT_ONLY_PLANNER_GUARD = 'Because DeepSeek cannot receive or understand reference images in this request, do not infer or describe product facts that are not explicitly present in the listing text or user-provided product facts. Do not invent colors, shapes, structures, accessories, logos, bundle quantity, package contents, materials, printed text, ports, buttons, or product variants. If a visual detail is unknown, keep the prompt neutral and refer to the exact product described by the provided facts.'
const PRODUCT_REFERENCE_FACTS_ONLY_PLANNER_GUIDE = [
  'Product reference image rule:',
  '- Use product reference images only to identify product facts: real appearance, color, shape, structure, included accessories, materials, package contents, and feature evidence.',
  '- Do not use product reference images to choose the final visual style, color palette, background mood, typography style, decorative accents, or overall aesthetic unless the listing text explicitly requests it.',
  '- imagePlans[].prompt and aPlusPlans[].prompt must avoid fixed non-product aesthetics such as coastal resort, warm cream background, botanical accents, luxury editorial, cyberpunk, or magazine fashion unless those are explicit product, brand, or listing requirements.',
  '- seriesStyleGuide should preserve cross-image product consistency, factual visual continuity, copy hierarchy, and product appearance only; it must not lock the final palette, typography, background, lighting mood, or decorative system because the user-selected preset style controls those during image generation.',
].join('\n')

const ETSY_ADDITIONAL_SHOT_BRIEFS = [
  {
    slot: 'E11',
    label: '吸睛首页图',
    planRequirement: '打造一张能在 Etsy 搜索缩略图中立刻抓住买家视线的首屏主图：产品必须一眼可识别、主体占比明确、层次干净、情绪强烈且具高级手作品牌感；场景必须依据该产品的视觉 DNA 定制，不使用文字贴纸、促销角标或通用模板。',
    promptRequirement: 'Mandatory role: create a scroll-stopping Etsy cover image that remains instantly readable at small search-thumbnail size. Give the exact product unmistakable visual dominance, a powerful but refined focal hierarchy, premium handmade-brand desire, and a bespoke product-specific scene. Do not use text overlays, promotional graphics, badges, or a generic marketplace template.',
    negativeRequirement: 'weak thumbnail impact, tiny product, confusing focal point, generic stock scene, text overlay, promotional badge',
  },
  {
    slot: 'E12',
    label: '尺寸规格图',
    planRequirement: '制作清晰、优雅、可信的尺寸与比例图，只能使用用户资料中已验证的尺寸、容量、重量或规格；以简洁测量线、比例参照和易读层级减少购买疑虑。若缺少数字尺寸，不得编造，改用真实通用参照表达比例，并在中文策划中注明需要卖家确认数字。',
    promptRequirement: 'Mandatory role: create an elegant, conversion-focused size and scale image. Show only verified dimensions, capacity, weight, quantity, or specifications supplied in the product facts; never invent a number. Use refined measurement lines, clean spatial hierarchy, accurate proportions, and a believable universal scale cue when numeric dimensions are unavailable.',
    negativeRequirement: 'invented dimensions, false measurements, unreadable labels, warped proportions, cluttered infographic, misleading scale',
  },
  {
    slot: 'E13',
    label: '匠心细节价值图',
    planRequirement: '用顶级微距商业摄影证明产品价值，聚焦最能支撑价格与品质感的材质、纹理、手工痕迹、连接结构或表面工艺；通过精准控光、焦点堆栈和细腻高光建立买家信任，但绝不虚构不存在的工艺。',
    promptRequirement: 'Mandatory role: create a world-class craftsmanship and value-proof macro image. Reveal the verified material, texture, handmade evidence, finish, joinery, surface treatment, or construction detail that most strongly justifies quality and price. Use meticulous focus stacking, controlled specular highlights, tactile micro-contrast, and truthful detail without inventing craftsmanship.',
    negativeRequirement: 'plastic texture, fake craftsmanship, invented construction, smeared detail, harsh glare, shallow focus hiding the feature',
  },
  {
    slot: 'E14',
    label: '买家代入场景图',
    planRequirement: '让目标 Etsy 买家立即想象拥有和使用产品后的生活：选择最匹配受众、用途与审美的真实高端场景，展示可信的人体或空间比例、使用方式和情绪价值，同时保证产品仍是画面第一主角。',
    promptRequirement: 'Mandatory role: create an aspirational buyer-self-projection lifestyle image tailored to the exact Etsy audience and real use case. Show believable human or spatial scale, authentic interaction, emotional reward, and a premium editorial environment while keeping the exact product as the undisputed hero.',
    negativeRequirement: 'generic lifestyle stock photo, product hidden by props, implausible use, wrong audience, distorted anatomy, inaccurate scale',
  },
  {
    slot: 'E15',
    label: '送礼决策收口图',
    planRequirement: '用送礼、纪念时刻或购买决策收口场景推动收藏与下单：优先呈现真实可验证的包装、套装内容、个性化能力或适用场合；若这些信息未提供，则改为展示最能消除犹豫的多用途、完整套装或情绪故事，绝不杜撰礼盒、配件和定制选项。',
    promptRequirement: 'Mandatory role: create a final conversion-closing image built around gift intent, a meaningful occasion, or the strongest remaining purchase-decision proof. Show packaging, included pieces, personalization, or gifting details only when verified. Otherwise adapt to a truthful versatility, complete-set, keepsake, or emotional-story composition that removes buyer hesitation without inventing extras.',
    negativeRequirement: 'invented gift box, invented accessories, unsupported personalization, fake claims, extra products, sentimental clutter',
  },
] as const

const ETSY_ADDITIONAL_PREMIUM_PRODUCTION_STANDARD = [
  'Premium production standard for this appended shot: art-directed by a world-class Etsy conversion strategist and luxury commercial photographer.',
  'Use a flagship medium-format campaign workflow, museum-grade product styling, category-appropriate elite optics, precise focus control, and a bespoke physical set derived from the product Visual DNA.',
  'Light with a masterfully controlled multi-light studio setup: large diffused key, shaped fill, subtle separation or rim light, negative fill where useful, accurate color management, and highlight control tailored to the real material and finish.',
].join(' ')

function applyEtsyAdditionalShotBrief(plan: AmazonImagePlan, index: number): AmazonImagePlan {
  const brief = ETSY_ADDITIONAL_SHOT_BRIEFS[index - ETSY_ORIGINAL_SHOT_COUNT]
  if (!brief) return plan

  return {
    ...plan,
    slot: brief.slot,
    label: brief.label,
    planMarkdown: [plan.planMarkdown, `**新增固定镜头要求：** ${brief.planRequirement}`].filter(Boolean).join('\n\n'),
    prompt: [plan.prompt, brief.promptRequirement, ETSY_ADDITIONAL_PREMIUM_PRODUCTION_STANDARD].filter(Boolean).join('\n\n'),
    negativePrompt: [plan.negativePrompt, brief.negativeRequirement].filter(Boolean).join(', '),
  }
}

export interface PlannerApiResult {
  mode: AmazonPlannerMode
  marketplaceId: AmazonMarketplaceId
  parsed: ListingParseResult
  seriesStyleGuide: string
  plans: AmazonImagePlan[]
  aPlusPlans: AmazonAPlusPlan[]
  aPlusType?: APlusContentType
  etsyVisualDna?: EtsyVisualDna | null
}

export interface EtsyListingApiResult {
  details: EtsyListingDetails
  webResearchUsed: boolean
}

type EtsyListingTransport = 'chat' | 'responses'

const PRODUCT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    category: { type: 'string' },
    brand: { type: 'string' },
    color: { type: 'string' },
    material: { type: 'string' },
    audience: { type: 'string' },
    packageIncludes: { type: 'string' },
  },
  required: ['title', 'category', 'brand', 'color', 'material', 'audience', 'packageIncludes'],
} as const

const SELLING_POINTS_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 5,
  items: { type: 'string' },
} as const

const CHINESE_LABEL_SCHEMA = {
  type: 'string',
  description: 'Concise Simplified Chinese label for UI display.',
} as const

const PLAN_MARKDOWN_SCHEMA = {
  type: 'string',
  description: 'Detailed Simplified Chinese planning write-up for this slot, similar to a ChatGPT agent response. Markdown is allowed.',
} as const

const NEGATIVE_PROMPT_SCHEMA = {
  type: 'string',
  description: 'English negative prompt for the image model. Never include Chinese characters.',
} as const

function getVisibleCopyLanguageRule(marketplaceId?: AmazonMarketplaceId): string {
  const marketplace = getAmazonMarketplace(marketplaceId)
  return marketplace.allowsCjkVisibleCopy
    ? `Visible customer-facing copy inside the prompt must be natural ${marketplace.onImageCopyLanguage} for ${marketplace.domain}; Japanese characters are allowed for visible copy, but do not include Simplified Chinese UI wording.`
    : `Visible customer-facing copy inside the prompt must be natural ${marketplace.onImageCopyLanguage} for ${marketplace.domain}; never include Chinese or Japanese characters in visible copy.`
}

function createImagePromptSchema(marketplaceId?: AmazonMarketplaceId) {
  return {
    type: 'string',
    description: `Professional English image-generation prompt. ${getVisibleCopyLanguageRule(marketplaceId)} The overall prompt instructions should remain English for image-model stability.`,
  } as const
}

function createAPlusExternalTextSchema(field: 'title' | 'body', marketplaceId?: AmazonMarketplaceId) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  return {
    type: 'string',
    description: `External A+ ${field} text in natural ${marketplace.copyLanguage} for ${marketplace.domain}, or an empty string when not needed.`,
  } as const
}

function createListingPlannerSchema(listingImageCount: number, marketplaceId?: AmazonMarketplaceId) {
  const slots = getAmazonListingImageSlots(listingImageCount)
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      product: PRODUCT_SCHEMA,
      sellingPoints: SELLING_POINTS_SCHEMA,
      seriesStyleGuide: {
        type: 'string',
        description: 'LLM-authored English visual style guide to keep the whole image set coherent.',
      },
      imagePlans: {
        type: 'array',
        minItems: slots.length,
        maxItems: slots.length,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slot: { type: 'string', enum: slots },
            label: CHINESE_LABEL_SCHEMA,
            planMarkdown: PLAN_MARKDOWN_SCHEMA,
            prompt: createImagePromptSchema(marketplaceId),
            negativePrompt: NEGATIVE_PROMPT_SCHEMA,
          },
          required: ['slot', 'label', 'planMarkdown', 'prompt', 'negativePrompt'],
        },
      },
    },
    required: ['product', 'sellingPoints', 'seriesStyleGuide', 'imagePlans'],
  } as const
}

const ETSY_VISUAL_DNA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    productNameType: { type: 'string', description: 'Exact product name/type, grounded in the product description and reference images.' },
    materialTextureFocus: { type: 'string', description: 'Detailed physical materials, surfaces, texture, finish, construction, and tactile qualities.' },
    colorPaletteLightingMood: { type: 'string', description: 'The real product color palette plus an adaptive lighting mood that reveals those colors and textures accurately.' },
    brandAestheticTargetAudience: { type: 'string', description: 'A product-specific brand aesthetic and the Etsy buyer segment most likely to value it.' },
  },
  required: ['productNameType', 'materialTextureFocus', 'colorPaletteLightingMood', 'brandAestheticTargetAudience'],
} as const

function createEtsyPlannerSchema() {
  const slots = getEtsyImageSlots()
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      product: PRODUCT_SCHEMA,
      sellingPoints: SELLING_POINTS_SCHEMA,
      visualDna: ETSY_VISUAL_DNA_SCHEMA,
      seriesStyleGuide: {
        type: 'string',
        description: 'English cross-shot consistency guide grounded only in the locked Visual DNA.',
      },
      imagePlans: {
        type: 'array',
        minItems: ETSY_SHOT_COUNT,
        maxItems: ETSY_SHOT_COUNT,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slot: { type: 'string', enum: slots },
            label: CHINESE_LABEL_SCHEMA,
            planMarkdown: {
              type: 'string',
              description: 'Simplified Chinese shot strategy plus a product-specific creative scene description. State the shot role such as hero, macro detail, lifestyle context, or atmospheric creative.',
            },
            prompt: {
              type: 'string',
              description: 'Professional English image-generation prompt. Explicitly repeat the locked material, color, texture, finish, silhouette, proportions, and construction details in every shot. Do not use generic reusable scene templates.',
            },
            negativePrompt: NEGATIVE_PROMPT_SCHEMA,
          },
          required: ['slot', 'label', 'planMarkdown', 'prompt', 'negativePrompt'],
        },
      },
    },
    required: ['product', 'sellingPoints', 'visualDna', 'seriesStyleGuide', 'imagePlans'],
  } as const
}

const ETSY_LISTING_DETAILS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    marketInsightsZh: {
      type: 'string',
      description: 'Concise Simplified Chinese market and verification insights covering current terminology, buyer pain points, positioning, and category fit.',
    },
    primaryCategoryEn: { type: 'string', description: 'The deepest accurate current Etsy category path in English.' },
    primaryCategoryZh: { type: 'string', description: 'Accurate Simplified Chinese translation of the primary Etsy category path.' },
    alternativeCategoryEn: { type: 'string', description: 'A genuinely useful alternative Etsy category path in English, or an empty string.' },
    alternativeCategoryZh: { type: 'string', description: 'Simplified Chinese translation of the alternative category, or an empty string.' },
    categoryRationaleZh: { type: 'string', description: 'Brief Simplified Chinese explanation of why the primary category matches product function and buyer behavior.' },
    titleEn: { type: 'string', description: 'Publication-ready natural English Etsy title, no more than 140 characters and preferably fewer than 15 words.' },
    titleZh: { type: 'string', description: 'Accurate natural Simplified Chinese translation of titleEn.' },
    descriptionEn: {
      type: 'string',
      description: 'Publication-ready English Markdown containing Heading / Hook, The Story, Why You’ll Love It, supported Details & Specs, Perfect For, and Before Ordering when relevant.',
    },
    descriptionZh: {
      type: 'string',
      description: 'Accurate Simplified Chinese Markdown counterpart containing 核心标题 / 情绪钩子、产品故事、你会喜欢它的原因、产品详情与规格、适合人群与场景，以及需要时的购买前须知。',
    },
    tags: {
      type: 'array',
      minItems: 13,
      maxItems: 13,
      items: {
        type: 'string',
        description: 'One relevant multi-word Etsy tag containing no more than 20 characters.',
      },
    },
  },
  required: [
    'marketInsightsZh',
    'primaryCategoryEn',
    'primaryCategoryZh',
    'alternativeCategoryEn',
    'alternativeCategoryZh',
    'categoryRationaleZh',
    'titleEn',
    'titleZh',
    'descriptionEn',
    'descriptionZh',
    'tags',
  ],
} as const

function createAPlusPlannerSchema(specs: AmazonAPlusModuleSpec[], marketplaceId?: AmazonMarketplaceId) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      product: PRODUCT_SCHEMA,
      sellingPoints: SELLING_POINTS_SCHEMA,
      seriesStyleGuide: {
        type: 'string',
        description: 'LLM-authored English visual style guide to keep the whole A+ module set coherent.',
      },
      aPlusPlans: {
        type: 'array',
        minItems: specs.length,
        maxItems: specs.length,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slot: { type: 'string', enum: specs.map((spec) => spec.slot) },
            label: CHINESE_LABEL_SCHEMA,
            moduleType: { type: 'string', enum: Array.from(new Set(specs.map((spec) => spec.moduleType))) },
            planMarkdown: PLAN_MARKDOWN_SCHEMA,
            textTitle: createAPlusExternalTextSchema('title', marketplaceId),
            textBody: createAPlusExternalTextSchema('body', marketplaceId),
            prompt: createImagePromptSchema(marketplaceId),
            negativePrompt: NEGATIVE_PROMPT_SCHEMA,
          },
          required: ['slot', 'label', 'moduleType', 'planMarkdown', 'textTitle', 'textBody', 'prompt', 'negativePrompt'],
        },
      },
    },
    required: ['product', 'sellingPoints', 'seriesStyleGuide', 'aPlusPlans'],
  } as const
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  if (typeof record.output_text === 'string') return record.output_text

  const choices = Array.isArray(record.choices) ? record.choices : []
  const chatChunks: string[] = []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const choiceRecord = choice as Record<string, unknown>
    const message = choiceRecord.message
    if (message && typeof message === 'object') {
      const messageRecord = message as Record<string, unknown>
      const content = messageRecord.content
      if (typeof content === 'string') chatChunks.push(content)
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue
          const partRecord = part as Record<string, unknown>
          if (typeof partRecord.text === 'string') chatChunks.push(partRecord.text)
        }
      }
    }
    const delta = choiceRecord.delta
    if (delta && typeof delta === 'object') {
      const content = (delta as Record<string, unknown>).content
      if (typeof content === 'string') chatChunks.push(content)
    }
  }
  if (chatChunks.length) return chatChunks.join('\n').trim()

  const output = Array.isArray(record.output) ? record.output : []
  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const itemRecord = item as Record<string, unknown>
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const partRecord = part as Record<string, unknown>
      if (typeof partRecord.text === 'string') chunks.push(partRecord.text)
    }
  }
  return chunks.join('\n').trim()
}

function hasWebSearchCall(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  if (record.type === 'web_search_call') return true
  if (typeof record.type === 'string' && record.type.includes('web_search_call')) return true
  const output = Array.isArray(record.output) ? record.output : []
  return output.some((item) => hasWebSearchCall(item))
}

interface PlannerResponseTextResult {
  text: string
  webResearchUsed: boolean
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value ? value : undefined
}

function parsePlannerPayload(text: string): PlannerApiPayload {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  return JSON.parse(fenced ?? trimmed) as PlannerApiPayload
}

function parseEtsyListingPayload(text: string): EtsyListingApiPayload {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  return JSON.parse(fenced ?? trimmed) as EtsyListingApiPayload
}

function getPlannerPayloadFromEvent(event: Record<string, unknown>): unknown {
  if (isRecordValue(event.response)) return event.response
  if (isRecordValue(event.item)) return { output: [event.item] }
  return null
}

function getPlannerTextFromEvent(event: Record<string, unknown>): string {
  const directText = extractResponseText(event)
  if (directText) return directText

  const payloadText = extractResponseText(getPlannerPayloadFromEvent(event))
  if (payloadText) return payloadText

  const text = getStringValue(event, 'text')
  if (text) return text

  const part = event.part
  if (isRecordValue(part)) {
    const partText = getStringValue(part, 'text')
    if (partText) return partText
  }

  return ''
}

async function readPlannerTextFromSseResponse(response: Response): Promise<PlannerResponseTextResult> {
  let completedText = ''
  let outputItemText = ''
  let doneText = ''
  let deltaText = ''
  let webResearchUsed = false

  await readJsonServerSentEvents(response, (event) => {
    if (hasWebSearchCall(event) || hasWebSearchCall(event.response) || hasWebSearchCall(event.item)) webResearchUsed = true
    const type = getStringValue(event, 'type')
    if (type === 'response.output_text.delta') {
      deltaText += getStringValue(event, 'delta') ?? ''
      return
    }

    const text = getPlannerTextFromEvent(event)
    if (!text) return

    if (type === 'response.completed') completedText = text
    else if (type === 'response.output_item.done') outputItemText = text
    else if (type === 'response.output_text.done' || type === 'response.content_part.done') doneText = text
    else if (!type) deltaText += text
  })

  return {
    text: completedText.trim() || outputItemText.trim() || doneText.trim() || deltaText.trim(),
    webResearchUsed,
  }
}

async function readPlannerTextFromSseText(rawText: string): Promise<PlannerResponseTextResult> {
  let completedText = ''
  let outputItemText = ''
  let doneText = ''
  let deltaText = ''
  let webResearchUsed = false

  await readJsonServerSentEventText(rawText, (event) => {
    if (hasWebSearchCall(event) || hasWebSearchCall(event.response) || hasWebSearchCall(event.item)) webResearchUsed = true
    const type = getStringValue(event, 'type')
    if (type === 'response.output_text.delta') {
      deltaText += getStringValue(event, 'delta') ?? ''
      return
    }

    const text = getPlannerTextFromEvent(event)
    if (!text) return

    if (type === 'response.completed') completedText = text
    else if (type === 'response.output_item.done') outputItemText = text
    else if (type === 'response.output_text.done' || type === 'response.content_part.done') doneText = text
    else if (!type) deltaText += text
  })

  return {
    text: completedText.trim() || outputItemText.trim() || doneText.trim() || deltaText.trim(),
    webResearchUsed,
  }
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes('application/json') || contentType.includes('+json')
}

function truncateForError(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= 1200) return trimmed
  return `${trimmed.slice(0, 1200)}...`
}

async function readPlannerResponseText(response: Response): Promise<PlannerResponseTextResult> {
  if (isEventStreamResponse(response)) {
    const result = await readPlannerTextFromSseResponse(response)
    if (!result.text) throw new Error('AI 策划流式接口未返回文本内容')
    return result
  }

  const rawText = await response.text()
  if (!rawText.trim()) throw new Error('AI 策划接口返回空内容')

  if (looksLikeServerSentEvents(rawText)) {
    const result = await readPlannerTextFromSseText(rawText)
    if (!result.text) throw new Error('AI 策划流式接口未返回文本内容')
    return result
  }

  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? ''
  if (!isJsonContentType(contentType) && !/^[{\[]/.test(rawText.trimStart())) {
    throw new Error(`AI 策划接口返回了非 JSON 内容：${truncateForError(rawText)}`)
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawText)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`AI 策划接口返回了无法解析的 JSON：${message}\n\n${truncateForError(rawText)}`)
  }

  const text = extractResponseText(payload)
  if (!text) throw new Error('AI 策划接口未返回文本内容')
  return { text, webResearchUsed: hasWebSearchCall(payload) }
}

function normalizePlan(plan: Partial<AmazonImagePlan>, index: number, slots: string[]): AmazonImagePlan {
  return {
    slot: plan.slot || slots[index] || `PT${String(index).padStart(2, '0')}`,
    label: plan.label || '图片方案',
    ...(plan.kind ? { kind: plan.kind } : {}),
    planMarkdown: plan.planMarkdown || '',
    prompt: plan.prompt || '',
    negativePrompt: plan.negativePrompt || '',
  }
}

function normalizePlannerText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function limitTextAtWord(value: string, maxCharacters: number): string {
  const characters = Array.from(value.trim())
  if (characters.length <= maxCharacters) return characters.join('')
  const clipped = characters.slice(0, maxCharacters + 1).join('')
  const lastSpace = clipped.lastIndexOf(' ')
  return (lastSpace >= Math.floor(maxCharacters * 0.6) ? clipped.slice(0, lastSpace) : characters.slice(0, maxCharacters).join('')).trim()
}

function normalizeEtsyTag(value: unknown): string {
  const normalized = normalizePlannerText(value)
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^['-]+|['-]+$/g, '')
    .trim()
  return limitTextAtWord(normalized, 20)
}

function requireEtsyListingText(payload: EtsyListingApiPayload, key: keyof EtsyListingApiPayload, label: string): string {
  const value = normalizePlannerText(payload[key])
  if (!value) throw new Error(`Etsy Listing 详情缺少${label}`)
  return value
}

function normalizeEtsyListingDetails(payload: EtsyListingApiPayload, webResearchUsed: boolean): EtsyListingDetails {
  const rawTags = Array.isArray(payload.tags) ? payload.tags : []
  const tags = rawTags
    .map(normalizeEtsyTag)
    .filter((tag, index, all) => Boolean(tag) && all.findIndex((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase()) === index)
    .slice(0, 13)
  if (tags.length !== 13) throw new Error(`Etsy Listing 详情必须包含 13 个不重复 Tags，当前为 ${tags.length} 个`)

  const marketInsights = requireEtsyListingText(payload, 'marketInsightsZh', '市场趋势与验证洞察')
  return {
    marketInsightsZh: webResearchUsed
      ? marketInsights
      : `本次策划接口未完成实时联网检索，以下洞察基于产品资料与模型已有知识，发布前建议再核对 Etsy Marketplace Insights、搜索联想与目标品类。\n\n${marketInsights}`,
    primaryCategoryEn: requireEtsyListingText(payload, 'primaryCategoryEn', '英文推荐品类'),
    primaryCategoryZh: requireEtsyListingText(payload, 'primaryCategoryZh', '中文推荐品类'),
    alternativeCategoryEn: normalizePlannerText(payload.alternativeCategoryEn),
    alternativeCategoryZh: normalizePlannerText(payload.alternativeCategoryZh),
    categoryRationaleZh: requireEtsyListingText(payload, 'categoryRationaleZh', '品类说明'),
    titleEn: limitTextAtWord(requireEtsyListingText(payload, 'titleEn', '英文标题'), 140),
    titleZh: requireEtsyListingText(payload, 'titleZh', '中文标题'),
    descriptionEn: requireEtsyListingText(payload, 'descriptionEn', '英文详情'),
    descriptionZh: requireEtsyListingText(payload, 'descriptionZh', '中文详情'),
    tags,
    researchStatus: webResearchUsed ? 'web-verified' : 'model-only',
  }
}

export function formatEtsyListingDetailsMarkdown(details: EtsyListingDetails): string {
  const alternativeCategory = details.alternativeCategoryEn && details.alternativeCategoryZh
    ? [
        '',
        `Alternative Category, if applicable:\n${details.alternativeCategoryEn}`,
        '',
        `备选品类，如适用：\n${details.alternativeCategoryZh}`,
      ].join('\n')
    : ''
  return [
    '## 1. Market & Verification Insights',
    '',
    '### 市场趋势与验证洞察',
    '',
    details.marketInsightsZh,
    '',
    '## 2. Recommended Etsy Category',
    '',
    '### 推荐 Etsy 品类',
    '',
    `Primary Category:\n${details.primaryCategoryEn}`,
    '',
    `中文品类：\n${details.primaryCategoryZh}`,
    alternativeCategory,
    '',
    `Category Rationale:\n${details.categoryRationaleZh}`,
    '',
    '## 3. Optimized SEO Title',
    '',
    '### 优化后的 SEO 标题',
    '',
    `English:\n${details.titleEn}`,
    '',
    `中文释义：\n${details.titleZh}`,
    '',
    '## 4. High-Converting Description',
    '',
    '### 高转化产品详情',
    '',
    '### English Version',
    '',
    details.descriptionEn,
    '',
    '### 中文版本',
    '',
    details.descriptionZh,
    '',
    '## 5. 13 Golden Tags',
    '',
    '### 13 个黄金 Tags',
    '',
    ...details.tags.map((tag, index) => `${index + 1}. ${tag}`),
  ].filter((section, index, all) => section !== '' || (index > 0 && all[index - 1] !== '')).join('\n')
}

function inferTitleFromListingText(value: string): string {
  const firstMeaningfulLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? ''

  return firstMeaningfulLine
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^(标题|商品标题|title|product title)\s*[：:]\s*/i, '')
    .trim()
}

function normalizePackageIncludes(value: unknown): string {
  if (!Array.isArray(value)) return normalizePlannerText(value)
  return value.map(normalizePlannerText).filter(Boolean).join(', ')
}

function normalizeParsedListing(payload: PlannerApiPayload, fallbackTitle = ''): ListingParseResult {
  const product = payload.product ?? {}
  const sellingPoints = Array.isArray(payload.sellingPoints)
    ? payload.sellingPoints.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 5)
    : []
  const title = normalizePlannerText(product.title) || normalizePlannerText(fallbackTitle)
  const brand = normalizePlannerText(product.brand)

  if (!title) throw new Error('AI 策划结果缺少商品标题')

  return {
    title,
    bullets: sellingPoints,
    inferred: {
      productTitle: title,
      category: normalizePlannerText(product.category),
      ...(brand ? { brand } : {}),
      color: normalizePlannerText(product.color),
      material: normalizePlannerText(product.material),
      audience: normalizePlannerText(product.audience),
      packageIncludes: normalizePackageIncludes(product.packageIncludes),
      sellingPoints: sellingPoints.join('\n'),
    },
  }
}

function normalizeSeriesStyleGuide(payload: PlannerApiPayload): string {
  return typeof payload.seriesStyleGuide === 'string' ? payload.seriesStyleGuide.trim() : ''
}

function normalizeListingPlannerApiPayload(payload: PlannerApiPayload, listingImageCount: number, marketplaceId: AmazonMarketplaceId, fallbackTitle = ''): PlannerApiResult {
  const parsed = normalizeParsedListing(payload, fallbackTitle)
  const seriesStyleGuide = normalizeSeriesStyleGuide(payload)
  const slots = getAmazonListingImageSlots(listingImageCount)
  const count = slots.length
  const plans = Array.isArray(payload.imagePlans)
    ? payload.imagePlans.map((plan, index) => normalizePlan(plan, index, slots)).filter((plan) => plan.prompt.trim() && plan.planMarkdown.trim()).slice(0, count)
    : []

  if (plans.length !== count) throw new Error(`AI 策划结果不是 ${count} 张图`)

  return {
    mode: 'listing',
    marketplaceId,
    parsed,
    seriesStyleGuide,
    plans,
    aPlusPlans: [],
  }
}

function normalizeEtsyVisualDna(payload: PlannerApiPayload, parsed: ListingParseResult): EtsyVisualDna {
  const source = payload.visualDna ?? {}
  const product = payload.product ?? {}
  const material = normalizePlannerText(product.material)
  const color = normalizePlannerText(product.color)
  const audience = normalizePlannerText(product.audience)

  return {
    productNameType: normalizePlannerText(source.productNameType) || parsed.title,
    materialTextureFocus: normalizePlannerText(source.materialTextureFocus) || material || 'Preserve the exact real materials, surface texture, finish, and construction visible in the reference images.',
    colorPaletteLightingMood: normalizePlannerText(source.colorPaletteLightingMood) || [color ? `Real product color: ${color}.` : '', 'Use adaptive commercial lighting that reveals the true color and texture without recoloring the product.'].filter(Boolean).join(' '),
    brandAestheticTargetAudience: normalizePlannerText(source.brandAestheticTargetAudience) || [audience ? `Target buyer: ${audience}.` : '', 'Define the brand mood from this specific product and its craftsmanship; do not impose a generic Etsy aesthetic.'].filter(Boolean).join(' '),
  }
}

function formatEtsyVisualDnaLock(visualDna: EtsyVisualDna): string {
  return [
    `Product Name/Type: ${visualDna.productNameType}`,
    `Material & Texture Focus: ${visualDna.materialTextureFocus}`,
    `Color Palette & Lighting Mood: ${visualDna.colorPaletteLightingMood}`,
    `Brand Aesthetic & Target Audience: ${visualDna.brandAestheticTargetAudience}`,
  ].join('\n')
}

function normalizeEtsyPlannerApiPayload(payload: PlannerApiPayload, marketplaceId: AmazonMarketplaceId, fallbackTitle = ''): PlannerApiResult {
  const parsed = normalizeParsedListing(payload, fallbackTitle)
  const slots = getEtsyImageSlots()
  const plans = Array.isArray(payload.imagePlans)
    ? payload.imagePlans
        .map((plan, index) => applyEtsyAdditionalShotBrief(normalizePlan(plan, index, slots), index))
        .filter((plan) => plan.prompt.trim() && plan.planMarkdown.trim())
        .slice(0, ETSY_SHOT_COUNT)
    : []

  if (plans.length !== ETSY_SHOT_COUNT) throw new Error(`Etsy 策划结果不是 ${ETSY_SHOT_COUNT} 张图`)

  const etsyVisualDna = normalizeEtsyVisualDna(payload, parsed)
  const visualDnaLock = formatEtsyVisualDnaLock(etsyVisualDna)
  const modelGuide = normalizeSeriesStyleGuide(payload)

  return {
    mode: 'etsy',
    marketplaceId,
    parsed,
    seriesStyleGuide: [visualDnaLock, modelGuide].filter(Boolean).join('\n\n'),
    plans,
    aPlusPlans: [],
    etsyVisualDna,
  }
}

function normalizeAPlusPlan(
  plan: Partial<AmazonAPlusPlan> | undefined,
  index: number,
  tier: SizeTier,
  specs: AmazonAPlusModuleSpec[],
): AmazonAPlusPlan {
  const spec = specs[index]
  if (!spec) throw new Error('A+ 模块规格不存在')

  return {
    slot: plan?.slot || spec.slot,
    label: spec.label,
    moduleType: spec.moduleType,
    uploadSize: getAPlusModuleUploadSize(spec),
    generationSize: getAPlusModuleGenerationSize(spec, tier),
    planMarkdown: plan?.planMarkdown || '',
    textTitle: plan?.textTitle || '',
    textBody: plan?.textBody || '',
    prompt: plan?.prompt || '',
    negativePrompt: plan?.negativePrompt || '',
  }
}

function normalizeAPlusPlannerApiPayload(
  payload: PlannerApiPayload,
  aPlusType: APlusContentType,
  tier: SizeTier,
  specs: AmazonAPlusModuleSpec[],
  marketplaceId: AmazonMarketplaceId,
): PlannerApiResult {
  const parsed = normalizeParsedListing(payload)
  const seriesStyleGuide = normalizeSeriesStyleGuide(payload)
  const rawPlans = Array.isArray(payload.aPlusPlans) ? payload.aPlusPlans : []
  if (rawPlans.length !== specs.length) throw new Error(`AI A+ 策划结果不是 ${specs.length} 个模块`)

  const aPlusPlans = specs.map((spec, index) => {
    const bySlot = rawPlans.find((plan) => plan?.slot === spec.slot)
    return normalizeAPlusPlan(bySlot ?? rawPlans[index], index, tier, specs)
  })

  const emptyPrompt = aPlusPlans.find((plan) => !plan.prompt.trim())
  if (emptyPrompt) throw new Error(`AI A+ 策划结果缺少 ${emptyPrompt.slot} 的提示词`)
  const emptyPlan = aPlusPlans.find((plan) => !plan.planMarkdown.trim())
  if (emptyPlan) throw new Error(`AI A+ 策划结果缺少 ${emptyPlan.slot} 的策划说明`)

  return {
    mode: 'aplus',
    marketplaceId,
    parsed,
    seriesStyleGuide,
    plans: [],
    aPlusPlans,
    aPlusType,
  }
}

function buildMarketplaceInstructionBlock(marketplaceId?: AmazonMarketplaceId) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  return [
    `Target marketplace: ${marketplace.label} (${marketplace.domain}, locale ${marketplace.locale}).`,
    `Customer-facing visible copy must be concise, natural ${marketplace.onImageCopyLanguage}.`,
    ...marketplace.localGuidance,
    'Keep image-generation prompt and negativePrompt fields written in English for image-model stability, but quote any visible customer-facing copy in the target marketplace language.',
  ].join('\n')
}

function buildFieldLanguageRules(marketplaceId?: AmazonMarketplaceId, options: { includeAPlusExternalText?: boolean } = {}) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  const externalTextRule = options.includeAPlusExternalText
    ? ` textTitle/textBody must be natural ${marketplace.copyLanguage} for ${marketplace.domain} or empty;`
    : ''
  return `Field language rules: label and planMarkdown must be Simplified Chinese;${externalTextRule} seriesStyleGuide, prompt, and negativePrompt must be English. Visible customer-facing copy described inside prompt must be ${marketplace.onImageCopyLanguage}.`
}

function buildListingPlannerInstructions(baseDraft: AmazonPromptDraft, listingImageCount: number, marketplaceId?: AmazonMarketplaceId) {
  const slots = getAmazonListingImageSlots(listingImageCount)
  return [
    'You are an Amazon image-planning agent. The user provides listing copy and optional product reference images.',
    buildMarketplaceInstructionBlock(marketplaceId),
    `Create a complete visual plan for exactly ${slots.length} Amazon listing image slots: ${slots.join(', ')}.`,
    'The application only fixes the slot count and order. You must decide the strategy, composition, copy approach, visual treatment, prompt content, and negative prompt content.',
    'Use the Amazon reference material below to improve compliance judgment. It is not a fixed slot-by-slot framework, and it must not replace the product facts from the listing and reference images.',
    formatAmazonListingReferenceMaterial(marketplaceId),
    PRODUCT_REFERENCE_FACTS_ONLY_PLANNER_GUIDE,
    'For each slot, write planMarkdown in Simplified Chinese as a detailed agent-style plan similar to a ChatGPT web response, then write a professional English image prompt and English negative prompt.',
    `Each image prompt should fully plan the finished Amazon image: composition, product evidence, on-image ${getAmazonMarketplace(marketplaceId).onImageCopyLanguage} copy when useful, callouts or information areas when useful, visual hierarchy, and rendering style.`,
    'For secondary information images, prefer complete information design with clear hierarchy and useful product evidence; lifestyle or beauty slots should still have purposeful composition and visible product support.',
    'Return one seriesStyleGuide string in English for cross-image product consistency and factual visual continuity. Keep it style-neutral and do not use it to choose the final color palette, typography, background mood, lighting mood, or decorative style.',
    'Do not create, request, or describe separate style reference board images. The application uses built-in preset style reference boards.',
    buildFieldLanguageRules(marketplaceId),
    'Do not generate images. Only return JSON matching the schema.',
    baseDraft.category ? `Known category: ${baseDraft.category}` : '',
  ].filter(Boolean).join('\n')
}

function buildEtsyPlannerInstructions(baseDraft: AmazonPromptDraft) {
  const slots = getEtsyImageSlots()
  return [
    "You are a 'World-Class Adaptive Art Director and AI Photographer' specifically tailored for Etsy sellers.",
    'Your mission is to curate a bespoke, commercially viable product photoshoot that elevates the seller brand while preserving the real product exactly.',
    'PHASE 1 — DEEP DIVE ANALYSIS & STRATEGIC PLANNING ONLY. Do not generate images in this response.',
    'PART A: VISUAL DNA ANALYSIS. Analyze and return all four required fields: Product Name/Type; Material & Texture Focus; Color Palette & Lighting Mood; Brand Aesthetic & Target Audience.',
    'Visual DNA Lock is crucial: derive physical facts from the product description, user-provided facts, and reference images. Never invent or redesign material, color, texture, finish, silhouette, dimensions, construction, accessories, logo, text, or quantity.',
    `PART B: THE DYNAMIC ${ETSY_SHOT_COUNT}-SHOT BESPOKE PLAN. Return exactly ${ETSY_SHOT_COUNT} shots in this slot order: ${slots.join(', ')}.`,
    'Never use a reusable fixed scene template. Dynamically design every scene from this product’s Visual DNA, use case, craftsmanship, price positioning, gifting context, and likely Etsy buyer.',
    `Preserve the original ${ETSY_ORIGINAL_SHOT_COUNT}-shot behavior for E01-E10: they must remain a strategic mix of hero/clean listing, macro/detail, lifestyle/in-situ, and atmospheric/creative images, with their exact order and concepts uniquely chosen for this product. Do not replace or compress these original ten shots.`,
    'Append these five additional conversion shots after the original ten, in this exact order:',
    ...ETSY_ADDITIONAL_SHOT_BRIEFS.map((brief) => `${brief.slot} — ${brief.label}: ${brief.promptRequirement}`),
    `For E11-E15, also follow this production requirement: ${ETSY_ADDITIONAL_PREMIUM_PRODUCTION_STANDARD}`,
    'For each imagePlans item, label the shot strategy clearly and write planMarkdown as: **[Shot Strategy]:** followed by a specific, creative scene description tailored exactly to this product.',
    'Every imagePlans.prompt must explicitly repeat the locked physical attributes—material, real color, texture, finish, silhouette, proportions, construction, and included details—so the image model cannot redesign the product.',
    `Every imagePlans.prompt must include this exact mandatory technical style: ${ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS}.`,
    'Prompts and negative prompts must be in English. planMarkdown and UI labels should be concise Simplified Chinese.',
    'Keep scenes commercially useful for Etsy. Avoid marketplace badges, fake reviews, prices, coupons, sale stickers, watermarks, QR codes, and unsupported claims.',
    'Return one seriesStyleGuide in English that reinforces only product consistency and a cohesive bespoke campaign derived from the Visual DNA.',
    'Do not ask follow-up questions inside the JSON and do not output prose outside the JSON. The application will display the Phase 1 confirmation message after the plan.',
    baseDraft.category ? `Known category: ${baseDraft.category}` : '',
  ].filter(Boolean).join('\n')
}

function getAPlusPlannerTypeName(aPlusType: APlusContentType) {
  switch (aPlusType) {
    case 'premium':
      return 'Premium A+ Content'
    case 'mobile':
      return 'Mobile A+ Content 600x450 module set'
    case 'standard-large':
      return 'Regular A+ Content large-image template'
    default:
      return 'Standard A+ Content'
  }
}

function buildAPlusPlannerInstructions(baseDraft: AmazonPromptDraft, aPlusType: APlusContentType, specs: AmazonAPlusModuleSpec[], marketplaceId?: AmazonMarketplaceId) {
  const typeLabel = getAPlusPlannerTypeName(aPlusType)
  const marketplace = getAmazonMarketplace(marketplaceId)
  const mobileGuidance = aPlusType === 'mobile'
    ? `For Mobile A+ modules, design every 600x450 image for compact mobile screens: one clear message per module, large product evidence, short mobile-readable ${marketplace.onImageCopyLanguage} copy, and no dense multi-column layouts.`
    : ''
  return [
    'You are an Amazon A+ Content image-planning agent. The user provides listing copy, optional brand notes, and optional product reference images.',
    buildMarketplaceInstructionBlock(marketplaceId),
    `Create a ${typeLabel} image module plan. Do not generate images. Only return JSON matching the schema.`,
    `Return exactly ${specs.length} modules in this order: ${specs.map((spec) => `${spec.slot} ${spec.label} ${getAPlusModuleUploadSize(spec)}px`).join('; ')}.`,
    'The application only fixes the module order, module type, upload size, and generation size. You must decide the strategy, composition, copy approach, visual treatment, prompt content, and negative prompt content.',
    'Use the Amazon A+ reference material below to improve compliance judgment. It is not a fixed module creative framework, and it must not replace the product facts from the listing and reference images.',
    formatAmazonAPlusReferenceMaterial(marketplaceId),
    PRODUCT_REFERENCE_FACTS_ONLY_PLANNER_GUIDE,
    'For each module, write planMarkdown in Simplified Chinese as a detailed agent-style plan similar to a ChatGPT web response, then write a professional English image prompt and English negative prompt.',
    `Each module prompt should fully plan the finished Amazon image: composition, product evidence, on-image ${marketplace.onImageCopyLanguage} copy when useful, callouts or information areas when useful, visual hierarchy, and rendering style.`,
    'For A+ information modules, prefer complete information design with clear hierarchy and useful product evidence; lifestyle or brand modules should still have purposeful composition and visible product support.',
    mobileGuidance,
    baseDraft.brand
      ? `Known brand/model: ${baseDraft.brand}. For header-banner and hero-banner modules, naturally include this real brand/model as a small brand line, headline prefix, or subline when it improves the composition. For brand-story modules, use this brand/model to frame the brand tone or promise only when supported by the provided listing or brand notes.`
      : 'If no real brand/model is provided, do not invent a brand name, logo, trademark, brand history, brand promise, authorization claim, website, contact detail, or external link.',
    'Use brand names as text only unless the user provides a real logo reference image. Do not invent logo artwork, standalone trademark/copyright symbols, brand history, authorization claims, websites, contact details, or external links.',
    'Return one seriesStyleGuide string in English for cross-module product consistency and factual visual continuity. Keep it style-neutral and do not use it to choose the final color palette, typography, background mood, lighting mood, or decorative style.',
    'Do not create, request, or describe separate style reference board images. The application uses built-in preset style reference boards.',
    `For modules that need external A+ text outside the image, write textTitle and textBody in natural ${marketplace.copyLanguage}. Otherwise return empty strings.`,
    buildFieldLanguageRules(marketplaceId, { includeAPlusExternalText: true }),
    baseDraft.category ? `Known category: ${baseDraft.category}` : '',
  ].filter(Boolean).join('\n')
}

function buildPlannerInstructions(
  baseDraft: AmazonPromptDraft,
  mode: AmazonPlannerMode,
  aPlusType: APlusContentType,
  options: { textOnlyReferenceGuard?: boolean; listingImageCount?: number; aPlusModuleSpecs?: AmazonAPlusModuleSpec[]; marketplaceId?: AmazonMarketplaceId } = {},
) {
  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  const aPlusModuleSpecs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
  return [
    mode === 'etsy'
      ? buildEtsyPlannerInstructions(baseDraft)
      : mode === 'aplus'
        ? buildAPlusPlannerInstructions(baseDraft, aPlusType, aPlusModuleSpecs, options.marketplaceId)
        : buildListingPlannerInstructions(baseDraft, listingImageCount, options.marketplaceId),
    options.textOnlyReferenceGuard ? DEEPSEEK_TEXT_ONLY_PLANNER_GUARD : '',
  ].filter(Boolean).join('\n')
}

function formatDraftFact(label: string, value: string) {
  const trimmed = value.trim()
  return trimmed ? `- ${label}: ${trimmed}` : ''
}

function buildUserProductFactsText(baseDraft: AmazonPromptDraft) {
  const facts = [
    formatDraftFact('Product title', baseDraft.productTitle),
    formatDraftFact('Category', baseDraft.category),
    formatDraftFact('Brand or model', baseDraft.brand),
    formatDraftFact('Color', baseDraft.color),
    formatDraftFact('Material / finish', baseDraft.material),
    formatDraftFact('Target customer', baseDraft.audience),
    formatDraftFact('Package includes', baseDraft.packageIncludes),
    formatDraftFact('Key selling points', baseDraft.sellingPoints),
    formatDraftFact('Do not show / avoid', baseDraft.forbidden),
  ].filter(Boolean)

  return facts.length
    ? ['User-provided product facts. Treat these as authoritative and do not contradict them:', ...facts].join('\n')
    : ''
}

function buildEtsyListingInstructions(options: { webSearchAvailable: boolean; textOnlyReferenceGuard: boolean }) {
  const today = new Date().toISOString().slice(0, 10)
  return [
    'You are a top-tier Etsy Operations Expert, SEO Strategist, and Senior Copywriting Director with 15 years of experience.',
    `Current date: ${today}. Create one commercially useful, publication-ready Etsy listing from the supplied product images and facts.`,
    '',
    'STEP 1 — DEEP VISUAL, MARKET, AUDIENCE, AND CATEGORY ANALYSIS',
    '- Decode product type and function, materials and finishes, real colors and textures, construction, style, distinctive features, and defensible advantages.',
    '- Never invent materials, dimensions, functions, techniques, included accessories, handmade status, personalization, certifications, performance claims, or production methods.',
    '- Profile likely buyers and their real motivations: self-gifting, styling, occasions, meaningful gifting, functional problem-solving, collecting, originality, durability, or premium materials.',
    '- Recommend the deepest accurate Etsy category based on primary function and buyer search behavior; include one alternative only when genuinely useful.',
    options.webSearchAvailable
      ? '- You MUST use web search before drafting. Cross-check current Etsy terminology and category behavior, Etsy search/best-seller language, Pinterest and Google trend language, seasonal and gifting demand, buyer pain points, and relevant premium competitors. Prefer Etsy official guidance and current, product-specific buyer-intent evidence. Do not copy competitor wording.'
      : '- Live web search is unavailable for this request. Do not claim that current trends, competitor terms, Pinterest, Google, or Etsy search results were verified. Make the best conservative draft and say in marketInsightsZh that live verification remains necessary.',
    '',
    'STEP 2 — DRAFTING AND SEO LAYOUT',
    '- Write one primary category, one English title, a bilingual conversion-focused description, and exactly 13 English Etsy tags.',
    '- Title: maximum 140 characters; prefer fewer than 15 clear words under Etsy’s current buyer-friendly guidance; clearly state the item and strongest objective traits early; put the strongest core phrase within the first 40 characters; avoid repetition, subjective filler, keyword stuffing, price, delivery, and non-essential gifting phrases.',
    '- Description: hook within the first paragraph; explain the product, supported materials/craft/function/emotional value, common buyer concerns, and important missing facts. Use short paragraphs and readable bullets.',
    '- English description Markdown must use: **Heading / Hook**, **The Story**, **Why You’ll Love It**, **Details & Specs**, **Perfect For**, and **Before Ordering** when sizing, installation, compatibility, personalization, variation, or options matter.',
    '- Chinese description must accurately mirror the English content using: **核心标题 / 情绪钩子**, **产品故事**, **你会喜欢它的原因**, **产品详情与规格**, **适合人群与场景**, and **购买前须知** when relevant.',
    '- Include only supported Details & Specs fields. Mark essential missing information as “Please confirm before publishing / 发布前需要确认” rather than guessing.',
    '- Tags: exactly 13 unique, relevant English tags; each at most 20 characters; use multi-word natural buyer-intent phrases when possible; balance product type, material, style, function, recipient, occasion, room/use scenario, and gift intent without repetitive variants.',
    '',
    'STEP 3 — CROSS-VERIFICATION AND EVOLUTION',
    '- Verify category, core phrases, title structure, tags, selling points, practical concerns, seasonal relevance, and differentiation when web search is available.',
    '- Remove generic, repetitive, low-intent, misleading, unsupported, awkward, or overly broad language. Do not name competitors unless essential.',
    '',
    'STEP 4 — FINAL SELF-CORRECTION',
    '- Internally check category accuracy, title character count and clarity, exact tag count and 20-character limit, supported claims, bilingual fidelity, scanability, and buyer relevance. Revise before returning.',
    '',
    'STEP 5 — OUTPUT',
    '- Return only JSON matching the provided schema. Do not reveal hidden reasoning, drafts, search steps, internal scoring, or fabricated verification.',
    '- English fields must be publication-ready; Chinese fields are accurate explanations for the seller.',
    options.textOnlyReferenceGuard ? DEEPSEEK_TEXT_ONLY_PLANNER_GUARD : '',
  ].filter(Boolean).join('\n')
}

function buildEtsyListingJsonGuide() {
  return [
    'Return one JSON object with EXACTLY these top-level keys and no others:',
    '{',
    '  "marketInsightsZh": "Simplified Chinese string",',
    '  "primaryCategoryEn": "English Etsy category path",',
    '  "primaryCategoryZh": "Simplified Chinese category path",',
    '  "alternativeCategoryEn": "English alternative path or empty string",',
    '  "alternativeCategoryZh": "Simplified Chinese alternative path or empty string",',
    '  "categoryRationaleZh": "Simplified Chinese string",',
    '  "titleEn": "English title",',
    '  "titleZh": "Simplified Chinese title",',
    '  "descriptionEn": "English Markdown string",',
    '  "descriptionZh": "Simplified Chinese Markdown string",',
    '  "tags": ["tag 1", "tag 2", "tag 3", "tag 4", "tag 5", "tag 6", "tag 7", "tag 8", "tag 9", "tag 10", "tag 11", "tag 12", "tag 13"]',
    '}',
    'The tags value MUST be a JSON array containing exactly 13 unique English strings. Every tag must be 20 characters or fewer after trimming. Never nest these fields inside another object and never rename them.',
  ].join('\n')
}

function buildEtsyListingRepairInput(previousOutput: string, errorMessage: string) {
  return [
    'Repair the previous Etsy Listing JSON response so it exactly follows the required schema.',
    `Validation error: ${errorMessage}`,
    'Preserve all useful product-specific content, but correct field names, nesting, title length, and tags.',
    'Do not add unsupported product facts. Return only the repaired JSON object.',
    '',
    'Previous response:',
    previousOutput,
  ].join('\n')
}

function buildEtsyListingInputText(
  listingText: string,
  baseDraft: AmazonPromptDraft,
  includeReferenceImageInstruction: boolean,
) {
  return [
    'Analyze the following Etsy product and generate its complete bilingual Listing details.',
    includeReferenceImageInstruction
      ? 'Reference images are attached. Use them only for verifiable product facts and appearance; text facts supplied by the user remain authoritative.'
      : 'No readable reference images are available to this planner. Rely only on the supplied text facts.',
    buildUserProductFactsText(baseDraft),
    '',
    'User product description:',
    listingText.trim(),
  ].filter((item) => item !== '').join('\n')
}

function buildPlannerInputText(
  listingText: string,
  mode: AmazonPlannerMode,
  aPlusType: APlusContentType,
  options: { includeReferenceImageInstruction?: boolean; userProductFacts?: string; listingImageCount?: number; aPlusModuleSpecs?: AmazonAPlusModuleSpec[]; marketplaceId?: AmazonMarketplaceId } = {},
) {
  const referenceImageInstruction = options.includeReferenceImageInstruction
    ? 'If reference images are attached, use them to understand the actual product appearance and included items.'
    : ''
  const userProductFacts = options.userProductFacts?.trim()
  const marketplace = getAmazonMarketplace(options.marketplaceId)
  if (mode === 'etsy') {
    return [
      `Analyze this Etsy product and produce its Visual DNA plus a dynamic ${ETSY_SHOT_COUNT}-shot bespoke photoshoot blueprint.`,
      'Treat the supplied product facts and reference images as authoritative. If a physical detail is uncertain, stay neutral rather than inventing it.',
      referenceImageInstruction,
      userProductFacts,
      '',
      listingText,
    ].filter((item) => item !== '').join('\n')
  }
  if (mode === 'aplus') {
    const specs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
    return [
      `Parse this ${marketplace.domain} listing copy and produce the ${getAPlusContentTypeLabel(aPlusType)} module plan for ${marketplace.label}.`,
      'Use the title and bullet points from the pasted text. If a field is uncertain, infer conservatively from the listing.',
      `Target marketplace language for visible customer-facing copy: ${marketplace.copyLanguage}.`,
      `Use these A+ modules exactly: ${specs.map((spec) => spec.slot).join(', ')}.`,
      referenceImageInstruction,
      userProductFacts,
      '',
      listingText,
    ].filter((item) => item !== '').join('\n')
  }

  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  return [
    `Parse this ${marketplace.domain} listing copy and produce the ${listingImageCount}-image visual plan for ${marketplace.label}.`,
    'Use the title and bullet points from the pasted text. If a field is uncertain, infer conservatively from the listing.',
    `Target marketplace language for visible customer-facing copy: ${marketplace.copyLanguage}.`,
    referenceImageInstruction,
    userProductFacts,
    '',
    listingText,
  ].filter((item) => item !== '').join('\n')
}

function buildChatPlannerUserContent(text: string, referenceImageDataUrls: string[]) {
  if (!referenceImageDataUrls.length) return text
  return [
    { type: 'text', text },
    ...referenceImageDataUrls.map((url) => ({
      type: 'image_url',
      image_url: { url },
    })),
  ]
}

function buildResponsesPlannerInput(text: string, referenceImageDataUrls: string[]) {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text,
        },
        ...referenceImageDataUrls.map((url) => ({
          type: 'input_image',
          image_url: url,
        })),
      ],
    },
  ]
}

function buildChatPlannerSchemaGuide(
  mode: AmazonPlannerMode,
  aPlusType: APlusContentType,
  options: { listingImageCount?: number; aPlusModuleSpecs?: AmazonAPlusModuleSpec[]; marketplaceId?: AmazonMarketplaceId } = {},
) {
  const productFields = 'product { title, category, color, material, audience, packageIncludes }'
  const styleFields = 'seriesStyleGuide string'
  const marketplace = getAmazonMarketplace(options.marketplaceId)
  if (mode === 'etsy') {
    const slots = getEtsyImageSlots()
    return [
      `Return JSON with: ${productFields}, sellingPoints string[], visualDna object, ${styleFields}, imagePlans array.`,
      'visualDna must include productNameType, materialTextureFocus, colorPaletteLightingMood, brandAestheticTargetAudience.',
      `imagePlans must contain exactly ${slots.length} items in this order: ${slots.join(', ')}.`,
      'Each imagePlans item must include: slot, label, planMarkdown, prompt, negativePrompt.',
      'Every prompt must explicitly repeat the locked product material, color, texture, finish, silhouette, proportions, and construction.',
    ].join('\n')
  }
  if (mode === 'aplus') {
    const specs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
    return [
      `Return JSON with: ${productFields}, sellingPoints string[], ${styleFields}, aPlusPlans array.`,
      `aPlusPlans must contain exactly ${specs.length} items in this order: ${specs.map((spec) => spec.slot).join(', ')}.`,
      'Each aPlusPlans item must include: slot, label, moduleType, planMarkdown, textTitle, textBody, prompt, negativePrompt.',
      `textTitle/textBody and visible on-image copy must use natural ${marketplace.copyLanguage} for ${marketplace.domain}; prompt and negativePrompt should remain English.`,
    ].join('\n')
  }

  const slots = getAmazonListingImageSlots(options.listingImageCount ?? DEFAULT_LISTING_IMAGE_COUNT)
  return [
    `Return JSON with: ${productFields}, sellingPoints string[], ${styleFields}, imagePlans array.`,
    `imagePlans must contain exactly ${slots.length} items in this order: ${slots.join(', ')}.`,
    'Each imagePlans item must include: slot, label, planMarkdown, prompt, negativePrompt.',
    `Visible on-image copy inside prompt must use natural ${marketplace.copyLanguage} for ${marketplace.domain}; prompt and negativePrompt should remain English.`,
  ].join('\n')
}

function buildChatPlannerSystemPrompt(
  baseDraft: AmazonPromptDraft,
  mode: AmazonPlannerMode,
  aPlusType: APlusContentType,
  options: { textOnlyReferenceGuard?: boolean; listingImageCount?: number; aPlusModuleSpecs?: AmazonAPlusModuleSpec[]; marketplaceId?: AmazonMarketplaceId } = {},
) {
  return [
    buildPlannerInstructions(baseDraft, mode, aPlusType, options),
    'Return a valid JSON object only. Do not output Markdown fences, comments, or any text outside the JSON object.',
    buildChatPlannerSchemaGuide(mode, aPlusType, {
      listingImageCount: normalizeListingImageCount(options.listingImageCount),
      aPlusModuleSpecs: options.aPlusModuleSpecs,
      marketplaceId: options.marketplaceId,
    }),
  ].join('\n\n')
}

export async function callAmazonPlannerApi(options: {
  listingText: string
  baseDraft: AmazonPromptDraft
  profile: ApiProfile
  referenceImageDataUrls?: string[]
  model?: string
  mode?: AmazonPlannerMode
  marketplaceId?: AmazonMarketplaceId
  listingImageCount?: number
  aPlusType?: APlusContentType
  aPlusModuleSpecs?: Array<Partial<AmazonAPlusModuleSpec>>
  aPlusGenerationTier?: SizeTier
  signal?: AbortSignal
}): Promise<PlannerApiResult> {
  const model = options.model?.trim() || options.profile.model.trim() || (options.profile.apiMode === 'chat' ? DEFAULT_CHAT_MODEL : DEFAULT_RESPONSES_MODEL)
  const mode = options.mode ?? 'listing'
  const marketplaceId = normalizeAmazonMarketplaceId(options.marketplaceId)
  const aPlusType = options.aPlusType ?? 'standard-large'
  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  const aPlusModuleSpecs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
  const aPlusGenerationTier = options.aPlusGenerationTier ?? '2K'
  const schema = mode === 'etsy'
    ? createEtsyPlannerSchema()
    : mode === 'aplus'
      ? createAPlusPlannerSchema(aPlusModuleSpecs, marketplaceId)
      : createListingPlannerSchema(listingImageCount, marketplaceId)
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(options.profile.apiProxy, proxyConfig, options.profile.baseUrl)
  const useChatCompletions = options.profile.apiMode === 'chat'
  const isDeepSeekPlannerProfile = isOfficialDeepSeekPlannerProfile(options.profile)
  const inputText = buildPlannerInputText(options.listingText, mode, aPlusType, {
    includeReferenceImageInstruction: !isDeepSeekPlannerProfile,
    userProductFacts: isDeepSeekPlannerProfile || mode === 'etsy' ? buildUserProductFactsText(options.baseDraft) : '',
    listingImageCount,
    aPlusModuleSpecs,
    marketplaceId,
  })
  const referenceImageDataUrls = isDeepSeekPlannerProfile
    ? []
    : options.referenceImageDataUrls ?? []
  const response = await fetch(
    useChatCompletions
      ? buildApiUrl(options.profile.baseUrl, 'chat/completions', proxyConfig, useApiProxy, { prefixV1: false })
      : buildApiUrl(options.profile.baseUrl, 'responses', proxyConfig, useApiProxy),
    {
    method: 'POST',
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${options.profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(useChatCompletions
      ? {
          model,
          messages: [
            {
              role: 'system',
              content: buildChatPlannerSystemPrompt(options.baseDraft, mode, aPlusType, {
                textOnlyReferenceGuard: isDeepSeekPlannerProfile,
                listingImageCount,
                aPlusModuleSpecs,
                marketplaceId,
              }),
            },
            {
              role: 'user',
              content: buildChatPlannerUserContent(inputText, referenceImageDataUrls),
            },
          ],
          response_format: { type: 'json_object' },
          stream: false,
        }
      : {
          model,
          instructions: buildPlannerInstructions(options.baseDraft, mode, aPlusType, {
            textOnlyReferenceGuard: isDeepSeekPlannerProfile,
            listingImageCount,
            aPlusModuleSpecs,
            marketplaceId,
          }),
          input: buildResponsesPlannerInput(inputText, referenceImageDataUrls),
          text: {
            format: {
              type: 'json_schema',
              name: mode === 'etsy' ? 'etsy_bespoke_photoshoot_plan' : mode === 'aplus' ? 'amazon_aplus_image_plan' : 'amazon_listing_image_plan',
              strict: true,
              schema,
            },
          },
          stream: false,
        },
    ),
    },
  )

  if (!response.ok) {
    const message = await getApiErrorMessage(response)
    throw new Error(`HTTP ${response.status}: ${message}`)
  }
  const responseResult = await readPlannerResponseText(response)
  const payload = parsePlannerPayload(responseResult.text)
  const fallbackTitle = options.baseDraft.productTitle || inferTitleFromListingText(options.listingText)
  return mode === 'etsy'
    ? normalizeEtsyPlannerApiPayload(payload, marketplaceId, fallbackTitle)
    : mode === 'aplus'
      ? normalizeAPlusPlannerApiPayload(payload, aPlusType, aPlusGenerationTier, aPlusModuleSpecs, marketplaceId)
      : normalizeListingPlannerApiPayload(payload, listingImageCount, marketplaceId, fallbackTitle)
}

export async function callEtsyListingDetailsApi(options: {
  listingText: string
  baseDraft: AmazonPromptDraft
  profile: ApiProfile
  referenceImageDataUrls?: string[]
  model?: string
  signal?: AbortSignal
}): Promise<EtsyListingApiResult> {
  const model = options.model?.trim() || options.profile.model.trim() || (options.profile.apiMode === 'chat' ? DEFAULT_CHAT_MODEL : DEFAULT_RESPONSES_MODEL)
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(options.profile.apiProxy, proxyConfig, options.profile.baseUrl)
  const isDeepSeekPlannerProfile = isOfficialDeepSeekPlannerProfile(options.profile)
  const referenceImageDataUrls = isDeepSeekPlannerProfile ? [] : options.referenceImageDataUrls ?? []
  const configuredTransport: EtsyListingTransport = options.profile.apiMode === 'chat' ? 'chat' : 'responses'
  const primaryTransport: EtsyListingTransport = isDeepSeekPlannerProfile ? configuredTransport : 'responses'
  const canRequestWebSearch = primaryTransport === 'responses' && !isDeepSeekPlannerProfile

  const request = async (
    transport: EtsyListingTransport,
    includeWebSearch: boolean,
    repair?: { previousOutput: string; errorMessage: string },
  ) => {
    const useChatCompletions = transport === 'chat'
    const instructions = [
      buildEtsyListingInstructions({
        webSearchAvailable: includeWebSearch,
        textOnlyReferenceGuard: isDeepSeekPlannerProfile,
      }),
      buildEtsyListingJsonGuide(),
    ].join('\n\n')
    const inputText = repair
      ? buildEtsyListingRepairInput(repair.previousOutput, repair.errorMessage)
      : buildEtsyListingInputText(
          options.listingText,
          options.baseDraft,
          !isDeepSeekPlannerProfile && referenceImageDataUrls.length > 0,
        )
    const requestReferenceImages = repair ? [] : referenceImageDataUrls
    return fetch(
      useChatCompletions
        ? buildApiUrl(options.profile.baseUrl, 'chat/completions', proxyConfig, useApiProxy, { prefixV1: false })
        : buildApiUrl(options.profile.baseUrl, 'responses', proxyConfig, useApiProxy),
      {
        method: 'POST',
        signal: options.signal,
        headers: {
          Authorization: `Bearer ${options.profile.apiKey}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(useChatCompletions
          ? {
              model,
              messages: [
                { role: 'system', content: instructions },
                { role: 'user', content: buildChatPlannerUserContent(inputText, requestReferenceImages) },
              ],
              response_format: { type: 'json_object' },
              stream: false,
            }
          : {
              model,
              instructions,
              input: buildResponsesPlannerInput(inputText, requestReferenceImages),
              ...(includeWebSearch ? { tools: [{ type: 'web_search' }] } : {}),
              text: {
                format: {
                  type: 'json_schema',
                  name: 'etsy_listing_details',
                  strict: true,
                  schema: ETSY_LISTING_DETAILS_SCHEMA,
                },
              },
              stream: false,
            }),
      },
    )
  }

  let responseTransport = primaryTransport
  let response = await request(responseTransport, canRequestWebSearch)
  if (!response.ok && canRequestWebSearch && [400, 404, 405, 415, 422, 500, 501].includes(response.status)) {
    const firstError = await getApiErrorMessage(response)
    if (configuredTransport === 'chat') {
      responseTransport = 'chat'
      response = await request(responseTransport, false)
    } else if (/web.?search|tool|unsupported|not supported|unknown/i.test(firstError)) {
      response = await request(responseTransport, false)
    } else {
      throw new Error(`HTTP ${response.status}: ${firstError}`)
    }
  }

  if (!response.ok) {
    const message = await getApiErrorMessage(response)
    throw new Error(`HTTP ${response.status}: ${message}`)
  }

  const responseResult = await readPlannerResponseText(response)
  let details: EtsyListingDetails
  try {
    details = normalizeEtsyListingDetails(
      parseEtsyListingPayload(responseResult.text),
      responseResult.webResearchUsed,
    )
  } catch (error) {
    const validationMessage = error instanceof Error ? error.message : String(error)
    const repairResponse = await request(responseTransport, false, {
      previousOutput: responseResult.text,
      errorMessage: validationMessage,
    })
    if (!repairResponse.ok) {
      const repairError = await getApiErrorMessage(repairResponse)
      throw new Error(`${validationMessage}\n\n自动纠错失败：HTTP ${repairResponse.status}: ${repairError}`)
    }
    const repairedResult = await readPlannerResponseText(repairResponse)
    try {
      details = normalizeEtsyListingDetails(
        parseEtsyListingPayload(repairedResult.text),
        responseResult.webResearchUsed,
      )
    } catch (repairValidationError) {
      const repairedMessage = repairValidationError instanceof Error ? repairValidationError.message : String(repairValidationError)
      throw new Error(`${validationMessage}\n\n自动纠错后仍未通过：${repairedMessage}`)
    }
  }
  return {
    details,
    webResearchUsed: responseResult.webResearchUsed,
  }
}
