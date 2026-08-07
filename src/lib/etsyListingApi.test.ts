import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { DEFAULT_AMAZON_PROMPT_DRAFT } from './amazonPrompt'
import { callEtsyListingDetailsApi, formatEtsyListingDetailsMarkdown } from './listingPlannerApi'

const ETSY_LISTING_PAYLOAD = {
  marketInsightsZh: '当前买家重视真实材质、容量信息与礼赠场景，品类应按产品的主要饮用功能选择。',
  primaryCategoryEn: 'Home & Living > Kitchen & Dining > Drinkware > Mugs',
  primaryCategoryZh: '家居生活 > 厨房与餐饮 > 饮具 > 马克杯',
  alternativeCategoryEn: '',
  alternativeCategoryZh: '',
  categoryRationaleZh: '马克杯是产品的主要功能，也是买家最直接的浏览路径。',
  titleEn: 'Seafoam Ceramic Mug, Speckled Stoneware Coffee Cup',
  titleZh: '海沫绿陶瓷马克杯，斑点炻器咖啡杯',
  descriptionEn: [
    '**Heading / Hook**',
    'Bring a calm tactile moment to your daily coffee ritual.',
    '',
    '**The Story**',
    'This seafoam ceramic mug pairs a speckled stoneware body with a glossy glaze.',
    '',
    '**Why You’ll Love It**',
    '- Tactile speckled surface',
    '- Calm seafoam finish',
    '',
    '**Details & Specs**',
    '- Materials: Speckled stoneware',
    '- Dimensions: Please confirm before publishing',
    '',
    '**Perfect For**',
    '- Daily coffee and tea rituals',
  ].join('\n'),
  descriptionZh: [
    '**核心标题 / 情绪钩子**',
    '为每日咖啡时光增添安静的触感。',
    '',
    '**产品故事**',
    '海沫绿色釉面与斑点炻器杯身相结合。',
    '',
    '**你会喜欢它的原因**',
    '- 斑点肌理',
    '- 柔和海沫绿',
    '',
    '**产品详情与规格**',
    '- 材质：斑点炻器',
    '- 尺寸：发布前需要确认',
    '',
    '**适合人群与场景**',
    '- 日常咖啡与饮茶',
  ].join('\n'),
  tags: [
    'ceramic coffee mug',
    'seafoam pottery',
    'stoneware cup',
    'artisan drinkware',
    'cozy kitchen decor',
    'slow living gift',
    'gift for tea lover',
    'rustic coffee cup',
    'pottery lover gift',
    'speckled ceramic',
    'morning coffee mug',
    'housewarming mug',
    'wheel thrown mug',
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callEtsyListingDetailsApi', () => {
  it('requests web research with Responses API and returns a validated bilingual listing', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'Etsy ceramic mug trends' } },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ETSY_LISTING_PAYLOAD) }] },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callEtsyListingDetailsApi({
      listingText: 'Seafoam ceramic mug with a speckled stoneware body.',
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, material: 'Speckled stoneware' },
      referenceImageDataUrls: ['data:image/png;base64,ref'],
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
    })

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String(init?.body))
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.text.format.name).toBe('etsy_listing_details')
    expect(body.instructions).toContain('prefer fewer than 15 clear words')
    expect(body.instructions).toContain('exactly 13 unique, relevant English tags')
    expect(body.input[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'input_image', image_url: 'data:image/png;base64,ref' }),
    ]))
    expect(result.webResearchUsed).toBe(true)
    expect(result.details.researchStatus).toBe('web-verified')
    expect(result.details.tags).toHaveLength(13)
    expect(result.details.tags.every((tag) => Array.from(tag).length <= 20)).toBe(true)
  })

  it('automatically uses Responses web search for a Chat-configured profile when supported', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'current Etsy ceramic mug category' } },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ETSY_LISTING_PAYLOAD) }] },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callEtsyListingDetailsApi({
      listingText: 'Seafoam ceramic mug with a speckled stoneware body.',
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'chat',
        model: 'gpt-planner-profile',
      }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String(init?.body))
    expect(String(url)).toBe('https://api.example.com/v1/responses')
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.messages).toBeUndefined()
    expect(result.webResearchUsed).toBe(true)
    expect(result.details.researchStatus).toBe('web-verified')
  })

  it('falls back without web search when a compatible Responses endpoint rejects the tool', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Unsupported tool: web_search' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: JSON.stringify(ETSY_LISTING_PAYLOAD) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callEtsyListingDetailsApi({
      listingText: 'Seafoam ceramic mug with a speckled stoneware body.',
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(secondBody.tools).toBeUndefined()
    expect(secondBody.instructions).toContain('Live web search is unavailable')
    expect(result.webResearchUsed).toBe(false)
    expect(result.details.researchStatus).toBe('model-only')
    expect(result.details.marketInsightsZh).toContain('未完成实时联网检索')
  })

  it('repairs a Chat Completions response that omits the required tags field', async () => {
    const incompletePayload = { ...ETSY_LISTING_PAYLOAD, tags: undefined }
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Unknown endpoint: /v1/responses' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(incompletePayload) } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(ETSY_LISTING_PAYLOAD) } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callEtsyListingDetailsApi({
      listingText: 'Seafoam ceramic mug with a speckled stoneware body.',
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'chat',
        model: 'gpt-planner-profile',
      }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const responsesBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    const firstChatBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    const repairChatBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.example.com/v1/responses')
    expect(responsesBody.tools).toEqual([{ type: 'web_search' }])
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://api.example.com/v1/chat/completions')
    expect(firstChatBody.response_format).toEqual({ type: 'json_object' })
    expect(firstChatBody.messages[0].content).toContain('"marketInsightsZh"')
    expect(firstChatBody.messages[0].content).toContain('"tags"')
    expect(firstChatBody.messages[0].content).toContain('exactly 13 unique English strings')
    expect(JSON.stringify(repairChatBody.messages[1].content)).toContain('Repair the previous Etsy Listing JSON response')
    expect(result.details.tags).toEqual(ETSY_LISTING_PAYLOAD.tags)
    expect(result.details.researchStatus).toBe('model-only')
  })

  it('formats the final output in the requested unified order', () => {
    const markdown = formatEtsyListingDetailsMarkdown({
      ...ETSY_LISTING_PAYLOAD,
      researchStatus: 'web-verified',
    })

    expect(markdown.indexOf('## 1. Market & Verification Insights')).toBeLessThan(markdown.indexOf('## 2. Recommended Etsy Category'))
    expect(markdown.indexOf('## 2. Recommended Etsy Category')).toBeLessThan(markdown.indexOf('## 3. Optimized SEO Title'))
    expect(markdown.indexOf('## 3. Optimized SEO Title')).toBeLessThan(markdown.indexOf('## 4. High-Converting Description'))
    expect(markdown.indexOf('## 4. High-Converting Description')).toBeLessThan(markdown.indexOf('## 5. 13 Golden Tags'))
    expect(markdown).toContain('13. wheel thrown mug')
  })
})
