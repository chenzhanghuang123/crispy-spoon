import type {
  ApiProfile,
  EtsyListingDetails,
  EtsyPhotographyAnalysis,
  EtsyShotPhotographyDecision,
  EtsyVisualDna,
} from '../types'
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
  ETSY_ADDITIONAL_SHOT_BRIEFS,
  ETSY_ORIGINAL_SHOT_COUNT,
  ETSY_SHOT_COUNT,
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
  photographyAnalysis?: Partial<Record<keyof EtsyPhotographyAnalysis, unknown>>
  shotOutline?: Array<Partial<EtsyShotOutline>>
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

function applyEtsyAdditionalShotBrief(plan: AmazonImagePlan, index: number): AmazonImagePlan {
  const brief = ETSY_ADDITIONAL_SHOT_BRIEFS[index - ETSY_ORIGINAL_SHOT_COUNT]
  if (!brief) return plan

  return {
    ...plan,
    slot: brief.slot,
    label: brief.label,
    planMarkdown: [plan.planMarkdown, `**新增固定镜头要求：** ${brief.planRequirement}`].filter(Boolean).join('\n\n'),
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
  etsyPhotographyAnalysis?: EtsyPhotographyAnalysis | null
  etsyShotGroup?: EtsyShotGroup
}

export type EtsyShotGroup = 'original' | 'additional'

let etsyOriginalCheckpoint: { key: string; savedAt: number; result: PlannerApiResult } | null = null

export function clearEtsyOriginalPlannerCheckpoint(): void {
  etsyOriginalCheckpoint = null
}

export interface EtsyPlannerCampaignContext {
  visualDna: EtsyVisualDna
  photographyAnalysis: EtsyPhotographyAnalysis
  plans: AmazonImagePlan[]
}

function getEtsyShotGroupSlots(group?: EtsyShotGroup): string[] {
  const slots = getEtsyImageSlots()
  return group === 'original' ? slots.slice(0, ETSY_ORIGINAL_SHOT_COUNT)
    : group === 'additional' ? slots.slice(ETSY_ORIGINAL_SHOT_COUNT)
      : slots
}

export function mergeEtsyShotGroups(existing: AmazonImagePlan[], incoming: AmazonImagePlan[]): AmazonImagePlan[] {
  const bySlot = new Map(existing.map((plan) => [plan.slot, plan]))
  for (const plan of incoming) bySlot.set(plan.slot, plan)
  return getEtsyImageSlots().flatMap((slot) => {
    const plan = bySlot.get(slot)
    return plan ? [plan] : []
  })
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

const ETSY_PHOTOGRAPHY_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    materialBehavior: { type: 'string', description: 'How the verified materials reflect, absorb, transmit, scatter, or reveal light, and the lighting implications.' },
    formAndScale: { type: 'string', description: 'The product geometry, silhouette, depth, scale cues, symmetry or asymmetry, and the viewpoints that reveal them truthfully.' },
    criticalDetails: { type: 'string', description: 'The verified craftsmanship, texture, finish, construction, controls, connections, or small details that deserve photographic proof.' },
    functionAndInteraction: { type: 'string', description: 'The verified function, handling, installation, wear, use sequence, or buyer interaction that photography should make immediately understandable.' },
    captureChallenges: { type: 'string', description: 'Product-specific photographic risks such as glare, transparency, dark-on-dark edges, tiny scale, distortion, moire, reflective metal, or shallow relief, plus how to control them.' },
    campaignStrategy: { type: 'string', description: 'A concise product-specific strategy for making fifteen images feel cohesive while deliberately varying viewpoint, scale, optics, light, and scene.' },
  },
  required: ['materialBehavior', 'formAndScale', 'criticalDetails', 'functionAndInteraction', 'captureChallenges', 'campaignStrategy'],
} as const

const ETSY_ANGLE_FAMILIES = ['front-orthographic', 'three-quarter', 'side-profile', 'rear', 'top-down', 'low-angle', 'high-angle', 'macro-detail', 'environmental-wide', 'functional-pov'] as const
const ETSY_SHOT_SCALES = ['extreme-macro', 'detail-close-up', 'full-product', 'product-in-context', 'wide-environment'] as const
const ETSY_LENS_CLASSES = ['ultra-wide', 'wide', 'normal', 'short-telephoto', 'macro', 'telephoto', 'tilt-shift'] as const
const ETSY_LIGHTING_FAMILIES = ['soft-studio', 'raking-texture', 'cross-polarized', 'backlit-translucency', 'window-daylight', 'hard-directional', 'mixed-practical', 'edge-defined-low-key', 'high-key-shadowless', 'outdoor-natural'] as const
const ETSY_SCENE_FAMILIES = ['seamless-studio', 'editorial-still-life', 'material-macro', 'scale-infographic', 'craft-workbench', 'active-use', 'contextual-interior', 'architectural-environment', 'nature-outdoor', 'gift-or-keepsake'] as const

const ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS = {
  angleFamily: { type: 'string', enum: ETSY_ANGLE_FAMILIES },
  shotScale: { type: 'string', enum: ETSY_SHOT_SCALES },
  lensClass: { type: 'string', enum: ETSY_LENS_CLASSES },
  lightingFamily: { type: 'string', enum: ETSY_LIGHTING_FAMILIES },
  sceneFamily: { type: 'string', enum: ETSY_SCENE_FAMILIES },
} as const

type EtsyPhotographyCategory = keyof typeof ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS
type EtsyPhotographyCategories = Pick<EtsyShotPhotographyDecision, EtsyPhotographyCategory>
type EtsyShotOutline = EtsyPhotographyCategories & { slot: string; label: string; concept: string }

interface EtsyPlannerRequestStage {
  name: string
  instructions: string
  inputText: string
  schema: object
  slots: string[]
  outline?: boolean
  fullPlan?: boolean
  categoryRepair?: boolean
}

const ETSY_ANGLE_FAMILY_ALIASES: Record<string, (typeof ETSY_ANGLE_FAMILIES)[number]> = {
  orthographic: 'front-orthographic',
  'orthographic-view': 'front-orthographic',
  'front-view': 'front-orthographic',
  'front-view-orthographic': 'front-orthographic',
  'straight-on': 'front-orthographic',
  'straight-on-view': 'front-orthographic',
  'three-quarter-view': 'three-quarter',
  'three-quarter-angle': 'three-quarter',
  side: 'side-profile',
  'side-view': 'side-profile',
  'rear-view': 'rear',
  overhead: 'top-down',
  'top-view': 'top-down',
  'low-view': 'low-angle',
  'high-view': 'high-angle',
  macro: 'macro-detail',
  'close-up': 'macro-detail',
  'wide-environmental': 'environmental-wide',
  environmental: 'environmental-wide',
  pov: 'functional-pov',
  'point-of-view': 'functional-pov',
}

const ETSY_LENS_CLASS_ALIASES: Record<string, (typeof ETSY_LENS_CLASSES)[number]> = {
  'normal-lens': 'normal',
  'normal-prime': 'normal',
  'normal-prime-lens': 'normal',
  'standard-lens': 'normal',
  'standard-prime': 'normal',
  'standard-prime-lens': 'normal',
  '标准定焦': 'normal',
  '标准定焦镜头': 'normal',
  '标准镜头': 'normal',
  '标准焦段': 'normal',
}

const ETSY_PHOTOGRAPHY_DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    productSuitability: { type: 'string', description: 'Why this exact capture choice reveals a verified material, form, detail, function, or purchase reason of this product.' },
    angleFamily: { type: 'string', enum: ETSY_ANGLE_FAMILIES },
    angle: { type: 'string', description: 'Precise product-specific camera height, azimuth, elevation, orientation, and perspective. Do not write only the angle family.' },
    shotScale: { type: 'string', enum: ETSY_SHOT_SCALES },
    framing: { type: 'string', description: 'Product occupancy, crop policy, orientation, negative space, layer placement, and perspective control.' },
    cameraSystem: { type: 'string', description: 'A real top-tier camera or technical camera system selected because it suits this shot, not because it is a generic luxury name.' },
    lensClass: { type: 'string', enum: ETSY_LENS_CLASSES },
    lens: { type: 'string', description: 'A real high-end lens with focal length or magnification and why its perspective or rendering suits this product.' },
    exposure: { type: 'string', description: 'Specific aperture, shutter speed, ISO, stabilization or tripod, and any tilt-shift or polarization setup needed.' },
    focusStrategy: { type: 'string', description: 'Exact focal plane, depth-of-field intent, focus stack or motion-freezing strategy.' },
    lightingFamily: { type: 'string', enum: ETSY_LIGHTING_FAMILIES },
    lighting: { type: 'string', description: 'Product-specific source size, direction, diffusion, fill ratio, flags, reflection control, color temperature, and shadow behavior.' },
    sceneFamily: { type: 'string', enum: ETSY_SCENE_FAMILIES },
    scene: { type: 'string', description: 'A bespoke physically believable set or location chosen for this product and audience, including only truthful props and interactions.' },
    differentiation: { type: 'string', description: 'State exactly how this shot differs from the other fourteen in viewpoint, scale, optics, light, scene, and selling job.' },
  },
  required: ['productSuitability', 'angleFamily', 'angle', 'shotScale', 'framing', 'cameraSystem', 'lensClass', 'lens', 'exposure', 'focusStrategy', 'lightingFamily', 'lighting', 'sceneFamily', 'scene', 'differentiation'],
} as const

function createEtsyPhotographyDecisionSchema(concise = false) {
  if (!concise) return ETSY_PHOTOGRAPHY_DECISION_SCHEMA
  return {
    ...ETSY_PHOTOGRAPHY_DECISION_SCHEMA,
    properties: {
      productSuitability: { type: 'string', description: 'Why this shot reveals verified product value.' },
      angleFamily: ETSY_PHOTOGRAPHY_DECISION_SCHEMA.properties.angleFamily,
      angle: { type: 'string', description: 'Exact camera viewpoint and perspective.' },
      shotScale: ETSY_PHOTOGRAPHY_DECISION_SCHEMA.properties.shotScale,
      framing: { type: 'string', description: 'Product occupancy, crop, orientation, and perspective.' },
      cameraSystem: { type: 'string', description: 'Suitable flagship camera system for this shot.' },
      lensClass: ETSY_PHOTOGRAPHY_DECISION_SCHEMA.properties.lensClass,
      lens: { type: 'string', description: 'Lens and focal length or magnification suited to the shot.' },
      exposure: { type: 'string', description: 'Aperture, shutter, ISO, support, and any needed optical aids.' },
      focusStrategy: { type: 'string', description: 'Focus plane and depth-of-field or motion strategy.' },
      lightingFamily: ETSY_PHOTOGRAPHY_DECISION_SCHEMA.properties.lightingFamily,
      lighting: { type: 'string', description: 'Source, diffusion, fill, reflection control, color, and shadows.' },
      sceneFamily: ETSY_PHOTOGRAPHY_DECISION_SCHEMA.properties.sceneFamily,
      scene: { type: 'string', description: 'Believable product-specific setting, scale, and restrained props.' },
      differentiation: { type: 'string', description: 'How this shot differs in purpose, view, scale, optics, light, and scene.' },
    },
  } as const
}

function createEtsyPlannerSchema(slots = getEtsyImageSlots(), options: { conciseSummary?: boolean } = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      product: PRODUCT_SCHEMA,
      sellingPoints: SELLING_POINTS_SCHEMA,
      visualDna: ETSY_VISUAL_DNA_SCHEMA,
      photographyAnalysis: ETSY_PHOTOGRAPHY_ANALYSIS_SCHEMA,
      seriesStyleGuide: options.conciseSummary
        ? {
          type: 'string',
          maxLength: 220,
          description: 'One concise English sentence for cross-shot product consistency; do not repeat Visual DNA facts.',
        }
        : {
          type: 'string',
          description: 'English cross-shot consistency guide grounded only in the locked Visual DNA.',
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
            planMarkdown: options.conciseSummary
              ? {
                type: 'string',
                maxLength: 120,
                description: 'One concise Simplified Chinese UI summary stating the shot purpose and unique visual idea. Do not repeat production details.',
              }
              : {
                type: 'string',
                description: 'Simplified Chinese shot strategy plus a product-specific creative scene description. State the shot role such as hero, macro detail, lifestyle context, or atmospheric creative.',
              },
            prompt: {
              type: 'string',
              description: 'Professional English image-generation prompt. Explicitly repeat the locked material, color, texture, finish, silhouette, proportions, and construction details in every shot. Do not use generic reusable scene templates.',
            },
            negativePrompt: options.conciseSummary
              ? {
                type: 'string',
                maxLength: 240,
                description: 'Concise English exclusions for shot-specific risks only; shared product-identity and layout exclusions are appended by the application.',
              }
              : NEGATIVE_PROMPT_SCHEMA,
            photographyDecision: createEtsyPhotographyDecisionSchema(options.conciseSummary),
          },
          required: ['slot', 'label', 'planMarkdown', 'prompt', 'negativePrompt', 'photographyDecision'],
        },
      },
    },
    required: ['product', 'sellingPoints', 'visualDna', 'photographyAnalysis', 'seriesStyleGuide', 'imagePlans'],
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

function createPlannerStreamCollector(requireCompletion: boolean, onActivity?: (characters?: number) => void) {
  let completedText = ''
  let outputItemText = ''
  let doneText = ''
  let deltaText = ''
  let webResearchUsed = false
  let sawChatDelta = false
  let chatCompleted = false
  let sawResponsesDelta = false
  let responsesCompleted = false

  const onEvent = (event: Record<string, unknown>) => {
    assertPlannerOutputComplete(event)
    if (hasWebSearchCall(event) || hasWebSearchCall(event.response) || hasWebSearchCall(event.item)) webResearchUsed = true
    const choices = Array.isArray(event.choices) ? event.choices : []
    for (const choice of choices) {
      if (!isRecordValue(choice) || (typeof choice.index === 'number' && choice.index !== 0)) continue
      if (choice.finish_reason === 'stop') chatCompleted = true
      if (!isRecordValue(choice.delta)) continue
      sawChatDelta = true
      // Chat fragments may be only a space; trimming them changes the prompt.
      if (typeof choice.delta.content === 'string' && choice.delta.content.length) {
        deltaText += choice.delta.content
        onActivity?.(deltaText.length)
      } else if (typeof choice.delta.reasoning_content === 'string' && choice.delta.reasoning_content.length) {
        onActivity?.()
      }
    }
    if (choices.some((choice) => isRecordValue(choice) && isRecordValue(choice.delta))) return

    const type = getStringValue(event, 'type')
    if (type === 'response.output_text.delta') {
      sawResponsesDelta = true
      deltaText += getStringValue(event, 'delta') ?? ''
      if (getStringValue(event, 'delta')) onActivity?.(deltaText.length)
      return
    }
    if (type === 'response.completed') responsesCompleted = true

    const text = getPlannerTextFromEvent(event)
    if (!text) return
    onActivity?.(text.length)

    if (type === 'response.completed') completedText = text
    else if (type === 'response.output_item.done') outputItemText = text
    else if (type === 'response.output_text.done' || type === 'response.content_part.done') doneText = text
    else if (!type) deltaText += text
  }

  const result = (): PlannerResponseTextResult => {
    if (requireCompletion && ((sawChatDelta && !chatCompleted) || (sawResponsesDelta && !responsesCompleted))) {
      throw new Error('AI 策划流式响应中途结束，未收到完整完成标记。请重试；若反复发生，请联系服务商检查流式连接和上游渠道。')
    }
    return {
      text: completedText.trim() || outputItemText.trim() || doneText.trim() || deltaText.trim(),
      webResearchUsed,
    }
  }
  return { onEvent, result }
}

function assertPlannerOutputComplete(payload: unknown): void {
  if (!isRecordValue(payload)) return
  const response = isRecordValue(payload.response) ? payload.response : payload
  if (payload.type === 'response.incomplete' || response.status === 'incomplete') {
    throw new Error('AI 策划输出未完成，可能达到服务商输出长度限制。请让服务商检查模型的输出上限。')
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  for (const choice of choices) {
    if (!isRecordValue(choice) || (typeof choice.index === 'number' && choice.index !== 0)) continue
    if (choice.finish_reason === 'length') {
      throw new Error('AI 策划输出达到服务商长度限制，策划方案可能被截断。请让服务商提高模型的输出上限。')
    }
    if (choice.finish_reason === 'content_filter') {
      throw new Error('AI 策划输出被服务商内容过滤中断，请检查产品描述或联系服务商。')
    }
  }
}

async function readPlannerTextFromSseResponse(response: Response, requireCompletion: boolean, onActivity?: (characters?: number) => void): Promise<PlannerResponseTextResult> {
  const collector = createPlannerStreamCollector(requireCompletion, onActivity)
  await readJsonServerSentEvents(response, collector.onEvent)
  return collector.result()
}

async function readPlannerTextFromSseText(rawText: string, requireCompletion: boolean, onActivity?: (characters?: number) => void): Promise<PlannerResponseTextResult> {
  const collector = createPlannerStreamCollector(requireCompletion, onActivity)
  await readJsonServerSentEventText(rawText, collector.onEvent)
  return collector.result()
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes('application/json') || contentType.includes('+json')
}

function truncateForError(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= 1200) return trimmed
  return `${trimmed.slice(0, 1200)}...`
}

async function readPlannerResponseText(response: Response, requireCompletion = false, onActivity?: (characters?: number) => void): Promise<PlannerResponseTextResult> {
  if (isEventStreamResponse(response)) {
    const result = await readPlannerTextFromSseResponse(response, requireCompletion, onActivity)
    if (!result.text) throw new Error('AI 策划流式接口未返回文本内容')
    return result
  }

  const rawText = await response.text()
  if (!rawText.trim()) throw new Error('AI 策划接口返回空内容')

  if (looksLikeServerSentEvents(rawText)) {
    const result = await readPlannerTextFromSseText(rawText, requireCompletion, onActivity)
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

  assertPlannerOutputComplete(payload)
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
    ...(plan.photographyDecision ? { photographyDecision: plan.photographyDecision } : {}),
  }
}

function normalizePlannerText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePhotographyCategoryKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s_/—–]+/g, '-')
    .replace(/[^a-z0-9\u3400-\u9fff-]+/g, '')
    .replace(/^-+|-+$/g, '')
}

function normalizePhotographyCategory(
  value: string,
  allowedValues: readonly string[],
  aliases: Record<string, string> = {},
): string {
  const key = normalizePhotographyCategoryKey(value)
  return allowedValues.find((allowedValue) => normalizePhotographyCategoryKey(allowedValue) === key)
    ?? aliases[key]
    ?? value
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

function normalizeEtsyPhotographyAnalysis(payload: PlannerApiPayload, visualDna: EtsyVisualDna): EtsyPhotographyAnalysis {
  const source = payload.photographyAnalysis ?? {}
  return {
    materialBehavior: normalizePlannerText(source.materialBehavior) || `Study how ${visualDna.materialTextureFocus} responds to highlight shape, diffusion, reflection control, and shadow depth.`,
    formAndScale: normalizePlannerText(source.formAndScale) || `Use product-specific viewpoints that preserve the exact silhouette, proportions, construction, and believable scale of ${visualDna.productNameType}.`,
    criticalDetails: normalizePlannerText(source.criticalDetails) || `Prioritize only verified material boundaries, texture, finish, construction, and included details visible in the product references.`,
    functionAndInteraction: normalizePlannerText(source.functionAndInteraction) || 'Show only verified functions and physically credible interaction; never invent use cases, accessories, or installation details.',
    captureChallenges: normalizePlannerText(source.captureChallenges) || `Control glare, distortion, depth of field, edge separation, and color so the real product remains accurate under ${visualDna.colorPaletteLightingMood}.`,
    campaignStrategy: normalizePlannerText(source.campaignStrategy) || 'Keep product identity coherent while varying viewpoint, shot scale, focal length, lighting family, and scene family across all fifteen images.',
  }
}

const ETSY_PHOTOGRAPHY_DECISION_FIELDS: Array<keyof EtsyShotPhotographyDecision> = [
  'productSuitability',
  'angleFamily',
  'angle',
  'shotScale',
  'framing',
  'cameraSystem',
  'lensClass',
  'lens',
  'exposure',
  'focusStrategy',
  'lightingFamily',
  'lighting',
  'sceneFamily',
  'scene',
  'differentiation',
]

function normalizeEtsyPhotographyDecision(plan: AmazonImagePlan): EtsyShotPhotographyDecision {
  const source = plan.photographyDecision
  const missingFields = ETSY_PHOTOGRAPHY_DECISION_FIELDS.filter((field) => !normalizePlannerText(source?.[field]))
  if (missingFields.length) {
    throw new Error(`Etsy 镜头 ${plan.slot} 缺少摄影自动判断：${missingFields.join(', ')}`)
  }

  const decision = Object.fromEntries(
    ETSY_PHOTOGRAPHY_DECISION_FIELDS.map((field) => [field, normalizePlannerText(source?.[field])]),
  ) as unknown as EtsyShotPhotographyDecision
  return { ...decision, ...normalizeEtsyPhotographyCategories(decision, plan.slot) }
}

function normalizeEtsyPhotographyCategory(field: EtsyPhotographyCategory, value: unknown): string {
  return normalizePhotographyCategory(
    normalizePlannerText(value),
    ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS[field].enum,
    field === 'angleFamily'
      ? ETSY_ANGLE_FAMILY_ALIASES
      : field === 'lensClass'
        ? ETSY_LENS_CLASS_ALIASES
        : undefined,
  )
}

function normalizeEtsyPhotographyCategories(source: Partial<EtsyPhotographyCategories>, slot: string): EtsyPhotographyCategories {
  const categories = {} as EtsyPhotographyCategories
  for (const field of Object.keys(ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS) as EtsyPhotographyCategory[]) {
    const allowedValues: readonly string[] = ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS[field].enum
    categories[field] = normalizeEtsyPhotographyCategory(field, source[field])
    if (!allowedValues.includes(categories[field])) {
      throw new Error(`Etsy 镜头 ${slot} 的 ${field} 不在摄影自动判断分类中：${categories[field]}`)
    }
  }
  return categories
}

function normalizeDiversityKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function assertEtsyPhotographyDiversity(plans: Array<{ slot: string; photographyDecision?: EtsyPhotographyCategories }>): void {
  const decisions = plans.map((plan) => plan.photographyDecision).filter((item): item is EtsyPhotographyCategories => Boolean(item))
  const partialMinimums = plans.length === ETSY_ORIGINAL_SHOT_COUNT ? [4, 3, 3, 3, 4] : [3, 3, 3, 3, 4]
  const minimums: Array<[EtsyPhotographyCategory, number, string]> = [
    ['angleFamily', plans.length === ETSY_SHOT_COUNT ? 5 : partialMinimums[0], '角度类型'],
    ['shotScale', plans.length === ETSY_SHOT_COUNT ? 4 : partialMinimums[1], '景别'],
    ['lensClass', plans.length === ETSY_SHOT_COUNT ? 4 : partialMinimums[2], '镜头/焦段'],
    ['lightingFamily', plans.length === ETSY_SHOT_COUNT ? 4 : partialMinimums[3], '布光类型'],
    ['sceneFamily', plans.length === ETSY_SHOT_COUNT ? 5 : partialMinimums[4], '场景类型'],
  ]
  const failures = minimums.flatMap(([field, minimum, label]) => {
    const uniqueCount = new Set(decisions.map((decision) => normalizeDiversityKey(decision[field]))).size
    return uniqueCount >= minimum ? [] : [`${label}仅 ${uniqueCount} 类（至少 ${minimum} 类）`]
  })

  for (let index = 0; index < decisions.length; index += 1) {
    const current = decisions[index]
    for (let compareIndex = index + 1; compareIndex < decisions.length; compareIndex += 1) {
      const other = decisions[compareIndex]
      const repeatedCore = ['angleFamily', 'shotScale', 'lightingFamily', 'sceneFamily']
        .filter((field) => normalizeDiversityKey(current[field as EtsyPhotographyCategory]) === normalizeDiversityKey(other[field as EtsyPhotographyCategory]))
      if (repeatedCore.length >= 4) failures.push(`${plans[index]?.slot} 与 ${plans[compareIndex]?.slot} 的角度、景别、布光和场景完全重复`)
    }
  }

  if (failures.length) {
    throw new Error(`Etsy 摄影自动判断未通过 ${plans.length} 镜头差异检查：${failures.slice(0, 5).join('；')}`)
  }
}

function normalizeEtsyPlannerApiPayload(payload: PlannerApiPayload, marketplaceId: AmazonMarketplaceId, fallbackTitle = '', slots = getEtsyImageSlots()): PlannerApiResult {
  const parsed = normalizeParsedListing(payload, fallbackTitle)
  const rawPlans = Array.isArray(payload.imagePlans) ? payload.imagePlans : []
  if (rawPlans.length !== slots.length) throw new Error(`Etsy 策划结果不是 ${slots.length} 张图`)
  const allSlots = getEtsyImageSlots()
  const plans = slots.map((slot) => {
    const matching = rawPlans.filter((plan) => plan?.slot === slot)
    if (matching.length !== 1) throw new Error(`Etsy 策划结果缺少或重复镜头 ${slot}`)
    const index = allSlots.indexOf(slot)
    const normalizedPlan = normalizePlan(matching[0]!, index, allSlots)
    if (!normalizedPlan.prompt.trim() || !normalizedPlan.planMarkdown.trim()) throw new Error(`Etsy 镜头 ${slot} 缺少提示词或策划说明`)
    return applyEtsyAdditionalShotBrief({
      ...normalizedPlan,
      photographyDecision: normalizeEtsyPhotographyDecision(normalizedPlan),
    }, index)
  })
  assertEtsyPhotographyDiversity(plans)

  const etsyVisualDna = normalizeEtsyVisualDna(payload, parsed)
  const etsyPhotographyAnalysis = normalizeEtsyPhotographyAnalysis(payload, etsyVisualDna)
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
    etsyPhotographyAnalysis,
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

function buildEtsyPlannerInstructions(baseDraft: AmazonPromptDraft, stage?: { outline?: boolean; slots?: string[]; partial?: boolean; lockedCampaign?: boolean }) {
  const slots = getEtsyImageSlots()
  const requestedSlots = stage?.slots ?? slots
  const isPartial = Boolean(stage?.partial)
  const isOriginalGroup = isPartial && requestedSlots.every((slot) => Number(slot.slice(1)) <= ETSY_ORIGINAL_SHOT_COUNT)
  const isAdditionalGroup = isPartial && requestedSlots.every((slot) => Number(slot.slice(1)) > ETSY_ORIGINAL_SHOT_COUNT)
  const includesAdditionalShots = !isPartial || isAdditionalGroup
  const additionalBriefs = ETSY_ADDITIONAL_SHOT_BRIEFS.filter((brief) => requestedSlots.includes(brief.slot))
  return [
    "You are a 'World-Class Adaptive Art Director and AI Photographer' specifically tailored for Etsy sellers.",
    'Your mission is to curate a bespoke, commercially viable product photoshoot that elevates the seller brand while preserving the real product exactly.',
    'PHASE 1 — DEEP DIVE ANALYSIS & STRATEGIC PLANNING ONLY. Do not generate images in this response.',
    stage?.lockedCampaign
      ? 'PART A: Use the supplied locked Visual DNA unchanged; do not reanalyze or repeat these fields.'
      : stage?.slots && !isPartial
      ? 'PART A: Use the supplied locked Visual DNA; do not reanalyze, change, or repeat the campaign-level fields.'
      : 'PART A: VISUAL DNA ANALYSIS. Analyze and return all four required fields: Product Name/Type; Material & Texture Focus; Color Palette & Lighting Mood; Brand Aesthetic & Target Audience.',
    'Visual DNA Lock is crucial: derive physical facts from the product description, user-provided facts, and reference images. Never invent or redesign material, color, texture, finish, silhouette, dimensions, construction, accessories, logo, text, or quantity.',
    stage?.lockedCampaign
      ? 'PART B: Apply the supplied locked photography diagnosis and shot assignments unchanged; do not repeat the analysis fields.'
      : stage?.slots && !isPartial
      ? 'PART B: PRODUCT-SPECIFIC PHOTOGRAPHY DIAGNOSIS. Apply the supplied locked material, form, detail, function, capture challenges, and campaign strategy to these shots.'
      : 'PART B: PRODUCT-SPECIFIC PHOTOGRAPHY DIAGNOSIS. Before designing any shot, return photographyAnalysis covering material light behavior, form and scale, critical details, verified function and interaction, capture challenges, and the campaign strategy. This diagnosis must explain what this particular product needs photographically; avoid generic luxury language.',
    stage?.outline
      ? `PART C: Plan exactly ${requestedSlots.length} shots as a compact shotOutline in this order: ${requestedSlots.join(', ')}. For each return its slot, Chinese label, one product-specific concept, and five photography category IDs. Do not write prompts or detailed camera settings yet; later batches expand every shot.`
      : stage?.slots
        ? isPartial
          ? `PART C: Generate only these ${stage.slots.length} assigned shots: ${stage.slots.join(', ')}. Return exactly these imagePlans in this order as one batch of the locked campaign; do not add other slots or change their assigned concepts.`
          : `PART C: Expand only these ${stage.slots.length} assigned shots: ${stage.slots.join(', ')}. Return only imagePlans for these slots. Preserve their exact concepts and all five assigned category IDs from the full campaign outline; the other shots are produced separately.`
        : `PART C: THE DYNAMIC ${ETSY_SHOT_COUNT}-SHOT BESPOKE PLAN. Return exactly ${ETSY_SHOT_COUNT} shots in this slot order: ${slots.join(', ')}.`,
    isOriginalGroup ? '' : 'Never use a reusable fixed scene template. Dynamically design every scene from this product’s Visual DNA, use case, craftsmanship, price positioning, gifting context, and likely Etsy buyer.',
    !isAdditionalGroup ? `Preserve the original ${ETSY_ORIGINAL_SHOT_COUNT}-shot behavior for E01-E10: they must remain a strategic mix of hero/clean listing, macro/detail, lifestyle/in-situ, and atmospheric/creative images, with their exact order and concepts uniquely chosen for this product. Do not replace or compress these original ten shots.` : '',
    isOriginalGroup ? stage?.lockedCampaign
      ? 'ORIGINAL TEN — LOCKED ART DIRECTION: Use the supplied product diagnosis and ten-shot outline unchanged. Expand assigned shots with distinct buyer value, bespoke believable scenes, material-accurate professional lighting, and purpose-chosen flagship camera/lens/exposure/focus decisions. Preserve exact product identity above styling; never invent or alter uncertain details. Follow the campaign-wide angle, scale, lens, lighting, and scene assignments.'
      : [
        `ORIGINAL TEN — WORLD-CLASS CREATIVE DIRECTION: Analyze this product’s design, materials, craft, verified use, buyer, and purchase questions. Create ${requestedSlots.length} complementary selling jobs tailored to this product; every shot must add product evidence or buyer appeal, not just a new background.`,
        'ORIGINAL TEN — BESPOKE PREMIUM SCENES: Design physically credible, art-directed scenes for the product and real use. Specify fitting surfaces, depth, scale, restrained props, and believable contact; avoid generic luxury sets, stock-photo styling, clutter, and repeated tabletops.',
        'ORIGINAL TEN — PRODUCT IDENTITY PRIORITY: Preserve the reference silhouette, proportions, thickness, parts and placement, color, finish, materials, and construction. Priority: product truth, verified material behavior, credible use/perspective/light, then composition and mood. If styling conflicts with the product, simplify it. Never crop, occlude, distort, recolor, mirror, stretch, replace, or beautify away defining features; keep unknown details neutral.',
        'ORIGINAL TEN — MASTER-LEVEL LIGHTING AND EQUIPMENT: Design distinct material-aware commercial lighting per shot, specifying source direction/size, diffusion, fill or negative fill, reflection control, highlights, shadows, and ambient color. Select a credible flagship camera, lens, distance, aperture, shutter, ISO, support, and focus method for each geometry and selling task. Use specialist optics only when useful; equipment is a capture target, not an actual exposure claim.',
        'ORIGINAL TEN — CAMPAIGN REVIEW: Compare all ten viewpoints, scales, optics, lighting, scenes, and buyer purposes. Redesign near-duplicates; keep product identity and visual craft cohesive while giving each shot a distinct useful role.',
      ].join('\n') : '',
    includesAdditionalShots ? 'The five additional shots must serve five distinct, complementary roles after the original ten:' : '',
    ...(isPartial ? additionalBriefs : includesAdditionalShots ? ETSY_ADDITIONAL_SHOT_BRIEFS : []).map((brief) => `${brief.slot} — ${brief.label}: ${brief.planRequirement} Image objective: ${brief.promptRequirement}`),
    includesAdditionalShots ? [
      'ADDITIONAL FIVE — EXACT PRODUCT TWIN: Independently inspect the original user-uploaded product references for every requested shot. Treat explicit user facts as authoritative. Never use another generated image as a source of product truth; do not add, remove, mirror, stretch, or redesign any part, and do not infer unseen backs, bottoms, interiors, dimensions, materials, or functions.',
      'ADDITIONAL FIVE — REAL PHOTOGRAPHY: First identify visible form, proportions, components, materials, finishes, texture, and verified use; then choose a product-specific viewpoint, distance, premium camera/lens category, focus plane, and physically plausible material-aware lighting. Equipment names describe an artistic capture target, not a claim of an actual exposure. Do not force one camera, lens, aperture, palette, or Etsy aesthetic onto every product.',
      'ADDITIONAL FIVE — FIVE INDEPENDENT DELIVERABLES: E11-E15 are five separate square 1:1 photographs, each one continuous real scene and one composition. No collage, grid, contact sheet, split screen, multi-panel layout, title, measurement line, label, promotional text, watermark, or UI. Do not output a planning essay; return only the required structured JSON.',
      'ADDITIONAL FIVE — REALISM CHECK: Keep perspective, depth of field, support, contact shadows, reflections, and light direction physically coherent. Preserve source texture scale and product color; do not invent scratches, wear, handmade marks, or repeated texture, and avoid artificial glow, HDR, oversharpening, heavy grading, and CGI-like surfaces.',
    ].join('\n') : '',
    ...stage?.outline ? [] : [
      'For every requested item, imagePlans.prompt must contain only the product-specific scene concept, verified product attributes, and truthful use or selling context. Keep all camera, lens, exposure, focus, lighting, scene-category, and differentiation decisions inside photographyDecision so the application can assemble a clean production prompt.',
       isOriginalGroup
         ? 'For each imagePlans item, write planMarkdown as one concise Simplified Chinese UI sentence (max 120 characters): shot purpose plus its unique visual idea. Do not repeat prompt or camera/lighting details.'
         : 'For each imagePlans item, label the shot strategy clearly and write planMarkdown as: **[Shot Strategy]:** followed by a specific, creative scene description tailored exactly to this product.',
      'Every imagePlans.prompt must explicitly repeat the locked physical attributes—material, real color, texture, finish, silhouette, proportions, construction, and included details—so the image model cannot redesign the product.',
      `For every requested shot, return a complete photographyDecision chosen from the product diagnosis: product suitability, angle family and exact viewpoint, shot scale and framing, top-tier real camera system, lens class and category-appropriate premium lens, aperture/shutter/ISO/support, focus strategy, lighting family and execution, scene family and execution, and an explicit difference from the other ${isPartial ? 'requested' : 'fourteen'} shots.`,
    ],
    isOriginalGroup ? '' : 'Choose equipment because it solves the shot: examples may include Phase One IQ4 for technical detail, Hasselblad X2D for controlled product or lifestyle work, high-end macro optics for craftsmanship, tilt-shift optics for strict geometry, or a flagship fast camera for real motion. Do not force one camera, one 100mm lens, or one aperture across the campaign.',
    isOriginalGroup && stage?.lockedCampaign
      ? 'Follow the full campaign diversity assignments in the locked outline; preserve each requested slot’s five assigned category IDs.'
      : isPartial
      ? `DIVERSITY MATRIX (mandatory for this request): across these ${requestedSlots.length} shots, use at least ${requestedSlots.length === ETSY_ORIGINAL_SHOT_COUNT ? 4 : 3} angleFamily values, 3 shotScale values, 3 lensClass values, 3 lightingFamily values, and 4 sceneFamily values. No two requested shots may share the same angleFamily + shotScale + lightingFamily + sceneFamily combination. When an existing campaign context is supplied, also avoid duplicating those existing shots.`
      : 'DIVERSITY MATRIX (mandatory): across E01-E15 use at least 5 angleFamily values, 4 shotScale values, 4 materially different lenses or focal lengths, 4 lightingFamily values, and 5 sceneFamily values. No two shots may share the same angleFamily + shotScale + lightingFamily + sceneFamily combination.',
    isOriginalGroup && stage?.lockedCampaign ? '' : 'Use diverse views only when they reveal something useful about this product. Build a deliberate rhythm across front/orthographic, three-quarter, side/rear, top-down, low/high, macro, functional POV, and environmental views as appropriate; never rotate the product arbitrarily just to satisfy variety.',
    isOriginalGroup && stage?.lockedCampaign ? '' : 'Each scene must differ in actual spatial logic, buyer context, and selling job. Renaming the same tabletop, background, or three-quarter composition does not count as diversity.',
    isOriginalGroup && stage?.lockedCampaign ? '' : 'Material-aware lighting is mandatory: select diffusion, raking light, cross-polarization, black flags, transmitted backlight, edge separation, practical ambience, or daylight shaping according to the verified surface behavior. Preserve true color and physically plausible reflections.',
    isOriginalGroup ? 'For negativePrompt, include only concise shot-specific risks (maximum 240 characters); the app appends shared product-identity and layout exclusions.' : '',
    'Prompts and negative prompts must be in English. planMarkdown and UI labels should be concise Simplified Chinese.',
    'Keep scenes commercially useful for Etsy. Avoid marketplace badges, fake reviews, prices, coupons, sale stickers, watermarks, QR codes, and unsupported claims.',
    stage?.lockedCampaign ? '' : isOriginalGroup
      ? 'Return one concise English seriesStyleGuide sentence about cross-shot product consistency; do not repeat Visual DNA facts.'
      : 'Return one seriesStyleGuide in English that reinforces only product consistency and a cohesive bespoke campaign derived from the Visual DNA.',
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
  options: { textOnlyReferenceGuard?: boolean; listingImageCount?: number; aPlusModuleSpecs?: AmazonAPlusModuleSpec[]; marketplaceId?: AmazonMarketplaceId; etsySlots?: string[]; etsyPartial?: boolean; etsyLockedCampaign?: boolean } = {},
) {
  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  const aPlusModuleSpecs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
  return [
    mode === 'etsy'
      ? buildEtsyPlannerInstructions(baseDraft, options.etsySlots ? { slots: options.etsySlots, partial: options.etsyPartial, lockedCampaign: options.etsyLockedCampaign } : undefined)
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

function buildEtsyPlannerRepairInput(
  previousOutput: string,
  errorMessage: string,
  slots = getEtsyImageSlots(),
  campaignContext?: EtsyPlannerCampaignContext,
) {
  return [
    `Repair the previous Etsy ${slots.length}-shot planning JSON so it passes the required schema and photography diversity check.`,
    `Validation error: ${errorMessage}`,
    'For angleFamily, shotScale, lensClass, lightingFamily, and sceneFamily, use only the exact lowercase machine-readable IDs listed in the system schema guide. Never translate, capitalize, or invent those values.',
    campaignContext
      ? 'The existing campaign context below is locked. Change only conflicting or invalid imagePlans items from this request; preserve every existing shot in that context exactly and keep Visual DNA and photography analysis unchanged. After combining both groups, the complete fifteen-shot campaign must have at least 5 angleFamily values, 4 shotScale values, 4 lensClass values, 4 lightingFamily values, and 5 sceneFamily values, with no duplicated angleFamily + shotScale + lightingFamily + sceneFamily combination.'
      : 'Preserve the product facts, Visual DNA, photography analysis, series style guide, and every valid unaffected shot exactly.',
    'Change only the minimum conflicting or invalid imagePlans items. When a shot setup changes, keep its prompt, planMarkdown, photographyDecision, and negativePrompt coherent with the new angle, scale, lens, lighting, scene, and selling job.',
    `The repaired campaign must still contain exactly ${slots.join(', ')} in the required order, meet every diversity minimum for this request, and use no duplicate angleFamily + shotScale + lightingFamily + sceneFamily combination.`,
    'Do not add unsupported product facts. Return only the complete repaired JSON object.',
    campaignContext ? `Locked existing campaign context: ${formatEtsyCampaignContext(campaignContext, slots)}` : '',
    '',
    'Previous response:',
    previousOutput,
  ].join('\n')
}

function formatEtsyCampaignContext(context: EtsyPlannerCampaignContext, excludedSlots: string[] = []): string {
  const excluded = new Set(excludedSlots)
  return `Locked Visual DNA and photography analysis from the existing campaign. Preserve them exactly and make the requested shots distinct: ${JSON.stringify({
    visualDna: context.visualDna,
    photographyAnalysis: context.photographyAnalysis,
    existingShots: context.plans.filter((plan) => !excluded.has(plan.slot)).map((plan) => ({
      slot: plan.slot,
      label: plan.label,
      planMarkdown: plan.planMarkdown.slice(0, 280),
      angleFamily: plan.photographyDecision?.angleFamily,
      angle: plan.photographyDecision?.angle,
      shotScale: plan.photographyDecision?.shotScale,
      lensClass: plan.photographyDecision?.lensClass,
      lightingFamily: plan.photographyDecision?.lightingFamily,
      sceneFamily: plan.photographyDecision?.sceneFamily,
      scene: plan.photographyDecision?.scene,
    })),
  })}`
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
  options: { includeReferenceImageInstruction?: boolean; userProductFacts?: string; listingImageCount?: number; aPlusModuleSpecs?: AmazonAPlusModuleSpec[]; marketplaceId?: AmazonMarketplaceId; etsySlots?: string[]; etsyCampaignContext?: EtsyPlannerCampaignContext } = {},
) {
  const referenceImageInstruction = options.includeReferenceImageInstruction
    ? 'If reference images are attached, use them to understand the actual product appearance and included items.'
    : ''
  const userProductFacts = options.userProductFacts?.trim()
  const marketplace = getAmazonMarketplace(options.marketplaceId)
  if (mode === 'etsy') {
    const slots = options.etsySlots ?? getEtsyImageSlots()
    const campaignContext = options.etsyCampaignContext
    return [
      options.etsySlots
        ? `Analyze this Etsy product and produce a bespoke photoshoot blueprint for exactly ${slots.length} shots: ${slots.join(', ')}.`
        : `Analyze this Etsy product and produce its Visual DNA plus a dynamic ${ETSY_SHOT_COUNT}-shot bespoke photoshoot blueprint.`,
      'Treat the supplied product facts and reference images as authoritative. If a physical detail is uncertain, stay neutral rather than inventing it.',
      campaignContext ? formatEtsyCampaignContext(campaignContext, slots) : '',
      options.etsySlots?.every((slot) => Number(slot.slice(1)) > ETSY_ORIGINAL_SHOT_COUNT) && !campaignContext
        ? 'No original E01-E10 plans exist in the current session. Generate these five conversion shots as a self-contained group, use the product description and references to infer consistent visual DNA, and do not claim that the original shots were reviewed.'
        : '',
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
  options: { listingImageCount?: number; aPlusModuleSpecs?: AmazonAPlusModuleSpec[]; marketplaceId?: AmazonMarketplaceId; etsySlots?: string[] } = {},
) {
  const productFields = 'product { title, category, color, material, audience, packageIncludes }'
  const styleFields = 'seriesStyleGuide string'
  const marketplace = getAmazonMarketplace(options.marketplaceId)
  if (mode === 'etsy') {
    const slots = options.etsySlots ?? getEtsyImageSlots()
    return [
      `Return JSON with: ${productFields}, sellingPoints string[], visualDna object, photographyAnalysis object, ${styleFields}, imagePlans array.`,
      'visualDna must include productNameType, materialTextureFocus, colorPaletteLightingMood, brandAestheticTargetAudience.',
      'photographyAnalysis must include materialBehavior, formAndScale, criticalDetails, functionAndInteraction, captureChallenges, campaignStrategy.',
      `imagePlans must contain exactly ${slots.length} items in this order: ${slots.join(', ')}.`,
      'Each imagePlans item must include: slot, label, planMarkdown, prompt, negativePrompt, photographyDecision.',
      'Each photographyDecision must include productSuitability, angleFamily, angle, shotScale, framing, cameraSystem, lensClass, lens, exposure, focusStrategy, lightingFamily, lighting, sceneFamily, scene, differentiation.',
      `angleFamily MUST be exactly one of: ${ETSY_ANGLE_FAMILIES.join(', ')}.`,
      `shotScale MUST be exactly one of: ${ETSY_SHOT_SCALES.join(', ')}.`,
      `lensClass MUST be exactly one of: ${ETSY_LENS_CLASSES.join(', ')}.`,
      `lightingFamily MUST be exactly one of: ${ETSY_LIGHTING_FAMILIES.join(', ')}.`,
      `sceneFamily MUST be exactly one of: ${ETSY_SCENE_FAMILIES.join(', ')}.`,
      'These five category fields are lowercase machine-readable IDs. Never translate, capitalize, or invent their values; put human-readable details in the adjacent descriptive fields instead.',
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
  options: { textOnlyReferenceGuard?: boolean; listingImageCount?: number; aPlusModuleSpecs?: AmazonAPlusModuleSpec[]; marketplaceId?: AmazonMarketplaceId; etsySlots?: string[]; etsyPartial?: boolean; etsyLockedCampaign?: boolean } = {},
) {
  return [
    buildPlannerInstructions(baseDraft, mode, aPlusType, options),
    'Return a valid JSON object only. Do not output Markdown fences, comments, or any text outside the JSON object.',
    buildChatPlannerSchemaGuide(mode, aPlusType, {
      listingImageCount: normalizeListingImageCount(options.listingImageCount),
      aPlusModuleSpecs: options.aPlusModuleSpecs,
      marketplaceId: options.marketplaceId,
      etsySlots: options.etsySlots,
    }),
  ].join('\n\n')
}

function isBananaProPlanner(profile: ApiProfile): boolean {
  try {
    return new URL(profile.baseUrl).hostname.toLowerCase() === 'api.bananapro.top'
  } catch {
    return false
  }
}

function createEtsyOutlineSchema(slots = getEtsyImageSlots(), options: { conciseSummary?: boolean } = {}) {
  const { imagePlans: _imagePlans, ...campaignProperties } = createEtsyPlannerSchema(slots, options).properties
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...campaignProperties,
      shotOutline: {
        type: 'array',
          minItems: slots.length,
          maxItems: slots.length,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slot: { type: 'string', enum: slots },
            label: CHINESE_LABEL_SCHEMA,
            concept: { type: 'string', description: 'One specific English sentence describing this shot and its distinct buyer purpose.' },
            ...ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS,
          },
          required: ['slot', 'label', 'concept', ...Object.keys(ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS)],
        },
      },
    },
    required: [...Object.keys(campaignProperties), 'shotOutline'],
  }
}

function normalizeEtsyOutline(payload: PlannerApiPayload, fallbackTitle: string, slots = getEtsyImageSlots()) {
  const parsed = normalizeParsedListing(payload, fallbackTitle)
  const visualDna = normalizeEtsyVisualDna(payload, parsed)
  const photographyAnalysis = normalizeEtsyPhotographyAnalysis(payload, visualDna)
  const rawOutline = payload.shotOutline
  if (!Array.isArray(rawOutline) || rawOutline.length !== slots.length) {
    throw new Error(`Etsy 总体策划必须包含 ${slots.length} 张镜头分配`)
  }
  const shotOutline: EtsyShotOutline[] = slots.map((slot) => {
    const shot = rawOutline.find((item) => item?.slot === slot)
    if (!shot || !normalizePlannerText(shot.concept) || !normalizePlannerText(shot.label)) {
      throw new Error(`Etsy 总体策划缺少 ${slot} 的镜头概念`)
    }
    return { slot, label: normalizePlannerText(shot.label), concept: normalizePlannerText(shot.concept), ...normalizeEtsyPhotographyCategories(shot, slot) }
  })
  assertEtsyPhotographyDiversity(shotOutline.map((shot) => ({ slot: shot.slot, photographyDecision: shot })))
  return { ...payload, visualDna, photographyAnalysis, shotOutline }
}

function normalizeEtsyShotBatch(payload: PlannerApiPayload, outline: EtsyShotOutline[]): AmazonImagePlan[] {
  const rawPlans = payload.imagePlans
  if (!Array.isArray(rawPlans) || rawPlans.length !== outline.length) {
    throw new Error(`Etsy 分批策划必须包含且仅包含：${outline.map((shot) => shot.slot).join(', ')}`)
  }
  return outline.map((shot, index) => {
    const rawPlan = rawPlans.find((plan) => plan?.slot === shot.slot)
    if (!rawPlan || !normalizePlannerText(rawPlan.prompt) || !normalizePlannerText(rawPlan.planMarkdown)) {
      throw new Error(`Etsy 镜头 ${shot.slot} 缺少完整提示词或策划说明`)
    }
    const plan = normalizePlan(rawPlan, index, outline.map((item) => item.slot))
    const decision = normalizeEtsyPhotographyDecision(plan)
    for (const field of Object.keys(ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS) as EtsyPhotographyCategory[]) {
      if (decision[field] !== shot[field]) throw new Error(`Etsy 镜头 ${shot.slot} 的 ${field} 偏离已锁定的总体策划：应为 ${shot[field]}`)
    }
    return { ...plan, photographyDecision: decision }
  })
}

function assertEtsyStageContent(payload: PlannerApiPayload, slots: string[]): void {
  if (!isRecordValue(payload)) throw new Error('Etsy 策划结果必须是 JSON 对象')
  const plans = payload.imagePlans
  if (!Array.isArray(plans) || plans.length !== slots.length) throw new Error(`Etsy 策划结果必须包含 ${slots.length} 张图`)
  for (const slot of slots) {
    const matching = plans.filter((plan) => isRecordValue(plan) && plan.slot === slot)
    if (matching.length !== 1) throw new Error(`Etsy 策划结果缺少或重复镜头 ${slot}`)
    const plan = matching[0]!
    for (const field of ['label', 'planMarkdown', 'prompt'] as const) {
      if (!normalizePlannerText(plan[field])) throw new Error(`Etsy 镜头 ${slot} 的 ${field} 必须是非空字符串`)
    }
    if (typeof plan.negativePrompt !== 'string') throw new Error(`Etsy 镜头 ${slot} 的 negativePrompt 必须是字符串`)
    const decision = plan.photographyDecision
    if (!isRecordValue(decision)) throw new Error(`Etsy 镜头 ${slot} 缺少 photographyDecision`)
    for (const field of ETSY_PHOTOGRAPHY_DECISION_FIELDS) {
      if (!(field in ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS) && !normalizePlannerText(decision[field])) {
        throw new Error(`Etsy 镜头 ${slot} 缺少摄影细节 ${field}`)
      }
    }
  }
}

async function repairEtsyPhotographyCategories(
  payload: PlannerApiPayload,
  stage: EtsyPlannerRequestStage,
  request: (stage: EtsyPlannerRequestStage) => Promise<PlannerResponseTextResult>,
): Promise<PlannerApiPayload> {
  if (!isRecordValue(payload)) return payload
  const plans = payload.imagePlans
  if (!Array.isArray(plans) || plans.length !== stage.slots.length
    || stage.slots.some((slot) => plans.filter((plan) => plan?.slot === slot).length !== 1)) return payload

  const categoryFields = Object.keys(ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS) as EtsyPhotographyCategory[]
  const invalid = plans.flatMap((plan) => {
    if (!isRecordValue(plan.photographyDecision)) return []
    const fields = categoryFields.filter((field) => {
      const allowed: readonly string[] = ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS[field].enum
      return !allowed.includes(normalizeEtsyPhotographyCategory(field, plan.photographyDecision?.[field]))
    })
    return fields.length ? [{ slot: plan.slot!, fields, plan }] : []
  })
  if (!invalid.length) return payload

  // Repair classification metadata only; never regenerate an already-written photograph.
  const correctionProperties = Object.fromEntries(invalid.map(({ slot, fields }) => [slot, {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(fields.map((field) => [field, ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS[field]])),
    required: fields,
  }]))
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      categoryCorrections: {
        type: 'object',
        additionalProperties: false,
        properties: correctionProperties,
        required: invalid.map(({ slot }) => slot),
      },
    },
    required: ['categoryCorrections'],
  }
  const repairStage: EtsyPlannerRequestStage = {
    name: `${stage.name}分类校正`,
    slots: invalid.map(({ slot }) => slot),
    categoryRepair: true,
    schema,
    instructions: [
      'Classify the existing photographs; do not redesign them or generate new prompts.',
      'Correct only the requested invalid category fields, using the existing detailed viewpoint, framing, optics, light, and scene as evidence.',
      'A shot role such as hero is not a shot scale. Determine scale from framing and product occupancy, not from the title or selling purpose.',
      'Use exactly the allowed IDs in the output schema. Never change valid categories or photographic content to manufacture diversity.',
      `Return JSON only matching this schema: ${JSON.stringify(schema)}`,
    ].join('\n'),
    inputText: JSON.stringify({
      shots: invalid.map(({ slot, fields, plan }) => ({
        slot,
        invalidFields: fields,
        label: plan.label,
        prompt: plan.prompt,
        photographyDecision: plan.photographyDecision,
      })),
    }),
  }
  let feedback = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Network failures propagate; only malformed classification output is retried.
    const result = await request({ ...repairStage, inputText: [repairStage.inputText, feedback].filter(Boolean).join('\n\n') })
    try {
      const correctionPayload: unknown = parsePlannerPayload(result.text)
      const corrections = isRecordValue(correctionPayload) ? correctionPayload.categoryCorrections : undefined
      if (!isRecordValue(corrections)
        || Object.keys(corrections).length !== invalid.length
        || invalid.some(({ slot }) => !isRecordValue(corrections[slot]))) {
        throw new Error('Etsy 分类校正未返回所需镜头的 categoryCorrections')
      }
      for (const { slot, fields } of invalid) {
        const corrected = corrections[slot] as Record<string, unknown>
        if (Object.keys(corrected).length !== fields.length || fields.some((field) => {
          const allowed: readonly string[] = ETSY_PHOTOGRAPHY_CATEGORY_SCHEMAS[field].enum
          return !allowed.includes(normalizeEtsyPhotographyCategory(field, corrected[field]))
        })) throw new Error(`Etsy 镜头 ${slot} 的分类校正必须仅返回合法的 ${fields.join(', ')}`)
      }
      return {
        ...payload,
        imagePlans: plans.map((plan) => {
          const corrected = corrections[plan.slot!]
          return isRecordValue(corrected)
            ? { ...plan, photographyDecision: { ...plan.photographyDecision, ...corrected } as EtsyShotPhotographyDecision }
            : plan
        }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === 1) throw new Error(`Etsy ${stage.name}分类校正未通过：${message}`)
      feedback = `Correct this classification error: ${message}\nPrevious correction output: ${result.text}`
    }
  }
  throw new Error('Etsy 分类校正未完成')
}

async function requestEtsyPlannerStage(options: {
  name: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
  request: (signal: AbortSignal, onActivity: (characters?: number) => void) => Promise<PlannerResponseTextResult>
}): Promise<PlannerResponseTextResult> {
  options.signal?.throwIfAborted()
  const controller = new AbortController()
  const stop = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', stop, { once: true })
  let timeoutReason = ''
  const timeOut = (reason: string) => {
    if (controller.signal.aborted) return
    timeoutReason = reason
    controller.abort()
  }
  let idleTimer = setTimeout(() => timeOut('连续 3 分钟未收到有效内容，服务商上游可能已停止响应。'), 180_000)
  const totalTimer = setTimeout(() => timeOut('总耗时超过 10 分钟，已停止本次请求。请检查服务商上游速度。'), 600_000)
  let lastProgressAt = 0
  const onActivity = (characters?: number) => {
    if (controller.signal.aborted) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => timeOut('连续 3 分钟未收到有效内容，服务商上游可能已停止响应。'), 180_000)
    if (Date.now() - lastProgressAt < 1000) return
    lastProgressAt = Date.now()
    options.onProgress?.(`Etsy ${options.name}：${characters ? `已接收 ${characters} 字符，正在继续接收` : '服务商正在分析产品'}`)
  }
  try {
    options.onProgress?.(`Etsy ${options.name}：等待服务商响应`)
    const result = await options.request(controller.signal, onActivity)
    controller.signal.throwIfAborted()
    return result
  } catch (error) {
    if (timeoutReason) throw new Error(`Etsy ${options.name}${timeoutReason}`)
    throw error
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
    options.signal?.removeEventListener('abort', stop)
    controller.abort()
  }
}

async function callBatchedEtsyPlanner(options: {
  baseDraft: AmazonPromptDraft
  buildInputText: (slots: string[]) => string
  textOnlyReferenceGuard: boolean
  marketplaceId: AmazonMarketplaceId
  fallbackTitle: string
  slots: string[]
  shotGroup: EtsyShotGroup
  checkpointKey: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
  request: (stage: EtsyPlannerRequestStage, signal: AbortSignal, onActivity: (characters?: number) => void) => Promise<PlannerResponseTextResult>
}): Promise<PlannerApiResult> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  options.signal?.addEventListener('abort', abort, { once: true })

  const requestStage = (stage: EtsyPlannerRequestStage) => requestEtsyPlannerStage({
    name: stage.name,
    signal: controller.signal,
    onProgress: options.onProgress,
    request: (signal, onActivity) => options.request(stage, signal, onActivity),
  })

  const runStage = async <T,>(stage: EtsyPlannerRequestStage, validate: (payload: PlannerApiPayload) => T): Promise<T> => {
    let previousOutput = ''
    let validationError = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await requestStage({
        ...stage,
        inputText: attempt === 0 ? stage.inputText : [
          stage.inputText,
          `Repair only this stage. Validation error: ${validationError}`,
          'Keep all verified product facts and valid shot categories. Correct the reported failure, preserving detailed photographic content unless it causes that failure. Return complete JSON for this stage only.',
          `Previous stage output: ${previousOutput}`,
        ].join('\n\n'),
      })
      let payload: PlannerApiPayload
      try {
        payload = parsePlannerPayload(result.text)
        assertEtsyStageContent(payload, stage.slots)
      } catch (error) {
        validationError = error instanceof Error ? error.message : String(error)
        if (attempt === 1) throw new Error(`Etsy ${stage.name}自动纠错后仍未通过：${validationError}`)
        previousOutput = result.text
        continue
      }
      // A network error must propagate, not trigger another costly full-plan request.
      payload = await repairEtsyPhotographyCategories(payload, stage, requestStage)
      try {
        return validate(payload)
      } catch (error) {
        validationError = error instanceof Error ? error.message : String(error)
        if (attempt === 1) throw new Error(`Etsy ${stage.name}自动纠错后仍未通过：${validationError}`)
        previousOutput = JSON.stringify(payload)
      }
    }
    throw new Error(validationError)
  }

  const results: PlannerApiResult[] = []
  try {
    const slots = options.slots
    const groups = [slots.slice(0, 5), slots.slice(5)].filter((group) => group.length > 0)
    const checkpoint = etsyOriginalCheckpoint
    if (checkpoint?.key === options.checkpointKey && Date.now() - checkpoint.savedAt < 30 * 60_000) {
      results.push(checkpoint.result)
      options.onProgress?.('已恢复通过校验的前 5 张，继续策划第二组')
    } else {
      clearEtsyOriginalPlannerCheckpoint()
    }

    for (const [groupIndex, group] of groups.entries()) {
      controller.signal.throwIfAborted()
      if (groupIndex < results.length) continue
      const groupLabel = groupIndex === 0 ? '第一组 5 张' : '第二组 5 张'
      const previous = results[0]
      const lockContext = previous
        ? [
          'The first five shots are already locked. Keep the exact product identity and campaign diagnosis, and create complementary assignments for the remaining five.',
          `First-half assignments: ${JSON.stringify(previous.plans.map((plan) => ({ slot: plan.slot, label: plan.label, planMarkdown: plan.planMarkdown, angleFamily: plan.photographyDecision?.angleFamily, angle: plan.photographyDecision?.angle, shotScale: plan.photographyDecision?.shotScale, framing: plan.photographyDecision?.framing, lensClass: plan.photographyDecision?.lensClass, lightingFamily: plan.photographyDecision?.lightingFamily, sceneFamily: plan.photographyDecision?.sceneFamily, scene: plan.photographyDecision?.scene })))}`,
          `Locked campaign diagnosis: ${JSON.stringify({ visualDna: previous.etsyVisualDna, photographyAnalysis: previous.etsyPhotographyAnalysis })}`,
          'Do not repeat the first-half slots, scenes, or buyer purposes. Across all ten, no two shots may share the same angleFamily + shotScale + lightingFamily + sceneFamily combination.',
        ].join('\n')
        : 'This is the first half of a ten-shot campaign. Establish strong product-specific variety so the second half can complement it.'
      const productionOutputRule = 'Keep the complete English generation prompt and all 15 photographyDecision fields detailed; keep only the Chinese UI summary and shot-specific negative exclusions concise.'
      const groupSchema = createEtsyPlannerSchema(group, { conciseSummary: true })
      const result = await runStage({
        name: groupLabel,
        slots: group,
        fullPlan: true,
        schema: groupSchema,
        instructions: [
          buildEtsyPlannerInstructions(options.baseDraft, { slots: group, partial: true }),
          options.textOnlyReferenceGuard ? DEEPSEEK_TEXT_ONLY_PLANNER_GUARD : '',
          previous ? 'Keep the campaign-level fields identical: copy the supplied locked visualDna and photographyAnalysis into their required JSON fields; do not reanalyze them. Across the combined ten shots, use at least 4 angleFamily values, 3 shotScale values, 3 lensClass values, 3 lightingFamily values, and 4 sceneFamily values. Compare the actual scenes, views, framing, and buyer purposes against the first half, not just their category IDs.' : '',
        ].filter(Boolean).join('\n'),
        inputText: [options.buildInputText(group), lockContext, productionOutputRule].join('\n\n'),
      }, (payload) => {
        const normalized = normalizeEtsyPlannerApiPayload(payload, options.marketplaceId, options.fallbackTitle, group)
        if (previous) assertEtsyPhotographyDiversity([...previous.plans, ...normalized.plans])
        return normalized
      })
      results.push(result)
      if (groupIndex === 0) {
        etsyOriginalCheckpoint = { key: options.checkpointKey, savedAt: Date.now(), result }
      }
      options.onProgress?.(`正在分两组策划 ${slots.length} 张镜头：${Math.min((groupIndex + 1) * 5, slots.length)}/${slots.length}`)
    }

    controller.signal.throwIfAborted()
    const first = results[0]
    if (!first) throw new Error('Etsy 原有 10 张策划未返回第一组结果')
    const mergedPlans = results.flatMap((result) => result.plans)
    assertEtsyPhotographyDiversity(mergedPlans)
    options.onProgress?.(`正在校验 ${slots.length} 张镜头的完整性与差异`)
    if (etsyOriginalCheckpoint?.key === options.checkpointKey) clearEtsyOriginalPlannerCheckpoint()
    return { ...first, plans: mergedPlans, etsyShotGroup: options.shotGroup }
  } catch (error) {
    if (!controller.signal.aborted && results.length) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n已在本页暂存通过校验的前 5 张（30 分钟内有效）；保持产品描述、参考图和接口配置不变，再点原有10张即可继续第二组。刷新页面会清除暂存。`)
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}

function buildChatEtsyStageGuide(stage: EtsyPlannerRequestStage): string {
  if (stage.categoryRepair) {
    return 'Return only categoryCorrections as specified by the schema. No prompts, imagePlans, explanation, or other fields.'
  }
  if (stage.outline) {
    return [
      'Return valid JSON only with keys product, sellingPoints, visualDna, photographyAnalysis, seriesStyleGuide, and shotOutline.',
      'shotOutline must contain exactly these slots in order: ' + stage.slots.join(', ') + '.',
      'Each shotOutline item must include slot, label, concept, angleFamily, shotScale, lensClass, lightingFamily, and sceneFamily. Use only the allowed category IDs already listed in the instructions.',
    ].join('\n')
  }
  if (stage.fullPlan) {
    return [
      buildChatPlannerSchemaGuide('etsy', 'standard-large', { etsySlots: stage.slots }),
      'Classify shotScale by actual framing and product occupancy, not by a selling role such as hero. Put creative role names in label or planMarkdown, never in the five category IDs.',
    ].join('\n')
  }
  return [
    'Return valid JSON only with one top-level key: imagePlans.',
    'imagePlans must contain exactly these slots in order: ' + stage.slots.join(', ') + '.',
    'Each item must include slot, label, planMarkdown, prompt, negativePrompt, and photographyDecision.',
    'photographyDecision must include productSuitability, angleFamily, angle, shotScale, framing, cameraSystem, lensClass, lens, exposure, focusStrategy, lightingFamily, lighting, sceneFamily, scene, and differentiation.',
  ].join('\n')
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
  etsyShotGroup?: EtsyShotGroup
  etsyCampaignContext?: EtsyPlannerCampaignContext
  signal?: AbortSignal
  onProgress?: (message: string) => void
}): Promise<PlannerApiResult> {
  const model = options.model?.trim() || options.profile.model.trim() || (options.profile.apiMode === 'chat' ? DEFAULT_CHAT_MODEL : DEFAULT_RESPONSES_MODEL)
  const mode = options.mode ?? 'listing'
  const etsyShotGroup = mode === 'etsy' ? options.etsyShotGroup : undefined
  const streamEtsyGroup = mode === 'etsy' && Boolean(etsyShotGroup)
  const etsySlots = mode === 'etsy' ? getEtsyShotGroupSlots(etsyShotGroup) : getEtsyImageSlots()
  const marketplaceId = normalizeAmazonMarketplaceId(options.marketplaceId)
  const aPlusType = options.aPlusType ?? 'standard-large'
  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  const aPlusModuleSpecs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
  const aPlusGenerationTier = options.aPlusGenerationTier ?? '2K'
  const schema = mode === 'etsy'
    ? createEtsyPlannerSchema(etsySlots, { conciseSummary: etsyShotGroup === 'original' })
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
    etsySlots: etsyShotGroup ? etsySlots : undefined,
    etsyCampaignContext: mode === 'etsy' ? options.etsyCampaignContext : undefined,
  })
  const referenceImageDataUrls = isDeepSeekPlannerProfile
    ? []
    : options.referenceImageDataUrls ?? []
  const request = async (
    repair?: { previousOutput: string; errorMessage: string },
    stage?: EtsyPlannerRequestStage,
    signal?: AbortSignal,
  ) => {
    const requestInputText = stage?.inputText ?? (repair
      ? buildEtsyPlannerRepairInput(repair.previousOutput, repair.errorMessage, etsySlots, options.etsyCampaignContext)
      : inputText)
    const requestReferenceImages = repair || stage?.categoryRepair ? [] : referenceImageDataUrls
    const requestSchema = stage?.schema ?? schema
    const requestInstructions = stage?.instructions ?? buildPlannerInstructions(options.baseDraft, mode, aPlusType, {
      textOnlyReferenceGuard: isDeepSeekPlannerProfile,
      listingImageCount,
      aPlusModuleSpecs,
      marketplaceId,
      etsySlots: etsyShotGroup ? etsySlots : undefined,
      etsyPartial: Boolean(etsyShotGroup),
      etsyLockedCampaign: Boolean(options.etsyCampaignContext),
    })
    return fetch(
      useChatCompletions
        ? buildApiUrl(options.profile.baseUrl, 'chat/completions', proxyConfig, useApiProxy, { prefixV1: false })
        : buildApiUrl(options.profile.baseUrl, 'responses', proxyConfig, useApiProxy),
      {
        method: 'POST',
        signal: signal ?? options.signal,
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
                  content: stage
                    ? [requestInstructions, buildChatEtsyStageGuide(stage)].join('\n\n')
                    : buildChatPlannerSystemPrompt(options.baseDraft, mode, aPlusType, {
                      textOnlyReferenceGuard: isDeepSeekPlannerProfile,
                      listingImageCount,
                      aPlusModuleSpecs,
                      marketplaceId,
                      etsySlots: etsyShotGroup ? etsySlots : undefined,
                      etsyPartial: Boolean(etsyShotGroup),
                      etsyLockedCampaign: Boolean(options.etsyCampaignContext),
                    }),
                },
                {
                  role: 'user',
                  content: buildChatPlannerUserContent(requestInputText, requestReferenceImages),
                },
              ],
              response_format: { type: 'json_object' },
              stream: streamEtsyGroup,
            }
          : {
              model,
              instructions: requestInstructions,
              input: buildResponsesPlannerInput(requestInputText, requestReferenceImages),
              text: {
                format: {
                  type: 'json_schema',
                  name: mode === 'etsy' ? 'etsy_bespoke_photoshoot_plan' : mode === 'aplus' ? 'amazon_aplus_image_plan' : 'amazon_listing_image_plan',
                  strict: true,
                  schema: requestSchema,
                },
              },
              stream: streamEtsyGroup,
            },
        ),
      },
    )
  }

  const fallbackTitle = options.baseDraft.productTitle || inferTitleFromListingText(options.listingText)
  if (mode === 'etsy' && etsyShotGroup === 'original') {
    options.signal?.throwIfAborted()
    // Hash credentials and reference content so the one-page checkpoint cannot cross inputs or accounts.
    const checkpointDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
      baseDraft: options.baseDraft, inputText, referenceImageDataUrls, model, marketplaceId,
      baseUrl: options.profile.baseUrl, apiMode: options.profile.apiMode,
      apiProxy: options.profile.apiProxy, apiKey: options.profile.apiKey,
    })))
    const checkpointKey = Array.from(new Uint8Array(checkpointDigest), (value) => value.toString(16).padStart(2, '0')).join('')
    return callBatchedEtsyPlanner({
      baseDraft: options.baseDraft,
      buildInputText: (slots) => buildPlannerInputText(options.listingText, mode, aPlusType, {
        includeReferenceImageInstruction: !isDeepSeekPlannerProfile,
        userProductFacts: buildUserProductFactsText(options.baseDraft),
        etsySlots: slots,
        etsyCampaignContext: options.etsyCampaignContext ? {
          ...options.etsyCampaignContext,
          plans: options.etsyCampaignContext.plans.filter((plan) => !etsySlots.includes(plan.slot)),
        } : undefined,
      }),
      textOnlyReferenceGuard: isDeepSeekPlannerProfile,
      marketplaceId,
      fallbackTitle,
      slots: etsySlots,
      shotGroup: etsyShotGroup,
      checkpointKey,
      signal: options.signal,
      onProgress: options.onProgress,
      request: async (stage, signal, onActivity) => {
        const stageResponse = await request(undefined, stage, signal)
        if (!stageResponse.ok) {
          const message = await getApiErrorMessage(stageResponse)
          throw new Error(`HTTP ${stageResponse.status}: ${message}`)
        }
        return readPlannerResponseText(stageResponse, true, onActivity)
      },
    })
  }

  const requestResult = (repair?: { previousOutput: string; errorMessage: string }) => {
    const read = async (signal?: AbortSignal, onActivity?: (characters?: number) => void) => {
      const response = await request(repair, undefined, signal)
      if (!response.ok) {
        const message = await getApiErrorMessage(response)
        const failure = `HTTP ${response.status}: ${message}`
        throw new Error(repair ? `${repair.errorMessage}\n\n自动纠错失败：${failure}` : failure)
      }
      return readPlannerResponseText(response, mode === 'etsy', onActivity)
    }
    return mode === 'etsy' && etsyShotGroup === 'additional'
      ? requestEtsyPlannerStage({
        name: repair ? '新增5张自动纠错' : '新增5张',
        signal: options.signal,
        onProgress: options.onProgress,
        request: read,
      })
      : read(options.signal)
  }
  const responseResult = await requestResult()
  if (mode === 'etsy') {
    const normalizeEtsyResult = (text: string): PlannerApiResult => {
      const result = normalizeEtsyPlannerApiPayload(parsePlannerPayload(text), marketplaceId, fallbackTitle, etsySlots)
      if (etsyShotGroup && options.etsyCampaignContext) {
        const combined = mergeEtsyShotGroups(options.etsyCampaignContext.plans, result.plans)
        if (combined.length === ETSY_SHOT_COUNT && combined.every((plan) => plan.photographyDecision)) {
          assertEtsyPhotographyDiversity(combined)
        }
      }
      return { ...result, ...(etsyShotGroup ? { etsyShotGroup } : {}) }
    }
    try {
      return normalizeEtsyResult(responseResult.text)
    } catch (error) {
      const validationMessage = error instanceof Error ? error.message : String(error)
      const repairedResult = await requestResult({
        previousOutput: responseResult.text,
        errorMessage: validationMessage,
      })
      try {
        return normalizeEtsyResult(repairedResult.text)
      } catch (repairValidationError) {
        const repairedMessage = repairValidationError instanceof Error ? repairValidationError.message : String(repairValidationError)
        throw new Error(`${validationMessage}\n\n自动纠错后仍未通过：${repairedMessage}`)
      }
    }
  }

  const payload = parsePlannerPayload(responseResult.text)
  return mode === 'aplus'
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
