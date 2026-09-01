const baseUrl = (process.env.NIAOTV_BASE_URL || 'https://ai-proxy.niaotv.art')
  .trim()
  .replace(/\/+$/, '')
const apiKey = (process.env.NIAOTV_API_KEY || '').trim()

if (!apiKey) {
  console.error('请先设置环境变量 NIAOTV_API_KEY，再运行 npm run niaotv:usage。')
  process.exitCode = 1
} else {
  const headers = { Authorization: `Bearer ${apiKey}` }
  const requestJson = async (path) => {
    const response = await fetch(`${baseUrl}${path}`, { headers, cache: 'no-store' })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const message = payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`
      throw new Error(message)
    }
    return payload
  }

  try {
    const [balance, usage] = await Promise.all([
      requestJson('/v1/account/token-balance'),
      requestJson('/v1/account/usage?limit=20&offset=0'),
    ])
    console.log(JSON.stringify({ balance, usage }, null, 2))
  } catch (error) {
    console.error(`NiaoTV AI 积分查询失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
