import { describe, expect, it, vi } from 'vitest'
import {
  prepareHighFidelityReferenceImageAndMaskPayload,
  prepareReferenceImageAndMaskPayload,
  prepareReferenceImagePayload,
  type PlannerReferenceImageCompressionRequest,
} from './referenceImagePayload'

function dataUrlOfLength(length: number, prefix = 'data:image/png;base64,') {
  return `${prefix}${'a'.repeat(Math.max(0, length - prefix.length))}`
}

describe('prepareReferenceImagePayload', () => {
  it('returns an empty payload without compressing when there are no reference images', async () => {
    const compressor = vi.fn()

    const result = await prepareReferenceImagePayload([], {
      maxPayloadBytes: 10,
      compressor,
    })

    expect(compressor).not.toHaveBeenCalled()
    expect(result).toEqual({
      dataUrls: [],
      originalBytes: 0,
      payloadBytes: 0,
      compressedCount: 0,
      pass: 'none',
      notice: '',
    })
  })

  it('compresses multiple reference images on the primary pass', async () => {
    const compressor = vi.fn(async (_dataUrl: string, request: PlannerReferenceImageCompressionRequest) =>
      dataUrlOfLength(request.maxEdge === 1024 ? 80 : 40, 'data:image/webp;base64,'),
    )

    const result = await prepareReferenceImagePayload([dataUrlOfLength(200), dataUrlOfLength(300)], {
      maxPayloadBytes: 200,
      compressor,
    })

    expect(compressor).toHaveBeenCalledTimes(2)
    expect(result.dataUrls).toHaveLength(2)
    expect(result.pass).toBe('primary')
    expect(result.compressedCount).toBe(2)
    expect(result.originalBytes).toBe(500)
    expect(result.payloadBytes).toBe(160)
    expect(result.notice).toContain('本次已压缩 2 张参考图')
  })

  it('can encode independent references concurrently while preserving their order', async () => {
    let active = 0
    let maxActive = 0
    const references = [dataUrlOfLength(200, 'data:image/png;base64,'), dataUrlOfLength(300, 'data:image/png;base64,')]
    const compressor = vi.fn(async (dataUrl: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return dataUrl
    })

    const result = await prepareReferenceImagePayload(references, {
      maxPayloadBytes: 600,
      compressor,
      parallel: true,
    })

    expect(maxActive).toBe(2)
    expect(result.dataUrls).toEqual(references)
    expect(compressor).toHaveBeenCalledTimes(2)
  })

  it('falls back to smaller compression when the primary pass is still too large', async () => {
    const compressor = vi.fn(async (_dataUrl: string, request: PlannerReferenceImageCompressionRequest) =>
      dataUrlOfLength(request.maxEdge === 1024 ? 80 : 40, 'data:image/webp;base64,'),
    )

    const result = await prepareReferenceImagePayload([dataUrlOfLength(200), dataUrlOfLength(300)], {
      maxPayloadBytes: 100,
      compressor,
    })

    expect(compressor).toHaveBeenCalledTimes(4)
    expect(result.pass).toBe('fallback')
    expect(result.payloadBytes).toBe(80)
    expect(result.notice).toContain('已自动降级压缩')
  })

  it('throws locally when the fallback payload is still too large', async () => {
    const compressor = vi.fn(async () => dataUrlOfLength(80, 'data:image/webp;base64,'))

    await expect(prepareReferenceImagePayload([dataUrlOfLength(200), dataUrlOfLength(300)], {
      maxPayloadBytes: 100,
      compressor,
    })).rejects.toThrow('参考图压缩后仍过大')

    expect(compressor).toHaveBeenCalledTimes(4)
  })

  it('honors an already aborted signal before compressing', async () => {
    const compressor = vi.fn()
    const controller = new AbortController()
    controller.abort()

    await expect(prepareReferenceImagePayload([dataUrlOfLength(200)], {
      signal: controller.signal,
      compressor,
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(compressor).not.toHaveBeenCalled()
  })
})

describe('prepareReferenceImageAndMaskPayload', () => {
  it('compresses the first image and mask as a matched pair', async () => {
    const compressor = vi.fn(async () => dataUrlOfLength(40, 'data:image/webp;base64,'))
    const maskCompressor = vi.fn(async () => ({
      imageDataUrl: dataUrlOfLength(50, 'data:image/webp;base64,'),
      maskDataUrl: dataUrlOfLength(30, 'data:image/png;base64,'),
    }))

    const result = await prepareReferenceImageAndMaskPayload([dataUrlOfLength(200), dataUrlOfLength(180)], dataUrlOfLength(160), {
      maxPayloadBytes: 140,
      compressor,
      maskCompressor,
    })

    expect(maskCompressor).toHaveBeenCalledTimes(1)
    expect(compressor).toHaveBeenCalledTimes(1)
    expect(result.dataUrls).toHaveLength(2)
    expect(result.maskDataUrl).toBe(dataUrlOfLength(30, 'data:image/png;base64,'))
    expect(result.payloadBytes).toBe(120)
    expect(result.pass).toBe('primary')
  })

  it('keeps a mask-only payload compatible for direct API callers', async () => {
    const result = await prepareReferenceImageAndMaskPayload([], dataUrlOfLength(80), {
      maxPayloadBytes: 100,
    })

    expect(result.dataUrls).toEqual([])
    expect(result.maskDataUrl).toBe(dataUrlOfLength(80))
    expect(result.compressedCount).toBe(0)
    expect(result.notice).toBe('')
  })
})

describe('prepareHighFidelityReferenceImageAndMaskPayload', () => {
  it('preserves original reference images when they already fit the request budget', async () => {
    const compressor = vi.fn()
    const references = [dataUrlOfLength(200), dataUrlOfLength(300)]

    const result = await prepareHighFidelityReferenceImageAndMaskPayload(references, undefined, {
      maxPayloadBytes: 600,
      compressor,
    })

    expect(compressor).not.toHaveBeenCalled()
    expect(result.dataUrls).toEqual(references)
    expect(result.payloadBytes).toBe(500)
    expect(result.compressedCount).toBe(0)
    expect(result.pass).toBe('none')
  })

  it('starts oversized Gemini references at 4K and high quality', async () => {
    const requests: PlannerReferenceImageCompressionRequest[] = []
    const compressor = vi.fn(async (_dataUrl: string, request: PlannerReferenceImageCompressionRequest) => {
      requests.push(request)
      return dataUrlOfLength(80, 'data:image/webp;base64,')
    })

    const result = await prepareHighFidelityReferenceImageAndMaskPayload([dataUrlOfLength(400)], undefined, {
      maxPayloadBytes: 100,
      compressor,
    })

    expect(compressor).toHaveBeenCalledTimes(1)
    expect(requests[0]).toEqual({ maxEdge: 4096, quality: 0.96 })
    expect(result.payloadBytes).toBe(80)
    expect(result.pass).toBe('primary')
  })

  it('reduces resolution only when the 4K high-fidelity payload remains too large', async () => {
    const requests: PlannerReferenceImageCompressionRequest[] = []
    const compressor = vi.fn(async (_dataUrl: string, request: PlannerReferenceImageCompressionRequest) => {
      requests.push(request)
      return dataUrlOfLength(request.maxEdge === 4096 ? 140 : 80, 'data:image/webp;base64,')
    })

    const result = await prepareHighFidelityReferenceImageAndMaskPayload([dataUrlOfLength(400)], undefined, {
      maxPayloadBytes: 100,
      compressor,
    })

    expect(compressor).toHaveBeenCalledTimes(2)
    expect(requests[1]).toEqual({ maxEdge: 3072, quality: 0.94 })
    expect(result.payloadBytes).toBe(80)
    expect(result.pass).toBe('fallback')
  })

  it('never degrades Gemini references below 2K to force an oversized request through', async () => {
    const requests: PlannerReferenceImageCompressionRequest[] = []
    const compressor = vi.fn(async (_dataUrl: string, request: PlannerReferenceImageCompressionRequest) => {
      requests.push(request)
      return dataUrlOfLength(140, 'data:image/webp;base64,')
    })

    await expect(prepareHighFidelityReferenceImageAndMaskPayload([dataUrlOfLength(400)], undefined, {
      maxPayloadBytes: 100,
      compressor,
    })).rejects.toThrow('高保真参考图压缩后仍过大')

    expect(compressor).toHaveBeenCalledTimes(3)
    expect(requests.map((request) => request.maxEdge)).toEqual([4096, 3072, 2048])
  })
})
