import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAmazonPlannerProfile, validateApiProfile } from '../lib/apiProfiles'
import {
  callGlobalInsightsApi,
  getGlobalInsightSourceFamily,
  type GlobalInsightPlatformType,
  type GlobalInsightsProgress,
  type GlobalInsightsReport,
  type GlobalInsightsWindowDays,
} from '../lib/globalInsightsApi'
import { useStore } from '../store'
import { ExternalLinkIcon, RefreshIcon } from './icons'

type CategoryFilter = 'all' | GlobalInsightPlatformType
const RESULTS_PER_PAGE = 12

const CATEGORY_META: Record<GlobalInsightPlatformType, { label: string; description: string; tone: string }> = {
  etsy: {
    label: 'Etsy重点',
    description: 'Etsy 官方趋势、热门 Listing、买家需求与评论信号',
    tone: 'bg-rose-100 text-rose-800 dark:bg-rose-400/10 dark:text-rose-200',
  },
  ecommerce: {
    label: '主流电商',
    description: 'Etsy 以外主流电商平台近期热销、热搜或讨论快速上升的商品',
    tone: 'bg-amber-100 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200',
  },
  social: {
    label: '社交与论坛',
    description: '社交平台、社区和论坛近期互动最集中的帖子与话题',
    tone: 'bg-blue-100 text-blue-800 dark:bg-blue-400/10 dark:text-blue-200',
  },
  design: {
    label: '设计趋势',
    description: '设计网站近期高关注项目、作品、文章与视觉趋势',
    tone: 'bg-violet-100 text-violet-800 dark:bg-violet-400/10 dark:text-violet-200',
  },
}

const CATEGORY_FILTERS: Array<[CategoryFilter, string]> = [
  ['all', '全部'],
  ['etsy', 'Etsy重点'],
  ['ecommerce', '主流电商'],
  ['social', '社交与论坛'],
  ['design', '设计趋势'],
]

function getSourceWebsite(value: string) {
  return getGlobalInsightSourceFamily(value)
}

const inFlightReports = new Map<string, Promise<GlobalInsightsReport>>()
const completedReports = new Map<string, GlobalInsightsReport>()

function getReportKey(
  profile: NonNullable<ReturnType<typeof getAmazonPlannerProfile>>,
  windowDays: GlobalInsightsWindowDays,
  searchQuery: string,
) {
  return [profile.id, profile.baseUrl, profile.model, windowDays, searchQuery.trim().toLocaleLowerCase()].join('|')
}

function requestReport(
  profile: NonNullable<ReturnType<typeof getAmazonPlannerProfile>>,
  windowDays: GlobalInsightsWindowDays,
  searchQuery: string,
  signal?: AbortSignal,
  onProgress?: (progress: GlobalInsightsProgress) => void,
) {
  const key = getReportKey(profile, windowDays, searchQuery)
  const existing = inFlightReports.get(key)
  if (existing) return existing
  const request = callGlobalInsightsApi({ profile, windowDays, searchQuery, signal, onProgress }).then((report) => {
    completedReports.set(key, report)
    return report
  })
  inFlightReports.set(key, request)
  void request.finally(() => {
    if (inFlightReports.get(key) === request) inFlightReports.delete(key)
  }).catch(() => {})
  return request
}

function formatGeneratedAt(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function InsightThumbnail({
  imageUrl,
  sourceUrl,
  title,
  platform,
}: {
  imageUrl: string
  sourceUrl: string
  title: string
  platform: string
}) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [imageUrl])

  return (
    <a
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`查看 ${title} 的原始来源`}
      className="group relative mb-4 block aspect-[16/10] overflow-hidden rounded-xl bg-gradient-to-br from-gray-100 to-gray-200 dark:from-white/[0.08] dark:to-white/[0.03]"
    >
      {imageUrl && !failed ? (
        <img
          src={imageUrl}
          alt={title}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/80 text-lg font-black text-gray-500 shadow-sm dark:bg-white/[0.07] dark:text-gray-300">
            {platform.trim().slice(0, 1).toUpperCase() || '?'}
          </span>
          <span className="text-[11px] font-medium">来源页面暂无可用图片</span>
        </div>
      )}
      <span className="absolute bottom-2 right-2 rounded-md bg-black/65 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur-sm">
        {platform}
      </span>
    </a>
  )
}

export default function GlobalInsights() {
  const settings = useStore((state) => state.settings)
  const setShowSettings = useStore((state) => state.setShowSettings)
  const plannerProfile = useMemo(() => getAmazonPlannerProfile(settings), [settings])
  const profileValidation = plannerProfile ? validateApiProfile(plannerProfile) : '未选择 AI 策划配置'
  const [windowDays, setWindowDays] = useState<GlobalInsightsWindowDays>(3)
  const [searchDraft, setSearchDraft] = useState('')
  const [activeSearchQuery, setActiveSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [platformFilter, setPlatformFilter] = useState('all')
  const [resultQuery, setResultQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [report, setReport] = useState<GlobalInsightsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [searchProgress, setSearchProgress] = useState('')
  const [error, setError] = useState('')
  const requestIdRef = useRef(0)
  const activeRequestRef = useRef<{ key: string; controller: AbortController } | null>(null)

  const loadInsights = useCallback(async (days: GlobalInsightsWindowDays, searchQuery: string) => {
    const normalizedSearchQuery = searchQuery.trim().slice(0, 160)
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    if (!plannerProfile || profileValidation) {
      activeRequestRef.current?.controller.abort()
      activeRequestRef.current = null
      setReport(null)
      setError(profileValidation || 'AI 策划配置不可用')
      return
    }

    const reportKey = getReportKey(plannerProfile, days, normalizedSearchQuery)
    const cachedReport = completedReports.get(reportKey) ?? null
    const previousActiveRequest = activeRequestRef.current
    if (previousActiveRequest && previousActiveRequest.key !== reportKey) {
      previousActiveRequest.controller.abort()
      inFlightReports.delete(previousActiveRequest.key)
    }
    const controller = previousActiveRequest?.key === reportKey && !previousActiveRequest.controller.signal.aborted
      ? previousActiveRequest.controller
      : new AbortController()
    activeRequestRef.current = { key: reportKey, controller }
    setReport((current) => cachedReport ?? (
      current?.windowDays === days && current.searchQuery === normalizedSearchQuery ? current : null
    ))
    setLoading(true)
    setSearchProgress(days === 7 ? '准备分批搜索' : '')
    setError('')
    try {
      const nextReport = await requestReport(
        plannerProfile,
        days,
        normalizedSearchQuery,
        controller.signal,
        (progress) => {
          if (requestIdRef.current !== requestId) return
          const label = CATEGORY_META[progress.platformType].label
          setSearchProgress(progress.completed >= progress.total
            ? '正在整理结果'
            : `${label} ${progress.completed + 1}/${progress.total}`)
        },
      )
      if (requestIdRef.current !== requestId) return
      setReport(nextReport)
    } catch (loadError) {
      if (requestIdRef.current !== requestId) return
      if (controller.signal.aborted) return
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false)
        setSearchProgress('')
      }
    }
  }, [plannerProfile, profileValidation])

  useEffect(() => {
    void loadInsights(windowDays, activeSearchQuery)
  }, [activeSearchQuery, loadInsights, windowDays])

  const submitTopicSearch = useCallback(() => {
    const nextQuery = searchDraft.trim()
    setCategoryFilter('all')
    setPlatformFilter('all')
    setResultQuery('')
    setCurrentPage(1)
    if (nextQuery === activeSearchQuery) {
      void loadInsights(windowDays, nextQuery)
      return
    }
    setActiveSearchQuery(nextQuery)
  }, [activeSearchQuery, loadInsights, searchDraft, windowDays])

  const clearTopicSearch = useCallback(() => {
    setSearchDraft('')
    setCategoryFilter('all')
    setPlatformFilter('all')
    setResultQuery('')
    setCurrentPage(1)
    if (activeSearchQuery) setActiveSearchQuery('')
    else void loadInsights(windowDays, '')
  }, [activeSearchQuery, loadInsights, windowDays])

  const categoryItems = useMemo(() => {
    if (!report) return []
    return categoryFilter === 'all'
      ? report.items
      : report.items.filter((item) => item.platformType === categoryFilter)
  }, [categoryFilter, report])

  const availablePlatforms = useMemo(() => (
    Array.from(new Set(categoryItems.map((item) => item.platform.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  ), [categoryItems])

  useEffect(() => {
    if (platformFilter !== 'all' && !availablePlatforms.includes(platformFilter)) setPlatformFilter('all')
  }, [availablePlatforms, platformFilter])

  const visibleItems = useMemo(() => {
    const query = resultQuery.trim().toLocaleLowerCase()
    return categoryItems.filter((item) => {
      if (platformFilter !== 'all' && item.platform !== platformFilter) return false
      if (!query) return true
      return [
        item.platform,
        item.countryOrRegion,
        item.title,
        item.titleZh,
        item.summaryZh,
        item.whyHotZh,
        ...item.heatSignals,
      ].join('\n').toLocaleLowerCase().includes(query)
    })
  }, [categoryItems, platformFilter, resultQuery])

  const totalPages = Math.max(1, Math.ceil(visibleItems.length / RESULTS_PER_PAGE))
  const pagedItems = useMemo(() => {
    const startIndex = (currentPage - 1) * RESULTS_PER_PAGE
    return visibleItems.slice(startIndex, startIndex + RESULTS_PER_PAGE)
  }, [currentPage, visibleItems])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const sourceCoverage = useMemo(() => {
    if (!report) return null
    const createCoverage = (items: GlobalInsightsReport['items']) => ({
      itemCount: items.length,
      websiteCount: new Set(items.map((item) => getSourceWebsite(item.sourceUrl)).filter(Boolean)).size,
      platforms: Array.from(new Set(items.map((item) => item.platform.trim()).filter(Boolean))),
    })
    return {
      all: createCoverage(report.items),
      etsy: createCoverage(report.items.filter((item) => item.platformType === 'etsy')),
      ecommerce: createCoverage(report.items.filter((item) => item.platformType === 'ecommerce')),
      social: createCoverage(report.items.filter((item) => item.platformType === 'social')),
      design: createCoverage(report.items.filter((item) => item.platformType === 'design')),
    }
  }, [report])

  return (
    <section data-no-drag-select className="mt-6 space-y-4">
      <div className="ios-surface overflow-hidden">
        <div className="border-b border-[hsl(var(--separator))] p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-50">全球信息</h2>
                {report && (
                  <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${report.webResearchUsed ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200' : 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200'}`}>
                    {report.webResearchUsed ? '已联网验证' : '联网证据未确认'}
                  </span>
                )}
                {activeSearchQuery && (
                  <span className="max-w-full truncate rounded-md bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700 dark:bg-blue-400/10 dark:text-blue-200">
                    搜索主题：{activeSearchQuery}
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                Etsy 作为重点独立追踪，并同步搜索美国及欧美发达市场的主流电商、社交论坛与设计网站，每次汇总 48 条近期高热信息。
              </p>
              <p className="mt-1 text-xs leading-relaxed text-gray-400 dark:text-gray-500">
                Etsy重点、主流电商、社交论坛、设计趋势各 12 条；非 Etsy 分类优先覆盖 6–10 个主流平台系列。
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="ios-segmented">
                {([3, 7] as const).map((days) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => setWindowDays(days)}
                    data-active={windowDays === days}
                    className={`ios-segment h-9 px-4 text-sm font-medium ${windowDays === days ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}
                  >
                    近 {days} 天
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void loadInsights(windowDays, activeSearchQuery)}
                disabled={loading || Boolean(profileValidation)}
                className="ios-button ios-button-filled inline-flex h-9 items-center gap-2 px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                {loading ? (searchProgress || '正在联网搜索') : '立即刷新'}
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-[hsl(var(--separator))] bg-[hsl(var(--muted)/0.35)] p-3">
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault()
                submitTopicSearch()
              }}
            >
              <input
                type="search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                maxLength={160}
                placeholder="输入搜索词，例如：personalized jewelry、复古婚礼、宠物纪念礼物"
                aria-label="输入全球平台联网搜索词"
                className="ios-field h-10 min-w-0 flex-1 px-3 text-sm"
              />
              <button
                type="submit"
                disabled={Boolean(profileValidation)}
                className="ios-button ios-button-filled h-10 shrink-0 px-5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              >
                搜索这些平台
              </button>
              {activeSearchQuery && (
                <button
                  type="button"
                  onClick={clearTopicSearch}
                  className="ios-button h-10 shrink-0 px-4 text-sm font-semibold"
                >
                  恢复综合热点
                </button>
              )}
            </form>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
              {activeSearchQuery
                ? `正在围绕“${activeSearchQuery}”联网搜索 Etsy、主流电商、社交论坛和设计网站。`
                : '输入主题后会重新联网研究四类平台；下方“筛选当前结果”只筛选已经返回的内容。'}
            </p>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {CATEGORY_FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setCategoryFilter(value)
                  setPlatformFilter('all')
                  setCurrentPage(1)
                }}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition ${categoryFilter === value ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-950' : 'bg-[hsl(var(--muted))] text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'}`}
              >
                <span>{label}</span>
                {sourceCoverage && (
                  <span className={`text-[10px] ${categoryFilter === value ? 'opacity-75' : 'text-gray-400 dark:text-gray-500'}`}>
                    {value === 'etsy'
                      ? `${sourceCoverage[value].itemCount}条 · 专项`
                      : `${sourceCoverage[value].itemCount}条 · ${sourceCoverage[value].websiteCount}站`}
                  </span>
                )}
              </button>
            ))}
            {plannerProfile && (
              <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">
                联网配置：{plannerProfile.name} · {plannerProfile.model}
              </span>
            )}
          </div>

          {sourceCoverage && (
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {(['etsy', 'ecommerce', 'social', 'design'] as const).map((platformType) => (
                <div key={platformType} className="rounded-xl border border-[hsl(var(--separator))] bg-[hsl(var(--muted)/0.45)] px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-gray-600 dark:text-gray-300">
                    <span>{CATEGORY_META[platformType].label}来源</span>
                    <span className="text-gray-400 dark:text-gray-500">
                      {platformType === 'etsy' ? 'Etsy 专项' : `${sourceCoverage[platformType].websiteCount} 个网站`}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-gray-400 dark:text-gray-500">
                    {platformType === 'etsy'
                      ? 'Trending Now · Marketplace Insights · 热门 Listing · 买家评论'
                      : sourceCoverage[platformType].platforms.join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          )}

          {report && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="search"
                value={resultQuery}
                onChange={(event) => {
                  setResultQuery(event.target.value)
                  setCurrentPage(1)
                }}
                placeholder="筛选当前结果中的标题、平台、国家或趋势词"
                aria-label="筛选当前全球信息结果"
                className="ios-field h-9 min-w-0 flex-1 px-3 text-xs"
              />
              <select
                value={platformFilter}
                onChange={(event) => {
                  setPlatformFilter(event.target.value)
                  setCurrentPage(1)
                }}
                aria-label="筛选来源平台"
                className="ios-field h-9 min-w-44 px-3 text-xs text-gray-700 dark:text-gray-200"
              >
                <option value="all">全部来源平台</option>
                {availablePlatforms.map((platform) => (
                  <option key={platform} value={platform}>{platform}</option>
                ))}
              </select>
              <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
                {visibleItems.length
                  ? `显示 ${(currentPage - 1) * RESULTS_PER_PAGE + 1}–${Math.min(currentPage * RESULTS_PER_PAGE, visibleItems.length)} / ${visibleItems.length} 条`
                  : '显示 0 条'}
              </span>
            </div>
          )}
        </div>

        {profileValidation && (
          <div className="m-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100 sm:m-5">
            <div className="font-semibold">需要先配置支持联网搜索的 AI 策划接口</div>
            <div className="mt-1 text-xs leading-relaxed opacity-80">{profileValidation}。建议使用支持 `/v1/responses` 和 `web_search` 的配置。</div>
            <button
              type="button"
              onClick={() => setShowSettings(true, 'api')}
              className="mt-3 rounded-lg bg-amber-900 px-3 py-2 text-xs font-semibold text-white dark:bg-amber-200 dark:text-amber-950"
            >
              打开 API 配置
            </button>
          </div>
        )}

        {!profileValidation && error && (
          <div className="m-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-100 sm:m-5">
            <div className="font-semibold">全球信息搜索失败</div>
            <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed opacity-85">{error}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void loadInsights(windowDays, activeSearchQuery)}
                disabled={loading}
                className="rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 dark:bg-red-200 dark:text-red-950"
              >
                重新搜索
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(true, 'api')}
                className="rounded-lg border border-red-300/70 px-3 py-2 text-xs font-semibold dark:border-red-300/20"
              >
                检查联网配置
              </button>
            </div>
          </div>
        )}

        {loading && !report && !profileValidation && (
          <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="ios-card animate-pulse p-4">
                <div className="h-4 w-24 rounded bg-gray-200 dark:bg-white/[0.08]" />
                <div className="mt-4 h-5 w-4/5 rounded bg-gray-200 dark:bg-white/[0.08]" />
                <div className="mt-3 h-3 w-full rounded bg-gray-100 dark:bg-white/[0.05]" />
                <div className="mt-2 h-3 w-3/4 rounded bg-gray-100 dark:bg-white/[0.05]" />
                <div className="mt-5 h-16 rounded-lg bg-gray-100 dark:bg-white/[0.05]" />
              </div>
            ))}
          </div>
        )}

        {report && (
          <div className={loading ? 'opacity-55 transition-opacity' : 'transition-opacity'}>
            <div className="border-b border-[hsl(var(--separator))] bg-[hsl(var(--muted)/0.5)] px-4 py-3 sm:px-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-200">{report.overviewZh}</p>
                <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
                  更新于 {formatGeneratedAt(report.generatedAt)}
                </span>
              </div>
            </div>

            {report.qualityWarnings.length > 0 && (
              <div className="mx-4 mt-4 rounded-xl border border-amber-200/80 bg-amber-50/80 p-3 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/[0.07] dark:text-amber-100 sm:mx-5">
                <div className="text-xs font-bold">48 条结果已完整返回 · 来源分布提醒</div>
                <div className="mt-1 space-y-1 text-[11px] leading-relaxed opacity-80">
                  {report.qualityWarnings.slice(0, 3).map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                  {report.qualityWarnings.length > 3 && (
                    <p>另有 {report.qualityWarnings.length - 3} 条来源提示，刷新时系统会继续优先增加平台多样性。</p>
                  )}
                </div>
              </div>
            )}

            <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3">
              {pagedItems.map((item) => {
                const category = CATEGORY_META[item.platformType]
                return (
                  <article key={item.id} className="ios-card flex min-h-full flex-col p-4">
                    <InsightThumbnail
                      imageUrl={item.imageUrl}
                      sourceUrl={item.sourceUrl}
                      title={item.titleZh}
                      platform={item.platform}
                    />
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-md px-2 py-1 text-[10px] font-bold ${category.tone}`}>{category.label}</span>
                        <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{item.platform}</span>
                      </div>
                      <span className="text-xs font-black text-gray-300 dark:text-gray-600">#{item.rank}</span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-gray-500 dark:text-gray-400">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-white/[0.05]">{item.countryOrRegion}</span>
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-white/[0.05]">{item.publishedOrObservedAt}</span>
                    </div>

                    <h3 className="mt-3 text-[15px] font-bold leading-snug text-gray-900 dark:text-gray-100">{item.titleZh}</h3>
                    {item.title !== item.titleZh && (
                      <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">{item.title}</div>
                    )}
                    <p className="mt-3 text-xs leading-relaxed text-gray-600 dark:text-gray-300">{item.summaryZh}</p>

                    <div className={`mt-3 rounded-xl p-3 ${item.platformType === 'etsy' ? 'bg-rose-50/90 dark:bg-rose-400/[0.07]' : 'bg-orange-50/80 dark:bg-orange-400/[0.07]'}`}>
                      <div className={`text-[11px] font-bold ${item.platformType === 'etsy' ? 'text-rose-700 dark:text-rose-200' : 'text-orange-700 dark:text-orange-200'}`}>
                        {item.platformType === 'etsy' ? 'Etsy 卖家机会' : '为什么热'}
                      </div>
                      <p className={`mt-1 text-xs leading-relaxed ${item.platformType === 'etsy' ? 'text-rose-900/80 dark:text-rose-100/80' : 'text-orange-900/80 dark:text-orange-100/80'}`}>{item.whyHotZh}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.heatSignals.map((signal) => (
                          <span key={signal} className={`rounded-md bg-white/80 px-2 py-1 text-[10px] dark:bg-white/[0.06] ${item.platformType === 'etsy' ? 'text-rose-700 dark:text-rose-200' : 'text-orange-700 dark:text-orange-200'}`}>{signal}</span>
                        ))}
                      </div>
                    </div>

                    <div className="mt-3 space-y-2">
                      <div className="text-[11px] font-bold text-gray-600 dark:text-gray-300">高热评论 / 反馈</div>
                      {item.topComments.map((comment, commentIndex) => (
                        <div key={`${item.id}-comment-${commentIndex}`} className="rounded-xl border border-gray-100 bg-gray-50/80 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]">
                          <p className="text-xs leading-relaxed text-gray-700 dark:text-gray-200">“{comment.summaryZh}”</p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-400 dark:text-gray-500">
                            <span>{comment.stanceZh}</span>
                            <span>·</span>
                            <span>{comment.heatSignal}</span>
                            {comment.sourceUrl && (
                              <a href={comment.sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-auto font-medium text-blue-600 hover:underline dark:text-blue-300">
                                评论来源
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-auto pt-4">
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:underline dark:text-blue-300"
                      >
                        查看原始来源
                        <ExternalLinkIcon className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </article>
                )
              })}
            </div>

            <div className="flex flex-col gap-2 border-t border-[hsl(var(--separator))] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <span className="text-xs text-gray-400 dark:text-gray-500">每页 {RESULTS_PER_PAGE} 条</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  disabled={currentPage <= 1}
                  className="ios-button h-8 px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                >
                  上一页
                </button>
                <span className="min-w-16 text-center text-xs font-medium text-gray-600 dark:text-gray-300">
                  第 {currentPage} / {totalPages} 页
                </span>
                <button
                  type="button"
                  onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                  disabled={currentPage >= totalPages}
                  className="ios-button h-8 px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="px-1 text-xs leading-relaxed text-gray-400 dark:text-gray-500">
        每次进入页面会自动发起一次综合热点搜索；提交搜索词、切换 3 天/7 天或点击“立即刷新”都会产生新的 API 请求。
      </div>
    </section>
  )
}
