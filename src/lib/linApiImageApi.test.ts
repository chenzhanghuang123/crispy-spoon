import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultLinApiProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { callImageApi } from './api'
import { callLinApiImageApi, getLinApiAspectRatio, getLinApiImageSize, getLinApiRequestModel } from './linApiImageApi'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LinAPI Gemini image adapter', () => {
  it('maps workspace dimensions to LinAPI size tiers and supported ratios', () => {
    expect(getLinApiImageSize('1024x1024', 'gemini-3-pro-image-preview')).toBe('1K')
    expect(getLinApiImageSize('2048x2048', 'gemini-3-pro-image-preview')).toBe('2K')
    expect(getLinApiImageSize('2880x2880', 'gemini-3-pro-image-preview')).toBe('4K')
    expect(getLinApiImageSize('auto', 'gemini-3-pro-image-preview-4K')).toBe('4K')
    expect(getLinApiAspectRatio('2048x2048')).toBe('1:1')
    expect(getLinApiAspectRatio('2048x1536')).toBe('4:3')
    expect(getLinApiRequestModel('gemini-3-pro-image-preview-4K', '2K')).toBe('gemini-3-pro-image-preview-2K')
  })

  it('sends text and reference images in native generateContent format', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            },
          }],
        },
        finishReason: 'STOP',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callLinApiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'Keep the product unchanged and replace the background.',
      params: { ...DEFAULT_PARAMS, size: '2048x2048' },
      inputImageDataUrls: ['data:image/webp;base64,cmVmZXJlbmNl'],
    }, createDefaultLinApiProfile({ apiKey: 'linapi-test-key' }))

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.linapi.net/v1beta/models/gemini-3-pro-image-preview-2K:generateContent',
    )
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer linapi-test-key',
      'Content-Type': 'application/json',
    }))
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      contents: [{
        parts: [
          { text: 'Keep the product unchanged and replace the background.' },
          { inlineData: { mimeType: 'image/webp', data: 'cmVmZXJlbmNl' } },
        ],
      }],
      generationConfig: {
        imageConfig: {
          aspectRatio: '1:1',
          imageSize: '2K',
        },
      },
    })
    expect(result.images).toEqual(['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='])
    expect(result.actualParams).toMatchObject({ size: '1x1', output_format: 'png', quality: 'high', n: 1 })
  })

  it('routes a LinAPI profile through the application image API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'cm91dGVk' } }] } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const linApiProfile = createDefaultLinApiProfile({
      id: 'linapi-active',
      apiKey: 'linapi-test-key',
      model: 'gemini-3.1-flash-image-preview',
    })

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: linApiProfile.baseUrl,
        apiKey: linApiProfile.apiKey,
        model: linApiProfile.model,
        apiMode: linApiProfile.apiMode,
        profiles: [linApiProfile],
        activeProfileId: linApiProfile.id,
        amazonPlannerProfileId: '',
      },
      prompt: 'Generate a clean product hero image.',
      params: { ...DEFAULT_PARAMS, size: '2880x2880' },
      inputImageDataUrls: [],
    })

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('gemini-3.1-flash-image-preview-4K:generateContent')
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '4K' })
    expect(body.contents[0].parts[0].text).toContain('expected image resolution 2880x2880 px')
    expect(result.images).toEqual(['data:image/jpeg;base64,cm91dGVk'])
  })

  it('returns a useful error when LinAPI responds without image data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'The request could not produce an image.' }] }, finishReason: 'SAFETY' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callLinApiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultLinApiProfile({ apiKey: 'linapi-test-key' }))).rejects.toThrow(/SAFETY.*could not produce/s)
  })
})
