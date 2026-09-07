import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { callLinApiGptImageApi } from './linApiGptImageApi'
import { callLinApiImageApi } from './linApiImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import { appendOutputResolutionToPrompt, type CallApiOptions, type CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  const prompt = appendOutputResolutionToPrompt(opts.prompt, opts.params.size)
  const requestOpts = prompt === opts.prompt ? opts : { ...opts, prompt }
  if (profile.provider === 'fal') return callFalAiImageApi(requestOpts, profile)
  if (profile.provider === 'linapi') return callLinApiImageApi(requestOpts, profile)
  if (profile.provider === 'linapi-gpt') return callLinApiGptImageApi(requestOpts, profile)
  return callOpenAICompatibleImageApi(requestOpts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
