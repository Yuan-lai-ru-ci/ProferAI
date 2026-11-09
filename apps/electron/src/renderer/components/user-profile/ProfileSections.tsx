/**
 * 「我的画像」展示分区：快速字段表单、补充内容、次要档案、本地推断、页脚。
 *
 * 纯展示 + 少量受控表单，不持有 IPC 状态；数据由 GlobalProfileView 注入。
 */

import * as React from 'react'
import {
  AlertCircle,
  ArrowUpRight,
  BriefcaseBusiness,
  Check,
  FileText,
  Handshake,
  HardDrive,
  Laptop,
  Languages,
  Loader2,
  Pencil,
  Plus,
  Server,
  ServerCog,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Tablet,
  Trash2,
  UserRound,
  Watch,
} from 'lucide-react'
import { Input } from '@profer/ui/primitives/input'
import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'
import {
  QUICK_FIELDS,
  customSectionTitles,
  freeTextPreview,
  plainText,
  type QuickField,
  type QuickFieldKey,
  type ProfileDeviceType,
  type ProfileListItem,
} from './profile-fields'

export type FieldSaveState = 'idle' | 'saving' | 'saved' | 'error'

const FIELD_ICONS: Record<QuickFieldKey, React.ComponentType<{ className?: string }>> = {
  address: UserRound,
  role: BriefcaseBusiness,
  language: Languages,
  collaboration: Handshake,
}

/** 卡片统一外壳：同一种圆角、边框、内边距、深浅色表面。 */
function Card({
  id,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLElement> & { id?: string }): React.ReactElement {
  return (
    <section
      id={id}
      {...rest}
      className={cn(
        'rounded-2xl border border-border/80 bg-card shadow-sm dark:bg-surface-raised',
        'animate-in fade-in slide-in-from-bottom-1 duration-500 motion-reduce:animate-none',
        className,
      )}
    >
      {children}
    </section>
  )
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
  action,
}: {
  id?: string
  eyebrow?: string
  title: string
  description?: string
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground/70">{eyebrow}</p>
        )}
        <h2
          id={id}
          className={cn('text-[17px] font-semibold tracking-[-0.015em] text-foreground', eyebrow && 'mt-1.5')}
        >
          {title}
        </h2>
        {description && (
          <p className="mt-1.5 max-w-[62ch] text-[12.5px] leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/** 单个字段的保存反馈：颜色之外始终带图标与文字。 */
function SaveBadge({ state }: { state: FieldSaveState }): React.ReactElement | null {
  if (state === 'idle') return null
  if (state === 'saving') {
    return (
      <span role="status" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
        保存中
      </span>
    )
  }
  if (state === 'saved') {
    return (
      <span role="status" className="inline-flex items-center gap-1 text-[11px] text-success">
        <Check className="size-3" aria-hidden="true" />
        已保存
      </span>
    )
  }
  return (
    <span role="alert" className="inline-flex items-center gap-1 text-[11px] text-destructive">
      <AlertCircle className="size-3" aria-hidden="true" />
      保存失败，重试
    </span>
  )
}

/** 首屏主区：四个即改即存的轻量字段。 */
export function QuickFieldGrid({
  drafts,
  saveState,
  onChange,
  onCommit,
}: {
  drafts: Record<QuickFieldKey, string>
  saveState: Record<QuickFieldKey, FieldSaveState>
  onChange: (key: QuickFieldKey, value: string) => void
  onCommit: (field: QuickField) => void
}): React.ReactElement {
  return (
    <Card id="profile-quick-fields" aria-labelledby="quick-fields-title" className="scroll-mt-6 p-4">
      <SectionHeading
        id="quick-fields-title"
        title="让 Agent 从一开始就更懂你"
      />

      <div className="mt-5 grid grid-cols-1 gap-y-5">
        {QUICK_FIELDS.map((field, index) => {
          const Icon = FIELD_ICONS[field.key]
          const inputId = `profile-field-${field.key}`
          return (
            <div key={field.key} className="min-w-0">
              <div className="mb-2 flex items-center justify-between gap-2">
                <label
                  htmlFor={inputId}
                  className="inline-flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="truncate">{field.label}</span>
                </label>
                <SaveBadge state={saveState[field.key] ?? 'idle'} />
              </div>
              <Input
                id={inputId}
                // 侧栏键盘导航打开画像时，焦点直接落到第一个可填写字段。
                data-user-profile-primary-action={index === 0 ? '' : undefined}
                value={drafts[field.key] ?? ''}
                placeholder={field.placeholder}
                maxLength={120}
                className="h-10 text-[14px]"
                onChange={(event) => onChange(field.key, event.target.value)}
                onBlur={() => onCommit(field)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.currentTarget.blur()
                  }
                }}
              />
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/** 用户在文件管理器里手写的自由正文 / 自定义小节预览。 */
export function FreeTextCard({
  contents,
  onOpenFile,
}: {
  contents: Record<string, string>
  onOpenFile: (path: string) => void
}): React.ReactElement {
  const entries = [
    {
      path: 'user-profile.md',
      label: '用户背景',
      text: freeTextPreview(contents['user-profile.md'] ?? ''),
      sections: customSectionTitles(contents['user-profile.md'] ?? ''),
    },
    {
      path: 'preferences.md',
      label: '工作方式',
      text: freeTextPreview(contents['preferences.md'] ?? ''),
      sections: customSectionTitles(contents['preferences.md'] ?? ''),
    },
  ].filter((entry) => entry.text.length > 0 || entry.sections.length > 0)

  const hasAny = entries.length > 0

  return (
    <Card className="scroll-mt-6 p-6 sm:p-7" aria-labelledby="free-text-title">
      <SectionHeading
        id="free-text-title"
        title="你手写过的背景"
        description="这里显示在「管理记忆文件」里补充过的段落；上面的基础信息不会重复出现。"
        action={
            <Button variant="ghost" size="sm" onClick={() => onOpenFile('user-profile.md')} className="shrink-0">
              去补充
              <ArrowUpRight className="size-3.5" />
            </Button>
          }
      />

      {hasAny ? (
        <div className="mt-5 space-y-3">
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => onOpenFile(entry.path)}
              aria-label={`打开${entry.label}文件`}
              className="group flex w-full items-start gap-3 rounded-xl border border-border/60 bg-surface-sunken/50 px-4 py-3.5 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
            >
              <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium text-foreground">{entry.label}</span>
                <span className="mt-1 block line-clamp-2 text-[12.5px] leading-6 text-muted-foreground">
                  {entry.text || entry.sections.map((title) => `· ${title}`).join('  ')}
                </span>
                {entry.sections.length > 0 && (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {entry.sections.map((title) => (
                      <span key={title} className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
                        {title}
                      </span>
                    ))}
                  </span>
                )}
              </span>
              <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-dashed border-border/80 bg-surface-sunken/40 px-5 py-6 text-center">
          <p className="text-[13px] text-foreground/80">还没有其他补充</p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[12px] leading-6 text-muted-foreground">
            想写更详细的背景、项目惯例或团队约定，可以在原始记忆文件里自由记录。
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => onOpenFile('user-profile.md')}>
            打开记忆文件
            <ArrowUpRight className="size-3.5" />
          </Button>
        </div>
      )}
    </Card>
  )
}

const DEVICE_ICONS = { computer: Laptop, phone: Smartphone, watch: Watch, tablet: Tablet, other: HardDrive } as const
const DEVICE_LABELS: Record<ProfileDeviceType, string> = { computer: '电脑', phone: '手机', watch: '手表', tablet: '平板', other: '其他' }

/** 用户可见目录只呈现名称和类型；细节保留在 Agent 记忆文件中。 */
export function SecondaryFilesCard({
  devices,
  servers,
  onSave,
}: {
  devices: ProfileListItem[]
  servers: ProfileListItem[]
  onSave: (kind: 'device' | 'server', items: ProfileListItem[]) => Promise<void>
}): React.ReactElement {
  const [kind, setKind] = React.useState<'device' | 'server' | null>(null)
  const [name, setName] = React.useState('')
  const [deviceType, setDeviceType] = React.useState<ProfileDeviceType>('computer')
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const activeItems = kind === 'device' ? devices : servers

  const begin = (target: 'device' | 'server', item?: ProfileListItem) => {
    setKind(target)
    setEditingId(item?.id ?? null)
    setName(item?.name ?? '')
    setDeviceType(item?.type ?? 'computer')
  }
  const submit = async () => {
    if (!kind || !name.trim()) return
    const id = editingId ?? `${kind}-${Date.now().toString(36)}`
    const next = editingId
      ? activeItems.map((item) => item.id === editingId ? { id, name: name.trim(), ...(kind === 'device' ? { type: deviceType } : {}) } : item)
      : [...activeItems, { id, name: name.trim(), ...(kind === 'device' ? { type: deviceType } : {}) }]
    setBusy(true)
    try {
      await onSave(kind, next)
      setKind(null)
    } catch {
      // 保存错误由上层提示，保留表单内容供重试。
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4" aria-labelledby="secondary-title">
      <SectionHeading id="secondary-title" title="设备与基础设施" />
      <div className="mt-4 divide-y divide-border/60 border-y border-border/60">
        {(['device', 'server'] as const).map((category) => {
          const items = category === 'device' ? devices : servers
          const title = category === 'device' ? '设备' : '服务器'
          return (
            <div key={category} className="py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-foreground">{title}</span>
                <Button variant="ghost" size="icon" className="size-7" aria-label={`添加${title}`} onClick={() => begin(category)}><Plus className="size-3.5" /></Button>
              </div>
              {items.length ? <ul className="mt-2 space-y-1">
                {items.map((item) => {
                  const Icon = category === 'device' ? DEVICE_ICONS[item.type ?? 'other'] : Server
                  return <li key={item.id} className="group relative flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/40">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[12px] transition-[padding] group-hover:pr-14 group-focus-within:pr-14" title={item.name}>{item.name}</span>
                    {category === 'device' && <span className="shrink-0 text-[10px] text-muted-foreground">{DEVICE_LABELS[item.type ?? 'other']}</span>}
                    <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 bg-card pl-1 opacity-0 pointer-events-none transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 dark:bg-surface-raised [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                      <Button variant="ghost" size="icon" className="size-6" aria-label={`编辑${item.name}`} onClick={() => begin(category, item)}><Pencil className="size-3" /></Button>
                      <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`删除${item.name}`} onClick={() => { void onSave(category, items.filter((entry) => entry.id !== item.id)).catch(() => undefined) }}><Trash2 className="size-3" /></Button>
                    </div>
                  </li>
                })}
              </ul> : <p className="mt-1 text-[11px] text-muted-foreground">尚未添加</p>}
            </div>
          )
        })}
      </div>
      {kind && <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <label className="sr-only" htmlFor="profile-list-name">名称</label>
        <Input id="profile-list-name" autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === 'device' ? '设备名称' : '服务器名称'} />
        {kind === 'device' && <label className="flex items-center gap-2 text-xs text-muted-foreground">设备类型
          <select className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-foreground" value={deviceType} onChange={(event) => setDeviceType(event.target.value as ProfileDeviceType)}>
            {Object.entries(DEVICE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => setKind(null)}>取消</Button><Button type="submit" size="sm" disabled={busy || !name.trim()}>保存</Button></div>
      </form>}
    </Card>
  )
}

/** 本地推断：与确认事实分开，明确标注来源差异。 */
export function InferredCard({
  content,
  onOpenFile,
}: {
  content: string
  onOpenFile: (path: string) => void
}): React.ReactElement {
  const text = plainText(content)
  return (
    <Card className="border-amber-500/20 bg-amber-500/[0.035] p-6 dark:bg-amber-500/[0.045] sm:p-7" aria-labelledby="inferred-title">
      <SectionHeading
        id="inferred-title"
        title="Agent 观察到的结论"
        description="由本机扫描推断而来，不是你确认过的事实。核对后可以把正确结论写进上面的基础信息。"
        action={
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
              <Sparkles className="size-3" aria-hidden="true" />
              推断
            </span>
          }
      />
      {text ? (
        <p className="mt-4 max-w-[72ch] text-[13px] leading-7 text-foreground/80 line-clamp-4">{text}</p>
      ) : (
        <p className="mt-4 text-[12.5px] leading-6 text-muted-foreground">还没有生成感知结论。</p>
      )}
      <button
        type="button"
        onClick={() => onOpenFile('user-sense.md')}
        className="mt-4 inline-flex items-center gap-1 rounded-sm text-[11.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
      >
        查看原始文件
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
      </button>
    </Card>
  )
}

/** 页脚：隐私说明 + 进阶入口。 */
export function PrivacyFooter({ onManageFiles }: { onManageFiles: () => void }): React.ReactElement {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-4 px-1 pb-2 pt-2">
      <p className="inline-flex items-center gap-2 text-[11px] leading-6 text-muted-foreground">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
        只保存在本机，不记录密码、私钥或 Token。
      </p>
      <Button variant="outline" size="sm" onClick={onManageFiles}>
        <ServerCog className="size-3.5" aria-hidden="true" />
        管理记忆文件
      </Button>
    </footer>
  )
}
