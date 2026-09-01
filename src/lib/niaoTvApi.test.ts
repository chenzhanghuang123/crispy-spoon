import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callImageApi } from './api'
import {
  createDefaultNiaoTvProfile,
  DEFAULT_NIAOTV_BASE_URL,
  DEFAULT_NIAOTV_MODEL,
  DEFAULT_SETTINGS,
  normalizeSettings,
  switchApiProfileProvider,
} from './apiProfiles'
import { getNiaoTvAccountOverview } from './niaoTvApi'
import { callNiaoTvImageApi } from './niaoTvImageApi'
import { normalizeParamsForSettings } from './paramCompatibility'

const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function settingsForProfile(profile: ReturnType<typeof createDefaultNiaoTvProfile>) {
  return {
    ...DEFAULT_SETTINGS,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    apiMode: profile.apiMode,
    profiles: [profile],
    activeProfileId: profile.id,
    amazonPlannerProfileId: '',
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('NiaoTV API integration', () => {
  it('normalizes and switches the built-in provider without affecting other profiles', () => {
    const switched = switchApiProfileProvider(DEFAULT_SETTINGS.profiles[0], 'niaotv')
    expect(switched).toMatchObject({
      provider: 'niaotv',
      baseUrl: DEFAULT_NIAOTV_BASE_URL,
      model: DEFAULT_NIAOTV_MODEL,
      apiMode: 'images',
    })

    const normalized = normalizeSettings({
      profiles: [{ ...createDefaultNiaoTvProfile(), apiMode: 'chat', model: 'unsupported-model' }],
      activeProfileId: 'missing',
    })
    expect(normalized.profiles[0]).toMatchObject({ provider: 'niaotv', model: DEFAULT_NIAOTV_MODEL, apiMode: 'images' })
  })

  it('loads token balance and recent usage from the documented account endpoints', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ used_tokens: 80, remaining_tokens: 920, availability: 'available' }))
      .mockResolvedValueOnce(jsonResponse({ used_tokens: 80, total: 1, data: [{ task_id: 'task-1', tokens: 80 }] }))

    const overview = await getNiaoTvAccountOverview(createDefaultNiaoTvProfile({ apiKey: 'test-account-key' }), { limit: 5 })

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://ai-proxy.niaotv.art/v1/account/token-balance',
      'https://ai-proxy.niaotv.art/v1/account/usage?limit=5&offset=0',
    ])
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-account-key' }))
    expect(overview.balance.remaining_tokens).toBe(920)
    expect(overview.usage.data?.[0]?.tokens).toBe(80)
  })

  it('checks config, quote and balance before routing GPT Image generation to the direct endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/provider/config')) return jsonResponse({
        generation_allowed: true,
        models: [{
          id: 'gpt-image-2',
          protocol: 'openai_images',
          available: true,
          operations: ['image_generation', 'image_edit'],
          parameters: {
            size: { values: ['auto', '1024x1024', '2048x1536'] },
            quality: { values: ['auto', 'low', 'medium', 'high'] },
          },
          input_limits: { max_reference_images: 6 },
        }],
      })
      if (url.endsWith('/v1/provider/config/quote')) return jsonResponse({
        total_tokens: 130,
        generation_allowed: true,
        normalized_parameters: { size: '2048x1536', quality: 'medium', quantity: 2 },
      })
      if (url.endsWith('/v1/account/token-balance')) return jsonResponse({
        remaining_tokens: 500,
        availability: 'available',
      })
      if (url.endsWith('/v1/images/generations')) return jsonResponse({
        data: [{ b64_json: TEST_PNG_BASE64 }, { b64_json: TEST_PNG_BASE64 }],
        usage: { total_tokens: 130 },
      })
      throw new Error(`Unexpected URL: ${url}`)
    })
    const profile = createDefaultNiaoTvProfile({ id: 'niaotv-active', apiKey: 'test-generation-key' })

    const result = await callImageApi({
      settings: settingsForProfile(profile),
      prompt: 'Create a clean product hero image.',
      params: { ...DEFAULT_PARAMS, size: '2048x1536', quality: 'medium', n: 2 },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const quoteCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v1/provider/config/quote'))
    expect(JSON.parse(String(quoteCall?.[1]?.body))).toEqual({
      model: 'gpt-image-2',
      operation: 'image_generation',
      size: '2048x1536',
      quality: 'medium',
      quantity: 2,
    })
    const generationCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v1/images/generations'))
    expect(generationCall?.[0]).toBe('https://ai-direct.niaotv.art/v1/images/generations')
    expect(generationCall?.[1]?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer test-generation-key',
      'Idempotency-Key': expect.any(String),
    }))
    const body = JSON.parse(String(generationCall?.[1]?.body))
    expect(body).toMatchObject({ model: 'gpt-image-2', size: '2048x1536', quality: 'medium', n: 2 })
    expect(body.output_format).toBeUndefined()
    expect(body.moderation).toBeUndefined()
    expect(result.images).toHaveLength(2)
  })

  it('uses the Google protocol for Nano Banana reference-image generation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/provider/config')) return jsonResponse({
        generation_allowed: true,
        models: [{
          id: 'gemini-3.1-flash-image',
          protocol: 'google_genai',
          available: true,
          operations: ['image_generation', 'image_edit'],
          parameters: {
            image_size: { values: ['1K', '2K', '4K'] },
            aspect_ratio: { values: ['1:1', '16:9', '9:16'] },
          },
          input_limits: { max_reference_images: 6 },
        }],
      })
      if (url.endsWith('/v1/provider/config/quote')) return jsonResponse({
        total_tokens: 80,
        generation_allowed: true,
        normalized_parameters: { image_size: '1K', aspect_ratio: '1:1' },
      })
      if (url.endsWith('/v1/account/token-balance')) return jsonResponse({ availability: 'unlimited', remaining_tokens: null })
      if (url.includes(':generateContent')) return jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: TEST_PNG_BASE64 } }] } }],
        usageMetadata: { totalTokenCount: 80 },
      })
      throw new Error(`Unexpected URL: ${url}`)
    })

    const result = await callNiaoTvImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'Keep the product unchanged.',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      inputImageDataUrls: ['data:image/png;base64,cmVmZXJlbmNl'],
    }, createDefaultNiaoTvProfile({ model: 'gemini-3.1-flash-image', apiKey: 'test-banana-key' }))

    const generationCall = fetchMock.mock.calls.find(([input]) => String(input).includes(':generateContent'))
    expect(generationCall?.[0]).toBe('https://ai-direct.niaotv.art/v1beta/models/gemini-3.1-flash-image:generateContent')
    const body = JSON.parse(String(generationCall?.[1]?.body))
    expect(body.contents[0].parts[1].inlineData).toEqual({ mimeType: 'image/png', data: 'cmVmZXJlbmNl' })
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '1K' })
    expect(result.images).toEqual([`data:image/png;base64,${TEST_PNG_BASE64}`])
  })

  it('normalizes unsupported workspace parameters and stops before generation when points are insufficient', async () => {
    const profile = createDefaultNiaoTvProfile({ apiKey: 'test-low-balance-key' })
    const normalizedParams = normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, output_format: 'webp', output_compression: 30, moderation: 'low', n: 9 },
      settingsForProfile(profile),
    )
    expect(normalizedParams).toMatchObject({ output_format: 'png', output_compression: null, moderation: 'auto', n: 4 })

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        generation_allowed: true,
        models: [{
          id: 'gpt-image-2', protocol: 'openai_images', available: true,
          operations: ['image_generation'], parameters: { size: { values: ['1024x1024'] }, quality: { values: ['medium'] } },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ total_tokens: 65, generation_allowed: true }))
      .mockResolvedValueOnce(jsonResponse({ remaining_tokens: 20, availability: 'available' }))

    await expect(callNiaoTvImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x1024', quality: 'medium' },
      inputImageDataUrls: [],
    }, profile)).rejects.toThrow('积分不足')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
