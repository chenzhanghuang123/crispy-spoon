export function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream') ?? false
}

export function looksLikeServerSentEvents(text: string): boolean {
  return /^(?:event|data):\s*/m.test(text.trimStart())
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecordValue(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) {
    return getStringValue(event, 'message') ?? '流式请求失败'
  }
  return null
}

function parseServerSentEventBlock(block: string): string | null {
  const dataLines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  const data = dataLines.join('\n').trim()
  return data || null
}

interface ServerSentEventReadOptions {
  onDone?: () => void
  stopOnDone?: boolean
}

async function processServerSentEventBlock(
  block: string,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
  options: ServerSentEventReadOptions,
) {
  const data = parseServerSentEventBlock(block)
  if (!data) return false
  if (data === '[DONE]') {
    options.onDone?.()
    return true
  }

  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    throw new Error('流式响应包含无法解析的 JSON 事件')
  }
  if (!isRecordValue(event)) return false

  const errorMessage = getStreamEventErrorMessage(event)
  if (errorMessage) throw new Error(errorMessage)

  await onEvent(event)
  return false
}

export async function readJsonServerSentEventText(
  text: string,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
  options: ServerSentEventReadOptions = {},
): Promise<void> {
  const normalized = text.replace(/\r\n/g, '\n')
  for (const block of normalized.split(/\n\n+/)) {
    if (block.trim() && await processServerSentEventBlock(block, onEvent, options) && options.stopOnDone) return
  }
}

export async function readJsonServerSentEvents(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
  options: ServerSentEventReadOptions = {},
): Promise<void> {
  if (!response.body) throw new Error('接口未返回可读取的流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separatorIndex = buffer.search(/\r?\n\r?\n/)
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex)
        const separator = buffer.match(/\r?\n\r?\n/)?.[0] ?? '\n\n'
        buffer = buffer.slice(separatorIndex + separator.length)
        if (await processServerSentEventBlock(block, onEvent, options) && options.stopOnDone) return
        separatorIndex = buffer.search(/\r?\n\r?\n/)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) await processServerSentEventBlock(buffer, onEvent, options)
  } finally {
    // Opt-in callers can finish at the protocol terminator even if the relay keeps HTTP open.
    if (options.stopOnDone) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
