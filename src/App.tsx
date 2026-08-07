import { lazy, Suspense, useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import Header, { type MainWorkspacePage } from './components/Header'
import { useGlobalClickSuppression } from './lib/clickSuppression'

const AmazonPlanner = lazy(() => import('./components/AmazonPlanner'))
const InputBar = lazy(() => import('./components/InputBar'))
const SearchBar = lazy(() => import('./components/SearchBar'))
const TaskGrid = lazy(() => import('./components/TaskGrid'))
const GlobalInsights = lazy(() => import('./components/GlobalInsights'))
const DetailModal = lazy(() => import('./components/DetailModal'))
const Lightbox = lazy(() => import('./components/Lightbox'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))
const ConfirmDialog = lazy(() => import('./components/ConfirmDialog'))
const MaskEditorModal = lazy(() => import('./components/MaskEditorModal'))
const Toast = lazy(() => import('./components/Toast'))
const ImageContextMenu = lazy(() => import('./components/ImageContextMenu'))

function WorkspaceFallback() {
  return (
    <div className="mt-6 animate-pulse" aria-label="正在加载工作区">
      <div className="h-40 rounded-[var(--ios-radius-lg)] bg-[hsl(var(--muted))]" />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="h-48 rounded-[var(--ios-radius-lg)] bg-[hsl(var(--muted))]" />
        <div className="h-48 rounded-[var(--ios-radius-lg)] bg-[hsl(var(--muted))]" />
      </div>
    </div>
  )
}

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const showSettings = useStore((s) => s.showSettings)
  const confirmDialog = useStore((s) => s.confirmDialog)
  const maskEditorImageId = useStore((s) => s.maskEditorImageId)
  const [workspacePage, setWorkspacePage] = useState<MainWorkspacePage>('studio')
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    initStore()
    useStore.getState().setAppMode('gallery')
  }, [setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header activePage={workspacePage} onPageChange={setWorkspacePage} />
      <main data-home-main data-drag-select-surface className={workspacePage === 'studio' ? 'home-main-with-dock pb-48 lg:pb-10' : 'pb-10'}>
        <div className="safe-area-x max-w-7xl mx-auto lg:!px-6">
          {workspacePage === 'studio' ? (
            <Suspense fallback={<WorkspaceFallback />}>
              <AmazonPlanner />
              <SearchBar />
              <TaskGrid />
            </Suspense>
          ) : (
            <Suspense fallback={<WorkspaceFallback />}>
              <GlobalInsights />
            </Suspense>
          )}
        </div>
      </main>
      {workspacePage === 'studio' && (
        <Suspense fallback={null}>
          <InputBar />
        </Suspense>
      )}
      <Suspense fallback={null}>
        {detailTaskId && <DetailModal />}
        {lightboxImageId && <Lightbox />}
        {showSettings && <SettingsModal />}
        {confirmDialog && <ConfirmDialog />}
        {maskEditorImageId && <MaskEditorModal />}
      </Suspense>
      <Suspense fallback={null}>
        <Toast />
        <ImageContextMenu />
      </Suspense>
    </>
  )
}
