import { lazy, Suspense, useEffect, useState } from 'react'
import { useStore } from '../store'
import { useTooltip } from '../hooks/useTooltip'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import ViewportTooltip from './ViewportTooltip'
import { HelpCircleIcon, InstallIcon, SettingsIcon } from './icons'
import { Button } from './Button'

const HelpModal = lazy(() => import('./HelpModal'))

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export type MainWorkspacePage = 'studio' | 'global-insights'

interface HeaderProps {
  activePage: MainWorkspacePage
  onPageChange: (page: MainWorkspacePage) => void
}

function isInstalledPwa() {
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
}

export default function Header({ activePage, onPageChange }: HeaderProps) {
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [showHelp, setShowHelp] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isPwaInstalled, setIsPwaInstalled] = useState(isInstalledPwa)

  const installTooltip = useTooltip()
  const helpTooltip = useTooltip()
  const settingsTooltip = useTooltip()

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
      setIsPwaInstalled(false)
    }

    const handleAppInstalled = () => {
      setInstallPrompt(null)
      setIsPwaInstalled(true)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  const handleInstallClick = async () => {
    if (installPrompt) {
      const promptEvent = installPrompt
      setInstallPrompt(null)

      try {
        await promptEvent.prompt()
        const choice = await promptEvent.userChoice
        setIsPwaInstalled(choice.outcome === 'accepted')
      } catch {
        setIsPwaInstalled(isInstalledPwa())
      }
    } else {
      const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      if (isIos) {
        setConfirmDialog({
          title: '安装为应用',
          message: '在 Safari 浏览器中，点击底部「分享」按钮，选择「添加到主屏幕」即可安装此应用。',
          showCancel: false,
          confirmText: '我知道了',
          icon: 'info',
          action: () => {},
        })
      } else {
        setConfirmDialog({
          title: '安装为应用',
          message: '请在浏览器的菜单中选择「添加到主屏幕」或「安装应用」。\n\n（如果在微信等内置浏览器中，请先在外部浏览器打开）',
          showCancel: false,
          confirmText: '我知道了',
          icon: 'info',
          action: () => {},
        })
      }
    }
  }

  return (
    <>
      <header data-no-drag-select className="safe-area-top fixed left-0 right-0 top-0 z-40 border-b border-black/[0.06] bg-white/75 shadow-[0_1px_0_rgba(255,255,255,0.5)] backdrop-blur-2xl dark:border-white/[0.08] dark:bg-gray-950/80 dark:shadow-none">
        <div className="safe-area-x safe-header-inner mx-auto flex max-w-7xl items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <h1 className="hidden min-w-0 shrink truncate sm:block">
              <span className="text-[16px] font-semibold tracking-[-0.025em] text-gray-900 dark:text-gray-100 sm:text-lg">
                CZH图片工作台
              </span>
            </h1>
            <nav className="ios-segmented shrink-0" aria-label="工作台页面">
              <button
                type="button"
                onClick={() => onPageChange('studio')}
                data-active={activePage === 'studio'}
                className={`ios-segment h-8 px-2.5 text-xs font-semibold sm:px-3 sm:text-sm ${activePage === 'studio' ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}
              >
                图片工作台
              </button>
              <button
                type="button"
                onClick={() => onPageChange('global-insights')}
                data-active={activePage === 'global-insights'}
                className={`ios-segment h-8 px-2.5 text-xs font-semibold sm:px-3 sm:text-sm ${activePage === 'global-insights' ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}
              >
                全球信息
              </button>
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!isPwaInstalled && (
              <div
                className="relative"
                {...installTooltip.handlers}
              >
                <Button
                  onClick={() => {
                    dismissAllTooltips()
                    handleInstallClick()
                  }}
                  variant="plain"
                  size="icon"
                  className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                  aria-label="安装为应用"
                >
                  <InstallIcon className="h-5 w-5" />
                </Button>
                <ViewportTooltip visible={installTooltip.visible} className="whitespace-nowrap">
                  安装为应用
                </ViewportTooltip>
              </div>
            )}
            <div
              className="relative"
              {...helpTooltip.handlers}
            >
              <Button
                onClick={() => {
                  dismissAllTooltips()
                  setShowHelp(true)
                }}
                variant="plain"
                size="icon"
                className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                aria-label="操作指南"
              >
                <HelpCircleIcon className="h-5 w-5" />
              </Button>
              <ViewportTooltip visible={helpTooltip.visible} className="whitespace-nowrap">
                操作指南
              </ViewportTooltip>
            </div>
            <div
              className="relative"
              {...settingsTooltip.handlers}
            >
              <Button
                onClick={() => setShowSettings(true)}
                variant="plain"
                size="icon"
                className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                aria-label="设置"
              >
                <SettingsIcon className="h-5 w-5" />
              </Button>
              <ViewportTooltip visible={settingsTooltip.visible} className="whitespace-nowrap">
                设置
              </ViewportTooltip>
            </div>
          </div>
        </div>
      </header>

      <div className="safe-area-top invisible pointer-events-none" aria-hidden="true">
        <div className="safe-header-inner" />
      </div>
      {showHelp && (
        <Suspense fallback={null}>
          <HelpModal appMode="gallery" onClose={() => setShowHelp(false)} />
        </Suspense>
      )}
    </>
  )
}
