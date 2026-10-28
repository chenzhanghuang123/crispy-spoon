import { describe, expect, it, vi } from 'vitest'
import { readJsonServerSentEvents, readJsonServerSentEventText } from './serverSentEvents'

describe('server-sent event completion', () => {
  it.each(['\n', '\r\n'])('recognizes a fragmented [DONE] marker and cancels an open relay stream with %j', async (newline) => {
    const text = [': keep-alive', 'data: {"value":"你好"}', 'data: [DONE]', ''].join(newline + newline)
    const bytes = new TextEncoder().encode(text)
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      },
      cancel,
    }))
    const onEvent = vi.fn()
    const onDone = vi.fn()

    await readJsonServerSentEvents(response, onEvent, { onDone, stopOnDone: true })

    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ value: '你好' })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
  })

  it('notifies text readers about [DONE] without passing it to the JSON parser', async () => {
    const onEvent = vi.fn()
    const onDone = vi.fn()
    await readJsonServerSentEventText('data: {"value":1}\n\ndata: [DONE]', onEvent, { onDone, stopOnDone: true })
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ value: 1 })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('preserves the existing behavior for callers that do not opt in', async () => {
    const onEvent = vi.fn()
    await readJsonServerSentEventText('data: {"value":1}\n\ndata: [DONE]\n\ndata: {"value":2}', onEvent)
    expect(onEvent.mock.calls).toEqual([[{ value: 1 }], [{ value: 2 }]])
  })

  it('does not notify completion merely because the connection closes', async () => {
    const onDone = vi.fn()
    await readJsonServerSentEvents(new Response('data: {"value":1}'), vi.fn(), { onDone, stopOnDone: true })
    expect(onDone).not.toHaveBeenCalled()
  })

  it.each(['data: {"value":', 'data: {"error":{"message":"upstream failed"}}'])('does not suppress invalid events before [DONE]: %s', async (event) => {
    const onDone = vi.fn()
    await expect(readJsonServerSentEvents(new Response(`${event}\n\ndata: [DONE]\n\n`), vi.fn(), { onDone, stopOnDone: true })).rejects.toThrow()
    expect(onDone).not.toHaveBeenCalled()
  })
})
