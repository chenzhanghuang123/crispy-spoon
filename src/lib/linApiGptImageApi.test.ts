import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callImageApi } from './api'
import { createDefaultLinApiGptProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { callLinApiGptImageApi, getLinApiGptImageSize } from './linApiGptImageApi'

const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('LinAPI GPT image adapter', () => {
  it('maps workspace dimensions to supported GPT Image sizes', () => {
    expect(getLinApiGptImageSize('1024x1024')).toBe('1024x1024')
    expect(getLinApiGptImageSize('2048x1536')).toBe('1536x1024')
    expect(getLinApiGptImageSize('1536x2048')).toBe('1024x1536')
    expect(getLinApiGptImageSize('auto')).toBe('1024x1024')
  })

  it('sends the Images API generation request body documented by LinAPI', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: TEST_PNG_BASE64 }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callLinApiGptImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'Generate a product hero image.',
      params: { ...DEFAULT_PARAMS, size: '2048x1536', quality: 'high', output_format: 'png', n: 12 },
      inputImageDataUrls: [],
    }, createDefaultLinApiGptProfile({
      apiKey: 'linapi-gpt-test-key',
      responseFormatB64Json: true,
    }))

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.linapi.net/v1/images/generations')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer linapi-gpt-test-key',
      'Content-Type': 'application/json',
    }))
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-image-2-4K',
      prompt: 'Generate a product hero image.',
      size: '1536x1024',
      quality: 'hd',
      style: 'vivid',
      n: 10,
      response_format: 'b64_json',
    })
    expect(result.images).toEqual([`data:image/png;base64,${TEST_PNG_BASE64}`])
    expect(result.actualParams).toMatchObject({ size: '1536x1024', quality: 'high', n: 1 })
  })

  it('sends reference images through Images Edits multipart requests', async () => {
    const nativeFetch = globalThis.fetch
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).startsWith('data:')) return nativeFetch(input, init)
      return new Response(JSON.stringify({
        data: [{ b64_json: TEST_PNG_BASE64 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    await callLinApiGptImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'Keep the product unchanged.',
      params: { ...DEFAULT_PARAMS, size: '1024x1536', quality: 'medium' },
      inputImageDataUrls: ['data:image/webp;base64,cmVmZXJlbmNl'],
    }, createDefaultLinApiGptProfile({ apiKey: 'linapi-key' }))

    const apiCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/images/edits'))
    expect(apiCall?.[0]).toBe('https://www.linapi.net/v1/images/edits')
    const init = apiCall?.[1] as RequestInit
    expect(init.headers).toEqual({ Authorization: 'Bearer linapi-key' })
    const formData = init.body as FormData
    expect(formData.get('model')).toBe('gpt-image-2-4K')
    expect(formData.get('prompt')).toBe('Keep the product unchanged.')
    expect(formData.get('size')).toBe('1024x1536')
    expect(formData.get('quality')).toBe('standard')
    expect(formData.get('style')).toBe('vivid')
    expect(formData.get('n')).toBe('1')
    expect(formData.get('response_format')).toBe('url')
    expect(formData.getAll('image[]')).toHaveLength(1)
  })

  it('downloads URL results and routes the built-in provider through callImageApi', async () => {
    const imageUrl = 'https://cdn.example.com/generated.png'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: imageUrl }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Blob(['image-bytes'], { type: 'image/png' }), { status: 200 }))
    const profile = createDefaultLinApiGptProfile({ id: 'linapi-gpt-active', apiKey: 'route-key' })

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        model: profile.model,
        apiMode: profile.apiMode,
        profiles: [profile],
        activeProfileId: profile.id,
        amazonPlannerProfileId: '',
      },
      prompt: 'Generate a product hero image.',
      params: { ...DEFAULT_PARAMS, size: '1024x1536' },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
    expect(body.prompt).toContain('expected image resolution 1024x1536 px')
    expect(body.size).toBe('1024x1536')
    expect(body.response_format).toBe('url')
    expect(result.images[0]).toMatch(/^data:image\/png;base64,/)
    expect(result.rawImageUrls).toEqual([imageUrl])
  })

  it('accepts images embedded in chat-style and Markdown response content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          images: [{ image_url: { url: `data:image/png;base64,${TEST_PNG_BASE64}` } }],
          content: `Generated result: ![image](data:image/png;base64,${TEST_PNG_BASE64})`,
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callLinApiGptImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    }, createDefaultLinApiGptProfile({ apiKey: 'linapi-key' }))

    expect(result.images).toEqual([`data:image/png;base64,${TEST_PNG_BASE64}`])
  })

  it('retries transient LinAPI gateway errors once', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        title: 'Error 502: Bad gateway',
        detail: 'The origin web server returned an invalid or incomplete response to Cloudflare.',
        retryable: true,
        retry_after: 0,
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: TEST_PNG_BASE64 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const result = await callLinApiGptImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    }, createDefaultLinApiGptProfile({ apiKey: 'linapi-key' }))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.images).toEqual([`data:image/jpeg;base64,${TEST_PNG_BASE64}`])
  })

  it('attaches the raw response when no image can be recognized', async () => {
    const payload = { choices: [{ message: { content: 'The image could not be generated.' } }] }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const request = callLinApiGptImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    }, createDefaultLinApiGptProfile({ apiKey: 'linapi-key' }))

    await expect(request).rejects.toMatchObject({
      message: expect.stringContaining('没有可识别的图片数据'),
      rawResponsePayload: JSON.stringify(payload, null, 2),
    })
  })

  it('reports non-JSON success responses without throwing parser internals', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<!doctype html><title>Bad gateway</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }))

    const request = callLinApiGptImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    }, createDefaultLinApiGptProfile({ apiKey: 'linapi-key' }))

    await expect(request).rejects.toMatchObject({
      message: expect.stringContaining('非 JSON 响应'),
      rawResponsePayload: '<!doctype html><title>Bad gateway</title>',
    })
  })
})
