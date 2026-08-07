import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { callGlobalInsightsApi } from './globalInsightsApi'

function createItems() {
  const recentDate = new Date().toISOString().slice(0, 10)
  return (['etsy', 'ecommerce', 'social', 'design'] as const).flatMap((platformType) =>
    Array.from({ length: 12 }, (_, index) => {
      const sourceUrl = platformType === 'etsy'
        ? `https://www.etsy.com/listing/${1000 + index}/etsy-product-${index + 1}`
        : `https://${platformType}-${index + 1}.example.com/${index + 1}`
      return {
        platformType,
        platform: platformType === 'etsy' ? 'Etsy' : `${platformType}-platform-${index + 1}`,
        countryOrRegion: index % 2 === 0 ? 'United States' : 'United Kingdom',
        title: `${platformType} original title ${index + 1}`,
        titleZh: `${platformType} 中文标题 ${index + 1}`,
        summaryZh: '这是基于近期公开页面的摘要。',
        whyHotZh: '近期公开互动与排名信号快速上升。',
        publishedOrObservedAt: `${recentDate} observed`,
        heatSignals: ['近期排名上升', '公开互动较高'],
        sourceUrl,
        imageUrl: `https://images.example.com/${platformType}-${index + 1}.jpg`,
        topComments: [{
          summaryZh: '用户认为这个项目实用且设计清晰。',
          stanceZh: '正面',
          heatSignal: '公开页面高赞评论',
          sourceUrl: `${sourceUrl}#comment`,
        }],
      }
    }),
  )
}

const VALID_ITEMS = createItems()

function createPayload(items = VALID_ITEMS) {
  return {
    overviewZh: '近三天高热内容集中在实用产品、社区讨论与简洁设计。',
    etsyItems: items.filter((item) => item.platformType === 'etsy'),
    ecommerceItems: items.filter((item) => item.platformType === 'ecommerce'),
    socialItems: items.filter((item) => item.platformType === 'social'),
    designItems: items.filter((item) => item.platformType === 'design'),
  }
}

const VALID_PAYLOAD = createPayload()

function responsePayload(payload: unknown = VALID_PAYLOAD, includeWebSearch = true) {
  return {
    output: [
      ...(includeWebSearch ? [{ type: 'web_search_call', status: 'completed' }] : []),
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callGlobalInsightsApi', () => {
  it('uses Responses web search and returns 48 insights with 12 results in every category', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(
      JSON.stringify(responsePayload()),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        apiMode: 'chat',
        model: 'gpt-search-model',
      }),
      windowDays: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.example.com/v1/responses')
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'high' }])
    expect(body.stream).toBe(true)
    expect(body.text.format.name).toBe('global_recent_insights')
    expect(body.text.format.schema.properties.etsyItems.minItems).toBe(12)
    expect(body.text.format.schema.properties.ecommerceItems.minItems).toBe(12)
    expect(body.text.format.schema.properties.socialItems.minItems).toBe(12)
    expect(body.text.format.schema.properties.designItems.minItems).toBe(12)
    expect(body.text.format.schema.properties.etsyItems.items.properties.imageUrl.type).toBe('string')
    expect(body.instructions).toContain('Etsy is the seller’s priority')
    expect(body.instructions).toContain('Do not place Etsy results in ecommerce')
    expect(body.instructions).toContain('target 6 to 10 different mainstream platform families per category')
    expect(body.instructions).toContain('Never use shortened or redirect URLs such as amzn.com')
    expect(body.instructions).toContain('Amazon Best Sellers')
    expect(body.instructions).toContain('Reddit, YouTube, TikTok')
    expect(body.instructions).toContain('Behance Best of Behance')
    expect(body.instructions).toContain('provide imageUrl')
    expect(report.webResearchUsed).toBe(true)
    expect(report.searchQuery).toBe('')
    expect(report.items).toHaveLength(48)
    expect(report.items.filter((item) => item.platformType === 'etsy')).toHaveLength(12)
    expect(report.items.filter((item) => item.platformType === 'ecommerce')).toHaveLength(12)
    expect(report.items.filter((item) => item.platformType === 'social')).toHaveLength(12)
    expect(report.items.filter((item) => item.platformType === 'design')).toHaveLength(12)
    expect(report.items.every((item) => item.imageUrl.startsWith('https://images.example.com/'))).toBe(true)
    expect(report.qualityWarnings).toEqual([])
  })

  it('uses a custom topic as a literal cross-platform web search focus', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(
      JSON.stringify(responsePayload()),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
        model: 'gpt-search-model',
      }),
      windowDays: 3,
      searchQuery: '  personalized jewelry  ',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.instructions).toContain('literal search topic is "personalized jewelry"')
    expect(body.instructions).toContain('Every returned result must be directly and materially relevant')
    expect(body.input).toContain('search topic "personalized jewelry"')
    expect(report.searchQuery).toBe('personalized jewelry')
  })

  it('splits local Cockpit seven-day searches into four sequential category requests', async () => {
    const progress: Array<{ completed: number; total: number; platformType: string }> = []
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      const platformType = String(body.text.format.name).replace('global_recent_', '') as 'etsy' | 'ecommerce' | 'social' | 'design'
      const payload = {
        overviewZh: `${platformType} 七天趋势总览`,
        items: VALID_ITEMS.filter((item) => item.platformType === platformType),
      }
      return new Response(JSON.stringify(responsePayload(payload)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'http://localhost:4604/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 7,
      onProgress: (nextProgress) => progress.push(nextProgress),
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const requestBodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
    expect(requestBodies.map((body) => body.text.format.name)).toEqual([
      'global_recent_etsy',
      'global_recent_ecommerce',
      'global_recent_social',
      'global_recent_design',
    ])
    expect(requestBodies.every((body) => JSON.stringify(body.tools) === JSON.stringify([{ type: 'web_search' }]))).toBe(true)
    expect(progress[0]).toEqual({ completed: 0, total: 4, platformType: 'etsy' })
    expect(progress[progress.length - 1]).toEqual({ completed: 4, total: 4, platformType: 'design' })
    expect(report.windowDays).toBe(7)
    expect(report.items).toHaveLength(48)
    expect(report.items.filter((item) => item.platformType === 'etsy')).toHaveLength(12)
    expect(report.items.filter((item) => item.platformType === 'ecommerce')).toHaveLength(12)
    expect(report.items.filter((item) => item.platformType === 'social')).toHaveLength(12)
    expect(report.items.filter((item) => item.platformType === 'design')).toHaveLength(12)
  })

  it('automatically retries when the browser connection fails before a response starts', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify(responsePayload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'http://localhost:4604/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(report.windowDays).toBe(3)
    expect(report.items).toHaveLength(48)
  })

  it('automatically retries when a streamed response connection is interrupted', async () => {
    const interruptedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('connection terminated'))
      },
    })
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(interruptedStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(responsePayload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'http://localhost:4604/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(report.items).toHaveLength(48)
  })

  it('retries with the standard web search tool when a compatible endpoint rejects search_context_size', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Unknown parameter: search_context_size' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(responsePayload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(secondBody.tools).toEqual([{ type: 'web_search' }])
    expect(report.windowDays).toBe(3)
    expect(report.webResearchUsed).toBe(true)
  })

  it('accepts Cockpit SSE responses even when stream is disabled in the request', async () => {
    const completedPayload = responsePayload()
    const sseText = [
      'event: response.web_search_call.completed',
      `data: ${JSON.stringify({ type: 'response.web_search_call.completed', item: { type: 'web_search_call', status: 'completed' } })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ type: 'response.completed', response: completedPayload })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(
      sseText,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'http://localhost:4604/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(report.items).toHaveLength(48)
    expect(report.webResearchUsed).toBe(true)
  })

  it('detects SSE bodies returned with a non-stream content type', async () => {
    const sseText = [
      'event: response.completed',
      `data: ${JSON.stringify({ type: 'response.completed', response: responsePayload() })}`,
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseText, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })))

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'http://localhost:4604/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(report.windowDays).toBe(3)
    expect(report.webResearchUsed).toBe(true)
  })

  it('repairs an incomplete researched response without losing its verified status', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify(responsePayload({
        ...VALID_PAYLOAD,
        ecommerceItems: VALID_PAYLOAD.ecommerceItems.slice(0, 11),
      })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(responsePayload(VALID_PAYLOAD, false)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const repairBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(repairBody.tools).toEqual([{ type: 'web_search' }])
    expect(repairBody.input).toContain('Repair the previous global insights JSON')
    expect(report.items).toHaveLength(48)
    expect(report.webResearchUsed).toBe(true)
  })

  it('returns complete results with a non-blocking warning when one category lacks website diversity', async () => {
    const lowDiversityPayload = {
      ...VALID_PAYLOAD,
      socialItems: VALID_PAYLOAD.socialItems.map((item) => ({
        ...item,
        platform: 'Single Social Platform',
        sourceUrl: `https://single-social.example.com/${item.title}`,
      })),
    }
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(
      JSON.stringify(responsePayload(lowDiversityPayload)),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(report.items).toHaveLength(48)
    expect(report.qualityWarnings.some((warning) => warning.includes('social 分类当前覆盖 1 个主流平台'))).toBe(true)
    expect(report.qualityWarnings.some((warning) => warning.includes('single-social.example.com 占 12 条'))).toBe(true)
  })

  it('keeps complete Etsy results visible and warns when a source is not official Etsy', async () => {
    const invalidEtsyPayload = {
      ...VALID_PAYLOAD,
      etsyItems: VALID_PAYLOAD.etsyItems.map((item) => ({
        ...item,
        sourceUrl: item.sourceUrl.replace('etsy.com', 'third-party.example.com'),
      })),
    }
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(
      JSON.stringify(responsePayload(invalidEtsyPayload)),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(report.items.filter((item) => item.platformType === 'etsy')).toHaveLength(12)
    expect(report.qualityWarnings.some((warning) => warning.includes('不是 Etsy 官方页面'))).toBe(true)
  })

  it('does not discard all 48 results when Amazon short links exceed the preferred share', async () => {
    const repeatedAmazonPayload = {
      ...VALID_PAYLOAD,
      ecommerceItems: VALID_PAYLOAD.ecommerceItems.map((item, index) => index < 4
        ? { ...item, platform: 'Amazon', sourceUrl: `https://amzn.com/dp/PRODUCT${index + 1}` }
        : item),
    }
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(
      JSON.stringify(responsePayload(repeatedAmazonPayload)),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(report.items).toHaveLength(48)
    expect(report.qualityWarnings.some((warning) => warning.includes('amazon 占 4 条'))).toBe(true)
  })

  it('replaces results whose only evidence date is outside the selected window', async () => {
    const stalePayload = {
      ...VALID_PAYLOAD,
      etsyItems: VALID_PAYLOAD.etsyItems.map((item, index) => index === 0
        ? { ...item, publishedOrObservedAt: '2025-07-30 published' }
        : item),
    }
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify(responsePayload(stalePayload)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(responsePayload(VALID_PAYLOAD)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const report = await callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const repairBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(repairBody.tools).toEqual([{ type: 'web_search' }])
    expect(repairBody.input).toContain('不在近 3 天时间窗口内')
    expect(report.items).toHaveLength(48)
  })

  it('explains how to refresh an expired Cockpit local access key', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(
      JSON.stringify({
        error: {
          type: 'codex_local_access_error',
          message: '本地访问秘钥无效',
        },
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(callGlobalInsightsApi({
      profile: createDefaultOpenAIProfile({
        baseUrl: 'http://localhost:4604/v1',
        apiKey: 'expired-key',
        apiMode: 'responses',
      }),
      windowDays: 3,
    })).rejects.toThrow('Cockpit 本地访问密钥已失效或已经更换')
  })
})
