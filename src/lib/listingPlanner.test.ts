import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  createDefaultAmazonPlannerProfile,
  createDefaultOpenAIProfile,
  getAmazonPlannerProfile,
  normalizeSettings,
} from './apiProfiles'
import { DEFAULT_AMAZON_PROMPT_DRAFT } from './amazonPrompt'
import {
  buildAmazonAPlusPlanPrompt,
  buildAmazonPlanPrompt,
  buildEtsyPlanPrompt,
  ETSY_ADDITIONAL_SHOT_BRIEFS,
  ETSY_ORIGINAL_SHOT_COUNT,
  ETSY_SHOT_COUNT,
  ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS,
  formatAPlusModuleText,
  insertAPlusModuleSpecAfter,
  MAX_A_PLUS_MODULE_COUNT,
  getAPlusContentTypeLabel,
  getEtsyImageSlots,
  getAPlusModuleDisplayName,
  getAPlusModuleEnglishName,
  getAPlusModuleSpecs,
  isAmazonListingMainSlot,
  removeAPlusModuleSpecAt,
} from './listingPlanner'
import { callAmazonPlannerApi } from './listingPlannerApi'

const SAMPLE_LISTING = [
  'Title: 40 oz Stainless Steel Insulated Tumbler with Handle and Straw Lid, Matte Black',
  '',
  'About this item',
  '- Keeps drinks cold for 24 hours and hot for 8 hours with double wall vacuum insulation',
  '- Ergonomic handle and slim base fit most car cup holders for commuting and travel',
  '- Leak resistant straw lid and splash proof design for daily use',
  '- Durable 18/8 stainless steel with matte powder coated finish',
  '- Includes reusable straw and cleaning brush, BPA free materials',
].join('\n')

const TEST_ANGLE_FAMILIES = ['front-orthographic', 'three-quarter', 'side-profile', 'rear', 'top-down', 'low-angle', 'high-angle', 'macro-detail', 'environmental-wide', 'functional-pov'] as const
const TEST_SHOT_SCALES = ['extreme-macro', 'detail-close-up', 'full-product', 'product-in-context', 'wide-environment'] as const
const TEST_LENS_CLASSES = ['ultra-wide', 'wide', 'normal', 'short-telephoto', 'macro', 'telephoto', 'tilt-shift'] as const
const TEST_LIGHTING_FAMILIES = ['soft-studio', 'raking-texture', 'cross-polarized', 'backlit-translucency', 'window-daylight', 'hard-directional', 'mixed-practical', 'edge-defined-low-key', 'high-key-shadowless'] as const
const TEST_SCENE_FAMILIES = ['seamless-studio', 'editorial-still-life', 'material-macro', 'scale-infographic', 'craft-workbench', 'active-use', 'contextual-interior', 'architectural-environment', 'nature-outdoor', 'gift-or-keepsake'] as const

function createPhotographyDecision(index = 0) {
  return {
    productSuitability: `This capture reveals verified product evidence ${index + 1}.`,
    angleFamily: TEST_ANGLE_FAMILIES[index % TEST_ANGLE_FAMILIES.length],
    angle: `Product-specific viewpoint ${index + 1} with controlled perspective.`,
    shotScale: TEST_SHOT_SCALES[index % TEST_SHOT_SCALES.length],
    framing: `Distinct product occupancy and negative-space plan ${index + 1}.`,
    cameraSystem: index % 2 ? 'Hasselblad X2D 100C' : 'Phase One XF IQ4 150MP',
    lensClass: TEST_LENS_CLASSES[index % TEST_LENS_CLASSES.length],
    lens: `${35 + index * 5}mm premium technical lens selected for this perspective`,
    exposure: `ISO ${50 + index}, f/${5.6 + index / 10}, tripod-supported calibrated exposure`,
    focusStrategy: `Product-specific focal-plane strategy ${index + 1}.`,
    lightingFamily: TEST_LIGHTING_FAMILIES[index % TEST_LIGHTING_FAMILIES.length],
    lighting: `Distinct material-aware lighting execution ${index + 1}.`,
    sceneFamily: TEST_SCENE_FAMILIES[index % TEST_SCENE_FAMILIES.length],
    scene: `Bespoke physically believable scene ${index + 1}.`,
    differentiation: `Unique angle, scale, optics, light, scene, and selling purpose ${index + 1}.`,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Amazon prompt builders', () => {
  it('uses LLM prompt content, series style guide, density guidance, negative prompt, and optional style guard', () => {
    const prompt = buildAmazonPlanPrompt({
      prompt: 'Professional Amazon main image of the exact product.',
      negativePrompt: 'text, logo, extra accessories',
      seriesStyleGuide: 'Use warm studio light and refined charcoal typography across the set.',
      styleReferenceAttached: true,
      styleDensityMode: 'rich',
    })

    expect(prompt).toContain('Professional Amazon main image of the exact product.')
    expect(prompt).toContain('Series style guide:')
    expect(prompt).toContain('Use warm studio light')
    expect(prompt).toContain('Negative prompt:')
    expect(prompt).toContain('text, logo, extra accessories')
    expect(prompt).toContain('Layout density:')
    expect(prompt).toContain('information-rich Amazon gallery layout')
    expect(prompt).toContain('multiple well-spaced callouts')
    expect(prompt).toContain('The last input image is a hidden style reference')
    expect(prompt).toContain('color palette, lighting, contrast')
    expect(prompt).toContain('typography feel')
    expect(prompt).toContain('Do not copy any placeholder words, fixed layout')
    expect(prompt).not.toContain('Render only the copy specified below')
    expect(prompt).not.toContain('A+ module requirements:')
  })

  it('prioritizes the selected visual style over conflicting series style language', () => {
    const prompt = buildAmazonPlanPrompt({
      prompt: 'Create an Amazon secondary infographic image of the exact product.',
      negativePrompt: 'price, reviews',
      seriesStyleGuide: 'Use warm cream backgrounds, botanical accents, and coastal resort styling.',
      styleReferenceAttached: true,
      styleDensityMode: 'rich',
      selectedVisualStyle: {
        label: '清爽科技',
        description: '冷色光感、干净层级、精准标注，适合电子、工具、办公类产品。',
        palette: ['#F8FAFC', '#38BDF8', '#14B8A6'],
      },
    })

    expect(prompt).toContain('Selected visual style (highest priority):')
    expect(prompt).toContain('Style reference: 清爽科技.')
    expect(prompt).toContain('冷色光感、干净层级、精准标注')
    expect(prompt).toContain('Palette anchors: #F8FAFC, #38BDF8, #14B8A6.')
    expect(prompt).toContain('highest-priority visual system')
    expect(prompt).toContain('override that conflict with this selected visual style')
    expect(prompt).toContain('Series style guide (lower priority than the selected visual style):')
    expect(prompt).toContain('Use warm cream backgrounds')
    expect(prompt).toContain('The selected visual style text block is higher priority')
  })

  it('builds minimal density guidance when requested', () => {
    const prompt = buildAmazonPlanPrompt({
      prompt: 'Create an Amazon secondary image.',
      negativePrompt: 'price, reviews',
      seriesStyleGuide: 'Refined kitchen styling.',
      styleReferenceAttached: true,
      styleDensityMode: 'minimal',
    })

    expect(prompt).toContain('Layout density:')
    expect(prompt).toContain('refined minimal Amazon layout')
    expect(prompt).toContain('fewer callouts')
    expect(prompt).not.toContain('information-rich Amazon gallery layout')
  })

  it('builds MAIN prompts without series style guide or style reference guard when style is disabled', () => {
    const prompt = buildAmazonPlanPrompt({
      prompt: 'Amazon compliant MAIN image on a pure white background.',
      negativePrompt: 'text, props, non-white background',
      seriesStyleGuide: null,
      styleReferenceAttached: false,
    })

    expect(prompt).toContain('Amazon compliant MAIN image')
    expect(prompt).toContain('Negative prompt:')
    expect(prompt).toContain('text, props, non-white background')
    expect(prompt).not.toContain('Series style guide:')
    expect(prompt).not.toContain('Layout density:')
    expect(prompt).not.toContain('The last input image is a hidden style reference')
    expect(prompt).not.toContain('Selected visual style')
  })

  it('builds Etsy prompts with a Visual DNA lock and a product-specific photography decision', () => {
    const photographyDecision = createPhotographyDecision(4)
    const prompt = buildEtsyPlanPrompt({
      prompt: 'Hero shot of the exact hand-thrown seafoam ceramic mug on a quiet breakfast table.',
      negativePrompt: 'plastic texture, wrong glaze color, extra handles, watermark',
      photographyDecision,
      seriesStyleGuide: [
        'Product Name/Type: Hand-thrown ceramic mug',
        'Material & Texture Focus: Speckled stoneware, raw clay foot, glossy seafoam glaze',
        'Color Palette & Lighting Mood: True seafoam green with warm morning light',
        'Brand Aesthetic & Target Audience: Slow-living craft collector',
      ].join('\n'),
      styleReferenceAttached: true,
      selectedVisualStyle: {
        label: 'Natural Warm',
        description: 'Warm handcrafted editorial photography.',
        palette: ['#E7DCCB', '#8AAE9B'],
      },
    })

    expect(prompt).toContain('VERIFIED PRODUCT FACTS')
    expect(prompt).toContain('Speckled stoneware, raw clay foot, glossy seafoam glaze')
    expect(prompt).toContain("AI PHOTOGRAPHER'S PRODUCT-SPECIFIC CAPTURE DECISION")
    expect(prompt).toContain(photographyDecision.cameraSystem)
    expect(prompt).toContain(photographyDecision.lens)
    expect(prompt).toContain(photographyDecision.lighting)
    expect(prompt).not.toContain(ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS)
    expect(prompt).toContain('PRODUCT REFERENCE LOCK (absolute priority)')
    expect(prompt).toContain('Selected Etsy campaign style (surrounding art direction only):')
    expect(prompt).toContain('capture decision is higher priority')
    expect(prompt).not.toContain('information-rich Amazon gallery layout')
  })

  it('uses an Etsy style as text-only photography direction without template artifacts', () => {
    const prompt = buildEtsyPlanPrompt({
      slot: 'E05',
      prompt: 'Photograph the exact product in a product-specific interior.',
      negativePrompt: 'wrong product, watermark',
      photographyDecision: createPhotographyDecision(4),
      seriesStyleGuide: 'Product Name/Type: Exact handmade product',
      styleReferenceAttached: false,
      selectedVisualStyle: {
        label: 'Clean Tech',
        description: 'Cool clean illumination, crisp whites, and restrained cyan accents.',
        palette: ['#F8FAFC', '#38BDF8', '#14B8A6'],
      },
    })

    expect(prompt).toContain('Selected Etsy campaign style (surrounding art direction only):')
    expect(prompt).toContain('Cool clean illumination, crisp whites, and restrained cyan accents.')
    expect(prompt).toContain('Keep one continuous real photograph')
    expect(prompt).toContain('no typography, captions, labels, callouts, arrows, swatches')
    expect(prompt).toContain('copied style-board text')
    expect(prompt).not.toContain('The last input image is a hidden style reference')
  })

  it('uses each AI-selected camera, angle, focus, lighting, and scene for appended Etsy shots', () => {
    const legacyProductionStandard = [
      'Premium production standard for this appended shot: art-directed by a world-class Etsy conversion strategist and luxury commercial photographer.',
      'Use a flagship medium-format campaign workflow, museum-grade product styling, category-appropriate elite optics, precise focus control, and a bespoke physical set derived from the product Visual DNA.',
      'Light with a masterfully controlled multi-light studio setup: large diffused key, shaped fill, subtle separation or rim light, negative fill where useful, accurate color management, and highlight control tailored to the real material and finish.',
    ].join(' ')
    for (const [index, brief] of ETSY_ADDITIONAL_SHOT_BRIEFS.entries()) {
      const photographyDecision = createPhotographyDecision(index + ETSY_ORIGINAL_SHOT_COUNT)
      const prompt = buildEtsyPlanPrompt({
        slot: brief.slot,
        prompt: `Bespoke product-specific scene ${index + 1}. ${brief.promptRequirement} ${legacyProductionStandard} ${ETSY_TECHNICAL_PHOTOGRAPHY_PARAMETERS}.`,
        negativePrompt: 'wrong product, blur',
        photographyDecision,
        seriesStyleGuide: [
          'Product Name/Type: Exact handmade product',
          'Material & Texture Focus: Verified natural material',
          '',
          'Campaign mood that should not be repeated in the compact Visual DNA block.',
        ].join('\n'),
        styleReferenceAttached: false,
      })

      expect(prompt).toContain('PRODUCT REFERENCE LOCK (absolute priority)')
      expect(prompt).toContain(brief.promptRequirement)
      expect(prompt).toContain(photographyDecision.angle)
      expect(prompt).toContain(photographyDecision.cameraSystem)
      expect(prompt).toContain(photographyDecision.lens)
      expect(prompt).toContain(photographyDecision.focusStrategy)
      expect(prompt).toContain(photographyDecision.lighting)
      expect(prompt).toContain(photographyDecision.scene)
      expect(prompt).toContain('Product Name/Type: Exact handmade product')
      expect(prompt).not.toContain('Campaign mood that should not be repeated')
      expect(prompt).not.toContain('100mm lens, f/2.8')
      expect(prompt).not.toContain('raytracing')
      expect(prompt).not.toContain('volumetric light')
      expect(prompt).not.toContain('flagship medium-format campaign workflow')
      expect(prompt).not.toContain(brief.cameraRequirement)
      expect(prompt.match(new RegExp(brief.promptRequirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1)
    }
  })

  it('identifies the Amazon listing MAIN slot regardless of casing or spacing', () => {
    expect(isAmazonListingMainSlot('MAIN')).toBe(true)
    expect(isAmazonListingMainSlot(' main ')).toBe(true)
    expect(isAmazonListingMainSlot('PT01')).toBe(false)
    expect(isAmazonListingMainSlot(undefined)).toBe(false)
  })

  it('builds A+ prompts with the same LLM-led structure', () => {
    const prompt = buildAmazonAPlusPlanPrompt({
      prompt: 'Premium A+ banner with the product in a refined kitchen setting.',
      negativePrompt: 'pricing, reviews, clutter',
      seriesStyleGuide: 'Bright ceramic editorial style.',
      styleReferenceAttached: false,
    })

    expect(prompt).toContain('Premium A+ banner')
    expect(prompt).toContain('Bright ceramic editorial style')
    expect(prompt).toContain('pricing, reviews, clutter')
    expect(prompt).not.toContain('Layout density:')
    expect(prompt).not.toContain('The last input image is a hidden style reference')
  })

  it('applies selected visual style priority to A+ prompts', () => {
    const prompt = buildAmazonAPlusPlanPrompt({
      prompt: 'A+ module with feature callouts.',
      negativePrompt: 'pricing, reviews',
      seriesStyleGuide: 'Use warm tan backgrounds.',
      styleReferenceAttached: true,
      selectedVisualStyle: {
        label: '明亮零售',
        description: '明快色块、清晰卖点区域、购物页友好，适合快消、厨房、运动配件。',
        palette: ['#FFFFFF', '#F97316', '#2563EB'],
      },
    })

    expect(prompt).toContain('Style reference: 明亮零售.')
    expect(prompt).toContain('Palette anchors: #FFFFFF, #F97316, #2563EB.')
    expect(prompt).toContain('Series style guide (lower priority than the selected visual style):')
  })

})

describe('A+ module helpers', () => {
  it('returns local Chinese module names while preserving English labels', () => {
    const highlightSpec = getAPlusModuleSpecs('standard')[4]!
    const premiumSpec = getAPlusModuleSpecs('premium')[0]!

    expect(getAPlusModuleDisplayName(highlightSpec)).toBe('卖点方块 1')
    expect(getAPlusModuleEnglishName(highlightSpec)).toBe('Highlight Tile 1')
    expect(getAPlusModuleDisplayName(premiumSpec)).toBe('高级首屏横幅')
    expect(getAPlusModuleEnglishName(premiumSpec)).toBe('Hero Banner')
    expect(getAPlusContentTypeLabel('standard-large')).toBe('普通A+')
    expect(getAPlusContentTypeLabel('standard')).toBe('标准A+')
    expect(getAPlusContentTypeLabel('premium')).toBe('高级A+')
    expect(getAPlusContentTypeLabel('mobile')).toBe('手机A+')
  })

  it('defines Mobile A+ as five 600x450 modules', () => {
    const mobileSpecs = getAPlusModuleSpecs('mobile')

    expect(mobileSpecs).toHaveLength(5)
    expect(mobileSpecs.map((spec) => spec.slot)).toEqual(['A+M01', 'A+M02', 'A+M03', 'A+M04', 'A+M05'])
    expect(mobileSpecs.every((spec) => spec.uploadWidth === 600 && spec.uploadHeight === 450)).toBe(true)
    expect(getAPlusModuleDisplayName(mobileSpecs[0]!)).toBe('手机首屏')
    expect(getAPlusModuleEnglishName(mobileSpecs[1]!)).toBe('Mobile Feature 1')
  })

  it('adds and removes A+ modules inline while reindexing slots and labels', () => {
    const defaultSpecs = getAPlusModuleSpecs('standard-large')
    const addedSpecs = insertAPlusModuleSpecAfter('standard-large', defaultSpecs, 4)

    expect(addedSpecs).toHaveLength(6)
    expect(addedSpecs.map((spec) => spec.slot)).toEqual(['A+L01', 'A+L02', 'A+L03', 'A+L04', 'A+L05', 'A+L06'])
    expect(addedSpecs[5]).toMatchObject({
      label: 'Single Image 5',
      displayLabel: '大图模块 5',
      moduleType: 'single-image',
      uploadWidth: 970,
      uploadHeight: 600,
    })

    const removedSpecs = removeAPlusModuleSpecAt('standard-large', addedSpecs, 0)
    expect(removedSpecs.map((spec) => spec.slot)).toEqual(['A+L01', 'A+L02', 'A+L03', 'A+L04', 'A+L05'])
    expect(removedSpecs[0]).toMatchObject({
      label: 'Single Image 1',
      displayLabel: '大图模块 1',
      moduleType: 'single-image',
      uploadWidth: 970,
      uploadHeight: 600,
    })
  })

  it('keeps A+ module counts between 1 and 12', () => {
    let specs = getAPlusModuleSpecs('mobile')
    for (let index = 0; index < 20; index += 1) {
      specs = insertAPlusModuleSpecAfter('mobile', specs, specs.length - 1)
    }

    expect(specs).toHaveLength(MAX_A_PLUS_MODULE_COUNT)
    for (let index = 0; index < 20; index += 1) {
      specs = removeAPlusModuleSpecAt('mobile', specs, specs.length - 1)
    }
    expect(specs).toHaveLength(1)
    expect(specs[0]?.slot).toBe('A+M01')
  })

  it('formats external A+ module copy from the LLM', () => {
    expect(formatAPlusModuleText({
      textTitle: 'Organized in Seconds',
      textBody: 'Elastic loops keep pens, pencils, and small tools easy to find.',
    })).toBe('Organized in Seconds\n\nElastic loops keep pens, pencils, and small tools easy to find.')
  })
})

function createApiPlans(count = 7) {
  return [
    'MAIN',
    ...Array.from({ length: count - 1 }, (_, index) => `PT${String(index + 1).padStart(2, '0')}`),
  ].map((slot) => ({
    slot,
    label: `${slot} 方案`,
    planMarkdown: `## ${slot} 主图方案\n\n中文策划说明。`,
    prompt: `Create Amazon listing image ${slot} for the product.`,
    negativePrompt: `negative ${slot}`,
  }))
}

function createApiPayload(title = 'AI planned tumbler', count = 7) {
  return {
    product: {
      title,
      category: 'Kitchen / Drinkware',
      brand: '',
      color: 'matte black',
      material: 'stainless steel',
      audience: 'commuters',
      packageIncludes: '1 tumbler, 1 straw',
    },
    sellingPoints: ['Cold for 24 hours'],
    seriesStyleGuide: 'Use a cohesive warm commercial style across the set.',
    imagePlans: createApiPlans(count),
  }
}

function createAPlusPlans(prefix: 'A+S' | 'A+L' | 'A+P' | 'A+M', brand = '') {
  const slots = prefix === 'A+S'
    ? ['A+S01', 'A+S02', 'A+S03', 'A+S04', 'A+S05', 'A+S06', 'A+S07', 'A+S08']
    : prefix === 'A+L'
      ? ['A+L01', 'A+L02', 'A+L03', 'A+L04', 'A+L05']
      : prefix === 'A+P'
        ? ['A+P01', 'A+P02', 'A+P03', 'A+P04', 'A+P05', 'A+P06']
        : ['A+M01', 'A+M02', 'A+M03', 'A+M04', 'A+M05']

  return slots.map((slot, index) => ({
    slot,
    label: `${slot} 模块`,
    moduleType: prefix === 'A+S'
      ? index === 0 ? 'header-banner' : index < 4 ? 'single-image' : 'highlight-tile'
      : prefix === 'A+L'
        ? index === 0 ? 'header-banner' : 'single-image'
        : prefix === 'A+P'
          ? index === 0 ? 'hero-banner' : index < 4 ? 'feature-image' : 'brand-story'
          : index === 0 ? 'hero-banner' : 'feature-image',
    planMarkdown: `## ${slot} 模块方案\n\n中文 A+ 策划说明。`,
    textTitle: prefix === 'A+S' && index >= 4 ? `Benefit ${slot}` : '',
    textBody: prefix === 'A+S' && index >= 4 ? `External A+ copy for ${slot}.` : '',
    prompt: brand && index === 0
      ? `Create A+ module ${slot} for ${brand}, using the brand name as a small headline line.`
      : `Create A+ module ${slot} for the product.`,
    negativePrompt: `negative ${slot}`,
  }))
}

function createAPlusPlansFromSpecs(specs: ReturnType<typeof getAPlusModuleSpecs>, brand = '') {
  return specs.map((spec, index) => ({
    slot: spec.slot,
    label: `${spec.slot} 模块`,
    moduleType: spec.moduleType,
    planMarkdown: `## ${spec.slot} 模块方案\n\n中文 A+ 策划说明。`,
    textTitle: spec.moduleType === 'highlight-tile' ? `Benefit ${spec.slot}` : '',
    textBody: spec.moduleType === 'highlight-tile' ? `External A+ copy for ${spec.slot}.` : '',
    prompt: brand && index === 0
      ? `Create A+ module ${spec.slot} for ${brand}, using the brand name as a small headline line.`
      : `Create A+ module ${spec.slot} for the product.`,
    negativePrompt: `negative ${spec.slot}`,
  }))
}

function createAPlusPayload(prefix: 'A+S' | 'A+L' | 'A+P' | 'A+M', title = 'AI planned A+ tumbler', brand = '') {
  return {
    product: {
      title,
      category: 'Kitchen / Drinkware',
      brand,
      color: 'matte black',
      material: 'stainless steel',
      audience: 'commuters',
      packageIncludes: '1 tumbler, 1 straw',
    },
    sellingPoints: ['Cold for 24 hours'],
    seriesStyleGuide: 'Use a cohesive A+ visual style across the module set.',
    aPlusPlans: createAPlusPlans(prefix, brand),
  }
}

function createAPlusPayloadFromSpecs(specs: ReturnType<typeof getAPlusModuleSpecs>, title = 'AI planned A+ tumbler', brand = '') {
  return {
    product: {
      title,
      category: 'Kitchen / Drinkware',
      brand,
      color: 'matte black',
      material: 'stainless steel',
      audience: 'commuters',
      packageIncludes: '1 tumbler, 1 straw',
    },
    sellingPoints: ['Cold for 24 hours'],
    seriesStyleGuide: 'Use a cohesive A+ visual style across the module set.',
    aPlusPlans: createAPlusPlansFromSpecs(specs, brand),
  }
}

function createEtsyPayload() {
  return {
    product: {
      title: 'Hand-thrown Seafoam Ceramic Mug',
      category: 'Handmade pottery',
      brand: '',
      color: 'seafoam green',
      material: 'speckled stoneware',
      audience: 'slow-living craft collectors',
      packageIncludes: '1 ceramic mug',
    },
    sellingPoints: ['Hand-thrown form', 'Glossy seafoam glaze', 'Raw clay foot'],
    visualDna: {
      productNameType: 'Hand-thrown ceramic mug',
      materialTextureFocus: 'Speckled stoneware body, raw clay foot, glossy seafoam glaze',
      colorPaletteLightingMood: 'True seafoam green, warm morning light that reveals glaze depth',
      brandAestheticTargetAudience: 'Slow-living artisan pottery for craft-conscious Etsy buyers',
    },
    photographyAnalysis: {
      materialBehavior: 'Glossy glaze needs broad reflected highlights while the raw clay foot needs gentle raking light.',
      formAndScale: 'The hand-thrown cylinder, open rim, curved handle, and raw foot need changing elevations and truthful perspective.',
      criticalDetails: 'Show the speckled clay, glaze boundary, lip, handle join, and throwing marks without inventing decoration.',
      functionAndInteraction: 'Show comfortable hand scale and believable use as a drinking vessel without adding unsupported accessories.',
      captureChallenges: 'Control glaze glare, keep the handle profile undistorted, and hold accurate seafoam color across environments.',
      campaignStrategy: 'Alternate technical, tactile, contextual, and emotional evidence while preserving the exact mug in every frame.',
    },
    seriesStyleGuide: 'Maintain the exact mug form, glaze boundary, handle proportions, and raw clay foot across all shots.',
    imagePlans: getEtsyImageSlots().map((slot, index) => ({
      slot,
      label: `镜头 ${index + 1}`,
      planMarkdown: `**${index === 0 ? 'Hero/Main Listing' : 'Adaptive Product Story'}:** 专属场景 ${index + 1}`,
      prompt: `Photograph the exact hand-thrown seafoam ceramic mug with speckled stoneware, glossy seafoam glaze, raw clay foot, and the same handle proportions. Bespoke scene ${index + 1}.`,
      negativePrompt: 'plastic texture, wrong glaze color, extra handles, watermark',
      photographyDecision: createPhotographyDecision(index),
    })),
  }
}

describe('callAmazonPlannerApi', () => {
  it('preserves the original Etsy ten-shot plan, appends five conversion shots, and carries adaptive photography decisions', async () => {
    const apiPayload = createEtsyPayload()
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(apiPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: 'Hand-thrown seafoam ceramic mug with speckled stoneware and a raw clay foot.',
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, productTitle: 'Hand-thrown Seafoam Ceramic Mug' },
      mode: 'etsy',
      referenceImageDataUrls: ['data:image/png;base64,etsy-ref'],
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
    })

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String(init?.body))
    expect(body.text.format.name).toBe('etsy_bespoke_photoshoot_plan')
    expect(body.instructions).toContain("World-Class Adaptive Art Director and AI Photographer")
    expect(body.instructions).toContain('Visual DNA Lock is crucial')
    expect(body.instructions).toContain('Never use a reusable fixed scene template')
    expect(body.instructions).toContain('PRODUCT-SPECIFIC PHOTOGRAPHY DIAGNOSIS')
    expect(body.instructions).toContain('DIVERSITY MATRIX (mandatory)')
    expect(body.instructions).toContain('at least 5 angleFamily values')
    expect(body.instructions).toContain('Do not force one camera, one 100mm lens, or one aperture')
    expect(body.instructions).toContain('Preserve the original 10-shot behavior for E01-E10')
    expect(body.instructions).toContain('E11 — 吸睛首页图')
    expect(body.instructions).toContain('E12 — 尺寸规格图')
    expect(body.instructions).toContain('E13 — 匠心细节价值图')
    expect(body.instructions).toContain('E14 — 买家代入场景图')
    expect(body.instructions).toContain('E15 — 送礼决策收口图')
    expect(body.text.format.schema.properties.photographyAnalysis).toBeTruthy()
    expect(body.text.format.schema.properties.imagePlans.items.properties.photographyDecision).toBeTruthy()
    expect(body.input[0].content[0].text).toContain(`dynamic ${ETSY_SHOT_COUNT}-shot bespoke photoshoot blueprint`)
    expect(result.mode).toBe('etsy')
    expect(result.plans).toHaveLength(ETSY_SHOT_COUNT)
    expect(result.plans.slice(0, ETSY_ORIGINAL_SHOT_COUNT).map((plan) => plan.prompt)).toEqual(
      apiPayload.imagePlans.slice(0, ETSY_ORIGINAL_SHOT_COUNT).map((plan) => plan.prompt),
    )
    expect(result.plans.slice(ETSY_ORIGINAL_SHOT_COUNT).map((plan) => [plan.slot, plan.label])).toEqual([
      ['E11', '吸睛首页图'],
      ['E12', '尺寸规格图'],
      ['E13', '匠心细节价值图'],
      ['E14', '买家代入场景图'],
      ['E15', '送礼决策收口图'],
    ])
    expect(result.plans[10]?.prompt).toBe(apiPayload.imagePlans[10]?.prompt)
    expect(result.plans[10]?.planMarkdown).toContain('新增固定镜头要求')
    expect(result.plans[10]?.photographyDecision?.angle).toBe(apiPayload.imagePlans[10]?.photographyDecision.angle)
    expect(result.plans[11]?.negativePrompt).toContain('invented dimensions')
    const finalHeroPrompt = buildEtsyPlanPrompt({
      ...result.plans[10]!,
      seriesStyleGuide: result.seriesStyleGuide,
      styleReferenceAttached: false,
    })
    expect(finalHeroPrompt).toContain('scroll-stopping Etsy cover image')
    expect(finalHeroPrompt).toContain(apiPayload.imagePlans[10]?.photographyDecision.cameraSystem)
    expect(finalHeroPrompt).toContain(apiPayload.imagePlans[10]?.photographyDecision.lighting)
    expect(finalHeroPrompt).not.toContain('100mm lens, f/2.8')
    expect(result.etsyVisualDna?.materialTextureFocus).toContain('Speckled stoneware')
    expect(result.etsyPhotographyAnalysis?.captureChallenges).toContain('glaze glare')
    expect(result.seriesStyleGuide).toContain('Product Name/Type: Hand-thrown ceramic mug')
  })

  it('automatically repairs an Etsy plan that fails the photography diversity check', async () => {
    const invalidPayload = createEtsyPayload()
    invalidPayload.imagePlans[12] = {
      ...invalidPayload.imagePlans[12]!,
      photographyDecision: { ...invalidPayload.imagePlans[2]!.photographyDecision },
    }
    const repairedPayload = createEtsyPayload()
    let requestCount = 0
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
      const payload = requestCount === 0 ? invalidPayload : repairedPayload
      requestCount += 1
      return new Response(JSON.stringify({
        output_text: JSON.stringify(payload),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: 'Hand-thrown seafoam ceramic mug.',
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, productTitle: 'Hand-thrown Seafoam Ceramic Mug' },
      mode: 'etsy',
      referenceImageDataUrls: ['data:image/png;base64,etsy-ref'],
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const repairBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(repairBody.input[0].content).toHaveLength(1)
    expect(repairBody.input[0].content[0].text).toContain('Repair the previous Etsy 15-shot planning JSON')
    expect(repairBody.input[0].content[0].text).toContain('Etsy 摄影自动判断未通过 15 镜头差异检查')
    expect(repairBody.input[0].content[0].text).toContain('E03 与 E13')
    expect(repairBody.input[0].content[0].text).toContain('Change only the minimum conflicting or invalid imagePlans items')
    expect(repairBody.input[0].content[0].text).toContain(invalidPayload.imagePlans[0]!.prompt)
    expect(JSON.stringify(repairBody.input)).not.toContain('input_image')
    expect(result.plans).toHaveLength(ETSY_SHOT_COUNT)
    expect(result.plans[1]?.photographyDecision?.angleFamily).toBe(createPhotographyDecision(1).angleFamily)
  })

  it('reports both validation attempts when automatic Etsy repair still fails', async () => {
    const invalidPayload = createEtsyPayload()
    invalidPayload.imagePlans = invalidPayload.imagePlans.map((plan) => ({
      ...plan,
      photographyDecision: createPhotographyDecision(0),
    }))
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(invalidPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(callAmazonPlannerApi({
      listingText: 'Hand-thrown seafoam ceramic mug.',
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, productTitle: 'Hand-thrown Seafoam Ceramic Mug' },
      mode: 'etsy',
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
    })).rejects.toThrow('自动纠错后仍未通过')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses Responses API planning with JSON schema and attached reference images', async () => {
    const apiPayload = createApiPayload()
    const controller = new AbortController()
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(apiPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      referenceImageDataUrls: ['data:image/png;base64,ref'],
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
      signal: controller.signal,
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/responses')
    expect(init?.signal).toBe(controller.signal)
    const body = JSON.parse(String(init?.body))
    expect(body.instructions).toContain('The application only fixes the slot count and order')
    expect(body.instructions).toContain('Target marketplace: 美国站 (Amazon.com, locale en-US).')
    expect(body.instructions).toContain('on-image US-English copy')
    expect(body.instructions).toContain('Amazon Listing reference material for the planner')
    expect(body.instructions).toContain('Use product reference images only to identify product facts')
    expect(body.instructions).toContain('must avoid fixed non-product aesthetics')
    expect(body.instructions).toContain('must not lock the final palette')
    expect(body.instructions).toContain('pure white background RGB 255,255,255')
    expect(body.instructions).toContain('product fills about 85%')
    expect(body.instructions).toContain('no text, logo, watermark')
    expect(body.instructions).toContain('Do not use Amazon, Prime, Alexa, Amazon Choice')
    expect(body.instructions).toContain('built-in preset style reference boards')
    expect(body.instructions).not.toContain('visual style reference board generation')
    expect(body.instructions).toContain('fully plan the finished Amazon image')
    expect(body.instructions).toContain('complete information design')
    expect(body.instructions).not.toContain('Because DeepSeek cannot receive or understand reference images')
    expect(body.instructions).not.toContain('sparse copy')
    expect(body.instructions).not.toContain('leave enough whitespace')
    expect(body.instructions).not.toContain('Embedded Amazon Listing knowledge rules')
    expect(body.instructions).not.toContain('mandatory phrase')
    expect(body.text.format.type).toBe('json_schema')
    expect(body.text.format.schema.required).toContain('seriesStyleGuide')
    expect(body.text.format.schema.required).not.toContain('styleCandidates')
    expect(body.text.format.schema.required).not.toContain('visualSystem')
    expect(body.text.format.schema.properties.product.properties).toHaveProperty('brand')
    expect(body.text.format.schema.properties.imagePlans.minItems).toBe(7)
    expect(body.text.format.schema.properties.imagePlans.maxItems).toBe(7)
    expect(body.text.format.schema.properties.imagePlans.items.properties.slot.enum).toEqual(['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06'])
    expect(body.text.format.schema.properties.imagePlans.items.properties).toHaveProperty('planMarkdown')
    expect(body.text.format.schema.properties.imagePlans.items.properties).toHaveProperty('negativePrompt')
    expect(body.text.format.schema.properties.imagePlans.items.properties.prompt.description).toContain('US-English')
    expect(body.input[0].content[0].text).toContain('Parse this Amazon.com listing copy')
    expect(body.input[0].content[0].text).toContain('Target marketplace language for visible customer-facing copy: US English.')
    expect(body.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,ref' })
    expect(result.marketplaceId).toBe('us')
    expect(result.parsed.title).toBe('AI planned tumbler')
    expect(result.seriesStyleGuide).toContain('cohesive warm')
    expect(result.plans[0]).toMatchObject({
      slot: 'MAIN',
      planMarkdown: expect.stringContaining('MAIN 主图方案'),
      negativePrompt: 'negative MAIN',
    })
  })

  it('normalizes packageIncludes arrays returned by non-compliant planner APIs', async () => {
    const baseApiPayload = createApiPayload()
    const apiPayload = {
      ...baseApiPayload,
      product: {
        ...baseApiPayload.product,
        packageIncludes: [' 1 tumbler ', '', '1 straw'],
      },
    }
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(apiPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
    })

    expect(result.parsed.inferred.packageIncludes).toBe('1 tumbler, 1 straw')
  })

  it('uses the independent planner profile connection in standard mode', async () => {
    const apiPayload = createApiPayload('Independent planner planned tumbler')
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(apiPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const settings = normalizeSettings({
      profiles: [
        createDefaultOpenAIProfile({
          id: 'image-profile',
          baseUrl: 'https://proxy.example.com/v1',
          apiKey: 'shared-key',
          apiMode: 'images',
          model: DEFAULT_IMAGES_MODEL,
        }),
        createDefaultAmazonPlannerProfile({
          id: 'planner-profile',
          baseUrl: 'https://planner.example.com/v1',
          apiKey: 'planner-key',
          apiMode: 'responses',
          model: DEFAULT_RESPONSES_MODEL,
        }),
      ],
      activeProfileId: 'image-profile',
      amazonPlannerProfileId: 'planner-profile',
    })
    const plannerProfile = getAmazonPlannerProfile(settings)
    expect(plannerProfile).toMatchObject({
      id: 'planner-profile',
      baseUrl: 'https://planner.example.com/v1',
      apiKey: 'planner-key',
      apiMode: 'responses',
      model: DEFAULT_RESPONSES_MODEL,
    })

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      profile: plannerProfile!,
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://planner.example.com/v1/responses')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer planner-key')
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe(DEFAULT_RESPONSES_MODEL)
    expect(result.parsed.title).toBe('Independent planner planned tumbler')
  })

  it('uses the active profile connection in single-connection mode while keeping planner API mode and model', async () => {
    const apiPayload = createApiPayload('Shared connection planned tumbler')
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(apiPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const settings = normalizeSettings({
      profiles: [
        createDefaultOpenAIProfile({
          id: 'image-profile',
          baseUrl: 'https://proxy.example.com/v1',
          apiKey: 'shared-key',
          apiMode: 'images',
          model: DEFAULT_IMAGES_MODEL,
        }),
        createDefaultAmazonPlannerProfile({
          id: 'planner-profile',
          apiKey: '',
          apiMode: 'responses',
          model: DEFAULT_RESPONSES_MODEL,
        }),
      ],
      activeProfileId: 'image-profile',
      amazonPlannerProfileId: 'planner-profile',
      apiSetupMode: 'single-connection',
    })
    const plannerProfile = getAmazonPlannerProfile(settings)
    expect(plannerProfile).toMatchObject({
      id: 'planner-profile',
      baseUrl: 'https://proxy.example.com/v1',
      apiKey: 'shared-key',
      apiMode: 'responses',
      model: DEFAULT_RESPONSES_MODEL,
    })

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      profile: plannerProfile!,
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://proxy.example.com/v1/responses')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer shared-key')
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe(DEFAULT_RESPONSES_MODEL)
    expect(result.parsed.title).toBe('Shared connection planned tumbler')
  })

  it('uses the requested Listing image count in Responses schema, instructions, input, and result validation', async () => {
    const apiPayload = createApiPayload('10 image tumbler', 10)
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(apiPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
      listingImageCount: 10,
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    const slots = ['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06', 'PT07', 'PT08', 'PT09']
    expect(body.text.format.schema.properties.imagePlans.minItems).toBe(10)
    expect(body.text.format.schema.properties.imagePlans.maxItems).toBe(10)
    expect(body.text.format.schema.properties.imagePlans.items.properties.slot.enum).toEqual(slots)
    expect(body.instructions).toContain(`exactly 10 Amazon listing image slots: ${slots.join(', ')}`)
    expect(body.input[0].content[0].text).toContain('produce the 10-image visual plan')
    expect(result.plans).toHaveLength(10)
    expect(result.plans.map((plan) => plan.slot)).toEqual(slots)
  })

  it('localizes Responses API planning instructions for Japan marketplace visible copy', async () => {
    const apiPayload = createApiPayload('Japan marketplace tumbler')
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(apiPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
      marketplaceId: 'jp',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.instructions).toContain('Target marketplace: 日本站 (Amazon.co.jp, locale ja-JP).')
    expect(body.instructions).toContain('on-image Japanese copy')
    expect(body.instructions).toContain('Japanese visible text may use Japanese characters')
    expect(body.text.format.schema.properties.imagePlans.items.properties.prompt.description).toContain('Amazon.co.jp')
    expect(body.text.format.schema.properties.imagePlans.items.properties.prompt.description).toContain('Japanese')
    expect(body.input[0].content[0].text).toContain('Parse this Amazon.co.jp listing copy')
    expect(body.input[0].content[0].text).toContain('Target marketplace language for visible customer-facing copy: Japanese.')
    expect(result.marketplaceId).toBe('jp')
    expect(result.plans).toHaveLength(7)
  })

  it('uses Chat Completions planning with multimodal user content when references are present', async () => {
    const apiPayload = createApiPayload('Chat planned tumbler')
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify(apiPayload),
          },
          finish_reason: 'stop',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      referenceImageDataUrls: ['data:image/png;base64,ref-chat'],
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com',
        apiKey: 'chat-key',
        apiMode: 'chat',
        model: DEFAULT_CHAT_MODEL,
      }),
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/chat/completions')
    const body = JSON.parse(String(init?.body))
    expect(body.messages[0].content).toContain('Return a valid JSON object only')
    expect(body.messages[0].content).toContain('Target marketplace: 美国站 (Amazon.com, locale en-US).')
    expect(body.messages[0].content).toContain('Visible on-image copy inside prompt must use natural US English for Amazon.com')
    expect(body.messages[0].content).not.toContain('styleCandidates')
    expect(body.messages[0].content).not.toContain('Because DeepSeek cannot receive or understand reference images')
    expect(body.messages[0].content).toContain('Amazon Listing reference material for the planner')
    expect(body.messages[0].content).toContain('Use product reference images only to identify product facts')
    expect(body.messages[0].content).toContain('must avoid fixed non-product aesthetics')
    expect(body.messages[0].content).toContain('built-in preset style reference boards')
    expect(body.messages[1].content[0]).toMatchObject({ type: 'text' })
    expect(body.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,ref-chat' },
    })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(result.parsed.title).toBe('Chat planned tumbler')
    expect(result.marketplaceId).toBe('us')
    expect(result.plans).toHaveLength(7)
  })

  it('uses the requested Listing image count in Chat Completions schema guidance', async () => {
    const apiPayload = createApiPayload('Chat 10 image tumbler', 10)
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify(apiPayload),
          },
          finish_reason: 'stop',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: DEFAULT_AMAZON_PROMPT_DRAFT,
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com',
        apiKey: 'chat-key',
        apiMode: 'chat',
        model: DEFAULT_CHAT_MODEL,
      }),
      listingImageCount: 10,
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.messages[0].content).toContain('imagePlans must contain exactly 10 items in this order: MAIN, PT01, PT02, PT03, PT04, PT05, PT06, PT07, PT08, PT09.')
    expect(body.messages[1].content).toContain('produce the 10-image visual plan')
    expect(result.plans).toHaveLength(10)
  })

  it('omits reference images for DeepSeek Chat Completions planning', async () => {
    const apiPayload = createApiPayload('DeepSeek planned tumbler')
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify(apiPayload),
          },
          finish_reason: 'stop',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: {
        ...DEFAULT_AMAZON_PROMPT_DRAFT,
        color: 'matte black',
        packageIncludes: '1 tumbler, 1 straw',
      },
      referenceImageDataUrls: ['data:image/png;base64,ref-chat'],
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'deepseek-key',
        apiMode: 'chat',
        model: DEFAULT_CHAT_MODEL,
      }),
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    const body = JSON.parse(String(init?.body))
    expect(body.messages[0].content).toContain('Because DeepSeek cannot receive or understand reference images')
    expect(body.messages[0].content).toContain('Do not invent colors, shapes, structures, accessories, logos, bundle quantity')
    expect(typeof body.messages[1].content).toBe('string')
    expect(body.messages[1].content).toContain('Parse this Amazon.com listing copy')
    expect(body.messages[1].content).toContain('User-provided product facts')
    expect(body.messages[1].content).toContain('- Color: matte black')
    expect(body.messages[1].content).toContain('- Package includes: 1 tumbler, 1 straw')
    expect(body.messages[1].content).not.toContain('If reference images are attached')
    expect(JSON.stringify(body.messages)).not.toContain('image_url')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(result.parsed.title).toBe('DeepSeek planned tumbler')
    expect(result.plans).toHaveLength(7)
  })

  it('omits reference images for DeepSeek Responses API planning', async () => {
    const apiPayload = createApiPayload('DeepSeek responses planned tumbler')
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(apiPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: {
        ...DEFAULT_AMAZON_PROMPT_DRAFT,
        brand: 'ExampleBrand',
        material: '18/8 stainless steel',
      },
      referenceImageDataUrls: ['data:image/png;base64,ref-responses'],
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'deepseek-key',
        apiMode: 'responses',
        model: 'deepseek-v4-pro',
      }),
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/v1/responses')
    const body = JSON.parse(String(init?.body))
    expect(body.instructions).toContain('Because DeepSeek cannot receive or understand reference images')
    expect(body.instructions).toContain('Do not invent colors, shapes, structures, accessories, logos, bundle quantity')
    expect(body.input[0].content).toHaveLength(1)
    expect(body.input[0].content[0].type).toBe('input_text')
    expect(body.input[0].content[0].text).toContain('User-provided product facts')
    expect(body.input[0].content[0].text).toContain('- Brand or model: ExampleBrand')
    expect(body.input[0].content[0].text).toContain('- Material / finish: 18/8 stainless steel')
    expect(body.input[0].content[0].text).not.toContain('If reference images are attached')
    expect(JSON.stringify(body.input)).not.toContain('input_image')
    expect(result.parsed.title).toBe('DeepSeek responses planned tumbler')
    expect(result.plans).toHaveLength(7)
  })

  it('parses Standard A+ output and fills fixed module sizes without deciding content locally', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(createAPlusPayload('A+S', 'Standard A+ tumbler', 'ExampleBrand')),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, brand: 'ExampleBrand' },
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
      mode: 'aplus',
      aPlusType: 'standard',
      aPlusGenerationTier: '2K',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.text.format.name).toBe('amazon_aplus_image_plan')
    expect(body.text.format.schema.properties.product.properties).toHaveProperty('brand')
    expect(body.text.format.schema.properties.product.required).toContain('brand')
    expect(body.text.format.schema.properties.aPlusPlans.items.properties).toHaveProperty('planMarkdown')
    expect(body.text.format.schema.properties.aPlusPlans.items.properties).toHaveProperty('negativePrompt')
    expect(body.text.format.schema.required).toContain('seriesStyleGuide')
    expect(body.text.format.schema.required).not.toContain('visualSystem')
    expect(body.instructions).toContain('The application only fixes the module order, module type, upload size, and generation size')
    expect(body.instructions).toContain('Amazon A+ reference material for the planner')
    expect(body.instructions).toContain('Use product reference images only to identify product facts')
    expect(body.instructions).toContain('must avoid fixed non-product aesthetics')
    expect(body.instructions).toContain('Header Banner 970x300')
    expect(body.instructions).toContain('Single Image 970x600')
    expect(body.instructions).toContain('Highlight Tile 220x220')
    expect(body.instructions).toContain('Comparison Thumbnail 150x300')
    expect(body.instructions).toContain('QR codes')
    expect(body.instructions).toContain('mobile-readable')
    expect(body.instructions).toContain('built-in preset style reference boards')
    expect(body.instructions).not.toContain('visual style reference board generation')
    expect(body.instructions).toContain('fully plan the finished Amazon image')
    expect(body.instructions).toContain('complete information design')
    expect(body.instructions).toContain('Known brand/model: ExampleBrand')
    expect(body.instructions).toContain('small brand line, headline prefix, or subline')
    expect(body.instructions).toContain('Do not invent logo artwork')
    expect(body.instructions).not.toContain('sparse copy')
    expect(body.instructions).not.toContain('leave enough whitespace')
    expect(body.instructions).not.toContain('A+ compliance:')
    expect(result.mode).toBe('aplus')
    expect(result.parsed.inferred.brand).toBe('ExampleBrand')
    expect(result.aPlusPlans).toHaveLength(8)
    expect(result.aPlusPlans[0]).toMatchObject({
      slot: 'A+S01',
      moduleType: 'header-banner',
      uploadSize: '970x300',
      planMarkdown: expect.stringContaining('A+S01 模块方案'),
      prompt: expect.stringContaining('ExampleBrand'),
    })
    expect(result.aPlusPlans[4]).toMatchObject({
      slot: 'A+S05',
      moduleType: 'highlight-tile',
      uploadSize: '220x220',
      textTitle: 'Benefit A+S05',
      textBody: 'External A+ copy for A+S05.',
    })
  })

  it.each([
    ['de', '德国站', 'Amazon.de', 'German'],
    ['fr', '法国站', 'Amazon.fr', 'French'],
    ['it', '意大利站', 'Amazon.it', 'Italian'],
    ['es', '西班牙站', 'Amazon.es', 'Spanish'],
  ] as const)('localizes A+ external text instructions for %s marketplace', async (marketplaceId, label, domain, language) => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(createAPlusPayload('A+S', `${language} A+ tumbler`, 'ExampleBrand')),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, brand: 'ExampleBrand' },
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
      mode: 'aplus',
      aPlusType: 'standard',
      marketplaceId,
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.instructions).toContain(`Target marketplace: ${label} (${domain}, locale`)
    expect(body.instructions).toContain(`on-image ${language} copy`)
    expect(body.instructions).toContain(`write textTitle and textBody in natural ${language}`)
    expect(body.text.format.schema.properties.aPlusPlans.items.properties.textTitle.description).toContain(`natural ${language}`)
    expect(body.text.format.schema.properties.aPlusPlans.items.properties.textBody.description).toContain(domain)
    expect(body.text.format.schema.properties.aPlusPlans.items.properties.prompt.description).toContain(language)
    expect(body.input[0].content[0].text).toContain(`Parse this ${domain} listing copy`)
    expect(body.input[0].content[0].text).toContain(`Target marketplace language for visible customer-facing copy: ${language}.`)
    expect(result.marketplaceId).toBe(marketplaceId)
  })

  it('uses custom A+ module specs in schema, prompts, chat guide, and result validation', async () => {
    const customSpecs = insertAPlusModuleSpecAfter('standard-large', getAPlusModuleSpecs('standard-large'), 4)
    const customPayload = createAPlusPayloadFromSpecs(customSpecs, 'Custom A+ tumbler', 'ExampleBrand')
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(customPayload),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const responseResult = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, brand: 'ExampleBrand' },
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
      mode: 'aplus',
      aPlusType: 'standard-large',
      aPlusModuleSpecs: customSpecs,
      aPlusGenerationTier: '2K',
    })

    const responseBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(responseBody.text.format.schema.properties.aPlusPlans.minItems).toBe(6)
    expect(responseBody.text.format.schema.properties.aPlusPlans.maxItems).toBe(6)
    expect(responseBody.text.format.schema.properties.aPlusPlans.items.properties.slot.enum).toEqual(['A+L01', 'A+L02', 'A+L03', 'A+L04', 'A+L05', 'A+L06'])
    expect(responseBody.instructions).toContain('Return exactly 6 modules')
    expect(responseBody.instructions).toContain('A+L06 Single Image 5 970x600px')
    expect(responseBody.input[0].content[0].text).toContain('Use these A+ modules exactly: A+L01, A+L02, A+L03, A+L04, A+L05, A+L06.')
    expect(responseResult.aPlusPlans).toHaveLength(6)
    expect(responseResult.aPlusPlans[5]).toMatchObject({
      slot: 'A+L06',
      label: 'Single Image 5',
      moduleType: 'single-image',
      uploadSize: '970x600',
      planMarkdown: expect.stringContaining('A+L06 模块方案'),
    })

    fetchMock.mockClear()
    const chatResult = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, brand: 'ExampleBrand' },
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'chat',
        model: 'gpt-planner-profile',
      }),
      mode: 'aplus',
      aPlusType: 'standard-large',
      aPlusModuleSpecs: customSpecs,
      aPlusGenerationTier: '2K',
    })

    const chatBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(chatBody.messages[0].content).toContain('Return exactly 6 modules')
    expect(chatBody.messages[0].content).toContain('aPlusPlans must contain exactly 6 items in this order: A+L01, A+L02, A+L03, A+L04, A+L05, A+L06.')
    expect(chatBody.messages[1].content).toContain('Use these A+ modules exactly: A+L01, A+L02, A+L03, A+L04, A+L05, A+L06.')
    expect(chatResult.aPlusPlans).toHaveLength(6)
  })

  it('parses Mobile A+ output as five fixed 600x450 modules', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(createAPlusPayload('A+M', 'Mobile A+ tumbler', 'ExampleBrand')),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, brand: 'ExampleBrand' },
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
      mode: 'aplus',
      aPlusType: 'mobile',
      aPlusGenerationTier: '2K',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.text.format.schema.properties.aPlusPlans.minItems).toBe(5)
    expect(body.text.format.schema.properties.aPlusPlans.maxItems).toBe(5)
    expect(body.text.format.schema.properties.aPlusPlans.items.properties.slot.enum).toEqual(['A+M01', 'A+M02', 'A+M03', 'A+M04', 'A+M05'])
    expect(body.text.format.schema.properties.aPlusPlans.items.properties.moduleType.enum).toEqual(['hero-banner', 'feature-image'])
    expect(body.instructions).toContain('Mobile A+ Content 600x450 module set')
    expect(body.instructions).toContain('A+M01 Mobile Hero 600x450px')
    expect(body.instructions).toContain('A+M05 Mobile Feature 4 600x450px')
    expect(body.instructions).toContain('five compact 600x450 modules')
    expect(body.instructions).toContain('compact mobile screens')
    expect(body.input[0].content[0].text).toContain('手机A+ module plan')
    expect(body.input[0].content[0].text).toContain('Use these A+ modules exactly: A+M01, A+M02, A+M03, A+M04, A+M05.')
    expect(result.mode).toBe('aplus')
    expect(result.aPlusType).toBe('mobile')
    expect(result.aPlusPlans).toHaveLength(5)
    expect(result.aPlusPlans[0]).toMatchObject({
      slot: 'A+M01',
      moduleType: 'hero-banner',
      uploadSize: '600x450',
      planMarkdown: expect.stringContaining('A+M01 模块方案'),
      prompt: expect.stringContaining('ExampleBrand'),
    })
    expect(result.aPlusPlans[4]).toMatchObject({
      slot: 'A+M05',
      moduleType: 'feature-image',
      uploadSize: '600x450',
    })
    expect(result.aPlusPlans[0]?.generationSize).not.toBe('600x450')
  })

  it('does not include empty A+ brand output in parsed inferred fields', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(createAPlusPayload('A+S', 'Standard A+ tumbler')),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callAmazonPlannerApi({
      listingText: SAMPLE_LISTING,
      baseDraft: { ...DEFAULT_AMAZON_PROMPT_DRAFT, brand: 'ExistingBrand' },
      profile: createDefaultOpenAIProfile({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'user-api-key',
        apiMode: 'responses',
        model: 'gpt-planner-profile',
      }),
      mode: 'aplus',
      aPlusType: 'standard',
      aPlusGenerationTier: '2K',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.instructions).toContain('Known brand/model: ExistingBrand')
    expect(result.parsed.inferred).not.toHaveProperty('brand')
  })
})
