/**
 * 「我的画像」身份卡：可换头像、可改名字、完成度概览。
 *
 * 交互与「设置 / 账户」保持一致（同一个 updateUserProfile 契约），
 * 让用户不必离开画像页就能完成最基础的身份填写。
 */

import * as React from 'react'
import { Camera, Check, ImagePlus, Loader2, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@profer/ui/primitives/popover'
import { UserAvatar } from '@/components/chat/UserAvatar'

/** 表情选择器体积较大，只在用户点开头像时才加载。 */
const EmojiAvatarPicker = React.lazy(() =>
  import('@/components/settings/EmojiAvatarPicker').then((module) => ({ default: module.EmojiAvatarPicker })),
)

const AVATAR_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const AVATAR_MAX_BYTES = 5 * 1024 * 1024
const NAME_MAX_LENGTH = 30

interface ProfileIdentityProps {
  name: string
  avatar: string
  /** 由首屏字段拼成的一句话身份摘要，空串表示还没填。 */
  summaryLine: string
  savingName: boolean
  savingAvatar: boolean
  filledCount: number
  totalCount: number
  updatedAt: string
  inferredCount: number
  onSaveName: (name: string) => void
  onSaveAvatar: (avatar: string) => void
}

/** 头像编辑：emoji 选择 + 本地图片上传，沿用设置页的校验规则。 */
function AvatarEditor({
  avatar,
  saving,
  onSave,
}: {
  avatar: string
  saving: boolean
  onSave: (avatar: string) => void
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const handleImage = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!AVATAR_MIME.includes(file.type)) {
      toast.error('请选择 PNG、JPEG、GIF 或 WebP 图片')
      return
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error('头像图片不能超过 5MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      onSave(String(reader.result ?? ''))
      setOpen(false)
    }
    reader.onerror = () => toast.error('无法读取头像图片，请重新选择')
    reader.readAsDataURL(file)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={saving}
          aria-label="更换头像"
          className="group/avatar relative shrink-0 rounded-[22%] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/20 disabled:opacity-60"
        >
          <UserAvatar avatar={avatar} size={88} className="text-[44px]" />
          <span
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center rounded-[22%] bg-foreground/55 opacity-0 text-background transition-opacity duration-200 group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100"
          >
            {saving ? <Loader2 className="size-5 animate-spin motion-reduce:animate-none" /> : <Camera className="size-5" />}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" sideOffset={12} className="w-auto border-none p-0 shadow-xl">
        <React.Suspense
          fallback={
            <div className="flex h-[320px] w-[280px] items-center justify-center text-[13px] text-muted-foreground">
              正在加载表情…
            </div>
          }
        >
          <EmojiAvatarPicker onEmojiSelect={(emoji) => { onSave(emoji.native); setOpen(false) }} />
        </React.Suspense>
        <div className="border-t border-border/70 p-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-50"
          >
            <ImagePlus className="size-4" />
            上传自定义图片
          </button>
          <input
            ref={fileInputRef}
            type="file"
            aria-label="上传头像图片"
            accept={AVATAR_MIME.join(',')}
            className="hidden"
            onChange={handleImage}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 名字内联编辑：点击文字进入输入，Enter / 失焦保存，Escape 取消。 */
function EditableName({
  name,
  saving,
  onSave,
}: {
  name: string
  saving: boolean
  onSave: (name: string) => void
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(name)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const inputId = React.useId()

  React.useEffect(() => {
    if (!editing) setDraft(name)
  }, [name, editing])

  React.useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = (): void => {
    if (saving) return
    const trimmed = draft.trim()
    if (!trimmed) {
      toast.error('名字不能为空')
      setDraft(name)
      setEditing(false)
      return
    }
    setEditing(false)
    if (trimmed !== name) onSave(trimmed)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <label htmlFor={inputId} className="sr-only">显示名称</label>
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={NAME_MAX_LENGTH}
          readOnly={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commit() }
            else if (event.key === 'Escape') { setDraft(name); setEditing(false) }
          }}
          className="w-full max-w-[180px] rounded-md border-b-2 border-primary bg-transparent pb-0.5 text-[22px] font-semibold leading-tight tracking-[-0.03em] text-foreground outline-none focus-visible:ring-0"
        />
        <button
          type="button"
          aria-label="取消编辑名字"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { setDraft(name); setEditing(false) }}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
        >
          <X className="size-4" />
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      disabled={saving}
      onClick={() => setEditing(true)}
      aria-label={`编辑显示名称，当前为 ${name}`}
      className="group/name flex min-w-0 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-60"
    >
      <span className="truncate text-[22px] font-semibold leading-tight tracking-[-0.03em] text-foreground">
        {name || '我的画像'}
      </span>
      <Pencil className="size-4 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100" />
    </button>
  )
}

/** 完成度：细进度条 + 数字，克制不抢主视觉。 */
function Completeness({ filled, total }: { filled: number; total: number }): React.ReactElement {
  const percent = total > 0 ? Math.round((filled / total) * 100) : 0
  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] tracking-[0.08em] text-muted-foreground">资料完整度</span>
        <span className="font-mono text-[13px] tabular-nums text-foreground">
          {filled}<span className="text-muted-foreground/60"> / {total}</span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={filled}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`已填写 ${filled} 项，共 ${total} 项`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        {filled === 0 ? '填几项常用信息，Agent 就能少问你几次' :
          filled < total ? '再补几项，画像会更完整' : '基础信息已齐全'}
      </p>
    </div>
  )
}

export function ProfileIdentity({
  name,
  avatar,
  summaryLine,
  savingName,
  savingAvatar,
  filledCount,
  totalCount,
  updatedAt,
  inferredCount,
  onSaveName,
  onSaveAvatar,
}: ProfileIdentityProps): React.ReactElement {
  return (
    <section
      aria-label="个人身份"
      className="rounded-2xl border border-border/80 bg-card p-5 shadow-sm dark:bg-surface-raised"
    >
      <div className="flex flex-col gap-6">
        <div className="flex min-w-0 items-start gap-4 lg:flex-col">
          <AvatarEditor avatar={avatar} saving={savingAvatar} onSave={onSaveAvatar} />

          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground/75">
              PROFILE · 个人画像
            </p>

            <div className="mt-2">
              <EditableName name={name} saving={savingName} onSave={onSaveName} />
            </div>

            <p className="mt-2 max-w-[440px] text-[13px] leading-6 text-muted-foreground">
              {summaryLine || '一份写给所有工作区 Agent 的简短自我介绍。'}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Check className="size-3 text-success" aria-hidden="true" />
                仅保存在本机
              </span>
              {updatedAt && (
                <>
                  <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                  <span>更新于 {updatedAt}</span>
                </>
              )}
              {inferredCount > 0 && (
                <>
                  <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                  <span>含 {inferredCount} 项本地推断</span>
                </>
              )}
              {(savingName || savingAvatar) && (
                <span role="status" className="inline-flex items-center gap-1 text-foreground">
                  <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                  保存中…
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-border/60 pt-5">
          <Completeness filled={filledCount} total={totalCount} />
        </div>
      </div>
    </section>
  )
}
