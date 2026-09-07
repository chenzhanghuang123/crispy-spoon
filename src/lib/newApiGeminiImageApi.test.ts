import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callImageApi } from './api'
import { createDefaultNewApiGeminiProfile, DEFAULT_SETTINGS } from './apiProfiles'
import {
  callNewApiGeminiImageApi,
  getNewApiGeminiAspectRatio,
  getNewApiGeminiImageSize,
} from './newApiGeminiImageApi'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('New API Gemini native image adapter', () => {
  it('maps workspace dimensions to Gemini size tiers and aspect ratios', () => {
    expect(getNewApiGeminiImageSize('1024x1024')).toBe('1K')
    expect(getNewApiGeminiImageSize('2048x1536')).toBe('2K')
    expect(getNewApiGeminiImageSize('2880x2880')).toBe('4K')
    expect(getNewApiGeminiAspectRatio('1024x1536')).toBe('2:3')
    expect(getNewApiGeminiAspectRatio('2048x1536')).toBe('4:3')
    expect(getNewApiGeminiAspectRatio('2560x1080')).toBe('21:9')
  })

  it('sends Bearer-authenticated native generateContent requests with reference images', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              mimeType: 'image/png',
              data: 'aW1hZ2U=',
            },
          }],
        },
        finishReason: 'STOP',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultNewApiGeminiProfile({
      baseUrl: 'https://newapi.example.com/v1/',
      apiKey: 'newapi-test-key',
      model: 'gemini-image-model',
    })

    const result = await callNewApiGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'Keep the product unchanged and replace the background.',
      params: { ...DEFAULT_PARAMS, size: '2048x1536' },
      inputImageDataUrls: ['data:image/webp;base64,cmVmZXJlbmNl'],
    }, profile)

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://newapi.example.com/v1beta/models/gemini-image-model:generateContent/',
    )
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer newapi-test-key',
      'Content-Type': 'application/json',
    }))
    expect(JSON.parse(String(init.body))).toEqual({
      contents: [{
        role: 'user',
        parts: [
          { text: 'Keep the product unchanged and replace the background.' },
          { inlineData: { mimeType: 'image/webp', data: 'cmVmZXJlbmNl' } },
        ],
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '4:3', imageSize: '2K' },
      },
    })
    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
    expect(result.actualParams).toMatchObject({ output_format: 'png', quality: 'high', n: 1 })
  })

  it('routes the built-in provider through the application image API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'cm91dGVk' } }] } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultNewApiGeminiProfile({
      id: 'newapi-gemini-active',
      baseUrl: 'https://newapi.example.com',
      apiKey: 'route-key',
      model: 'gemini-image-model',
    })

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
      prompt: 'Generate a clean product hero image.',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      inputImageDataUrls: [],
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://newapi.example.com/v1beta/models/gemini-image-model:generateContent/',
    )
    expect(result.images).toEqual(['data:image/jpeg;base64,cm91dGVk'])
  })

  it('returns the Gemini finish reason when no image is produced', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'The request could not produce an image.' }] },
        finishReason: 'SAFETY',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callNewApiGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultNewApiGeminiProfile({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'newapi-test-key',
    }))).rejects.toThrow(/SAFETY.*could not produce/s)
  })
})
