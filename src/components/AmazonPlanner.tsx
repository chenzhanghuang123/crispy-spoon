import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { addImageFromFile, ensureImageCached, submitTask, useStore } from '../store'
import { getAmazonPlannerProfile, isOfficialDeepSeekPlannerProfile, validateApiProfile } from '../lib/apiProfiles'
import {
  DEFAULT_AMAZON_PROMPT_DRAFT,
  type AmazonPromptDraft,
} from '../lib/amazonPrompt'
import {
  A_PLUS_CONTENT_TYPES,
  buildAmazonAPlusPlanPrompt,
  buildAmazonPlanPrompt,
  buildEtsyPlanPrompt,
  DEFAULT_LISTING_IMAGE_COUNT,
  ETSY_ORIGINAL_SHOT_COUNT,
  ETSY_SHOT_COUNT,
  formatAmazonListingSlotRange,
  formatAPlusModuleText,
  areAPlusModuleSpecsEquivalent,
  insertAPlusModuleSpecAfter,
  LISTING_IMAGE_COUNT_OPTIONS,
  MAX_A_PLUS_MODULE_COUNT,
  MIN_A_PLUS_MODULE_COUNT,
  getAPlusContentTypeLabel,
  getAPlusModuleDisplayName,
  getAPlusModuleEnglishName,
  getAPlusModuleGenerationSize,
  getAPlusModuleSpecs,
  getAPlusModuleUploadSize,
  isAmazonListingMainSlot,
  isAPlusTextModule,
  normalizeAPlusModuleSpecs,
  normalizeListingImageCount,
  removeAPlusModuleSpecAt,
  withAPlusGenerationSizes,
  type APlusContentType,
  type AmazonAPlusModuleSpec,
  type AmazonAPlusPlan,
  type AmazonImagePlan,
  type AmazonPlannerMode,
  type AmazonStyleDensityMode,
} from '../lib/listingPlanner'
import { callAmazonPlannerApi, callEtsyListingDetailsApi, clearEtsyOriginalPlannerCheckpoint, formatEtsyListingDetailsMarkdown, type EtsyShotGroup, type PlannerApiResult } from '../lib/listingPlannerApi'
import { deleteAmazonPlannerSession, getAllAmazonPlannerSessions, putAmazonPlannerSession } from '../lib/db'
import {
  AMAZON_MARKETPLACES,
  DEFAULT_AMAZON_MARKETPLACE_ID,
  getAmazonMarketplace,
  getAmazonMarketplaceLabel,
  normalizeAmazonMarketplaceId,
  type AmazonMarketplaceId,
} from '../lib/amazonMarketplaces'
import { prepareReferenceImagePayload, type PlannerReferenceImagePayload } from '../lib/referenceImagePayload'
import {
  DEFAULT_STYLE_PRESET_ID,
  STYLE_PRESETS,
  ensureStylePresetImageStored,
  getStylePresetAssetUrl,
  getStylePresetFallbackDataUrl,
  getStylePresetById,
  type StylePreset,
} from '../lib/stylePresets'
import {
  createStyleReferenceEditStateFromPreset,
  ensureCustomStyleReferenceImageStored,
  getCustomStyleReferenceDescription,
  getCustomStyleReferenceVisualMeta,
  renderStyleReferenceDataUrl,
  sanitizeStyleReferenceEditState,
} from '../lib/styleReferences'
import { DEFAULT_PARAMS } from '../types'
import type { AmazonPlannerSession, CustomStyleReference, EtsyListingDetails, EtsyPhotographyAnalysis, EtsyVisualDna, StyleReferenceEditState } from '../types'
import MarkdownRenderer from './MarkdownRenderer'
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, CopyIcon, EditIcon, EyeIcon, HistoryIcon, PhotoIcon, PlusIcon, RefreshIcon, TrashIcon } from './icons'

const StyleReferenceEditorModal = lazy(() => import('./StyleReferenceEditorModal'))

const FIELD_CLASS = 'ios-field w-full px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500'
const LABEL_CLASS = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.07em] text-gray-500 dark:text-gray-400'
const PLAN_LIST_CLASS = 'grid max-h-[420px] gap-2 overflow-y-auto overscroll-contain pr-1 custom-scrollbar sm:max-h-[480px]'
const GUIDE_HINT_CLASS = 'mb-3 rounded-[var(--ios-radius-md)] bg-[hsl(var(--ios-blue-tint))] px-3 py-2 text-xs font-medium leading-relaxed text-[hsl(var(--primary))]'
const DEEPSEEK_PLANNER_NOTICE = '当前 AI 策划配置为 DeepSeek 官方接口。DeepSeek 策划阶段不会读取参考图，系统会仅用 Listing 文本和你填写的商品信息生成策划；参考图仍会在正式生图时随生图请求发送。请把产品颜色、形状、结构、配件、Logo、套装数量等关键特征写进 Listing 或商品信息中。'
const DEEPSEEK_ETSY_LISTING_NOTICE = '当前 AI 策划配置为 DeepSeek 官方接口。此接口不会读取参考图，也不能通过 Responses Web Search 完成实时趋势验证；系统会仅依据你填写的产品事实生成文案，并明确标记“未联网验证”。'
const API_MAX_IMAGES = 16
const STYLE_PREVIEW_WIDTH = 420
const STYLE_PREVIEW_HEIGHT = 500
const STYLE_PREVIEW_OFFSET = 16
const STYLE_DENSITY_OPTIONS: Array<{ value: AmazonStyleDensityMode; label: string }> = [
  { value: 'rich', label: '信息丰富' },
  { value: 'minimal', label: '简约' },
]
type ComplianceStatus = 'ready' | 'warning' | 'missing'
type WorkflowStepStatus = 'done' | 'current' | 'todo'
type PlannerGuideTarget = 'planner-api' | 'planner-input' | 'planner-action' | 'style' | 'style-choice' | 'plan-list' | 'action-bar' | 'complete'
type PlannerGuideState = {
  target: PlannerGuideTarget
  message: string
}
type GuidePanelTone = 'white' | 'muted'
type PlannerActionProgress = 'filled' | 'submitted'
type PlannerActionProgressMap = Record<string, PlannerActionProgress>
type MobileActionDock = 'left' | 'right' | null
type APlusModuleSpecsByType = Partial<Record<APlusContentType, AmazonAPlusModuleSpec[]>>
type PlannerWorkspaceMode = AmazonPlannerMode | 'etsy-listing'
type SelectedStyleReference = {
  presetId: string | null
  customStyleReferenceId: string | null
  imageId: string
  dataUrl: string
  label: string
  description: string
  palette: string[]
}
type StylePreviewState = {
  dataUrl: string
  fallbackDataUrl?: string
  label: string
  description: string
  left: number
  top: number
}
const PLANNER_HISTORY_LIMIT = 30

function createPlannerSessionId() {
  return `amazon-planner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createCustomStyleReferenceId() {
  return `custom-style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeHistoryTitle(value: string) {
  const chars = Array.from(value.replace(/\s+/g, ' ').trim())
  if (chars.length <= 40) return chars.join('')
  return `${chars.slice(0, 37).join('')}...`
}

function getPlannerSessionTitle(draft: AmazonPromptDraft, listingText: string) {
  return normalizeHistoryTitle(draft.productTitle) || normalizeHistoryTitle(listingText) || '未命名策划'
}

function getSessionListingImageCount(session: AmazonPlannerSession) {
  if (session.listingImageCount != null) return normalizeListingImageCount(session.listingImageCount)
  return normalizeListingImageCount(session.imagePlans.length || DEFAULT_LISTING_IMAGE_COUNT)
}

function getSessionMarketplaceId(session: AmazonPlannerSession): AmazonMarketplaceId {
  return normalizeAmazonMarketplaceId(session.marketplaceId)
}

function getSessionAPlusModuleSpecsByType(session: AmazonPlannerSession): APlusModuleSpecsByType {
  const sessionSpecs = session.aPlusModuleSpecs ?? {}
  return A_PLUS_CONTENT_TYPES.reduce<APlusModuleSpecsByType>((result, type) => {
    const specs = sessionSpecs[type]
    if (Array.isArray(specs) && specs.length) {
      const normalizedSpecs = normalizeAPlusModuleSpecs(type, specs as Array<Partial<AmazonAPlusModuleSpec>>)
      if (!areAPlusModuleSpecsEquivalent(normalizedSpecs, getAPlusModuleSpecs(type))) {
        result[type] = normalizedSpecs
      }
    }
    return result
  }, {})
}

function getAPlusModuleSpecsForSession(
  specsByType: APlusModuleSpecsByType,
): AmazonPlannerSession['aPlusModuleSpecs'] {
  const entries = A_PLUS_CONTENT_TYPES
    .map((type) => {
      const specs = specsByType[type]
      if (!specs?.length || areAPlusModuleSpecsEquivalent(specs, getAPlusModuleSpecs(type))) return null
      return [type, specs] as const
    })
    .filter((entry): entry is readonly [APlusContentType, AmazonAPlusModuleSpec[]] => Boolean(entry))

  return entries.length ? Object.fromEntries(entries) : undefined
}

function formatPlannerSessionTime(value: number) {
  if (!Number.isFinite(value)) return ''
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getPlannerSessionResultLabel(session: AmazonPlannerSession) {
  if (session.mode === 'aplus') return getAPlusContentTypeLabel(session.aPlusType)
  if (session.mode === 'etsy-listing') return '双语详情 + 13 Tags'
  if (session.mode !== 'etsy') return `${session.imagePlans.length} 张`
  return session.imagePlans.length ? `${session.imagePlans.length} 张图片` : '未生成'
}

function toSessionDraft(draft: AmazonPromptDraft): AmazonPlannerSession['draft'] {
  return {
    kind: draft.kind,
    productTitle: draft.productTitle,
    category: draft.category,
    brand: draft.brand,
    color: draft.color,
    material: draft.material,
    audience: draft.audience,
    sellingPoints: draft.sellingPoints,
    packageIncludes: draft.packageIncludes,
    scene: draft.scene,
    forbidden: draft.forbidden,
  }
}

function fromSessionDraft(draft: AmazonPlannerSession['draft']): AmazonPromptDraft {
  return {
    ...DEFAULT_AMAZON_PROMPT_DRAFT,
    ...draft,
    kind: (draft.kind as AmazonPromptDraft['kind']) || DEFAULT_AMAZON_PROMPT_DRAFT.kind,
  }
}

function sortPlannerSessions(sessions: AmazonPlannerSession[]) {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, PLANNER_HISTORY_LIMIT)
}

function getActionStepClass(status: WorkflowStepStatus) {
  if (status === 'done') return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200'
  if (status === 'current') return 'bg-[hsl(var(--ios-blue-tint))] text-[hsl(var(--primary))] ring-2 ring-[hsl(var(--primary)/0.16)]'
  return 'bg-[hsl(var(--muted))] text-gray-500 dark:text-gray-400'
}

function getGuidePanelClass(isActive: boolean, tone: GuidePanelTone = 'white') {
  if (isActive) return 'bg-[hsl(var(--ios-blue-tint))] ring-2 ring-[hsl(var(--primary)/0.2)]'
  if (tone === 'muted') return 'bg-[hsl(var(--muted)/0.72)]'
  return 'bg-[hsl(var(--surface)/0.94)]'
}

function getGuideFocusClass(isActive: boolean) {
  return isActive ? 'ring-2 ring-[hsl(var(--primary)/0.2)]' : ''
}

function getPlannerActionKey(mode: AmazonPlannerMode, planIndex: number | null, slot: string | undefined | null) {
  if (planIndex == null || !slot) return ''
  return `${mode}:${planIndex}:${slot}`
}

function getEtsyCampaignInputKey(listingText: string, draft: AmazonPromptDraft, referenceImageIds: string[]) {
  return JSON.stringify([
    listingText.trim(),
    referenceImageIds,
    draft.productTitle,
    draft.category,
    draft.brand,
    draft.color,
    draft.material,
    draft.audience,
    draft.sellingPoints,
    draft.packageIncludes,
    draft.scene,
    draft.forbidden,
  ])
}

function toAmazonPlannerSessionMode(mode: AmazonPlannerMode): AmazonPlannerSession['mode'] {
  return mode
}

function getPlannerFailureDetail(err: unknown, isEtsyImageMode = false): string {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const message = rawMessage.trim() || '未知错误'
  const lower = message.toLowerCase()
  const hints: string[] = []
  const hasNoAvailableChannel = /无可用渠道|no available channel|distributor/.test(lower)

  if (/401|invalid api key|incorrect api key|unauthorized|forbidden|权限|认证|鉴权/.test(lower)) {
    hints.push('请检查 AI 策划配置里的 API Key 是否正确，并确认该 Key 有所选聊天/策划接口权限。')
  }
  if (/404|not found|responses|endpoint|route|路径|不存在/.test(lower)) {
    hints.push('请确认 AI 策划配置的 API URL 支持当前接口：DeepSeek 请使用 Chat Completions（/chat/completions），不要使用只开放 /v1/images 的图片中转。')
  }
  if (hasNoAvailableChannel) {
    hints.push('当前 API Key 所属分组没有该模型的可用渠道。请在设置 -> AI 策划中点击“检测可用模型”并选择服务端返回的模型，或更换有该模型权限的 Key。')
  } else if (/model|does not exist|unsupported|not supported|模型/.test(lower)) {
    hints.push('请确认 AI 策划配置使用的是文本/多模态模型，而不是 gpt-image-2。')
  }
  if (/json_schema|schema|structured|text\.format|response_format|strict/.test(lower)) {
    hints.push('该接口可能不支持当前 JSON 输出参数；Chat Completions 需要支持 response_format=json_object。')
  }
  if (/failed to fetch|network|cors|load failed|连接|网络|跨域/.test(lower)) {
    hints.push('浏览器未能连接到策划接口；请检查网络、跨域设置，或确认部署端 API 代理配置。')
  }
  if (/\b(?:524|504)\b/.test(lower)) {
    hints.push('服务商网关等待上游模型超时；若持续出现，请让服务商检查渠道响应速度和流式转发是否被缓冲。')
  }
  if (/\b429\b|rate limit|too many requests|限流/.test(lower)) {
    hints.push(isEtsyImageMode
      ? '服务商上游正在限流。Etsy 策划已分成 10 张与 5 张两个独立请求；请间隔后重试失败的那一组，若仍持续出现，请联系服务商检查该模型的额度和渠道。'
      : '服务商上游正在限流，请稍后重试；若持续出现，请联系服务商检查该模型的额度和渠道。')
  }

  return [message, ...hints].join('\n\n')
}

function updateDraft<K extends keyof AmazonPromptDraft>(
  draft: AmazonPromptDraft,
  key: K,
  value: AmazonPromptDraft[K],
) {
  return { ...draft, [key]: value }
}

function isAbortError(err: unknown): boolean {
  return (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
}

function getStylePreviewPosition(clientX: number, clientY: number) {
  if (typeof window === 'undefined') {
    return { left: clientX + STYLE_PREVIEW_OFFSET, top: clientY + STYLE_PREVIEW_OFFSET }
  }
  const viewportPadding = 12
  const rightLeft = clientX + STYLE_PREVIEW_OFFSET
  const left = rightLeft + STYLE_PREVIEW_WIDTH <= window.innerWidth - viewportPadding
    ? rightLeft
    : Math.max(viewportPadding, clientX - STYLE_PREVIEW_WIDTH - STYLE_PREVIEW_OFFSET)
  const maxTop = Math.max(viewportPadding, window.innerHeight - STYLE_PREVIEW_HEIGHT - viewportPadding)
  const top = Math.min(Math.max(viewportPadding, clientY - 160), maxTop)
  return { left, top }
}

function getPlanSummary(planMarkdown: string) {
  const lines = planMarkdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
  return lines[0] ?? ''
}

function getAmazonAPlusComplianceChecks(
  draft: AmazonPromptDraft,
  plan: AmazonAPlusPlan | null,
  aPlusType: APlusContentType,
  marketplaceId: AmazonMarketplaceId,
  referenceImageCount: number,
  hasStyleReference: boolean,
): Array<{ label: string; status: ComplianceStatus; detail: string }> {
  return [
    {
      label: '目标站点',
      status: 'ready',
      detail: getAmazonMarketplaceLabel(marketplaceId),
    },
    {
      label: '商品名称',
      status: draft.productTitle.trim() ? 'ready' : 'missing',
      detail: draft.productTitle.trim() ? '已填写' : '需要填写准确商品名',
    },
    {
      label: 'A+ 类型',
      status: 'ready',
      detail: `${getAPlusContentTypeLabel(aPlusType)} A+ 编排`,
    },
    {
      label: 'A+ 尺寸',
      status: plan ? 'ready' : 'warning',
      detail: plan ? `${plan.generationSize} 生成，上传建议 ${plan.uploadSize}` : '请选择一个 A+ 模块',
    },
    {
      label: '参考图',
      status: referenceImageCount > 0 ? 'ready' : 'warning',
      detail: referenceImageCount > 0 ? `${referenceImageCount} 张参考图` : '建议上传产品实拍参考图',
    },
    {
      label: '风格参考',
      status: hasStyleReference ? 'ready' : 'warning',
      detail: hasStyleReference ? '已选择隐藏风格参考' : '正式生成前请选择风格参考',
    },
  ]
}

function getAmazonListingPlannerChecks(
  draft: AmazonPromptDraft,
  size: string,
  marketplaceId: AmazonMarketplaceId,
  referenceImageCount: number,
  hasStyleReference: boolean,
  styleReferenceRequired: boolean,
): Array<{ label: string; status: ComplianceStatus; detail: string }> {
  return [
    {
      label: '目标站点',
      status: 'ready',
      detail: getAmazonMarketplaceLabel(marketplaceId),
    },
    {
      label: '商品名称',
      status: draft.productTitle.trim() ? 'ready' : 'missing',
      detail: draft.productTitle.trim() ? '已填写' : '等待 AI 从 Listing 解析',
    },
    {
      label: '图片规格',
      status: /^(2048|4096)x(2048|4096)$/.test(size) ? 'ready' : 'warning',
      detail: /4096x4096/.test(size) ? '4K 方图' : /2048x2048/.test(size) ? '2K 方图' : size || '未选择 2K/4K',
    },
    {
      label: '参考图',
      status: referenceImageCount > 0 ? 'ready' : 'warning',
      detail: referenceImageCount > 0 ? `${referenceImageCount} 张产品参考图` : '建议上传产品实拍参考图',
    },
    {
      label: '风格参考',
      status: !styleReferenceRequired || hasStyleReference ? 'ready' : 'warning',
      detail: !styleReferenceRequired
        ? 'MAIN 主图不使用隐藏风格参考'
        : hasStyleReference ? '已选择隐藏风格参考' : '正式生成前请选择风格参考',
    },
  ]
}

function getEtsyPlannerChecks(
  draft: AmazonPromptDraft,
  size: string,
  referenceImageCount: number,
  visualDna: EtsyVisualDna | null,
  hasStyleReference: boolean,
  plannedShotCount: number,
): Array<{ label: string; status: ComplianceStatus; detail: string }> {
  return [
    {
      label: '商品名称',
      status: draft.productTitle.trim() ? 'ready' : 'missing',
      detail: draft.productTitle.trim() ? '已锁定商品名称' : '需要商品名称或清晰产品描述',
    },
    {
      label: 'Visual DNA',
      status: visualDna ? 'ready' : 'warning',
      detail: visualDna ? '材质、颜色、纹理与受众已锁定' : '选择一组 Etsy 镜头生成 Visual DNA',
    },
    {
      label: '镜头规格',
      status: /^(2048|4096)x(2048|4096)$/.test(size) ? 'ready' : 'warning',
      detail: `${plannedShotCount}/${ETSY_SHOT_COUNT} 张已策划 · ${/4096x4096/.test(size) ? '4K' : '2K'} · 1:1`,
    },
    {
      label: '产品参考图',
      status: referenceImageCount > 0 ? 'ready' : 'warning',
      detail: referenceImageCount > 0 ? `${referenceImageCount} 张产品参考图` : '强烈建议上传产品实拍图，防止AI重设计',
    },
    {
      label: '风格参考',
      status: hasStyleReference ? 'ready' : 'warning',
      detail: hasStyleReference ? '已选择视觉风格参考' : '可选择风格参考统一15张氛围',
    },
  ]
}

export default function AmazonPlanner() {
  const prompt = useStore((s) => s.prompt)
  const inputImages = useStore((s) => s.inputImages)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setPrompt = useStore((s) => s.setPrompt)
  const setParams = useStore((s) => s.setParams)
  const setPendingTaskCategory = useStore((s) => s.setPendingTaskCategory)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const setInputImages = useStore((s) => s.setInputImages)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const showToast = useStore((s) => s.showToast)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const plannerAbortControllerRef = useRef<AbortController | null>(null)
  const etsyCampaignInputKeyRef = useRef<string | null>(null)
  const etsyListingAbortControllerRef = useRef<AbortController | null>(null)
  const stylePresetAbortControllerRef = useRef<AbortController | null>(null)
  const [draft, setDraft] = useState<AmazonPromptDraft>(DEFAULT_AMAZON_PROMPT_DRAFT)
  const [resolution, setResolution] = useState<'2k' | '4k'>('2k')
  const [listingImageCount, setListingImageCount] = useState(DEFAULT_LISTING_IMAGE_COUNT)
  const [plannerMode, setPlannerMode] = useState<AmazonPlannerMode>('listing')
  const [etsyListingStandalone, setEtsyListingStandalone] = useState(false)
  const [marketplaceId, setMarketplaceId] = useState<AmazonMarketplaceId>(DEFAULT_AMAZON_MARKETPLACE_ID)
  const [aPlusType, setAPlusType] = useState<APlusContentType>('standard-large')
  const [aPlusModuleSpecsByType, setAPlusModuleSpecsByType] = useState<APlusModuleSpecsByType>({})
  const [listingText, setListingText] = useState('')
  const [etsyPlanningProgress, setEtsyPlanningProgress] = useState('')
  const [imagePlans, setImagePlans] = useState<AmazonImagePlan[]>([])
  const [aPlusPlans, setAPlusPlans] = useState<AmazonAPlusPlan[]>([])
  const [seriesStyleGuides, setSeriesStyleGuides] = useState<{ listing: string; aplus: string; etsy: string }>({
    listing: '',
    aplus: '',
    etsy: '',
  })
  const [etsyVisualDna, setEtsyVisualDna] = useState<EtsyVisualDna | null>(null)
  const [etsyPhotographyAnalysis, setEtsyPhotographyAnalysis] = useState<EtsyPhotographyAnalysis | null>(null)
  const [etsyListingDetails, setEtsyListingDetails] = useState<EtsyListingDetails | null>(null)
  const [selectedStylePresetId, setSelectedStylePresetId] = useState<string | null>(DEFAULT_STYLE_PRESET_ID)
  const [selectedStyleReference, setSelectedStyleReference] = useState<SelectedStyleReference | null>(null)
  const [styleDensityMode, setStyleDensityMode] = useState<AmazonStyleDensityMode>('rich')
  const [stylePreview, setStylePreview] = useState<StylePreviewState | null>(null)
  const [isLoadingStylePreset, setIsLoadingStylePreset] = useState(false)
  const [styleError, setStyleError] = useState('')
  const [customStyleImageDataUrls, setCustomStyleImageDataUrls] = useState<Record<string, string>>({})
  const [styleEditor, setStyleEditor] = useState<{
    mode: 'preset' | 'custom'
    title: string
    basePresetId: string | null
    customStyleId: string | null
    initialState: StyleReferenceEditState
  } | null>(null)
  const [isSavingStyleEditor, setIsSavingStyleEditor] = useState(false)
  const [selectedPlanIndex, setSelectedPlanIndex] = useState<number | null>(null)
  const [selectedAPlusPlanIndex, setSelectedAPlusPlanIndex] = useState<number | null>(null)
  const [plannerSessions, setPlannerSessions] = useState<AmazonPlannerSession[]>([])
  const [currentPlannerSessionId, setCurrentPlannerSessionId] = useState<string | null>(null)
  const [showPlannerHistory, setShowPlannerHistory] = useState(false)
  const [isPlanning, setIsPlanning] = useState(false)
  const [planningEtsyShotGroup, setPlanningEtsyShotGroup] = useState<EtsyShotGroup | null>(null)
  const [isGeneratingEtsyBatch, setIsGeneratingEtsyBatch] = useState(false)
  const [isGeneratingEtsyListing, setIsGeneratingEtsyListing] = useState(false)
  const [plannerError, setPlannerError] = useState('')
  const [etsyListingError, setEtsyListingError] = useState('')
  const [isPreparingReferencePayload, setIsPreparingReferencePayload] = useState(false)
  const [referencePayloadNotice, setReferencePayloadNotice] = useState('')
  const [actionProgress, setActionProgress] = useState<PlannerActionProgressMap>({})
  const [mobileActionDock, setMobileActionDock] = useState<MobileActionDock>(null)
  const [showProductDetails, setShowProductDetails] = useState(false)
  const workspaceMode: PlannerWorkspaceMode = etsyListingStandalone ? 'etsy-listing' : plannerMode
  const isEtsyListingMode = workspaceMode === 'etsy-listing'
  const isEtsyImageMode = workspaceMode === 'etsy'
  const productDetailValues = [
    draft.productTitle,
    draft.category,
    draft.brand,
    draft.color,
    draft.material,
    draft.audience,
    draft.sellingPoints,
    draft.packageIncludes,
    ...(!isEtsyListingMode ? [draft.scene] : []),
    draft.forbidden,
  ]
  const completedProductDetailCount = productDetailValues.filter((value) => value.trim()).length
  const resolutionTier = resolution === '4k' ? '4K' : '2K'
  const marketplace = useMemo(() => getAmazonMarketplace(marketplaceId), [marketplaceId])
  const listingSlotRange = formatAmazonListingSlotRange(listingImageCount)
  const aPlusSpecs = useMemo(
    () => normalizeAPlusModuleSpecs(aPlusType, aPlusModuleSpecsByType[aPlusType]),
    [aPlusModuleSpecsByType, aPlusType],
  )
  const aPlusDefaultSpecs = useMemo(() => getAPlusModuleSpecs(aPlusType), [aPlusType])
  const aPlusSpecsAreDefault = areAPlusModuleSpecsEquivalent(aPlusSpecs, aPlusDefaultSpecs)
  const aPlusPlansWithSizes = useMemo(() => withAPlusGenerationSizes(aPlusPlans, resolutionTier), [aPlusPlans, resolutionTier])
  const selectedPlan = selectedPlanIndex == null ? null : imagePlans[selectedPlanIndex] ?? null
  const selectedAPlusPlan = selectedAPlusPlanIndex == null ? null : aPlusPlansWithSizes[selectedAPlusPlanIndex] ?? null
  const selectedAPlusText = selectedAPlusPlan ? formatAPlusModuleText(selectedAPlusPlan) : ''
  const customStyleReferences = settings.customStyleReferences ?? []
  const selectedStylePreset = getStylePresetById(selectedStylePresetId)
  const selectedStyleImage = selectedStyleReference
  const selectedStyleLabel = selectedStyleReference?.label ?? selectedStylePreset?.label ?? ''
  const selectedVisualStyle = selectedStyleReference
    ? {
        label: selectedStyleReference.label,
        description: selectedStyleReference.description,
        palette: selectedStyleReference.palette,
      }
    : selectedStylePreset
  const selectedEtsyVisualStyle = selectedVisualStyle
    ? {
        ...selectedVisualStyle,
        description: selectedStyleReference?.customStyleReferenceId
          ? selectedVisualStyle.description
          : selectedStylePreset?.etsyPhotographyDescription ?? selectedVisualStyle.description,
      }
    : null
  const activeSeriesStyleGuide = plannerMode === 'aplus'
    ? seriesStyleGuides.aplus
    : plannerMode === 'etsy'
      ? seriesStyleGuides.etsy
      : seriesStyleGuides.listing
  const isMainListingPlan = plannerMode === 'listing' && isAmazonListingMainSlot(selectedPlan?.slot)
  const styleReferenceRequired = !isEtsyListingMode && (plannerMode === 'etsy' || !isMainListingPlan)
  const hasStyleReference = Boolean(selectedStyleImage?.imageId)
  const usesStyleDirectionForActivePlan = styleReferenceRequired && Boolean(selectedVisualStyle)
  const usesStyleReferenceForActivePlan = usesStyleDirectionForActivePlan && !isEtsyImageMode && hasStyleReference
  const hasRequiredStyle = !styleReferenceRequired || (isEtsyImageMode ? usesStyleDirectionForActivePlan : hasStyleReference)
  const effectiveReferenceCount = inputImages.length + (usesStyleReferenceForActivePlan && selectedStyleImage?.imageId && !inputImages.some((image) => image.id === selectedStyleImage.imageId) ? 1 : 0)
  const styleReferenceLimitExceeded = usesStyleReferenceForActivePlan && effectiveReferenceCount > API_MAX_IMAGES
  const activePrompt = plannerMode === 'aplus'
    ? selectedAPlusPlan ? buildAmazonAPlusPlanPrompt({
      ...selectedAPlusPlan,
      seriesStyleGuide: activeSeriesStyleGuide,
      styleReferenceAttached: usesStyleReferenceForActivePlan,
      styleDensityMode,
      marketplaceId,
      selectedVisualStyle: usesStyleReferenceForActivePlan ? selectedVisualStyle : null,
    }) : ''
    : plannerMode === 'etsy'
      ? selectedPlan ? buildEtsyPlanPrompt({
        ...selectedPlan,
        seriesStyleGuide: activeSeriesStyleGuide,
        styleReferenceAttached: false,
        styleDensityMode,
        selectedVisualStyle: usesStyleDirectionForActivePlan ? selectedEtsyVisualStyle : null,
      }) : ''
      : selectedPlan ? buildAmazonPlanPrompt({
        ...selectedPlan,
        seriesStyleGuide: isMainListingPlan ? null : activeSeriesStyleGuide,
        styleReferenceAttached: usesStyleReferenceForActivePlan,
        styleDensityMode,
        marketplaceId,
        selectedVisualStyle: usesStyleReferenceForActivePlan ? selectedVisualStyle : null,
      }) : ''
  const activePlanMarkdown = plannerMode === 'aplus' ? selectedAPlusPlan?.planMarkdown ?? '' : selectedPlan?.planMarkdown ?? ''
  const activePlanPreview = activePlanMarkdown
    ? [
        activePlanMarkdown,
        '',
        plannerMode === 'etsy' ? 'English Image Prompt / Visual DNA Locked' : `英文生图提示词 Prompt / ${marketplace.copyLanguage}可见文案`,
        activePrompt,
      ].join('\n')
    : activePrompt
  const etsyListingMarkdown = etsyListingDetails ? formatEtsyListingDetailsMarkdown(etsyListingDetails) : ''
  const plannerProfile = getAmazonPlannerProfile(settings)
  const plannerProfileValidation = plannerProfile ? validateApiProfile(plannerProfile) : '未选择支持 Chat Completions 或 Responses API 的 AI 策划配置'
  const plannerApiLabel = plannerProfile?.apiMode === 'chat' ? 'Chat Completions' : 'Responses API'
  const plannerUsesOfficialDeepSeek = plannerProfile ? isOfficialDeepSeekPlannerProfile(plannerProfile) : false
  const listingTargetSize = resolution === '4k' ? '4096x4096' : '2048x2048'
  const targetSize = plannerMode === 'aplus' && selectedAPlusPlan ? selectedAPlusPlan.generationSize : listingTargetSize
  const generationParamLabel = `${DEFAULT_PARAMS.output_format.toUpperCase()} / ${DEFAULT_PARAMS.quality} / 压缩率${DEFAULT_PARAMS.output_compression}`
  const visiblePlanCount = plannerMode === 'aplus' ? aPlusPlansWithSizes.length : imagePlans.length
  const visiblePlanIndex = plannerMode === 'aplus' ? selectedAPlusPlanIndex : selectedPlanIndex
  const actionSlot = plannerMode === 'aplus' ? selectedAPlusPlan?.slot : selectedPlan?.slot
  const actionLabel = plannerMode === 'aplus' ? selectedAPlusPlan?.label : selectedPlan?.label
  const showStickyActions = plannerMode === 'aplus' ? aPlusPlansWithSizes.length > 0 : imagePlans.length > 0
  const actionDisabled = plannerMode === 'aplus' ? !selectedAPlusPlan : !activePrompt.trim()
  const submitDisabled = actionDisabled || !hasRequiredStyle || styleReferenceLimitExceeded
  const hasPlanOptions = visiblePlanCount > 0
  const hasSelectedPlan = plannerMode === 'aplus' ? Boolean(selectedAPlusPlan) : Boolean(selectedPlan)
  const canGoPrev = visiblePlanCount > 0 && visiblePlanIndex != null && visiblePlanIndex > 0
  const canGoNext = visiblePlanCount > 0 && visiblePlanIndex != null && visiblePlanIndex < visiblePlanCount - 1
  const actionPositionLabel = visiblePlanCount > 0 && visiblePlanIndex != null
    ? `${visiblePlanIndex + 1}/${visiblePlanCount}`
    : plannerMode === 'aplus'
      ? `${aPlusSpecs.length} 个待策划模块`
      : '未选择'
  const currentActionKey = getPlannerActionKey(plannerMode, visiblePlanIndex, actionSlot)
  const currentActionProgress = currentActionKey ? actionProgress[currentActionKey] ?? null : null
  const currentActionFilled = currentActionProgress === 'filled' || currentActionProgress === 'submitted'
  const currentActionSubmitted = currentActionProgress === 'submitted'
  const pendingEtsyPlanCount = plannerMode === 'etsy'
    ? imagePlans.filter((plan, index) => actionProgress[getPlannerActionKey('etsy', index, plan.slot)] !== 'submitted').length
    : 0
  const etsyCampaignInputKey = getEtsyCampaignInputKey(listingText, draft, inputImages.map((image) => image.id))
  const canContinueEtsyCampaign = etsyCampaignInputKeyRef.current === etsyCampaignInputKey
  const actionKindLabel = plannerMode === 'aplus' ? '模块' : plannerMode === 'etsy' ? '镜头' : isMainListingPlan ? '主图' : '图片'
  const actionGuidance = !hasSelectedPlan
    ? plannerMode === 'aplus' ? '先选择一个 A+ 模块' : '先选择一个图片位'
    : currentActionSubmitted
      ? `已提交 ${actionSlot ?? '当前'} ${actionKindLabel}，${canGoNext ? '点击下一张继续' : '已是最后一张'}`
      : currentActionFilled
        ? '已填入右侧输入框，下一步提交生成'
        : `先填入当前 ${actionSlot ?? '当前'} ${actionKindLabel}提示词`
  const mainStyleGuidance = isMainListingPlan
    ? hasStyleReference
      ? 'MAIN 主图不附加风格参考图；附图和 A+ 会使用已选风格。'
      : 'MAIN 主图不附加风格参考图；附图和 A+ 可选择风格参考。'
    : ''
  const actionProgressSteps = [
    {
      label: '1 填入',
      detail: currentActionFilled ? '已填入' : '待填入',
      status: currentActionFilled ? 'done' : 'current',
    },
    {
      label: plannerMode === 'etsy' ? '2 生成镜头' : '2 提交生成',
      detail: currentActionSubmitted ? '已提交' : currentActionFilled ? '下一步' : '待提交',
      status: currentActionSubmitted ? 'done' : currentActionFilled ? 'current' : 'todo',
    },
    {
      label: '3 下一张',
      detail: currentActionSubmitted ? (canGoNext ? '继续下一张' : '最后一张') : '提交后继续',
      status: currentActionSubmitted ? (canGoNext ? 'current' : 'done') : 'todo',
    },
  ] satisfies Array<{ label: string; detail: string; status: WorkflowStepStatus }>
  const hasListingText = Boolean(listingText.trim())
  const hasUsablePlannerProfile = Boolean(plannerProfile && !plannerProfileValidation)
  const seriesStyleReferenceNeeded = isEtsyListingMode
    ? false
    : plannerMode === 'etsy'
    ? hasPlanOptions
    : plannerMode === 'aplus'
    ? hasPlanOptions
    : imagePlans.some((plan) => !isAmazonListingMainSlot(plan.slot))
  const guideState: PlannerGuideState = !hasUsablePlannerProfile
    ? {
        target: 'planner-api',
        message: plannerProfileValidation ? `下一步：先配置 AI 策划 API（${plannerProfileValidation}）` : '下一步：先配置 AI 策划 API',
      }
    : !hasListingText
      ? {
          target: 'planner-input',
          message: isEtsyListingMode
            ? '下一步：填写用于 Etsy Listing 的产品事实、规格、用途和目标买家'
            : plannerMode === 'etsy'
            ? '下一步：粘贴产品描述、材质工艺、尺寸、用途与目标买家'
            : plannerMode === 'aplus' ? '下一步：粘贴标题、五点描述或品牌说明' : '下一步：粘贴标题和五点描述',
        }
      : isEtsyListingMode
        ? etsyListingDetails
          ? {
              target: 'complete',
              message: 'Etsy Listing详情已生成，可复制后发布前核对缺失规格。',
            }
          : {
              target: 'planner-action',
              message: '下一步：点击生成Listing详情，完成趋势验证、SEO标题、双语详情与13个Tags',
            }
      : !hasPlanOptions
        ? {
            target: 'planner-action',
              message: plannerMode === 'etsy'
              ? '下一步：点击对应按钮，只策划原有10张或新增5张；两组方案独立显示'
              : plannerMode === 'aplus' ? '下一步：点击 AI策划A+ 生成模块方案' : '下一步：点击 AI策划生成逐张方案',
          }
        : seriesStyleReferenceNeeded && !hasStyleReference
          ? {
              target: 'style-choice',
              message: isLoadingStylePreset
                ? '正在加载风格参考图'
                : plannerMode === 'etsy' ? '下一步：选择风格参考，统一15张Etsy大片氛围' : '下一步：选择一套风格参考，统一附图和 A+ 视觉',
            }
          : !hasSelectedPlan
            ? {
                target: 'plan-list',
                message: plannerMode === 'etsy'
                  ? '下一步：确认方案并选择要生成的Etsy镜头'
                  : plannerMode === 'aplus' ? '下一步：选择要生成的 A+ 模块' : '下一步：选择要生成的图片位',
              }
            : {
                target: 'action-bar',
                message: currentActionSubmitted
                  ? canGoNext ? '下一步：点击下一张继续处理' : '当前图片已提交，已是最后一张'
                  : currentActionFilled
                    ? '下一步：提交生成当前图片'
                    : `下一步：填入当前 ${actionSlot ?? '当前'} ${actionKindLabel}提示词`,
              }
  const plannerGuideActive = guideState.target === 'planner-api' || guideState.target === 'planner-input' || guideState.target === 'planner-action'
  const styleGuideActive = guideState.target === 'style' || guideState.target === 'style-choice'
  const planListGuideActive = guideState.target === 'plan-list'
  const actionBarGuideActive = guideState.target === 'action-bar'
  const checks = plannerMode === 'etsy'
    ? getEtsyPlannerChecks(draft, targetSize, inputImages.length, etsyVisualDna, hasStyleReference, imagePlans.length)
    : plannerMode === 'aplus'
      ? getAmazonAPlusComplianceChecks(draft, selectedAPlusPlan, aPlusType, marketplaceId, inputImages.length, hasStyleReference)
      : getAmazonListingPlannerChecks(draft, targetSize, marketplaceId, inputImages.length, hasStyleReference, styleReferenceRequired)
  const atImageLimit = inputImages.length >= API_MAX_IMAGES

  useEffect(() => {
    let cancelled = false
    getAllAmazonPlannerSessions()
      .then((sessions) => {
        if (!cancelled) setPlannerSessions(sortPlannerSessions(sessions))
      })
      .catch((err) => {
        if (!cancelled) showToast(`策划历史加载失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    return () => {
      cancelled = true
    }
  }, [showToast])

  useEffect(() => {
    return () => {
      plannerAbortControllerRef.current?.abort()
      plannerAbortControllerRef.current = null
      etsyListingAbortControllerRef.current?.abort()
      etsyListingAbortControllerRef.current = null
      stylePresetAbortControllerRef.current?.abort()
      stylePresetAbortControllerRef.current = null
    }
  }, [])

  useEffect(() => {
    setReferencePayloadNotice('')
  }, [inputImages])

  useEffect(() => {
    if (!showStickyActions && mobileActionDock) setMobileActionDock(null)
  }, [mobileActionDock, showStickyActions])

  useEffect(() => {
    let cancelled = false
    Promise.all(customStyleReferences.map(async (style) => {
      const cached = style.imageId ? await ensureImageCached(style.imageId) : ''
      if (cached) return [style.id, cached] as const
      try {
        return [style.id, renderStyleReferenceDataUrl(style.editState)] as const
      } catch {
        return [style.id, ''] as const
      }
    }))
      .then((entries) => {
        if (cancelled) return
        setCustomStyleImageDataUrls(Object.fromEntries(entries.filter(([, dataUrl]) => Boolean(dataUrl))))
      })
      .catch(() => {
        if (!cancelled) setCustomStyleImageDataUrls({})
      })
    return () => {
      cancelled = true
    }
  }, [customStyleReferences])

  const upsertPlannerSessionList = (session: AmazonPlannerSession) => {
    setPlannerSessions((current) => sortPlannerSessions([
      session,
      ...current.filter((item) => item.id !== session.id),
    ]))
  }

  const createPlannerSessionSnapshot = (overrides: Partial<AmazonPlannerSession> = {}): AmazonPlannerSession => {
    const now = Date.now()
    const targetSessionId = overrides.id ?? currentPlannerSessionId
    const existing = targetSessionId ? plannerSessions.find((session) => session.id === targetSessionId) : null
    const snapshotDraft = overrides.draft ? fromSessionDraft(overrides.draft) : draft
    const snapshotListingText = overrides.listingText ?? listingText
    const hasOverride = (key: keyof AmazonPlannerSession) => Object.prototype.hasOwnProperty.call(overrides, key)
    return {
      id: targetSessionId ?? createPlannerSessionId(),
      title: overrides.title ?? getPlannerSessionTitle(snapshotDraft, snapshotListingText),
      mode: overrides.mode ?? (isEtsyListingMode ? 'etsy-listing' : toAmazonPlannerSessionMode(plannerMode)),
      marketplaceId: overrides.marketplaceId ?? marketplaceId,
      aPlusType: overrides.aPlusType ?? aPlusType,
      resolution: overrides.resolution ?? resolution,
      listingImageCount: overrides.listingImageCount ?? listingImageCount,
      aPlusModuleSpecs: hasOverride('aPlusModuleSpecs')
        ? overrides.aPlusModuleSpecs
        : getAPlusModuleSpecsForSession(aPlusModuleSpecsByType),
      listingText: snapshotListingText,
      referenceImageIds: overrides.referenceImageIds ?? inputImages.map((image) => image.id),
      draft: overrides.draft ?? toSessionDraft(draft),
      seriesStyleGuides: overrides.seriesStyleGuides ?? seriesStyleGuides,
      etsyVisualDna: hasOverride('etsyVisualDna') ? overrides.etsyVisualDna ?? null : etsyVisualDna,
      etsyPhotographyAnalysis: hasOverride('etsyPhotographyAnalysis')
        ? overrides.etsyPhotographyAnalysis ?? null
        : etsyPhotographyAnalysis,
      etsyListingDetails: hasOverride('etsyListingDetails')
        ? overrides.etsyListingDetails ?? null
        : isEtsyListingMode ? etsyListingDetails : null,
      styleCandidates: overrides.styleCandidates ?? [],
      styleImages: overrides.styleImages ?? [],
      selectedStyleIndex: overrides.selectedStyleIndex ?? null,
      selectedStylePresetId: hasOverride('selectedStylePresetId') ? overrides.selectedStylePresetId : selectedStylePresetId,
      selectedStyleReferenceImageId: hasOverride('selectedStyleReferenceImageId') ? overrides.selectedStyleReferenceImageId : selectedStyleReference?.imageId ?? null,
      selectedCustomStyleReferenceId: hasOverride('selectedCustomStyleReferenceId') ? overrides.selectedCustomStyleReferenceId : selectedStyleReference?.customStyleReferenceId ?? null,
      selectedCustomStyleReferenceSnapshot: hasOverride('selectedCustomStyleReferenceSnapshot') ? overrides.selectedCustomStyleReferenceSnapshot : (
        selectedStyleReference?.customStyleReferenceId
          ? customStyleReferences.find((style) => style.id === selectedStyleReference.customStyleReferenceId) ?? null
          : null
      ),
      styleDensityMode: overrides.styleDensityMode ?? styleDensityMode,
      imagePlans: overrides.imagePlans ?? imagePlans,
      aPlusPlans: overrides.aPlusPlans ?? aPlusPlansWithSizes,
      selectedPlanIndex: hasOverride('selectedPlanIndex') ? overrides.selectedPlanIndex ?? null : selectedPlanIndex,
      selectedAPlusPlanIndex: hasOverride('selectedAPlusPlanIndex') ? overrides.selectedAPlusPlanIndex ?? null : selectedAPlusPlanIndex,
      createdAt: overrides.createdAt ?? existing?.createdAt ?? now,
      updatedAt: now,
    }
  }

  const savePlannerSession = async (overrides: Partial<AmazonPlannerSession> = {}) => {
    const session = createPlannerSessionSnapshot(overrides)
    await putAmazonPlannerSession(session)
    setCurrentPlannerSessionId(session.id)
    upsertPlannerSessionList(session)
    return session
  }

  const updateCurrentPlannerSession = (overrides: Partial<AmazonPlannerSession>) => {
    if (!currentPlannerSessionId) return
    void savePlannerSession(overrides).catch((err) => {
      showToast(`策划历史保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    })
  }

  const markActionProgress = (key: string, progress: PlannerActionProgress) => {
    if (!key) return
    setActionProgress((current) => ({
      ...current,
      [key]: progress,
    }))
  }

  const applyPrompt = (options: { requireStyle?: boolean } = {}) => {
    if (plannerMode === 'aplus' && !selectedAPlusPlan) {
      showToast('请先 AI 策划并选择一个 A+ 模块', 'error')
      return false
    }
    if (!activePrompt.trim()) {
      showToast(plannerMode === 'etsy'
        ? '请先 Etsy策划并选择一个镜头'
        : plannerMode === 'aplus' ? '请先 AI 策划并选择一个 A+ 模块' : '请先 AI 策划并选择一个图片位', 'error')
      return false
    }
    const shouldRequireStyle = options.requireStyle && styleReferenceRequired
    if (shouldRequireStyle && !hasRequiredStyle) {
      showToast('请先选择一套风格参考', 'error')
      return false
    }
    if (shouldRequireStyle && styleReferenceLimitExceeded) {
      showToast(`已选择隐藏风格参考板，实际参考图数量不能超过 ${API_MAX_IMAGES} 张；请删除一张产品参考图后再提交。`, 'error')
      return false
    }

    setPrompt(activePrompt)
    setPendingTaskCategory({
      mode: 'prompt-match',
      prompt: activePrompt,
      category: {
        productTitle: draft.productTitle.trim(),
        workflow: plannerMode === 'etsy' ? 'etsy' : plannerMode === 'aplus' ? 'amazon-aplus' : 'amazon-listing',
        ...(plannerMode === 'etsy'
          ? { etsySlot: selectedPlan?.slot }
          : {
              amazonSlot: plannerMode === 'aplus' ? selectedAPlusPlan?.slot : selectedPlan?.slot,
              marketplaceId,
              ...(plannerMode === 'aplus' ? { aPlusType } : {}),
            }),
        ...(usesStyleReferenceForActivePlan && selectedStyleImage?.imageId ? { styleReferenceImageId: selectedStyleImage.imageId } : {}),
      },
    })
    setParams({
      size: targetSize,
      quality: DEFAULT_PARAMS.quality,
      output_format: DEFAULT_PARAMS.output_format,
      output_compression: DEFAULT_PARAMS.output_compression,
      n: 1,
    })
    markActionProgress(currentActionKey, 'filled')
    showToast(plannerMode === 'etsy' ? '已填入 Etsy 镜头提示词' : plannerMode === 'aplus' ? '已填入 A+ 图片提示词' : '已填入亚马逊图片提示词', 'success')
    return true
  }

  const applyAndSubmit = () => {
    if (!applyPrompt({ requireStyle: true })) return
    const submittedActionKey = currentActionKey
    queueMicrotask(() => {
      void submitTask().then((submitted) => {
        if (submitted) markActionProgress(submittedActionKey, 'submitted')
      })
    })
  }

  const generatePendingEtsyPlans = async () => {
    if (plannerMode !== 'etsy' || isGeneratingEtsyBatch || !imagePlans.length) return
    if (!hasRequiredStyle || styleReferenceLimitExceeded) {
      showToast('请先选择有效的 Etsy 风格参考配置', 'error')
      return
    }

    const plansToGenerate = imagePlans.filter((plan, index) =>
      actionProgress[getPlannerActionKey('etsy', index, plan.slot)] !== 'submitted',
    )
    if (!plansToGenerate.length) {
      showToast('15 个 Etsy 镜头都已提交', 'info')
      return
    }

    setParams({
      size: targetSize,
      quality: DEFAULT_PARAMS.quality,
      output_format: DEFAULT_PARAMS.output_format,
      output_compression: DEFAULT_PARAMS.output_compression,
      n: 1,
    })
    setIsGeneratingEtsyBatch(true)
    showToast(`开始并行生成 ${plansToGenerate.length} 个 Etsy 镜头（最多 3 路）`, 'info')

    let nextIndex = 0
    let submittedCount = 0
    const worker = async () => {
      while (nextIndex < plansToGenerate.length) {
        const plan = plansToGenerate[nextIndex++]
        const planIndex = imagePlans.findIndex((candidate) => candidate.slot === plan.slot)
        if (planIndex < 0) continue

        const submitted = await submitTask({
          promptOverride: buildEtsyPlanPrompt({
            ...plan,
            seriesStyleGuide: seriesStyleGuides.etsy,
            styleReferenceAttached: false,
            styleDensityMode,
            selectedVisualStyle: usesStyleDirectionForActivePlan ? selectedEtsyVisualStyle : null,
          }),
          taskCategoryOverride: {
            productTitle: draft.productTitle.trim(),
            workflow: 'etsy',
            etsySlot: plan.slot,
          },
          preserveInputAfterSubmit: true,
        })
        if (submitted) {
          submittedCount += 1
          markActionProgress(getPlannerActionKey('etsy', planIndex, plan.slot), 'submitted')
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(3, plansToGenerate.length) }, () => worker()))
      showToast(`已提交 ${submittedCount} 个 Etsy 镜头，图片会并行生成`, submittedCount ? 'success' : 'error')
    } catch (err) {
      showToast(`Etsy 批量提交失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setIsGeneratingEtsyBatch(false)
    }
  }

  const copyPrompt = async () => {
    if (plannerMode === 'aplus' && !selectedAPlusPlan) {
      showToast('请先 AI 策划并选择一个 A+ 模块', 'error')
      return
    }
    if (!activePrompt.trim()) {
      showToast(plannerMode === 'aplus' ? '请先 AI 策划并选择一个 A+ 模块' : '请先 AI 策划并选择一个图片位', 'error')
      return
    }

    try {
      await navigator.clipboard.writeText(activePrompt)
      showToast('提示词已复制', 'success')
    } catch {
      showToast('复制失败，请手动选择提示词', 'error')
    }
  }

  const copyAPlusText = async () => {
    if (!selectedAPlusText.trim()) {
      showToast('当前 A+ 模块没有可复制文案', 'error')
      return
    }

    try {
      await navigator.clipboard.writeText(selectedAPlusText)
      showToast('A+ 文案已复制', 'success')
    } catch {
      showToast('复制失败，请手动选择文案', 'error')
    }
  }

  const prepareReferencePayloadForRequest = async (dataUrls: string[], signal?: AbortSignal): Promise<PlannerReferenceImagePayload> => {
    if (!dataUrls.length) {
      setReferencePayloadNotice('')
      return prepareReferenceImagePayload([], { signal })
    }

    setIsPreparingReferencePayload(true)
    setReferencePayloadNotice('')
    try {
      const payload = await prepareReferenceImagePayload(dataUrls, { signal })
      if (payload.notice) setReferencePayloadNotice(payload.notice)
      return payload
    } finally {
      setIsPreparingReferencePayload(false)
    }
  }

  const selectStylePreset = async (presetId: string, options: { silent?: boolean; persist?: boolean } = {}) => {
    const preset = getStylePresetById(presetId)
    if (!preset) {
      showToast('预设风格不存在', 'error')
      return null
    }

    stylePresetAbortControllerRef.current?.abort()
    const controller = new AbortController()
    stylePresetAbortControllerRef.current = controller
    setSelectedStylePresetId(preset.id)
    setIsLoadingStylePreset(true)
    setStyleError('')

    try {
      const result = await ensureStylePresetImageStored(preset.id, controller.signal)
      if (stylePresetAbortControllerRef.current !== controller) return null
      const reference: SelectedStyleReference = {
        presetId: preset.id,
        customStyleReferenceId: null,
        imageId: result.imageId,
        dataUrl: result.dataUrl,
        label: preset.label,
        description: preset.description,
        palette: preset.palette,
      }
      setSelectedStyleReference(reference)
      if (options.persist !== false) {
        await savePlannerSession({
          selectedStylePresetId: preset.id,
          selectedStyleReferenceImageId: result.imageId,
          selectedCustomStyleReferenceId: null,
          selectedCustomStyleReferenceSnapshot: null,
          styleCandidates: [],
          styleImages: [],
          selectedStyleIndex: null,
        })
      }
      if (!options.silent) showToast(`已选择「${preset.label}」风格参考`, 'success')
      return reference
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return null
      const message = err instanceof Error ? err.message : String(err)
      setSelectedStyleReference(null)
      setStyleError(message)
      showToast('风格参考图加载失败', 'error')
      return null
    } finally {
      if (stylePresetAbortControllerRef.current === controller) {
        stylePresetAbortControllerRef.current = null
        setIsLoadingStylePreset(false)
      }
    }
  }

  const selectCustomStyleReference = async (
    customStyle: CustomStyleReference,
    options: { silent?: boolean; persist?: boolean } = {},
  ) => {
    setIsLoadingStylePreset(true)
    setStyleError('')
    try {
      let imageId = customStyle.imageId
      let dataUrl = imageId ? await ensureImageCached(imageId) : ''
      let normalizedCustomStyle = customStyle
      if (!dataUrl) {
        const rendered = await ensureCustomStyleReferenceImageStored(customStyle.editState)
        imageId = rendered.imageId
        dataUrl = rendered.dataUrl
        normalizedCustomStyle = {
          ...customStyle,
          editState: rendered.editState,
          imageId,
          updatedAt: Date.now(),
        }
        const latestSettings = useStore.getState().settings
        setSettings({
          customStyleReferences: (latestSettings.customStyleReferences ?? []).map((item) =>
            item.id === customStyle.id ? normalizedCustomStyle : item,
          ),
        })
      }

      const meta = getCustomStyleReferenceVisualMeta(normalizedCustomStyle)
      const reference: SelectedStyleReference = {
        presetId: normalizedCustomStyle.basePresetId ?? null,
        customStyleReferenceId: normalizedCustomStyle.id,
        imageId,
        dataUrl,
        label: meta.label,
        description: meta.description,
        palette: meta.palette,
      }
      setSelectedStylePresetId(normalizedCustomStyle.basePresetId ?? null)
      setSelectedStyleReference(reference)
      setCustomStyleImageDataUrls((current) => ({ ...current, [normalizedCustomStyle.id]: dataUrl }))
      if (options.persist !== false) {
        await savePlannerSession({
          selectedStylePresetId: normalizedCustomStyle.basePresetId ?? null,
          selectedStyleReferenceImageId: imageId,
          selectedCustomStyleReferenceId: normalizedCustomStyle.id,
          selectedCustomStyleReferenceSnapshot: normalizedCustomStyle,
          styleDensityMode: normalizedCustomStyle.editState.density,
          styleCandidates: [],
          styleImages: [],
          selectedStyleIndex: null,
        })
      }
      setStyleDensityMode(normalizedCustomStyle.editState.density)
      if (!options.silent) showToast(`已选择「${meta.label}」自定义风格`, 'success')
      return reference
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStyleError(message)
      showToast('自定义风格图加载失败', 'error')
      return null
    } finally {
      setIsLoadingStylePreset(false)
    }
  }

  const openStyleEditorFromPreset = (preset: StylePreset) => {
    setStyleEditor({
      mode: 'preset',
      title: `编辑「${preset.label}」`,
      basePresetId: preset.id,
      customStyleId: null,
      initialState: createStyleReferenceEditStateFromPreset(preset),
    })
  }

  const openStyleEditorFromCustom = (customStyle: CustomStyleReference) => {
    setStyleEditor({
      mode: 'custom',
      title: `编辑「${customStyle.title}」`,
      basePresetId: customStyle.basePresetId ?? null,
      customStyleId: customStyle.id,
      initialState: sanitizeStyleReferenceEditState(customStyle.editState),
    })
  }

  const saveStyleEditor = async (editState: StyleReferenceEditState) => {
    if (!styleEditor) return
    setIsSavingStyleEditor(true)
    try {
      const rendered = await ensureCustomStyleReferenceImageStored(editState)
      const now = Date.now()
      const latestSettings = useStore.getState().settings
      const currentLibrary = latestSettings.customStyleReferences ?? []
      const existing = styleEditor.customStyleId
        ? currentLibrary.find((item) => item.id === styleEditor.customStyleId)
        : null
      const title = rendered.editState.title || existing?.title || 'Custom style'
      const nextStyle: CustomStyleReference = {
        id: existing?.id ?? createCustomStyleReferenceId(),
        basePresetId: styleEditor.basePresetId,
        title,
        editState: rendered.editState,
        imageId: rendered.imageId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      const nextLibrary = existing
        ? currentLibrary.map((item) => item.id === existing.id ? nextStyle : item)
        : [nextStyle, ...currentLibrary]
      setSettings({ customStyleReferences: nextLibrary })
      setStyleEditor(null)
      await selectCustomStyleReference(nextStyle, { silent: true })
      showToast(existing ? '自定义风格已更新' : '自定义风格已保存', 'success')
    } catch (err) {
      showToast(`风格保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setIsSavingStyleEditor(false)
    }
  }

  const deleteCustomStyleReference = (customStyle: CustomStyleReference) => {
    const latestSettings = useStore.getState().settings
    setSettings({
      customStyleReferences: (latestSettings.customStyleReferences ?? []).filter((item) => item.id !== customStyle.id),
    })
    setCustomStyleImageDataUrls((current) => {
      const next = { ...current }
      delete next[customStyle.id]
      return next
    })
    if (selectedStyleReference?.customStyleReferenceId === customStyle.id) {
      void selectStylePreset(DEFAULT_STYLE_PRESET_ID, { silent: true })
    }
    showToast('自定义风格已删除', 'success')
  }

  const updateStylePreview = (
    preset: StylePreset,
    event: ReactMouseEvent<HTMLElement>,
  ) => {
    setStylePreview({
      dataUrl: getStylePresetAssetUrl(preset),
      fallbackDataUrl: getStylePresetFallbackDataUrl(preset),
      label: preset.label,
      description: preset.description,
      ...getStylePreviewPosition(event.clientX, event.clientY),
    })
  }

  const updateCustomStylePreview = (
    customStyle: CustomStyleReference,
    event: ReactMouseEvent<HTMLElement>,
  ) => {
    const meta = getCustomStyleReferenceVisualMeta(customStyle)
    setStylePreview({
      dataUrl: customStyleImageDataUrls[customStyle.id] || renderStyleReferenceDataUrl(customStyle.editState),
      label: meta.label,
      description: meta.description,
      ...getStylePreviewPosition(event.clientX, event.clientY),
    })
  }

  const openStylePresetPreview = async (presetId: string) => {
    const reference = selectedStyleReference?.presetId === presetId
      ? selectedStyleReference
      : await selectStylePreset(presetId, { silent: true })
    if (reference?.imageId) setLightboxImageId(reference.imageId, [reference.imageId])
  }

  const openCustomStylePreview = async (customStyle: CustomStyleReference) => {
    const reference = selectedStyleReference?.customStyleReferenceId === customStyle.id
      ? selectedStyleReference
      : await selectCustomStyleReference(customStyle, { silent: true })
    if (reference?.imageId) setLightboxImageId(reference.imageId, [reference.imageId])
  }

  const applyPlannerResult = (result: PlannerApiResult, sourceLabel: string) => {
    const resultMarketplaceId = normalizeAmazonMarketplaceId(result.marketplaceId)
    const firstPlan = result.plans[0]
    const hasExistingEtsyCampaign = result.mode === 'etsy' && Boolean(result.etsyShotGroup) && imagePlans.length > 0 && canContinueEtsyCampaign
    const keepExistingEtsyIdentity = hasExistingEtsyCampaign && Boolean(etsyVisualDna && etsyPhotographyAnalysis)
    const nextDraft = keepExistingEtsyIdentity ? draft : {
      ...draft,
      ...result.parsed.inferred,
      productTitle: result.parsed.title || draft.productTitle,
      sellingPoints: result.parsed.bullets.length ? result.parsed.bullets.join('\n') : draft.sellingPoints,
      ...(firstPlan?.kind ? { kind: firstPlan.kind } : {}),
    }
    const nextSeriesStyleGuides = {
      ...seriesStyleGuides,
      [result.mode]: keepExistingEtsyIdentity ? seriesStyleGuides.etsy : result.seriesStyleGuide,
    }
    const nextImagePlans = result.mode === 'aplus' ? [] : result.plans
    const nextAPlusPlans = result.mode === 'aplus' ? withAPlusGenerationSizes(result.aPlusPlans, resolutionTier) : []
    const nextSelectedPlanIndex = result.mode !== 'aplus' && result.plans.length
      ? Math.max(0, nextImagePlans.findIndex((plan) => plan.slot === firstPlan?.slot))
      : null
    const nextSelectedAPlusPlanIndex = result.mode === 'aplus' && result.aPlusPlans.length ? 0 : null
    const nextEtsyVisualDna = result.mode === 'etsy' ? keepExistingEtsyIdentity ? etsyVisualDna : result.etsyVisualDna ?? null : null
    const nextEtsyPhotographyAnalysis = result.mode === 'etsy' ? keepExistingEtsyIdentity ? etsyPhotographyAnalysis : result.etsyPhotographyAnalysis ?? null : null
    if (result.mode === 'etsy' && result.etsyShotGroup) {
      etsyCampaignInputKeyRef.current = getEtsyCampaignInputKey(listingText, nextDraft, inputImages.map((image) => image.id))
    }

    setDraft(nextDraft)
    setMarketplaceId(resultMarketplaceId)
    if (result.mode === 'aplus') {
      setAPlusPlans(nextAPlusPlans)
      setImagePlans([])
      setSelectedAPlusPlanIndex(nextSelectedAPlusPlanIndex)
      setSelectedPlanIndex(null)
    } else {
      setImagePlans(nextImagePlans)
      setAPlusPlans([])
      setSelectedPlanIndex(nextSelectedPlanIndex)
      setSelectedAPlusPlanIndex(null)
    }
    setSeriesStyleGuides(nextSeriesStyleGuides)
    setEtsyVisualDna(nextEtsyVisualDna)
    setEtsyPhotographyAnalysis(nextEtsyPhotographyAnalysis)
    if (!hasExistingEtsyCampaign) {
      setSelectedStylePresetId(DEFAULT_STYLE_PRESET_ID)
      setSelectedStyleReference(null)
      setStylePreview(null)
      setStyleError('')
    }
    setPlannerError('')
    setActionProgress({})
    void savePlannerSession({
      id: createPlannerSessionId(),
      mode: toAmazonPlannerSessionMode(result.mode),
      marketplaceId: resultMarketplaceId,
      listingImageCount,
      aPlusModuleSpecs: getAPlusModuleSpecsForSession(aPlusModuleSpecsByType),
      draft: toSessionDraft(nextDraft),
      seriesStyleGuides: nextSeriesStyleGuides,
      etsyVisualDna: nextEtsyVisualDna,
      etsyPhotographyAnalysis: nextEtsyPhotographyAnalysis,
      styleCandidates: [],
      styleImages: [],
      selectedStyleIndex: null,
      ...(!hasExistingEtsyCampaign ? {
        selectedStylePresetId: DEFAULT_STYLE_PRESET_ID,
        selectedStyleReferenceImageId: null,
        selectedCustomStyleReferenceId: null,
        selectedCustomStyleReferenceSnapshot: null,
      } : {}),
      styleDensityMode,
      imagePlans: nextImagePlans,
      aPlusPlans: nextAPlusPlans,
      selectedPlanIndex: nextSelectedPlanIndex,
      selectedAPlusPlanIndex: nextSelectedAPlusPlanIndex,
    })
      .then((session) => hasExistingEtsyCampaign ? null : selectStylePreset(DEFAULT_STYLE_PRESET_ID, { silent: true, persist: false })
        .then((reference) => {
          if (!reference) return
          const nextSession = {
            ...session,
            selectedStylePresetId: reference.presetId,
            selectedStyleReferenceImageId: reference.imageId,
            selectedCustomStyleReferenceId: null,
            selectedCustomStyleReferenceSnapshot: null,
            updatedAt: Date.now(),
          }
          void putAmazonPlannerSession(nextSession)
            .then(() => upsertPlannerSessionList(nextSession))
            .catch((err) => {
              showToast(`策划历史保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
            })
        }))
      .catch((err) => {
      showToast(`策划历史保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    })
    showToast(`${sourceLabel}已生成 ${result.mode === 'aplus' ? result.aPlusPlans.length : result.plans.length} 张图片策划`, 'success')
  }

  const createAiPlan = async (etsyShotGroup?: EtsyShotGroup) => {
    if (plannerAbortControllerRef.current) {
      showToast('AI 策划正在进行中', 'info')
      return
    }
    if (etsyListingAbortControllerRef.current) {
      showToast('Etsy Listing 详情正在生成中', 'info')
      return
    }
    if (!listingText.trim()) {
      showToast(plannerMode === 'etsy' ? '请先填写产品描述和材质工艺' : '请先粘贴标题和五点描述', 'error')
      return
    }

    if (!plannerProfile) {
      setPlannerError('未选择支持 Chat Completions 或 Responses API 的 AI 策划配置。\n\n请在设置 -> API 中创建或选择一个 Chat Completions 配置，例如 DeepSeek 文本模型；生图配置继续使用 Images API，不要把 gpt-image-2 用作策划模型。')
      showToast('AI 策划配置缺失', 'error')
      return
    }
    if (plannerProfileValidation) {
      setPlannerError(`AI 策划配置「${plannerProfile.name}」不完整：${plannerProfileValidation}`)
      showToast('AI 策划配置不完整', 'error')
      return
    }

    const controller = new AbortController()
    plannerAbortControllerRef.current = controller
    setIsPlanning(true)
    setPlanningEtsyShotGroup(plannerMode === 'etsy' ? etsyShotGroup ?? null : null)
    setEtsyPlanningProgress('')
    setPlannerError('')
    try {
      const currentMarketplaceId = marketplaceId
      const referencePayload = await prepareReferencePayloadForRequest(inputImages.map((image) => image.dataUrl), controller.signal)
      const result = await callAmazonPlannerApi({
        listingText,
        baseDraft: draft,
        profile: plannerProfile,
        referenceImageDataUrls: referencePayload.dataUrls,
        mode: plannerMode,
        marketplaceId: currentMarketplaceId,
        listingImageCount,
        aPlusType,
        aPlusModuleSpecs: aPlusSpecs,
        aPlusGenerationTier: resolutionTier,
        etsyShotGroup: plannerMode === 'etsy' ? etsyShotGroup : undefined,
        etsyCampaignContext: plannerMode === 'etsy' && etsyShotGroup && canContinueEtsyCampaign && imagePlans.length && etsyVisualDna && etsyPhotographyAnalysis
          ? { visualDna: etsyVisualDna, photographyAnalysis: etsyPhotographyAnalysis, plans: imagePlans }
          : undefined,
        signal: controller.signal,
        onProgress: plannerMode === 'etsy' && etsyShotGroup === 'original'
          ? (message) => { if (!controller.signal.aborted) setEtsyPlanningProgress(message) }
          : undefined,
      })
      if (controller.signal.aborted) return
      applyPlannerResult(result, plannerMode === 'etsy'
        ? etsyShotGroup === 'additional' ? 'Etsy新增5张策划' : etsyShotGroup === 'original' ? 'Etsy原10张策划' : 'Etsy专属策划'
        : plannerMode === 'aplus' ? 'A+ AI 策划' : 'AI 策划')
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return
      setPlannerError(getPlannerFailureDetail(err, plannerMode === 'etsy'))
      showToast('AI 策划失败，请查看详情', 'error')
    } finally {
      if (plannerAbortControllerRef.current === controller) {
        plannerAbortControllerRef.current = null
        setIsPlanning(false)
        setPlanningEtsyShotGroup(null)
        setEtsyPlanningProgress('')
      }
    }
  }

  const stopAiPlan = () => {
    const controller = plannerAbortControllerRef.current
    if (!controller) return
    controller.abort()
    plannerAbortControllerRef.current = null
    setIsPlanning(false)
    setPlanningEtsyShotGroup(null)
    setEtsyPlanningProgress('')
    showToast('AI 策划已停止', 'info')
  }

  const createEtsyListingDetails = async () => {
    if (plannerAbortControllerRef.current || etsyListingAbortControllerRef.current) {
      showToast('已有 AI 任务正在进行中', 'info')
      return
    }
    if (!listingText.trim()) {
      showToast('请先填写产品描述、材质、尺寸和用途', 'error')
      return
    }
    if (!plannerProfile) {
      setEtsyListingError('未选择支持 Chat Completions 或 Responses API 的 AI 策划配置。请先在设置 -> API 中选择策划配置。')
      showToast('AI 策划配置缺失', 'error')
      return
    }
    if (plannerProfileValidation) {
      setEtsyListingError(`AI 策划配置「${plannerProfile.name}」不完整：${plannerProfileValidation}`)
      showToast('AI 策划配置不完整', 'error')
      return
    }

    const controller = new AbortController()
    etsyListingAbortControllerRef.current = controller
    setIsGeneratingEtsyListing(true)
    setEtsyListingError('')
    try {
      const referencePayload = await prepareReferencePayloadForRequest(inputImages.map((image) => image.dataUrl), controller.signal)
      const result = await callEtsyListingDetailsApi({
        listingText,
        baseDraft: draft,
        profile: plannerProfile,
        referenceImageDataUrls: referencePayload.dataUrls,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setEtsyListingDetails(result.details)
      await savePlannerSession({
        mode: 'etsy-listing',
        etsyVisualDna: null,
        etsyPhotographyAnalysis: null,
        etsyListingDetails: result.details,
        seriesStyleGuides: { listing: '', aplus: '', etsy: '' },
        selectedStylePresetId: null,
        selectedStyleReferenceImageId: null,
        selectedCustomStyleReferenceId: null,
        selectedCustomStyleReferenceSnapshot: null,
        imagePlans: [],
        aPlusPlans: [],
        selectedPlanIndex: null,
        selectedAPlusPlanIndex: null,
      })
      showToast(result.webResearchUsed ? 'Etsy Listing 详情已生成并完成联网验证' : 'Etsy Listing 详情已生成；当前接口未完成联网验证', result.webResearchUsed ? 'success' : 'info')
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return
      setEtsyListingError(getPlannerFailureDetail(err))
      showToast('Etsy Listing 详情生成失败，请查看详情', 'error')
    } finally {
      if (etsyListingAbortControllerRef.current === controller) {
        etsyListingAbortControllerRef.current = null
        setIsGeneratingEtsyListing(false)
      }
    }
  }

  const stopEtsyListingDetails = () => {
    const controller = etsyListingAbortControllerRef.current
    if (!controller) return
    controller.abort()
    etsyListingAbortControllerRef.current = null
    setIsGeneratingEtsyListing(false)
    showToast('Etsy Listing 详情生成已停止', 'info')
  }

  const copyEtsyListingDetails = async () => {
    if (!etsyListingMarkdown) return
    try {
      await navigator.clipboard.writeText(etsyListingMarkdown)
      showToast('Etsy Listing 详情已复制', 'success')
    } catch {
      showToast('复制 Etsy Listing 详情失败', 'error')
    }
  }

  const changeStyleDensityMode = (mode: AmazonStyleDensityMode) => {
    setStyleDensityMode(mode)
    updateCurrentPlannerSession({ styleDensityMode: mode })
  }

  const selectPlan = (index: number) => {
    const plan = imagePlans[index]
    setSelectedPlanIndex(plan ? index : null)
    if (plan) {
      setDraft((current) => plan.kind ? { ...current, kind: plan.kind } : current)
    }
    updateCurrentPlannerSession({
      selectedPlanIndex: plan ? index : null,
      draft: toSessionDraft(plan?.kind ? { ...draft, kind: plan.kind } : draft),
    })
  }

  const selectAPlusPlan = (index: number) => {
    const plan = aPlusPlansWithSizes[index]
    setSelectedAPlusPlanIndex(plan ? index : null)
    updateCurrentPlannerSession({
      selectedAPlusPlanIndex: plan ? index : null,
    })
  }

  const selectVisiblePlan = (index: number) => {
    if (plannerMode === 'aplus') selectAPlusPlan(index)
    else selectPlan(index)
  }

  const stepVisiblePlan = (direction: -1 | 1) => {
    if (visiblePlanCount === 0 || visiblePlanIndex == null) return
    const nextIndex = Math.min(visiblePlanCount - 1, Math.max(0, visiblePlanIndex + direction))
    if (nextIndex !== visiblePlanIndex) selectVisiblePlan(nextIndex)
  }

  const changePlannerMode = (mode: AmazonPlannerMode) => {
    if (mode === plannerMode) return
    if (mode === 'etsy' || plannerMode === 'etsy') {
      setImagePlans([])
      setSelectedPlanIndex(null)
      setEtsyVisualDna(null)
      setEtsyPhotographyAnalysis(null)
    }
    setPlannerMode(mode)
    setStylePreview(null)
    setStyleError('')
    setActionProgress({})
  }

  const changeWorkspaceMode = (mode: PlannerWorkspaceMode) => {
    if (mode === workspaceMode) return
    if (mode === 'etsy-listing') {
      if (plannerMode !== 'etsy') changePlannerMode('etsy')
      setEtsyListingStandalone(true)
    } else {
      setEtsyListingStandalone(false)
      changePlannerMode(mode)
    }
    setPlannerError('')
    setEtsyListingError('')
    setMobileActionDock(null)
  }

  const changeAPlusType = (nextType: APlusContentType) => {
    setAPlusType(nextType)
    if (nextType !== aPlusType) {
      setAPlusPlans([])
      setSelectedAPlusPlanIndex(null)
      setSeriesStyleGuides((current) => ({ ...current, aplus: '' }))
      setSelectedStylePresetId(DEFAULT_STYLE_PRESET_ID)
      setSelectedStyleReference(null)
      setStylePreview(null)
      setStyleError('')
      setActionProgress({})
    }
  }

  const changeMarketplaceId = (value: string) => {
    const nextMarketplaceId = normalizeAmazonMarketplaceId(value)
    if (nextMarketplaceId === marketplaceId) return
    const clearedStyleGuides = { listing: '', aplus: '', etsy: '' }
    setMarketplaceId(nextMarketplaceId)
    setImagePlans([])
    setAPlusPlans([])
    setEtsyVisualDna(null)
    setEtsyPhotographyAnalysis(null)
    setEtsyListingDetails(null)
    setEtsyListingError('')
    setSeriesStyleGuides(clearedStyleGuides)
    setSelectedPlanIndex(null)
    setSelectedAPlusPlanIndex(null)
    setPlannerError('')
    setActionProgress({})
    updateCurrentPlannerSession({
      marketplaceId: nextMarketplaceId,
      seriesStyleGuides: clearedStyleGuides,
      etsyVisualDna: null,
      etsyPhotographyAnalysis: null,
      etsyListingDetails: null,
      imagePlans: [],
      aPlusPlans: [],
      selectedPlanIndex: null,
      selectedAPlusPlanIndex: null,
    })
  }

  const changeListingImageCount = (value: string) => {
    const nextCount = normalizeListingImageCount(value)
    setListingImageCount(nextCount)
    updateCurrentPlannerSession({ listingImageCount: nextCount })
  }

  const saveAPlusModuleSpecsByType = (nextSpecsByType: APlusModuleSpecsByType) => {
    const sessionSpecs = getAPlusModuleSpecsForSession(nextSpecsByType)
    updateCurrentPlannerSession({ aPlusModuleSpecs: sessionSpecs })
  }

  const updateCurrentAPlusModuleSpecs = (nextSpecs: AmazonAPlusModuleSpec[]) => {
    const normalizedSpecs = normalizeAPlusModuleSpecs(aPlusType, nextSpecs)
    const next = { ...aPlusModuleSpecsByType }
    if (areAPlusModuleSpecsEquivalent(normalizedSpecs, getAPlusModuleSpecs(aPlusType))) {
      delete next[aPlusType]
    } else {
      next[aPlusType] = normalizedSpecs
    }
    setAPlusModuleSpecsByType(next)
    saveAPlusModuleSpecsByType(next)
  }

  const addAPlusModuleAfter = (index: number) => {
    if (isPlanning || aPlusPlans.length > 0 || aPlusSpecs.length >= MAX_A_PLUS_MODULE_COUNT) return
    updateCurrentAPlusModuleSpecs(insertAPlusModuleSpecAfter(aPlusType, aPlusSpecs, index))
  }

  const removeAPlusModuleAt = (index: number) => {
    if (isPlanning || aPlusPlans.length > 0 || aPlusSpecs.length <= MIN_A_PLUS_MODULE_COUNT) return
    updateCurrentAPlusModuleSpecs(removeAPlusModuleSpecAt(aPlusType, aPlusSpecs, index))
  }

  const restoreDefaultAPlusModules = () => {
    if (isPlanning || aPlusPlans.length > 0 || aPlusSpecsAreDefault) return
    const next = { ...aPlusModuleSpecsByType }
    delete next[aPlusType]
    setAPlusModuleSpecsByType(next)
    saveAPlusModuleSpecsByType(next)
  }

  const clearListingPlan = () => {
    clearEtsyOriginalPlannerCheckpoint()
    setEtsyPlanningProgress('')
    setListingText('')
    setMarketplaceId(DEFAULT_AMAZON_MARKETPLACE_ID)
    setListingImageCount(DEFAULT_LISTING_IMAGE_COUNT)
    setAPlusModuleSpecsByType({})
    setImagePlans([])
    setAPlusPlans([])
    setSeriesStyleGuides({ listing: '', aplus: '', etsy: '' })
    setEtsyVisualDna(null)
    setEtsyPhotographyAnalysis(null)
    setEtsyListingDetails(null)
    setSelectedStylePresetId(DEFAULT_STYLE_PRESET_ID)
    setSelectedStyleReference(null)
    setStyleDensityMode('rich')
    setStylePreview(null)
    setStyleError('')
    setSelectedPlanIndex(null)
    setSelectedAPlusPlanIndex(null)
    setPlannerError('')
    setEtsyListingError('')
    setCurrentPlannerSessionId(null)
    setActionProgress({})
  }

  const restorePlannerSession = async (session: AmazonPlannerSession) => {
    const isEtsyListingSession = session.mode === 'etsy-listing'
    const restoredReferences = []
    for (const imageId of session.referenceImageIds) {
      const dataUrl = await ensureImageCached(imageId)
      if (dataUrl) restoredReferences.push({ id: imageId, dataUrl })
    }

    const nextStylePresetId = getStylePresetById(session.selectedStylePresetId)
      ? session.selectedStylePresetId!
      : DEFAULT_STYLE_PRESET_ID
    let restoredStyleReference: SelectedStyleReference | null = null
    let restoredCustomStyleReference: CustomStyleReference | null = null
    let restoredStyleError = ''

    const sessionCustomStyle = session.selectedCustomStyleReferenceId
      ? customStyleReferences.find((style) => style.id === session.selectedCustomStyleReferenceId) ?? session.selectedCustomStyleReferenceSnapshot ?? null
      : session.selectedCustomStyleReferenceSnapshot ?? null
    if (sessionCustomStyle) {
      try {
        let customStyle = sessionCustomStyle
        let dataUrl = customStyle.imageId ? await ensureImageCached(customStyle.imageId) : ''
        if (!dataUrl) {
          const rendered = await ensureCustomStyleReferenceImageStored(customStyle.editState)
          customStyle = {
            ...customStyle,
            editState: rendered.editState,
            imageId: rendered.imageId,
            updatedAt: Date.now(),
          }
          dataUrl = rendered.dataUrl
          if (customStyleReferences.some((style) => style.id === customStyle.id)) {
            setSettings({
              customStyleReferences: customStyleReferences.map((style) =>
                style.id === customStyle.id ? customStyle : style,
              ),
            })
          }
        }
        const meta = getCustomStyleReferenceVisualMeta(customStyle)
        restoredCustomStyleReference = customStyle
        restoredStyleReference = {
          presetId: customStyle.basePresetId ?? null,
          customStyleReferenceId: customStyle.id,
          imageId: customStyle.imageId,
          dataUrl,
          label: meta.label,
          description: meta.description,
          palette: meta.palette,
        }
      } catch (err) {
        restoredStyleError = `历史中的自定义风格恢复失败：${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (!restoredStyleReference && session.selectedStyleReferenceImageId) {
      const dataUrl = await ensureImageCached(session.selectedStyleReferenceImageId)
      if (dataUrl) {
        const preset = getStylePresetById(nextStylePresetId)
        restoredStyleReference = {
          presetId: preset?.id ?? null,
          customStyleReferenceId: null,
          imageId: session.selectedStyleReferenceImageId,
          dataUrl,
          label: preset?.label ?? '历史风格',
          description: preset?.description ?? '从策划历史恢复的隐藏风格参考。',
          palette: preset?.palette ?? [],
        }
      }
    }

    if (!restoredStyleReference && session.selectedStyleIndex != null) {
      const legacyStyle = session.styleImages.find((image) => image.candidateIndex === session.selectedStyleIndex)
      if (legacyStyle?.imageId) {
        const dataUrl = await ensureImageCached(legacyStyle.imageId)
        if (dataUrl) {
          const legacyCandidate = session.styleCandidates[session.selectedStyleIndex]
          restoredStyleReference = {
            presetId: null,
            customStyleReferenceId: null,
            imageId: legacyStyle.imageId,
            dataUrl,
            label: legacyCandidate?.label || '历史风格板',
            description: legacyCandidate?.description || '从旧版策划历史恢复的隐藏风格参考。',
            palette: [],
          }
        } else {
          restoredStyleError = '历史中的风格板图片不存在，已切换为默认风格参考。'
        }
      }
    }

    if (!isEtsyListingSession && !restoredStyleReference && nextStylePresetId) {
      try {
        const result = await ensureStylePresetImageStored(nextStylePresetId)
        restoredStyleReference = {
          presetId: nextStylePresetId,
          customStyleReferenceId: null,
          imageId: result.imageId,
          dataUrl: result.dataUrl,
          label: result.preset.label,
          description: result.preset.description,
          palette: result.preset.palette,
        }
      } catch (err) {
        restoredStyleError = err instanceof Error ? err.message : String(err)
      }
    }

    const restoredAPlusModuleSpecsByType = getSessionAPlusModuleSpecsByType(session)
    const restoredMarketplaceId = getSessionMarketplaceId(session)
    setPlannerMode(session.mode === 'etsy-listing' ? 'etsy' : session.mode)
    setEtsyListingStandalone(session.mode === 'etsy-listing')
    setMarketplaceId(restoredMarketplaceId)
    setAPlusType(session.aPlusType)
    setResolution(session.resolution)
    setListingImageCount(getSessionListingImageCount(session))
    setAPlusModuleSpecsByType(restoredAPlusModuleSpecsByType)
    setListingText(session.listingText)
    setInputImages(restoredReferences)
    setDraft(fromSessionDraft(session.draft))
    setSeriesStyleGuides({ ...session.seriesStyleGuides, etsy: session.seriesStyleGuides.etsy ?? '' })
    setEtsyVisualDna(session.etsyVisualDna ?? null)
    setEtsyPhotographyAnalysis(session.etsyPhotographyAnalysis ?? null)
    setEtsyListingDetails(session.etsyListingDetails ?? null)
    setSelectedStylePresetId(isEtsyListingSession ? null : restoredStyleReference ? restoredStyleReference.presetId : nextStylePresetId)
    setSelectedStyleReference(isEtsyListingSession ? null : restoredStyleReference)
    setStyleDensityMode(restoredCustomStyleReference?.editState.density ?? session.styleDensityMode ?? 'rich')
    setStylePreview(null)
    setImagePlans(session.imagePlans as AmazonImagePlan[])
    setAPlusPlans(session.aPlusPlans as AmazonAPlusPlan[])
    setSelectedPlanIndex(session.selectedPlanIndex != null && session.imagePlans[session.selectedPlanIndex] ? session.selectedPlanIndex : null)
    setSelectedAPlusPlanIndex(session.selectedAPlusPlanIndex != null && session.aPlusPlans[session.selectedAPlusPlanIndex] ? session.selectedAPlusPlanIndex : null)
    setPlannerError('')
    setEtsyListingError('')
    setStyleError(restoredStyleError)
    setCurrentPlannerSessionId(session.id)
    etsyCampaignInputKeyRef.current = session.mode === 'etsy'
      ? getEtsyCampaignInputKey(session.listingText, fromSessionDraft(session.draft), session.referenceImageIds)
      : null
    setShowPlannerHistory(false)
    setActionProgress({})
    const restoredSession = {
      ...session,
      marketplaceId: restoredMarketplaceId,
      listingImageCount: getSessionListingImageCount(session),
      aPlusModuleSpecs: getAPlusModuleSpecsForSession(restoredAPlusModuleSpecsByType),
      selectedStylePresetId: isEtsyListingSession ? null : restoredStyleReference ? restoredStyleReference.presetId : nextStylePresetId,
      selectedStyleReferenceImageId: isEtsyListingSession ? null : restoredStyleReference?.imageId ?? null,
      selectedCustomStyleReferenceId: isEtsyListingSession ? null : restoredCustomStyleReference?.id ?? null,
      selectedCustomStyleReferenceSnapshot: isEtsyListingSession ? null : restoredCustomStyleReference,
      styleDensityMode: restoredCustomStyleReference?.editState.density ?? session.styleDensityMode ?? 'rich',
      updatedAt: Date.now(),
    }
    void putAmazonPlannerSession(restoredSession)
      .then(() => upsertPlannerSessionList(restoredSession))
      .catch((err) => {
        showToast(`策划历史保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    showToast('策划历史已恢复', 'success')
  }

  const removePlannerSession = async (sessionId: string) => {
    try {
      await deleteAmazonPlannerSession(sessionId)
      setPlannerSessions((current) => current.filter((session) => session.id !== sessionId))
      if (currentPlannerSessionId === sessionId) setCurrentPlannerSessionId(null)
      showToast('策划历史已删除', 'success')
    } catch (err) {
      showToast(`策划历史删除失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const copyPlannerError = async () => {
    try {
      await navigator.clipboard.writeText(plannerError)
      showToast('错误详情已复制', 'success')
    } catch {
      showToast('复制错误详情失败', 'error')
    }
  }

  const handleFiles = async (files: FileList | File[]) => {
    const accepted = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (accepted.length === 0) {
      showToast('请选择图片文件', 'error')
      return
    }

    const currentCount = useStore.getState().inputImages.length
    if (currentCount >= API_MAX_IMAGES) {
      showToast(`参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`, 'error')
      return
    }

    const remaining = API_MAX_IMAGES - currentCount
    const toAdd = accepted.slice(0, remaining)
    const discarded = accepted.length - toAdd.length

    try {
      for (const file of toAdd) {
        await addImageFromFile(file)
      }

      const added = useStore.getState().inputImages.length - currentCount
      updateCurrentPlannerSession({
        referenceImageIds: useStore.getState().inputImages.map((image) => image.id),
      })
      if (discarded > 0) {
        showToast(
          added > 0
            ? `已上传 ${added} 张参考图，已达上限 ${API_MAX_IMAGES} 张，${discarded} 张被丢弃`
            : `已达上限 ${API_MAX_IMAGES} 张，${discarded} 张图片被丢弃`,
          added > 0 ? 'success' : 'error',
        )
        return
      }

      showToast(added > 0 ? `已上传 ${added} 张参考图` : '参考图已存在', added > 0 ? 'success' : 'info')
    } catch (err) {
      showToast(`参考图上传失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    await handleFiles(event.target.files || [])
    event.target.value = ''
  }

  return (
    <>
    {styleEditor && (
      <Suspense fallback={null}>
        <StyleReferenceEditorModal
          title={styleEditor.title}
          initialState={styleEditor.initialState}
          saving={isSavingStyleEditor}
          onClose={() => setStyleEditor(null)}
          onSave={(state) => void saveStyleEditor(state)}
        />
      </Suspense>
    )}
    <section data-no-drag-select className="ios-surface mt-6 overflow-hidden">
      <div className="border-b border-[hsl(var(--separator))] px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-gray-900 dark:text-gray-50">CZH图片工作台</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>OpenAI gpt-image-2</span>
              <span className="h-1 w-1 rounded-full bg-gray-300 dark:bg-gray-600" />
              <span>2K / 4K</span>
              <span className="h-1 w-1 rounded-full bg-gray-300 dark:bg-gray-600" />
              <span>Amazon 图片与 Etsy 运营工作台</span>
            </div>
            <div className="ios-segmented mt-3">
              {([
                ['listing', 'Listing 图'],
                ['aplus', 'A+ 图'],
                ['etsy', 'Etsy 图'],
                ['etsy-listing', 'Etsy Listing详情'],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => changeWorkspaceMode(mode)}
                  data-active={workspaceMode === mode}
                  className={`ios-segment h-8 px-3 text-sm font-medium ${workspaceMode === mode ? 'text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {plannerMode !== 'etsy' && <label className="inline-flex h-10 items-center gap-2 rounded-[var(--ios-radius-md)] bg-[hsl(var(--muted))] px-3 text-sm font-medium text-gray-600 dark:text-gray-300">
              <span className="text-xs text-gray-400 dark:text-gray-500">目标站点</span>
              <select
                value={marketplaceId}
                onChange={(event) => changeMarketplaceId(event.target.value)}
                className="h-7 bg-transparent px-2 text-sm font-semibold text-gray-900 dark:text-gray-100"
              >
                {AMAZON_MARKETPLACES.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>}
            {plannerMode === 'listing' && (
              <label className="inline-flex h-10 items-center gap-2 rounded-[var(--ios-radius-md)] bg-[hsl(var(--muted))] px-3 text-sm font-medium text-gray-600 dark:text-gray-300">
                <span className="text-xs text-gray-400 dark:text-gray-500">图片数</span>
                <select
                  value={listingImageCount}
                  onChange={(event) => changeListingImageCount(event.target.value)}
                  className="h-7 bg-transparent px-2 text-sm font-semibold text-gray-900 dark:text-gray-100"
                >
                  {LISTING_IMAGE_COUNT_OPTIONS.map((count) => (
                    <option key={count} value={count}>{count} 张</option>
                  ))}
                </select>
              </label>
            )}
            {isEtsyImageMode && (
              <div className="inline-flex h-10 items-center gap-2 rounded-[var(--ios-radius-md)] bg-[hsl(var(--muted))] px-3 text-sm font-medium text-gray-600 dark:text-gray-300">
                <span className="text-xs text-gray-400 dark:text-gray-500">镜头数</span>
                <span className="font-semibold text-gray-900 dark:text-gray-100">{ETSY_SHOT_COUNT} 张</span>
              </div>
            )}
            {!isEtsyListingMode && <div className="ios-segmented">
              {(['2k', '4k'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setResolution(item)}
                  data-active={resolution === item}
                  className={`ios-segment h-8 min-w-14 px-3 text-sm font-medium ${resolution === item ? 'text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
                >
                  {item.toUpperCase()}
                </button>
              ))}
            </div>}
            <button
              type="button"
              onClick={() => setShowPlannerHistory((value) => !value)}
              className={`ios-button inline-flex h-10 items-center gap-2 px-3 text-sm font-medium ${showPlannerHistory ? 'ios-button-tinted' : 'bg-[hsl(var(--muted))] text-gray-700 dark:text-gray-200'}`}
            >
              <HistoryIcon className="h-4 w-4" />
              策划历史
              {plannerSessions.length > 0 && (
                <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-white/[0.08] dark:text-gray-300">
                  {plannerSessions.length}
                </span>
              )}
            </button>
          </div>
        </div>
        {showPlannerHistory && (
          <div className="ios-material mt-4 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">策划历史</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  保存在当前浏览器中；Etsy 图片策划和 Etsy Listing详情会作为不同类型分别保存与恢复。
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPlannerHistory(false)}
                className="rounded-lg px-2 py-1 text-xs font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              >
                收起
              </button>
            </div>
            {plannerSessions.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {plannerSessions.map((session) => (
                  <div key={session.id} className="ios-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{session.title}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                          <span>{session.mode === 'etsy-listing' ? 'Etsy Listing详情' : session.mode === 'etsy' ? 'Etsy 图' : session.mode === 'aplus' ? 'A+ 图' : 'Listing 图'}</span>
                          {session.mode !== 'etsy' && session.mode !== 'etsy-listing' && (
                            <>
                              <span>·</span>
                              <span>{getAmazonMarketplaceLabel(getSessionMarketplaceId(session))}</span>
                            </>
                          )}
                          <span>·</span>
                          <span>{getPlannerSessionResultLabel(session)}</span>
                          <span>·</span>
                          <span>{formatPlannerSessionTime(session.updatedAt)}</span>
                        </div>
                      </div>
                      {currentPlannerSessionId === session.id && (
                        <span className="shrink-0 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">当前</span>
                      )}
                    </div>
                    <div className="mt-2 line-clamp-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                      {session.listingText || session.draft.sellingPoints || '无 Listing 文本'}
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void restorePlannerSession(session).catch((err) => {
                            showToast(`策划历史恢复失败：${err instanceof Error ? err.message : String(err)}`, 'error')
                          })
                        }}
                        className="inline-flex h-8 items-center rounded-lg bg-gray-900 px-3 text-xs font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200"
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        onClick={() => void removePlannerSession(session.id)}
                        className="inline-flex h-8 items-center rounded-lg px-2 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-400/10"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-200 bg-white px-3 py-4 text-center text-xs text-gray-500 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-400">
                暂无策划历史。AI 策划成功后会自动保存。
              </div>
            )}
          </div>
        )}
      </div>

      <div className={`grid gap-0 ${isEtsyListingMode ? 'lg:grid-cols-1' : 'lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]'}`}>
        <div className={`border-b border-[hsl(var(--separator))] p-4 sm:p-5 lg:border-b-0 ${isEtsyListingMode ? '' : 'lg:border-r lg:border-[hsl(var(--separator))]'}`}>
          <div className={`ios-group p-4 ${getGuidePanelClass(plannerGuideActive)}`}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                  {isEtsyListingMode ? 'Etsy Listing 详情专家' : isEtsyImageMode ? 'Etsy 自适应艺术总监' : plannerMode === 'aplus' ? 'A+ 图片策划' : 'Listing 智能策划'}
                </div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {isEtsyListingMode
                    ? '独立生成 Etsy 双语品类、SEO标题、高转化详情和13个Tags；不调用生图流程。'
                    : isEtsyImageMode
                    ? `先锁定产品 Visual DNA，再动态策划 ${ETSY_SHOT_COUNT} 个专属镜头；每张提示词都重复材质、颜色和纹理，防止 AI 重设计。`
                    : plannerMode === 'aplus'
                      ? `面向${marketplace.label}，生成普通A+ / 标准A+ / 高级A+ / 手机A+模块编排、英文生图提示词和${marketplace.copyLanguage}文案。`
                      : `面向${marketplace.label}，生成 ${listingSlotRange} 的逐张方案、英文生图提示词和${marketplace.copyLanguage}图片文案。`}
                </div>
              </div>
              <div className="rounded-lg bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                {isEtsyListingMode ? '独立文案' : '双配置'}
              </div>
            </div>
            {plannerGuideActive && (
              <div className={`${GUIDE_HINT_CLASS} mt-3`}>
                {guideState.message}
              </div>
            )}
            {plannerMode === 'aplus' && (
              <div className="ios-segmented mt-3">
                {([
                  ['standard-large', '普通A+'],
                  ['standard', '标准A+'],
                  ['premium', '高级A+'],
                  ['mobile', '手机A+'],
                ] as const).map(([type, label]) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => changeAPlusType(type)}
                    data-active={aPlusType === type}
                    className={`ios-segment h-8 px-3 text-sm font-medium ${aPlusType === type ? 'text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <label className={`mt-3 block rounded-xl transition ${getGuideFocusClass(guideState.target === 'planner-input')}`}>
              <span className={LABEL_CLASS}>{isEtsyListingMode ? 'Etsy Listing 产品资料 / 规格 / 用途 / 目标买家' : isEtsyImageMode ? '产品描述 / 材质工艺 / 尺寸 / 目标买家' : plannerMode === 'aplus' ? '标题 / 五点描述 / 品牌说明' : '标题 / 五点描述'}</span>
              <textarea
                value={listingText}
                onChange={(event) => setListingText(event.target.value)}
                className={`${FIELD_CLASS} min-h-[138px] resize-y`}
                placeholder={isEtsyListingMode
                  ? 'Product name: ...\nProduct type / function: ...\nMaterial / finish: ...\nColor: ...\nDimensions / options: ...\nWhat is included: ...\nTarget buyer / use case: ...\nVerified craftsmanship: ...\nFacts that need confirmation: ...'
                  : isEtsyImageMode
                  ? 'Product name: ...\nMaterial / texture: ...\nReal color / finish: ...\nDimensions / construction: ...\nUse case / target Etsy buyer: ...\nDo not change: ...'
                  : plannerMode === 'aplus'
                    ? 'Title: ...\n\nAbout this item\n- Bullet 1...\n- Bullet 2...\n\nBrand story / tone: ...'
                    : 'Title: ...\n\nAbout this item\n- Bullet 1...\n- Bullet 2...\n- Bullet 3...\n- Bullet 4...\n- Bullet 5...'}
              />
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className={`rounded-[var(--ios-radius-md)] px-3 py-2 ${guideState.target === 'planner-api' ? 'bg-[hsl(var(--ios-blue-tint))] text-[hsl(var(--primary))] ring-2 ring-[hsl(var(--primary)/0.18)]' : plannerProfile && !plannerProfileValidation ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200' : 'bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200'}`}>
                <div className="text-xs font-semibold">AI 策划配置</div>
                <div className="mt-1 text-xs leading-relaxed">
                  {plannerProfile ? `${plannerProfile.name} · ${plannerProfile.model} · ${plannerApiLabel}` : '未配置，请在设置中选择一个 Chat Completions 策划配置'}
                  {plannerProfileValidation ? `（${plannerProfileValidation}）` : ''}
                </div>
              </div>
              <div className={`flex flex-wrap items-center gap-2 rounded-xl transition sm:justify-end ${getGuideFocusClass(guideState.target === 'planner-action')}`}>
                {!isEtsyListingMode && (isEtsyImageMode ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void createAiPlan('original')}
                      disabled={isPlanning || isGeneratingEtsyListing || Boolean(plannerProfileValidation)}
                      className={`ios-button h-10 px-3 text-sm font-semibold ${isPlanning && planningEtsyShotGroup === 'original' ? 'cursor-wait bg-gray-400 text-white' : isPlanning || isGeneratingEtsyListing || plannerProfileValidation ? 'cursor-not-allowed bg-gray-300 text-white dark:bg-white/[0.12]' : 'ios-button-filled'} ${guideState.target === 'planner-action' ? 'ring-2 ring-[hsl(var(--primary)/0.25)] ring-offset-2 ring-offset-white dark:ring-offset-gray-950' : ''}`}
                    >
                      {isPlanning && planningEtsyShotGroup === 'original' ? '策划中...' : `原有${ETSY_ORIGINAL_SHOT_COUNT}张`}
                    </button>
                    <button
                      type="button"
                      onClick={() => void createAiPlan('additional')}
                      disabled={isPlanning || isGeneratingEtsyListing || Boolean(plannerProfileValidation)}
                      className={`ios-button h-10 px-3 text-sm font-semibold ${isPlanning && planningEtsyShotGroup === 'additional' ? 'cursor-wait bg-gray-400 text-white' : isPlanning || isGeneratingEtsyListing || plannerProfileValidation ? 'cursor-not-allowed bg-gray-300 text-white dark:bg-white/[0.12]' : 'ios-button-plain'}`}
                    >
                      {isPlanning && planningEtsyShotGroup === 'additional' ? '策划中...' : `新增${ETSY_SHOT_COUNT - ETSY_ORIGINAL_SHOT_COUNT}张`}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void createAiPlan()}
                    disabled={isPlanning || isGeneratingEtsyListing || Boolean(plannerProfileValidation)}
                    className={`ios-button h-10 px-4 text-sm font-semibold ${isPlanning ? 'cursor-wait bg-gray-400 text-white' : isGeneratingEtsyListing || plannerProfileValidation ? 'cursor-not-allowed bg-gray-300 text-white dark:bg-white/[0.12]' : 'ios-button-filled'} ${guideState.target === 'planner-action' ? 'ring-2 ring-[hsl(var(--primary)/0.25)] ring-offset-2 ring-offset-white dark:ring-offset-gray-950' : ''}`}
                  >
                    {isPlanning ? '策划中...' : plannerMode === 'aplus' ? 'AI策划A+' : 'AI策划'}
                  </button>
                ))}
                {isEtsyListingMode && (
                  <button
                    type="button"
                    onClick={createEtsyListingDetails}
                    disabled={isPlanning || isGeneratingEtsyListing || Boolean(plannerProfileValidation)}
                    className={`ios-button h-10 px-4 text-sm font-semibold ${isGeneratingEtsyListing ? 'cursor-wait bg-violet-400 text-white' : isPlanning || plannerProfileValidation ? 'cursor-not-allowed bg-gray-300 text-white dark:bg-white/[0.12]' : 'bg-violet-600 text-white hover:bg-violet-500'}`}
                  >
                    {isGeneratingEtsyListing ? '生成详情中...' : etsyListingDetails ? '重新生成Listing详情' : '生成Listing详情'}
                  </button>
                )}
                {isPlanning && (
                  <button
                    type="button"
                    onClick={stopAiPlan}
                    className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 text-sm font-semibold text-red-600 transition hover:bg-red-50 dark:border-red-400/20 dark:bg-gray-900 dark:text-red-300 dark:hover:bg-red-400/10"
                  >
                    <CloseIcon className="h-4 w-4" />
                    停止
                  </button>
                )}
                {isGeneratingEtsyListing && (
                  <button
                    type="button"
                    onClick={stopEtsyListingDetails}
                    className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 text-sm font-semibold text-red-600 transition hover:bg-red-50 dark:border-red-400/20 dark:bg-gray-900 dark:text-red-300 dark:hover:bg-red-400/10"
                  >
                    <CloseIcon className="h-4 w-4" />
                    停止
                  </button>
                )}
                {(listingText.trim() || imagePlans.length > 0 || aPlusPlans.length > 0 || etsyListingDetails) && (
                  <button
                    type="button"
                    onClick={clearListingPlan}
                    className="inline-flex h-10 items-center rounded-xl px-3 text-sm font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                  >
                    清空
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowSettings(true, 'api')}
                  className="ios-button ios-button-plain h-10 px-3 text-sm font-medium"
                >
                  设置
                </button>
              </div>
            </div>
            <div className="mt-3 rounded-[var(--ios-radius-md)] bg-[hsl(var(--ios-blue-tint))] px-3 py-2 text-xs leading-relaxed text-[hsl(var(--primary))]">
              {isEtsyListingMode
                ? '此页面只生成 Etsy Listing 文案，不生成图片。联网能力可用时会验证当前关键词与市场术语；不可用时会明确标注。'
                 : isEtsyImageMode
                     ? '原有10张与新增5张分别策划、分别显示；点击哪个按钮就只处理对应镜头。Phase 2 点击提交生成时才调用生图配置。'
                  : 'AI策划使用设置中的策划配置，生图配置保持不变。'}
            </div>
            {isEtsyImageMode && isPlanning && planningEtsyShotGroup === 'original' && etsyPlanningProgress && (
              <div role="status" aria-live="polite" className="mt-2 text-xs leading-relaxed text-[hsl(var(--primary))]">
                {etsyPlanningProgress}
              </div>
            )}
            {plannerUsesOfficialDeepSeek && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100">
                {isEtsyListingMode ? DEEPSEEK_ETSY_LISTING_NOTICE : DEEPSEEK_PLANNER_NOTICE}
              </div>
            )}
            {!isEtsyListingMode && plannerError && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-semibold">AI 策划失败详情</span>
                  <button
                    type="button"
                    onClick={copyPlannerError}
                    className="rounded-md px-2 py-1 text-[11px] font-medium text-red-700 transition hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-400/10"
                  >
                    复制错误
                  </button>
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{plannerError}</pre>
              </div>
            )}
            {isEtsyListingMode && etsyListingError && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
                <div className="font-semibold">Etsy Listing 详情生成失败</div>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{etsyListingError}</pre>
              </div>
            )}
          </div>

          {isEtsyListingMode && etsyListingDetails && (
            <div className="ios-group mt-5 overflow-hidden p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">Etsy Listing 详情</div>
                    <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${etsyListingDetails.researchStatus === 'web-verified' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200' : 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200'}`}>
                      {etsyListingDetails.researchStatus === 'web-verified' ? '已联网验证' : '未联网验证'}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    英文内容可直接整理发布；中文内容用于核对。发布前请确认所有标注的缺失规格。
                  </div>
                </div>
                <button
                  type="button"
                  onClick={copyEtsyListingDetails}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-700 transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-white/[0.06]"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  复制全部
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
                <div className="rounded-lg bg-gray-100 px-3 py-2 text-gray-600 dark:bg-white/[0.05] dark:text-gray-300">标题 {Array.from(etsyListingDetails.titleEn).length}/140 字符</div>
                <div className="rounded-lg bg-gray-100 px-3 py-2 text-gray-600 dark:bg-white/[0.05] dark:text-gray-300">Tags {etsyListingDetails.tags.length}/13</div>
                <div className="col-span-2 rounded-lg bg-gray-100 px-3 py-2 text-gray-600 sm:col-span-1 dark:bg-white/[0.05] dark:text-gray-300">单个 Tag ≤ 20 字符</div>
              </div>
              <div className="mt-4 max-h-[720px] overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 custom-scrollbar dark:border-white/[0.08] dark:bg-gray-950">
                <MarkdownRenderer content={etsyListingMarkdown} className="text-sm leading-relaxed" />
              </div>
            </div>
          )}

          {isEtsyImageMode && etsyVisualDna && (
            <div className="ios-group mt-5 p-4">
              <div className="mb-3">
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">PART A: VISUAL DNA ANALYSIS</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">以下属性会作为锁定信息重复写入每一张 Etsy 生图提示词。</div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  ['Product Name/Type', etsyVisualDna.productNameType],
                  ['Material & Texture Focus', etsyVisualDna.materialTextureFocus],
                  ['Color Palette & Lighting Mood', etsyVisualDna.colorPaletteLightingMood],
                  ['Brand Aesthetic & Target Audience', etsyVisualDna.brandAestheticTargetAudience],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-[var(--ios-radius-md)] bg-[hsl(var(--muted)/0.72)] px-3 py-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[hsl(var(--primary))]">{label}</div>
                    <div className="mt-1 text-xs leading-relaxed text-gray-700 dark:text-gray-200">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isEtsyImageMode && etsyPhotographyAnalysis && (
            <div className="ios-group mt-5 p-4">
              <div className="mb-3">
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">PART B: AI 摄影自动判断</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">AI 已先分析产品，再为 15 张图分别选择角度、器材、参数、布光与场景。</div>
              </div>
              <dl className="divide-y divide-gray-200 text-xs dark:divide-white/[0.08]">
                {[
                  ['材质与光线', etsyPhotographyAnalysis.materialBehavior],
                  ['形状与尺度', etsyPhotographyAnalysis.formAndScale],
                  ['关键细节', etsyPhotographyAnalysis.criticalDetails],
                  ['功能与交互', etsyPhotographyAnalysis.functionAndInteraction],
                  ['拍摄难点', etsyPhotographyAnalysis.captureChallenges],
                  ['15 图策略', etsyPhotographyAnalysis.campaignStrategy],
                ].map(([label, value]) => (
                  <div key={label} className="grid gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[92px_1fr] sm:gap-3">
                    <dt className="font-semibold text-[hsl(var(--primary))]">{label}</dt>
                    <dd className="leading-relaxed text-gray-700 dark:text-gray-200">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div className="ios-group mt-5 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">参考图</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {inputImages.length > 0
                    ? isEtsyListingMode
                      ? `${inputImages.length}/${API_MAX_IMAGES} 张产品参考图，将用于识别可验证的外观与产品事实`
                      : `${inputImages.length}/${API_MAX_IMAGES} 张产品参考图${usesStyleReferenceForActivePlan ? `；正式生成时另附 1 张隐藏风格参考图（实际 ${effectiveReferenceCount}/${API_MAX_IMAGES}）` : '，将随生成请求一起发送'}`
                    : usesStyleReferenceForActivePlan
                      ? `未上传产品参考图；正式生成时会附 1 张隐藏风格参考图`
                      : isEtsyListingMode ? '建议上传产品实拍、包装或规格参考图，帮助准确撰写详情' : '建议上传产品实拍、包装或结构参考图'}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => !atImageLimit && fileInputRef.current?.click()}
                  disabled={atImageLimit}
                  className={`ios-button h-9 gap-2 px-3 text-sm font-medium ${atImageLimit ? 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-white/[0.04] dark:text-gray-500' : 'bg-[hsl(var(--muted))] text-gray-700 dark:text-gray-200'}`}
                >
                  <PlusIcon className="h-4 w-4" />
                  上传参考图
                </button>
                <button
                  type="button"
                  onClick={() => !atImageLimit && cameraInputRef.current?.click()}
                  disabled={atImageLimit}
                  className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition sm:hidden ${atImageLimit ? 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-white/[0.04] dark:text-gray-500' : 'bg-white text-gray-700 shadow-sm hover:bg-gray-100 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-white/[0.06]'}`}
                >
                  <PhotoIcon className="h-4 w-4" />
                  拍照
                </button>
                {inputImages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      clearInputImages()
                      updateCurrentPlannerSession({ referenceImageIds: [] })
                    }}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-red-200 bg-white px-3 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-400/20 dark:bg-gray-900 dark:text-red-300 dark:hover:bg-red-400/10"
                  >
                    <TrashIcon className="h-4 w-4" />
                    清空
                  </button>
                )}
              </div>
            </div>

            {(isPreparingReferencePayload || referencePayloadNotice) && (
              <div className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${isPreparingReferencePayload ? 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200' : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200'}`}>
                {isPreparingReferencePayload ? '正在压缩参考图...' : referencePayloadNotice}
              </div>
            )}

            {inputImages.length > 0 ? (
              <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,72px)]">
                {inputImages.map((image, index) => (
                  <div key={image.id} className="group relative aspect-square overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-gray-900">
                    <img src={image.dataUrl} alt={`参考图 ${index + 1}`} className="h-full w-full object-cover" />
                    <span className="absolute bottom-1 left-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/60 px-1.5 text-[10px] font-semibold text-white">
                      {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const nextReferenceImageIds = inputImages.filter((_, imageIndex) => imageIndex !== index).map((item) => item.id)
                        removeInputImage(index)
                        updateCurrentPlannerSession({ referenceImageIds: nextReferenceImageIds })
                      }}
                      className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white opacity-100 transition hover:bg-red-500 sm:opacity-0 sm:group-hover:opacity-100"
                      aria-label={`删除参考图 ${index + 1}`}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-3 flex min-h-[96px] w-full flex-col items-center justify-center rounded-[var(--ios-radius-md)] bg-[hsl(var(--muted)/0.72)] text-center transition-colors hover:bg-[hsl(var(--ios-blue-tint))]"
              >
                <PhotoIcon className="h-5 w-5 text-gray-400" />
                <span className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-200">上传产品参考图</span>
                <span className="mt-1 text-xs text-gray-400">支持多选、拖到底部输入栏或直接在这里选择文件</span>
              </button>
            )}

            {atImageLimit && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
                参考图数量已达上限（{API_MAX_IMAGES} 张），请删除不需要的图片后再上传。
              </div>
            )}

            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileUpload} />
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileUpload} />
          </div>

          <div className="mt-5">
            <button
              type="button"
              onClick={() => setShowProductDetails((value) => !value)}
              aria-expanded={showProductDetails}
              aria-controls="planner-product-details"
              className="flex w-full items-center gap-3 rounded-[var(--ios-radius-md)] bg-[hsl(var(--muted)/0.72)] px-4 py-3 text-left transition-colors hover:bg-[hsl(var(--ios-blue-tint))]"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">商品细节</div>
                <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">材质、受众、卖点、包装与禁用元素</div>
              </div>
              <span className="shrink-0 rounded-lg bg-[hsl(var(--surface))] px-2 py-1 text-[11px] font-semibold text-gray-500 dark:text-gray-300">
                已填 {completedProductDetailCount}/{productDetailValues.length}
              </span>
              <ChevronRightIcon className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${showProductDetails ? 'rotate-90' : ''}`} />
            </button>

            {showProductDetails && (
              <div id="planner-product-details" className="mt-5 space-y-5">
                <section>
                  <div className="ios-group-title">Product Profile</div>
                  <div className="ios-group grid gap-px bg-[hsl(var(--separator))] md:grid-cols-2">
                    {([
                      ['productTitle', '商品标题', '例：Stainless Steel Insulated Travel Mug'],
                      ['category', '类目', '例：Kitchen / Sports / Home'],
                      ['brand', '品牌 / 型号', '只填商品真实品牌或型号'],
                      ['color', '颜色', '例：matte black'],
                      ['material', '材质 / 表面工艺', '例：304 stainless steel, silicone lid'],
                      ['audience', '目标人群', '例：commuters, office workers'],
                    ] as const).map(([field, label, placeholder]) => (
                      <label key={field} className="ios-group-row bg-[hsl(var(--surface))]">
                        <span className={LABEL_CLASS}>{label}</span>
                        <input
                          value={draft[field]}
                          onChange={(event) => setDraft((current) => updateDraft(current, field, event.target.value))}
                          className={FIELD_CLASS}
                          placeholder={placeholder}
                        />
                      </label>
                    ))}
                  </div>
                </section>

                <section>
                  <div className="ios-group-title">Selling Story</div>
                  <div className="ios-group grid gap-px bg-[hsl(var(--separator))] md:grid-cols-2">
                    <label className="ios-group-row bg-[hsl(var(--surface))] md:col-span-2">
                      <span className={LABEL_CLASS}>卖点</span>
                      <textarea
                        value={draft.sellingPoints}
                        onChange={(event) => setDraft((current) => updateDraft(current, 'sellingPoints', event.target.value))}
                        className={`${FIELD_CLASS} min-h-[86px] resize-y`}
                        placeholder="一行一个卖点，或用分号分隔"
                      />
                    </label>
                    <label className={`ios-group-row bg-[hsl(var(--surface))] ${isEtsyListingMode ? 'md:col-span-2' : ''}`}>
                      <span className={LABEL_CLASS}>包装清单</span>
                      <textarea
                        value={draft.packageIncludes}
                        onChange={(event) => setDraft((current) => updateDraft(current, 'packageIncludes', event.target.value))}
                        className={`${FIELD_CLASS} min-h-[76px] resize-y`}
                        placeholder="例：1 mug, 1 lid, 1 straw"
                      />
                    </label>
                    {!isEtsyListingMode && (
                      <label className="ios-group-row bg-[hsl(var(--surface))]">
                        <span className={LABEL_CLASS}>场景 / 构图</span>
                        <textarea
                          value={draft.scene}
                          onChange={(event) => setDraft((current) => updateDraft(current, 'scene', event.target.value))}
                          className={`${FIELD_CLASS} min-h-[76px] resize-y`}
                          placeholder="例：白底产品构图 / 厨房台面场景 / 尺寸标注信息图"
                        />
                      </label>
                    )}
                  </div>
                </section>

                <section>
                  <div className="ios-group-title">{isEtsyListingMode ? 'Publishing Guardrails' : 'Guardrails'}</div>
                  <label className="ios-group ios-group-row block">
                    <span className={LABEL_CLASS}>{isEtsyListingMode ? '禁止声明 / 待确认信息' : '禁用元素'}</span>
                    <input
                      value={draft.forbidden}
                      onChange={(event) => setDraft((current) => updateDraft(current, 'forbidden', event.target.value))}
                      className={FIELD_CLASS}
                      placeholder={isEtsyListingMode ? '例：不得声称 handmade；尺寸发布前需确认；不要承诺未经验证的性能' : '例：do not show phone, laptop, gift box'}
                    />
                  </label>
                </section>
              </div>
            )}
          </div>
        </div>

        {!isEtsyListingMode && <div className="p-4 sm:p-5">
          {showStickyActions && (
            <>
              {mobileActionDock && (
                <button
                  type="button"
                  data-amazon-action-dock
                  onClick={() => setMobileActionDock(null)}
                  className={`fixed top-[7.25rem] z-30 flex min-h-[104px] w-12 flex-col items-center justify-center gap-1 border border-blue-200 bg-white/95 px-1.5 py-2 text-blue-700 shadow-lg shadow-gray-900/10 backdrop-blur transition hover:bg-blue-50 sm:hidden dark:border-blue-300/25 dark:bg-gray-950/95 dark:text-blue-200 dark:hover:bg-blue-400/10 ${mobileActionDock === 'left' ? 'left-0 rounded-r-xl border-l-0' : 'right-0 rounded-l-xl border-r-0'}`}
                  aria-label="展开移动端生成操作窗"
                  title="展开操作窗"
                >
                  {mobileActionDock === 'left' ? (
                    <ChevronRightIcon className="h-4 w-4" />
                  ) : (
                    <ChevronLeftIcon className="h-4 w-4" />
                  )}
                  <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                    {actionSlot ?? (plannerMode === 'aplus' ? 'A+' : '当前')}
                  </span>
                  <span className="[writing-mode:vertical-rl] text-[11px] font-semibold tracking-wide">展开</span>
                </button>
              )}
              <div data-amazon-action-bar className={`z-30 rounded-xl border p-3 shadow-lg shadow-gray-900/5 backdrop-blur transition dark:shadow-black/20 sm:sticky sm:left-auto sm:right-auto sm:top-20 sm:mb-4 ${mobileActionDock ? 'hidden sm:block' : 'fixed left-3 right-3 top-[7.25rem]'} ${getGuidePanelClass(actionBarGuideActive)}`}>
                <button
                  type="button"
                  onClick={() => setMobileActionDock('left')}
                  className="absolute -left-3 top-1/2 flex h-24 w-7 -translate-y-1/2 items-center justify-center rounded-r-xl border border-blue-200 bg-white/95 text-blue-700 shadow-sm transition hover:bg-blue-50 sm:hidden dark:border-blue-300/25 dark:bg-gray-950/95 dark:text-blue-200 dark:hover:bg-blue-400/10"
                  aria-label="收起到左侧"
                  title="收起到左侧"
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setMobileActionDock('right')}
                  className="absolute -right-3 top-1/2 flex h-24 w-7 -translate-y-1/2 items-center justify-center rounded-l-xl border border-blue-200 bg-white/95 text-blue-700 shadow-sm transition hover:bg-blue-50 sm:hidden dark:border-blue-300/25 dark:bg-gray-950/95 dark:text-blue-200 dark:hover:bg-blue-400/10"
                  aria-label="收起到右侧"
                  title="收起到右侧"
                >
                  <ChevronRightIcon className="h-4 w-4" />
                </button>
                <div className="flex flex-col gap-3">
                  {actionBarGuideActive && (
                    <div className={GUIDE_HINT_CLASS}>
                      {guideState.message}
                    </div>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md bg-blue-600 px-2 py-0.5 text-[11px] font-bold text-white">
                          {actionSlot ?? (plannerMode === 'aplus' ? 'A+' : '当前')}
                        </span>
                        <span className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {actionLabel ?? (plannerMode === 'aplus' ? '请选择 A+ 模块' : '当前图片方案')}
                        </span>
                        <span className="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:bg-white/[0.08] dark:text-gray-300">
                          {actionPositionLabel}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                        {targetSize} / {generationParamLabel}{plannerMode === 'aplus' && selectedAPlusPlan ? ` · 上传建议 ${selectedAPlusPlan.uploadSize}` : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => stepVisiblePlan(-1)}
                        disabled={!canGoPrev}
                        className={`inline-flex h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition ${canGoPrev ? 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-white/[0.06]' : 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-300 dark:border-white/[0.04] dark:bg-white/[0.04] dark:text-gray-600'}`}
                      >
                        <ChevronLeftIcon className="h-3.5 w-3.5" />
                        上一张
                      </button>
                      <button
                        type="button"
                        onClick={() => stepVisiblePlan(1)}
                        disabled={!canGoNext}
                        className={`inline-flex h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition ${currentActionSubmitted && canGoNext ? 'border-blue-600 bg-blue-600 text-white shadow-sm hover:bg-blue-500' : canGoNext ? 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-white/[0.06]' : 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-300 dark:border-white/[0.04] dark:bg-white/[0.04] dark:text-gray-600'}`}
                      >
                        下一张
                        <ChevronRightIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className={`rounded-lg border px-3 py-2 text-xs font-medium ${currentActionSubmitted ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200' : currentActionFilled ? 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200' : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200'}`}>
                    {actionGuidance}
                    {mainStyleGuidance && (
                      <span className="mt-1 block text-[11px] font-normal opacity-80">{mainStyleGuidance}</span>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {actionProgressSteps.map((step) => (
                      <div key={step.label} className={`rounded-lg border px-2 py-1.5 ${getActionStepClass(step.status)}`}>
                        <div className="truncate text-[10px] font-bold">{step.label}</div>
                        <div className="mt-0.5 truncate text-[10px] opacity-80">{step.detail}</div>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={copyPrompt}
                      disabled={actionDisabled}
                      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition ${actionDisabled ? 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-300 dark:border-white/[0.04] dark:bg-white/[0.04] dark:text-gray-600' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-white/[0.06]'}`}
                    >
                      <CopyIcon className="h-3.5 w-3.5" />
                      复制
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPrompt()}
                      disabled={actionDisabled}
                      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition ${actionDisabled ? 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-white/[0.06] dark:text-gray-600' : currentActionFilled ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-gray-900 text-white hover:bg-gray-700 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200'}`}
                    >
                      {currentActionFilled ? (
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <PhotoIcon className="h-3.5 w-3.5" />
                      )}
                      {currentActionFilled ? '已填入' : '填入'}
                    </button>
                    <button
                      type="button"
                      onClick={applyAndSubmit}
                      disabled={submitDisabled || currentActionSubmitted}
                      className={`inline-flex h-9 items-center justify-center rounded-lg px-2 text-xs font-semibold transition ${currentActionSubmitted ? 'cursor-default bg-emerald-600 text-white' : submitDisabled ? 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-white/[0.06] dark:text-gray-600' : 'bg-blue-600 text-white hover:bg-blue-500'}`}
                    >
                      {currentActionSubmitted ? '已提交' : plannerMode === 'etsy' ? '生成当前镜头' : '提交生成'}
                    </button>
                  </div>
                </div>
              </div>
              {plannerMode === 'etsy' && (
                <button
                  type="button"
                  onClick={() => void generatePendingEtsyPlans()}
                  disabled={isGeneratingEtsyBatch || pendingEtsyPlanCount === 0 || submitDisabled}
                  className={`mt-2 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${isGeneratingEtsyBatch || pendingEtsyPlanCount === 0 || submitDisabled ? 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-400 dark:border-white/[0.04] dark:bg-white/[0.04] dark:text-gray-600' : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200 dark:hover:bg-blue-400/20'}`}
                >
                  <PhotoIcon className="h-3.5 w-3.5" />
                  {isGeneratingEtsyBatch ? '正在并行提交 Etsy 镜头...' : `批量生成未提交镜头（${pendingEtsyPlanCount}）`}
                </button>
              )}
              <div className={mobileActionDock ? 'h-16 sm:hidden' : 'h-[218px] sm:hidden'} aria-hidden="true" />
            </>
          )}
          {hasPlanOptions && (
            <div className={`mb-4 rounded-xl border p-3 transition ${getGuidePanelClass(styleGuideActive, 'muted')}`}>
              {styleGuideActive && (
                <div className={GUIDE_HINT_CLASS}>
                  {guideState.message}
                </div>
              )}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">视觉风格选择</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {isEtsyImageMode
                      ? 'Etsy 仅把所选预设转换为配色、光感与摄影质感，不会把带文字和版式的模板板附到生图请求。'
                      : '选择内置预设，或编辑后保存到“我的风格”。附图和 A+ 正式生图时会隐藏附加到请求末尾。'}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex h-9 rounded-lg border border-gray-200 bg-white p-0.5 text-xs font-semibold dark:border-white/[0.08] dark:bg-gray-900">
                    {STYLE_DENSITY_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => changeStyleDensityMode(option.value)}
                        className={`rounded-md px-2.5 transition ${styleDensityMode === option.value ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-950' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100'}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {isLoadingStylePreset && (
                <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-800 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200">
                  正在加载风格参考图...
                </div>
              )}
              {styleError && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
                  {styleError}
                </div>
              )}
              <div className={`mt-3 space-y-4 rounded-xl transition ${getGuideFocusClass(guideState.target === 'style-choice')}`}>
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400">内置预设</div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    {STYLE_PRESETS.map((preset) => {
                      const isSelected = !selectedStyleReference?.customStyleReferenceId && selectedStyleReference?.presetId === preset.id
                      const isLoading = isLoadingStylePreset && selectedStylePresetId === preset.id
                      const assetUrl = getStylePresetAssetUrl(preset)
                      return (
                        <div
                          key={preset.id}
                          onMouseEnter={(event) => updateStylePreview(preset, event)}
                          onMouseMove={(event) => updateStylePreview(preset, event)}
                          onMouseLeave={() => setStylePreview(null)}
                          className={`min-w-0 overflow-hidden rounded-xl border text-left transition ${isSelected ? 'border-violet-400 bg-violet-50 ring-2 ring-violet-500/15 dark:border-violet-300/70 dark:bg-violet-500/10' : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:hover:bg-white/[0.05]'}`}
                        >
                          <button
                            type="button"
                            onClick={() => void selectStylePreset(preset.id)}
                            className="block w-full text-left"
                          >
                            <div className="aspect-square bg-gray-100 dark:bg-white/[0.04]">
                              <img
                                src={assetUrl}
                                alt={preset.label}
                                className="h-full w-full object-cover"
                                onError={(event) => {
                                  const fallbackUrl = getStylePresetFallbackDataUrl(preset)
                                  if (event.currentTarget.src !== fallbackUrl) event.currentTarget.src = fallbackUrl
                                }}
                              />
                            </div>
                            <div className="p-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate text-xs font-semibold text-gray-900 dark:text-gray-100">{preset.label}</span>
                                {isSelected && (
                                  <span className="shrink-0 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-bold text-white">已选</span>
                                )}
                                {isLoading && !isSelected && (
                                  <span className="shrink-0 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">加载中</span>
                                )}
                              </div>
                              <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{preset.description}</div>
                              <div className="mt-2 flex gap-1">
                                {preset.palette.map((color) => (
                                  <span
                                    key={color}
                                    className="h-3 flex-1 rounded-sm border border-black/5 dark:border-white/10"
                                    style={{ backgroundColor: color }}
                                    aria-hidden="true"
                                  />
                                ))}
                              </div>
                            </div>
                          </button>
                          <div className="grid grid-cols-2 gap-1 border-t border-gray-100 p-2 dark:border-white/[0.08]">
                            <button
                              type="button"
                              onClick={() => void openStylePresetPreview(preset.id)}
                              className="inline-flex h-8 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                            >
                              <EyeIcon className="h-3.5 w-3.5" />
                              预览
                            </button>
                            <button
                              type="button"
                              onClick={() => openStyleEditorFromPreset(preset)}
                              className="inline-flex h-8 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                            >
                              <EditIcon className="h-3.5 w-3.5" />
                              编辑
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400">我的风格</div>
                    <span className="text-[11px] text-gray-400">{customStyleReferences.length} 套</span>
                  </div>
                  {customStyleReferences.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {customStyleReferences.map((customStyle) => {
                        const meta = getCustomStyleReferenceVisualMeta(customStyle)
                        const isSelected = selectedStyleReference?.customStyleReferenceId === customStyle.id
                        const imageUrl = customStyleImageDataUrls[customStyle.id] || ''
                        return (
                          <div
                            key={customStyle.id}
                            onMouseEnter={(event) => updateCustomStylePreview(customStyle, event)}
                            onMouseMove={(event) => updateCustomStylePreview(customStyle, event)}
                            onMouseLeave={() => setStylePreview(null)}
                            className={`min-w-0 overflow-hidden rounded-xl border text-left transition ${isSelected ? 'border-violet-400 bg-violet-50 ring-2 ring-violet-500/15 dark:border-violet-300/70 dark:bg-violet-500/10' : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:hover:bg-white/[0.05]'}`}
                          >
                            <button
                              type="button"
                              onClick={() => void selectCustomStyleReference(customStyle)}
                              className="block w-full text-left"
                            >
                              <div className="aspect-square bg-gray-100 dark:bg-white/[0.04]">
                                {imageUrl ? (
                                  <img src={imageUrl} alt={meta.label} className="h-full w-full object-cover" />
                                ) : (
                                  <div className="flex h-full items-center justify-center text-xs text-gray-400">加载中</div>
                                )}
                              </div>
                              <div className="p-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="min-w-0 truncate text-xs font-semibold text-gray-900 dark:text-gray-100">{meta.label}</span>
                                  {isSelected && (
                                    <span className="shrink-0 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-bold text-white">已选</span>
                                  )}
                                </div>
                                <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{meta.description}</div>
                                <div className="mt-2 flex gap-1">
                                  {meta.palette.map((color, index) => (
                                    <span
                                      key={`${customStyle.id}-${color}-${index}`}
                                      className="h-3 flex-1 rounded-sm border border-black/5 dark:border-white/10"
                                      style={{ backgroundColor: color }}
                                      aria-hidden="true"
                                    />
                                  ))}
                                </div>
                              </div>
                            </button>
                            <div className="grid grid-cols-3 gap-1 border-t border-gray-100 p-2 dark:border-white/[0.08]">
                              <button
                                type="button"
                                onClick={() => void openCustomStylePreview(customStyle)}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                              >
                                <EyeIcon className="h-3.5 w-3.5" />
                                预览
                              </button>
                              <button
                                type="button"
                                onClick={() => openStyleEditorFromCustom(customStyle)}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                              >
                                <EditIcon className="h-3.5 w-3.5" />
                                编辑
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteCustomStyleReference(customStyle)}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold text-red-500 transition hover:bg-red-50 hover:text-red-700 dark:text-red-300 dark:hover:bg-red-400/10 dark:hover:text-red-200"
                              >
                                <TrashIcon className="h-3.5 w-3.5" />
                                删除
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 px-3 py-4 text-center text-xs text-gray-500 dark:border-white/[0.12] dark:bg-gray-900/50 dark:text-gray-400">
                      还没有自定义风格。点击内置预设的“编辑”保存到这里。
                    </div>
                  )}
                </div>
              </div>
              {stylePreview && (
                <div
                  className="ios-menu pointer-events-none fixed z-50 hidden w-[420px] max-w-[calc(100vw-24px)] overflow-hidden sm:block"
                  style={{ left: stylePreview.left, top: stylePreview.top }}
                >
                  <img
                    src={stylePreview.dataUrl}
                    alt=""
                    className="aspect-square w-full bg-gray-100 object-contain dark:bg-white/[0.04]"
                    onError={(event) => {
                      if (stylePreview.fallbackDataUrl && event.currentTarget.src !== stylePreview.fallbackDataUrl) {
                        event.currentTarget.src = stylePreview.fallbackDataUrl
                      }
                    }}
                  />
                  <div className="border-t border-gray-100 p-3 dark:border-white/[0.08]">
                    <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{stylePreview.label}</div>
                    <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{stylePreview.description}</div>
                  </div>
                </div>
              )}
              {selectedStyleImage?.imageId && selectedStyleLabel && (
                <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs leading-relaxed text-violet-800 dark:border-violet-300/20 dark:bg-violet-400/10 dark:text-violet-200">
                  {isEtsyImageMode
                    ? `已选择「${selectedStyleLabel}」。将只用文字传递配色、光感与摄影质感，不附加模板图，避免占位文字、色条和信息框污染成品。`
                    : isMainListingPlan
                    ? `已选择「${selectedStyleLabel}」，但当前 MAIN 主图不会附加这张风格参考图；切换到附图或 A+ 时才会作为隐藏参考。`
                    : `已选择「${selectedStyleLabel}」。正式生成时会隐藏附加这张风格参考图作为最后一张参考图，用于统一字体感觉、色板、光影、材质和标注样式，不复制其中占位文字、固定版式或产品摆放。`}
                </div>
              )}
              {styleReferenceLimitExceeded && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
                  当前产品参考图加隐藏风格参考图共 {effectiveReferenceCount} 张，超过上限 {API_MAX_IMAGES} 张，请删除一张产品参考图后再提交。
                </div>
              )}
            </div>
          )}
          {plannerMode !== 'aplus' && imagePlans.length > 0 && (
            <div className={`mb-4 rounded-xl border p-3 transition ${getGuidePanelClass(planListGuideActive)}`}>
              {planListGuideActive && (
                <div className={GUIDE_HINT_CLASS}>
                  {guideState.message}
                </div>
              )}
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">{plannerMode === 'etsy' ? 'PART B: THE DYNAMIC 15-SHOT BESPOKE PLAN' : '逐张策划'}</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {plannerMode === 'etsy' ? '10个镜头根据当前产品动态设计；选择镜头后可直接进入 Phase 2 实际生图。' : '选择图片位后，Prompt Preview 和生成按钮会切换到对应提示词。'}
                  </div>
                </div>
                <span className="shrink-0 rounded-lg bg-gray-100 px-2 py-1 text-xs font-medium text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                  {imagePlans.length} 张
                </span>
              </div>
              <div className={PLAN_LIST_CLASS}>
                {imagePlans.map((plan, index) => {
                  const isSelected = selectedPlanIndex === index
                  const planActionProgress = actionProgress[getPlannerActionKey(plannerMode, index, plan.slot)]
                  return (
                    <button
                      key={`${plan.slot}-${index}`}
                      type="button"
                      onClick={() => selectPlan(index)}
                      className={`rounded-xl border p-3 text-left transition ${isSelected ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-500/15 dark:border-blue-400/70 dark:bg-blue-500/10' : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-950 dark:hover:bg-white/[0.05]'}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${isSelected ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 dark:bg-white/[0.08] dark:text-gray-300'}`}>
                          {plan.slot}
                        </span>
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{plan.label}</span>
                        {isSelected && (
                          <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">当前</span>
                        )}
                        {planActionProgress && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${planActionProgress === 'submitted' ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200'}`}>
                            {planActionProgress === 'submitted' ? '已提交' : '已填入'}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 line-clamp-3 text-xs leading-relaxed text-gray-600 dark:text-gray-300">{getPlanSummary(plan.planMarkdown)}</div>
                      <div className="mt-2 line-clamp-2 rounded-lg bg-white/70 px-2 py-1 text-[11px] leading-relaxed text-gray-500 dark:bg-white/[0.05] dark:text-gray-300">
                        Negative：{plan.negativePrompt || '未提供'}
                      </div>
                    </button>
                  )
                })}
              </div>
              {plannerMode === 'etsy' && (
                <div className="mt-3 rounded-[var(--ios-radius-md)] bg-[hsl(var(--ios-blue-tint))] px-3 py-2 text-xs leading-relaxed text-[hsl(var(--primary))]">
                  I have designed this bespoke strategic plan based on your product&apos;s unique characteristics. Please confirm if this direction aligns with your vision, or upload a reference photo so I can <strong>immediately start generating Image 1</strong>.
                </div>
              )}
            </div>
          )}
          {plannerMode === 'aplus' && aPlusPlansWithSizes.length > 0 && (
            <div className={`mb-4 rounded-xl border p-3 transition ${getGuidePanelClass(planListGuideActive)}`}>
              {planListGuideActive && (
                <div className={GUIDE_HINT_CLASS}>
                  {guideState.message}
                </div>
              )}
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">A+ 模块编排</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    选择模块后，Prompt Preview 和生成按钮会切换到对应 A+ 提示词与尺寸。
                  </div>
                </div>
                <span className="shrink-0 rounded-lg bg-gray-100 px-2 py-1 text-xs font-medium text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                  {aPlusPlansWithSizes.length} 张
                </span>
              </div>
              <div className={PLAN_LIST_CLASS}>
                {aPlusPlansWithSizes.map((plan, index) => {
                  const isSelected = selectedAPlusPlanIndex === index
                  const externalText = formatAPlusModuleText(plan)
                  const planActionProgress = actionProgress[getPlannerActionKey('aplus', index, plan.slot)]
                  return (
                    <button
                      key={`${plan.slot}-${index}`}
                      type="button"
                      onClick={() => selectAPlusPlan(index)}
                      className={`rounded-xl border p-3 text-left transition ${isSelected ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-500/15 dark:border-blue-400/70 dark:bg-blue-500/10' : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-950 dark:hover:bg-white/[0.05]'}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${isSelected ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 dark:bg-white/[0.08] dark:text-gray-300'}`}>
                          {plan.slot}
                        </span>
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{getAPlusModuleDisplayName(plan)}</span>
                        <span className="text-xs text-gray-400">{getAPlusModuleEnglishName(plan)}</span>
                        {isSelected && (
                          <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">当前</span>
                        )}
                        {planActionProgress && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${planActionProgress === 'submitted' ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200'}`}>
                            {planActionProgress === 'submitted' ? '已提交' : '已填入'}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                        <span className="rounded-md bg-white/70 px-2 py-0.5 dark:bg-white/[0.05]">上传 {plan.uploadSize}</span>
                        <span className="rounded-md bg-white/70 px-2 py-0.5 dark:bg-white/[0.05]">生成 {plan.generationSize}</span>
                      </div>
                      <div className="mt-2 line-clamp-3 text-xs leading-relaxed text-gray-600 dark:text-gray-300">{getPlanSummary(plan.planMarkdown)}</div>
                      {(isAPlusTextModule(plan) || externalText) && externalText && (
                        <div className="mt-2 rounded-lg bg-white/70 px-2 py-1 text-xs leading-relaxed text-gray-700 dark:bg-white/[0.05] dark:text-gray-200">
                          {plan.textTitle && <div className="font-semibold">{plan.textTitle}</div>}
                          {plan.textBody && <div className="mt-0.5 line-clamp-2 text-gray-500 dark:text-gray-300">{plan.textBody}</div>}
                        </div>
                      )}
                      <div className="mt-2 line-clamp-2 rounded-lg bg-white/70 px-2 py-1 text-[11px] leading-relaxed text-gray-500 dark:bg-white/[0.05] dark:text-gray-300">
                        Negative：{plan.negativePrompt || '未提供'}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {plannerMode === 'aplus' && aPlusPlansWithSizes.length === 0 && (
            <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-white/[0.08] dark:bg-gray-950">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">A+ 模块编排</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    当前选择 {getAPlusContentTypeLabel(aPlusType)}，可先调整模块数量，再点击 AI策划A+。
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={restoreDefaultAPlusModules}
                    disabled={isPlanning || aPlusSpecsAreDefault}
                    title="恢复当前 A+ 类型默认模块"
                    className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition ${!isPlanning && !aPlusSpecsAreDefault ? 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white' : 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-300 dark:border-white/[0.04] dark:bg-white/[0.04] dark:text-gray-600'}`}
                  >
                    <RefreshIcon className="h-3.5 w-3.5" />
                    恢复默认
                  </button>
                  <span className="rounded-lg bg-gray-100 px-2 py-1 text-xs font-medium text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                    {aPlusSpecs.length} 张
                  </span>
                </div>
              </div>
              <div className={PLAN_LIST_CLASS}>
                {aPlusSpecs.map((spec, index) => (
                  <div key={spec.slot} className="rounded-xl border border-dashed border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-gray-900">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] font-bold text-gray-600 dark:bg-white/[0.08] dark:text-gray-300">
                            {spec.slot}
                          </span>
                          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{getAPlusModuleDisplayName(spec)}</span>
                          <span className="text-xs text-gray-400">{getAPlusModuleEnglishName(spec)}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                          上传 {getAPlusModuleUploadSize(spec)} · 生成 {getAPlusModuleGenerationSize(spec, resolutionTier)}
                          {isAPlusTextModule(spec) ? ' · 含标题/正文' : ''}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => addAPlusModuleAfter(index)}
                          disabled={isPlanning || aPlusSpecs.length >= MAX_A_PLUS_MODULE_COUNT}
                          aria-label={`在 ${spec.slot} 后添加同尺寸 A+ 模块`}
                          title={aPlusSpecs.length >= MAX_A_PLUS_MODULE_COUNT ? `最多 ${MAX_A_PLUS_MODULE_COUNT} 张` : '添加同尺寸模块'}
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition ${!isPlanning && aPlusSpecs.length < MAX_A_PLUS_MODULE_COUNT ? 'border-blue-100 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200 dark:hover:bg-blue-400/20' : 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-300 dark:border-white/[0.04] dark:bg-white/[0.04] dark:text-gray-600'}`}
                        >
                          <PlusIcon className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeAPlusModuleAt(index)}
                          disabled={isPlanning || aPlusSpecs.length <= MIN_A_PLUS_MODULE_COUNT}
                          aria-label={`删除 ${spec.slot} A+ 模块`}
                          title={aPlusSpecs.length <= MIN_A_PLUS_MODULE_COUNT ? `至少保留 ${MIN_A_PLUS_MODULE_COUNT} 张` : '删除模块'}
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition ${!isPlanning && aPlusSpecs.length > MIN_A_PLUS_MODULE_COUNT ? 'border-red-100 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200 dark:hover:bg-red-400/20' : 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-300 dark:border-white/[0.04] dark:bg-white/[0.04] dark:text-gray-600'}`}
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            {checks.map((check) => (
              <div
                key={check.label}
                className={`rounded-[var(--ios-radius-md)] px-3 py-2 ${check.status === 'ready' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200' : check.status === 'missing' ? 'bg-red-50 text-red-800 dark:bg-red-400/10 dark:text-red-200' : 'bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200'}`}
              >
                <div className="text-xs font-semibold">{check.label}</div>
                <div className="mt-0.5 text-[11px] opacity-80">{check.detail}</div>
              </div>
            ))}
          </div>
          <div className="ios-group mt-4 p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                Prompt Preview{plannerMode === 'aplus' && selectedAPlusPlan ? ` · ${selectedAPlusPlan.slot}` : selectedPlan ? ` · ${selectedPlan.slot}` : ''}
              </span>
              <span className="text-xs text-gray-400">{targetSize} / {generationParamLabel}</span>
            </div>
            <textarea
              value={plannerMode === 'aplus' && !selectedAPlusPlan
                ? '请先点击 AI策划A+，再在右侧选择一个 A+ 模块。'
                 : plannerMode === 'etsy' && !selectedPlan
                   ? '请先填写产品描述，再选择“原有10张”或“新增5张”进行 Etsy 策划。每次只显示当前按钮对应的策划方案。'
                  : activePlanPreview || '请先粘贴 Listing 并点击 AI策划，LLM 会生成中文策划、英文 Prompt 和 Negative Prompt。'}
              className={`ios-field w-full resize-none p-3 font-mono text-xs leading-relaxed text-gray-700 dark:text-gray-200 ${hasSelectedPlan ? 'h-[430px]' : 'h-36 sm:h-44'}`}
              spellCheck={false}
              readOnly
            />
          </div>
          {plannerMode === 'aplus' && selectedAPlusPlan && (
            <div className="ios-group mt-3 p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                  A+ 文案 · {selectedAPlusPlan.slot}
                </span>
                <button
                  type="button"
                  onClick={copyAPlusText}
                  disabled={!selectedAPlusText.trim()}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition ${selectedAPlusText.trim() ? 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-white/[0.06]' : 'cursor-not-allowed border-gray-100 bg-gray-100 text-gray-300 dark:border-white/[0.04] dark:bg-white/[0.04] dark:text-gray-600'}`}
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  复制文案
                </button>
              </div>
              <textarea
                value={selectedAPlusText || (isAPlusTextModule(selectedAPlusPlan) ? '该模块暂未生成标题/正文文案。' : '当前模块通常不需要外部标题/正文文案。')}
                className="ios-field h-28 w-full resize-none p-3 text-xs leading-relaxed text-gray-700 dark:text-gray-200"
                spellCheck={false}
                readOnly
              />
              <div className="mt-2 text-[11px] text-gray-400">
                外部 A+ 文案用于亚马逊模块文本区，不会写入图片生成 Prompt。
              </div>
            </div>
          )}
          {activePrompt.trim() && prompt.trim() && prompt !== activePrompt && (
            <div className="mt-3 rounded-[var(--ios-radius-md)] bg-[hsl(var(--ios-blue-tint))] px-3 py-2 text-xs text-[hsl(var(--primary))]">
              底部输入框已有内容，点击“填入”会用当前{plannerMode === 'etsy' ? 'Etsy镜头' : '亚马逊'}提示词覆盖。
            </div>
          )}
        </div>}
      </div>
    </section>
    </>
  )
}
