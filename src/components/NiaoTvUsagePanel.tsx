import { useCallback, useEffect, useState } from 'react'
import type { ApiProfile } from '../types'
import { getNiaoTvAccountOverview, type NiaoTvAccountOverview } from '../lib/niaoTvApi'
import { RefreshIcon } from './icons'

interface Props {
  profile: ApiProfile
}

function formatTokens(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '--'
}

function formatUsageTime(value: string | undefined): string {
  if (!value) return '--'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function NiaoTvUsagePanel({ profile }: Props) {
  const [overview, setOverview] = useState<NiaoTvAccountOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadOverview = useCallback(async (signal?: AbortSignal) => {
    if (!profile.apiKey.trim()) {
      setOverview(null)
      setError('')
      return
    }

    setLoading(true)
    setError('')
    try {
      setOverview(await getNiaoTvAccountOverview(profile, { limit: 5, signal }))
    } catch (requestError) {
      if (signal?.aborted) return
      setOverview(null)
      setError(requestError instanceof Error ? requestError.message : String(requestError))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [profile.apiKey, profile.baseUrl])

  useEffect(() => {
    const controller = new AbortController()
    setOverview(null)
    setError('')
    setLoading(false)
    const timer = profile.apiKey.trim()
      ? window.setTimeout(() => void loadOverview(controller.signal), 600)
      : null
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      controller.abort()
    }
  }, [profile.id, loadOverview, profile.apiKey])

  const refresh = () => {
    void loadOverview()
  }

  const remaining = overview?.balance.availability === 'unlimited'
    ? '不限额'
    : formatTokens(overview?.balance.remaining_tokens)
  const usageItems = overview?.usage.data ?? []

  return (
    <div className="block">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm text-gray-600 dark:text-gray-300">积分使用情况</span>
        <button
          type="button"
          onClick={refresh}
          disabled={loading || !profile.apiKey.trim()}
          className="ios-button ios-button-sm ios-button-tinted inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
          title="刷新积分使用情况"
        >
          <RefreshIcon className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {!profile.apiKey.trim() ? (
        <div className="text-xs text-gray-500 dark:text-gray-500">填写 API Key 后即可读取当前密钥的积分余额和最近消耗。</div>
      ) : loading && !overview ? (
        <div className="text-xs text-gray-500 dark:text-gray-500">正在读取积分账户...</div>
      ) : error ? (
        <div data-selectable-text className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : overview ? (
        <div className="space-y-3">
          <div className="grid grid-cols-3 divide-x divide-gray-200 overflow-hidden rounded-lg border border-gray-200/70 bg-gray-50/70 dark:divide-white/[0.08] dark:border-white/[0.08] dark:bg-white/[0.03]">
            <div className="min-w-0 px-3 py-2.5">
              <div className="text-[11px] text-gray-400">已用积分</div>
              <div className="mt-0.5 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{formatTokens(overview.balance.used_tokens)}</div>
            </div>
            <div className="min-w-0 px-3 py-2.5">
              <div className="text-[11px] text-gray-400">剩余积分</div>
              <div className="mt-0.5 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{remaining}</div>
            </div>
            <div className="min-w-0 px-3 py-2.5">
              <div className="text-[11px] text-gray-400">消耗记录</div>
              <div className="mt-0.5 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{formatTokens(overview.usage.total)}</div>
            </div>
          </div>

          {usageItems.length > 0 ? (
            <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200/70 dark:divide-white/[0.06] dark:border-white/[0.08]">
              {usageItems.map((item, index) => (
                <div key={item.task_id || `${item.occurred_at}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-gray-700 dark:text-gray-200">{item.model || '未知模型'}</div>
                    <div className="mt-0.5 text-[11px] text-gray-400">{formatUsageTime(item.occurred_at)}</div>
                  </div>
                  <div className="shrink-0 font-mono font-semibold text-gray-700 dark:text-gray-200">-{formatTokens(item.tokens)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-gray-500 dark:text-gray-500">当前密钥还没有最终消耗记录。</div>
          )}
        </div>
      ) : null}
    </div>
  )
}
