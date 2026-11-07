/**
 * 「我的画像」— 跨工作区共享的个人信息首页。
 *
 * 与旧版的差别：首屏可直接改名字 / 头像，并填写四个常用字段；
 * 字段即改即存到既有全局记忆文件，保留「管理记忆文件」作为进阶出口。
 * 只走 renderer 已有的 electronAPI，不改动 preload / 主进程契约。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { RefreshCw, Settings2 } from 'lucide-react'
import type { GlobalMemorySummary } from '@profer/shared'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import {
  FullScreenView,
  ViewBody,
  ViewHeader,
} from '@/components/app-shell/FullScreenView'
import { activeViewAtom, globalProfileFileAtom } from '@/atoms/active-view'
import { userProfileAtom } from '@/atoms/user-profile'
import { ProfileIdentity } from './ProfileIdentity'
import { GlobalUsageCard } from './GlobalUsageCard'
import {
  FreeTextCard,
  InferredCard,
  PrivacyFooter,
  QuickFieldGrid,
  SecondaryFilesCard,
  type FieldSaveState,
} from './ProfileSections'
import {
  QUICK_FIELDS,
  QUICK_FIELD_FILES,
  normalizeFieldValue,
  plainText,
  readField,
  writeField,
  type QuickField,
  type QuickFieldKey,
} from './profile-fields'

/** 需要读取的全部记忆文件（首屏字段文件 + 概览展示文件 + 推断文件）。 */
const ALL_FILES = [
  ...QUICK_FIELD_FILES,
  'devices/README.md',
  'infrastructure/servers.md',
  'user-sense.md',
] as const

const EMPTY_DRAFTS: Record<QuickFieldKey, string> = {
  address: '',
  role: '',
  language: '',
  collaboration: '',
}

const IDLE_STATES: Record<QuickFieldKey, FieldSaveState> = {
  address: 'idle',
  role: 'idle',
  language: 'idle',
  collaboration: 'idle',
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return '今天'
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

/** 由已填字段拼出身份卡下的一句话摘要。 */
function buildSummary(drafts: Record<QuickFieldKey, string>): string {
  const parts = [
    drafts.address.trim(),
    drafts.role.trim(),
    drafts.language.trim() ? `${drafts.language.trim()}` : '',
  ].filter(Boolean)
  if (parts.length === 0) return ''
  return parts.join(' · ')
}

function ProfileSkeleton(): React.ReactElement {
  return (
    <div className="mx-auto w-full max-w-[880px] px-6 pb-12 pt-7 sm:px-8" aria-busy="true">
      <div className="h-[188px] animate-pulse rounded-2xl border border-border/70 bg-muted/30 motion-reduce:animate-none" />
      <div className="mt-6 h-[260px] animate-pulse rounded-2xl border border-border/70 bg-muted/30 motion-reduce:animate-none" />
      <div className="mt-6 h-[150px] animate-pulse rounded-2xl border border-border/70 bg-muted/30 motion-reduce:animate-none" />
      <span className="sr-only">正在读取我的画像…</span>
    </div>
  )
}

export function GlobalProfileView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)
  const setProfileFile = useSetAtom(globalProfileFileAtom)
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)

  const [summary, setSummary] = React.useState<GlobalMemorySummary | null>(null)
  const [contents, setContents] = React.useState<Record<string, string>>({})
  const [drafts, setDrafts] = React.useState<Record<QuickFieldKey, string>>(EMPTY_DRAFTS)
  const [saveState, setSaveState] = React.useState<Record<QuickFieldKey, FieldSaveState>>(IDLE_STATES)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [savingName, setSavingName] = React.useState(false)
  const [savingAvatar, setSavingAvatar] = React.useState(false)

  // 保存队列：同一文件的写入串行化，且每次都基于「最新文档」重算，
  // 避免多个字段同时 blur 时后写覆盖先写。ref 保存的是各文件的当前全文。
  const docsRef = React.useRef<Record<string, string>>({})
  const queuesRef = React.useRef<Record<string, Promise<void>>>({})
  const savedTimers = React.useRef<Partial<Record<QuickFieldKey, ReturnType<typeof setTimeout>>>>({})
  const aliveRef = React.useRef(true)

  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      for (const timer of Object.values(savedTimers.current)) {
        if (timer) clearTimeout(timer)
      }
      savedTimers.current = {}
    }
  }, [])

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [nextSummary, nextContents] = await Promise.all([
        window.electronAPI.getGlobalMemorySummary(),
        Promise.all(
          ALL_FILES.map(async (path) => [
            path,
            (await window.electronAPI.readGlobalMemoryFile(path)).content ?? '',
          ] as const),
        ),
      ])
      const nextDocs = Object.fromEntries(nextContents)
      if (!aliveRef.current) return
      docsRef.current = nextDocs
      queuesRef.current = {}
      setSummary(nextSummary)
      setContents(nextDocs)
      const nextDrafts = { ...EMPTY_DRAFTS }
      for (const field of QUICK_FIELDS) {
        nextDrafts[field.key] = readField(nextDocs[field.file] ?? '', field.title)
      }
      setDrafts(nextDrafts)
      setSaveState(IDLE_STATES)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast.error(`读取我的画像失败：${message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const openFile = (path: string): void => {
    setProfileFile(path)
    setActiveView('user-profile-files')
  }

  /** 头像 / 名字：与「设置 / 账户」使用同一个 updateUserProfile 契约。 */
  const saveProfile = React.useCallback(async (updates: { userName?: string; avatar?: string }, kind: 'name' | 'avatar'): Promise<void> => {
    const setSaving = kind === 'name' ? setSavingName : setSavingAvatar
    setSaving(true)
    try {
      const updated = await window.electronAPI.updateUserProfile(updates)
      if (!aliveRef.current) return
      setUserProfile(updated)
    } catch (cause) {
      if (!aliveRef.current) return
      toast.error(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (aliveRef.current) setSaving(false)
    }
  }, [setUserProfile])

  /** 字段失焦时提交：只在内容相对已保存值变化时才写盘。 */
  const commitField = React.useCallback((field: QuickField): void => {
    if (loading || error) return
    const value = normalizeFieldValue(drafts[field.key] ?? '')
    const previous = readField(docsRef.current[field.file] ?? '', field.title)
    if (value === previous) {
      setSaveState((state) => ({ ...state, [field.key]: 'idle' }))
      return
    }

    setSaveState((state) => ({ ...state, [field.key]: 'saving' }))
    const path = field.file
    // 串行接到该文件既有队列尾部，写入前重新读取当前内存文档。
    const task = (queuesRef.current[path] ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const doc = writeField(docsRef.current[path] ?? '', field.title, value)
        await window.electronAPI.writeGlobalMemoryFile(path, doc)
        docsRef.current[path] = doc
        if (!aliveRef.current) return
        setContents((current) => ({ ...current, [path]: doc }))
        const nextSummary = await window.electronAPI.getGlobalMemorySummary()
        if (!aliveRef.current) return
        setSummary(nextSummary)
        setSaveState((state) => ({ ...state, [field.key]: 'saved' }))
        const timer = savedTimers.current[field.key]
        if (timer) clearTimeout(timer)
        savedTimers.current[field.key] = setTimeout(() => {
          setSaveState((state) => ({ ...state, [field.key]: 'idle' }))
        }, 2200)
      })
      .catch((cause: unknown) => {
        if (!aliveRef.current) return
        setSaveState((state) => ({ ...state, [field.key]: 'error' }))
        toast.error(`保存「${field.label}」失败：${cause instanceof Error ? cause.message : String(cause)}`)
      })

    queuesRef.current[path] = task
  }, [drafts, loading, error])

  const filledCount = QUICK_FIELDS.filter((field) => (drafts[field.key] ?? '').trim().length > 0).length
  const inferredCount = plainText(contents['user-sense.md'] ?? '').length > 0 ? 1 : 0
  const updatedAt = formatDate(summary?.updatedAt)

  return (
    <FullScreenView region="user-profile" controlsId="user-profile">
      <ViewHeader
        title="我的画像"
        subtitle="跨工作区共享的个人信息"
        back={{ label: '返回当前 Agent 会话', onClick: () => setActiveView('conversations') }}
        actions={
          <>
            <Button variant="ghost" size="icon" className="size-8" onClick={() => void load()} aria-label="刷新">
              <RefreshCw className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-3 text-[13px]"
              onClick={() => setActiveView('user-profile-files')}
            >
              <Settings2 className="size-3.5" aria-hidden="true" />
              管理文件
            </Button>
          </>
        }
      />

      <ScrollRegion className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <ProfileSkeleton />
        ) : error ? (
          <div className="mx-auto w-full max-w-[880px] px-6 py-7 sm:px-8">
            <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6">
              <p className="text-sm font-medium text-destructive">读取我的画像失败</p>
              <p className="mt-1.5 text-xs leading-6 text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
                重试
              </Button>
            </div>
          </div>
        ) : (
          <ViewBody className="pb-10">
            <h1 className="sr-only">我的画像</h1>
            <div className="grid items-start gap-4 lg:grid-cols-[252px_minmax(0,1fr)_252px]">
              <aside className="min-w-0 space-y-4">
                <ProfileIdentity
                  name={userProfile.userName}
                  avatar={userProfile.avatar}
                  summaryLine={buildSummary(drafts)}
                  savingName={savingName}
                  savingAvatar={savingAvatar}
                  filledCount={filledCount}
                  totalCount={QUICK_FIELDS.length}
                  updatedAt={updatedAt}
                  inferredCount={inferredCount}
                  onSaveName={(name) => void saveProfile({ userName: name }, 'name')}
                  onSaveAvatar={(avatar) => void saveProfile({ avatar }, 'avatar')}
                />
                <QuickFieldGrid
                  drafts={drafts}
                  saveState={saveState}
                  onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
                  onCommit={commitField}
                />
              </aside>

              <main className="min-w-0 space-y-4">
                <GlobalUsageCard />
                <FreeTextCard contents={contents} onOpenFile={openFile} />
                <InferredCard content={contents['user-sense.md'] ?? ''} onOpenFile={openFile} />
              </main>

              <aside className="min-w-0 space-y-4">
                <section aria-label="画像概览" className="rounded-2xl border border-border/80 bg-card p-5 shadow-sm dark:bg-surface-raised">
                  <h2 className="text-sm font-semibold text-foreground">画像概览</h2>
                  <dl className="mt-4 divide-y divide-border/60 text-xs">
                    <div className="flex justify-between gap-4 py-3"><dt className="text-muted-foreground">基础信息</dt><dd className="font-medium tabular-nums">{filledCount} / {QUICK_FIELDS.length}</dd></div>
                    <div className="flex justify-between gap-4 py-3"><dt className="text-muted-foreground">记忆文件</dt><dd className="font-medium tabular-nums">{summary?.fileCount ?? '—'}</dd></div>
                    <div className="flex justify-between gap-4 py-3"><dt className="text-muted-foreground">本地推断</dt><dd className="font-medium tabular-nums">{inferredCount} 项</dd></div>
                    <div className="flex justify-between gap-4 py-3"><dt className="text-muted-foreground">最近更新</dt><dd className="text-right font-medium">{updatedAt || '—'}</dd></div>
                  </dl>
                  <p className="mt-3 text-[11px] leading-5 text-muted-foreground">画像跨工作区共享，本地推断与已确认信息分开展示。</p>
                </section>
                <SecondaryFilesCard contents={contents} onOpenFile={openFile} />
              </aside>
            </div>
            <div className="mt-4"><PrivacyFooter onManageFiles={() => setActiveView('user-profile-files')} /></div>
          </ViewBody>
        )}
      </ScrollRegion>
    </FullScreenView>
  )
}
