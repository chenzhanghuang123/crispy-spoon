import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLikelyImageGenerationModel, listAvailableModels } from './modelApi'

describe('isLikelyImageGenerationModel', () => {
  it.each([
    'gpt-image-2',
    'gpt-image-2.5-exact',
    'google/gemini-3.1-flash-image-preview',
    'gemini-3-pro-image-preview',
    'gemini-nano-banana-2.1',
    'imagen-4',
    'dall-e-3',
  ])('recognizes image generation model %s', (model) => {
    expect(isLikelyImageGenerationModel(model)).toBe(true)
  })

  it.each(['gpt-6.1-sol', 'gpt-5.5', 'deepseek-chat', 'google/gemini-2.5-pro'])('keeps planner model %s', (model) => {
    expect(isLikelyImageGenerationModel(model)).toBe(false)
  })
})

describe('listAvailableModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads and deduplicates OpenAI-compatible models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'gpt-6.1-sol', object: 'model' },
        { id: 'gpt-5.5', object: 'model' },
        { id: 'gpt-6.1-sol', object: 'model' },
        { id: '' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listAvailableModels({
      baseUrl: 'https://api.bananapro.top/v1',
      apiKey: 'test-key',
      apiProxy: false,
    })).resolves.toEqual(['gpt-6.1-sol', 'gpt-5.5'])

    expect(fetchMock).toHaveBeenCalledWith('https://api.bananapro.top/v1/models', expect.objectContaining({
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-key',
        Accept: 'application/json',
      },
    }))
  })

  it('surfaces the provider error when model discovery fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: '令牌无权访问模型列表' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })))

    await expect(listAvailableModels({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      apiProxy: false,
    })).rejects.toThrow('HTTP 403: 令牌无权访问模型列表')
  })
})
