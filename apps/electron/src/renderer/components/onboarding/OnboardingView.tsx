/**
 * OnboardingView — 首次启动的全屏设置流程。
 *
 * 步骤：
 *  1. welcome：一句话说明 Profer 是什么，两个出口（看看功能 / 直接开始）
 *  2. featureTour：4 页功能说明（FeatureTour）
 *  3. environment：Windows 环境检测（其他平台自动跳过）
 *  4. migration：从其他设备 / 同事导入配置
 *
 * 视觉（v2 重写）：
 *  - 用产品自身的 token（bg-content-area / border / muted-foreground），不再有独立的
 *    暖纸 + 颗粒 + 洗层。旧版那套配色与主界面不是同一个产品，进入主界面会突兀。
 *  - 版面收敛到 max-w-3xl 的单列：首次引导不是落地页，不需要 1440px 大栅格和
 *    巨型标题；一屏之内把「这是什么、下一步做什么」说清即可。
 *  - 去掉全屏装饰层与 backdrop-blur：多层全屏渐变叠加在低端 GPU 上会持续合成，
 *    是开屏阶段掉帧的来源之一。
 */

import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ArrowRight, ChevronRight, HardDriveDownload, Users, X } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { EnvironmentCheckPanel } from '@/components/environment/EnvironmentCheckPanel'
import { isShellEnvironmentOkAtom } from '@/atoms/environment'
import { detectIsWindows } from '@profer/ui'
import { migrationImportDialogOpenAtom } from '@/atoms/migration-atoms'
import { FeatureTour } from './FeatureTour'

type OnboardingStep = 'welcome' | 'featureTour' | 'environment' | 'migration'

interface OnboardingViewProps {
  onComplete: (openTutorial?: boolean) => void
  /** 供主界面测试入口复用首次引导页；默认从欢迎页开始。 */
  initialStep?: OnboardingStep
  /** 测试重放完成时不写入用户的首次 onboarding 状态。 */
  persistCompletion?: boolean
}

export function OnboardingView({
  onComplete,
  initialStep = 'welcome',
  persistCompletion = true,
}: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>(initialStep)
  const isWindows = useMemo(() => detectIsWindows(), [])
  const shellOk = useAtomValue(isShellEnvironmentOkAtom)
  const setMigrationImportDialogOpen = useSetAtom(migrationImportDialogOpenAtom)

  const handleFinish = async () => {
    if (persistCompletion) {
      await window.electronAPI.updateSettings({ onboardingCompleted: true })
    }
    onComplete()
  }

  const handleNextFromWelcome = () => setStep('featureTour')

  const handleNextFromFeatureTour = () => {
    setStep(isWindows ? 'environment' : 'migration')
  }

  const handleOpenMigration = () => {
    setMigrationImportDialogOpen(true)
  }

  if (step === 'featureTour') {
    return (
      <FeatureTour
        finishLabel={isWindows ? '下一步：环境检测' : '下一步：导入数据'}
        onNext={handleNextFromFeatureTour}
        onSkip={handleNextFromFeatureTour}
      />
    )
  }

  const totalSteps = isWindows ? 3 : 2
  const stepIndex = step === 'welcome' ? 1 : step === 'environment' ? 2 : isWindows ? 3 : 2
  const stepLabel = step === 'welcome' ? '欢迎' : step === 'environment' ? '环境检查' : '导入数据'

  return (
    <OnboardingStage
      stepIndex={stepIndex}
      totalSteps={totalSteps}
      stepLabel={stepLabel}
      onSkip={() => void handleFinish()}
    >
      {step === 'welcome' && (
        <div className="w-full max-w-xl rounded-xl border border-border bg-card p-8 text-card-foreground shadow-sm">
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
              P
            </span>
            <span className="text-[12px] font-medium tracking-tight">Profer</span>
          </div>

          <h1 className="mt-5 text-[24px] font-semibold leading-tight tracking-[-0.02em]">把事交给它，拿结果回来</h1>
          <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
            通用 Agent：能聊天，也能读你的文件、跑命令、按计划把事做完。
            先用一分钟看看它能做什么；不想看也可以直接开始，之后随时在设置里重播。
          </p>

          <div className="mt-6 flex items-center gap-2">
            <Button size="sm" className="h-9 gap-1.5 px-3.5 text-[13px]" onClick={handleNextFromWelcome}>
              看看能做什么
              <ArrowRight className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 px-3 text-[12px] text-muted-foreground"
              onClick={() => void handleFinish()}
            >
              直接开始
            </Button>
          </div>

          <dl className="mt-7 grid grid-cols-3 gap-4 border-t border-border pt-5">
            {[
              { term: 'Agent', desc: '拆步骤、改文件、交付结果' },
              { term: 'Chat', desc: '轻问答，不绑工作区' },
              { term: '工作区', desc: '文件、记忆、技能各自独立' },
            ].map((item) => (
              <div key={item.term}>
                <dt className="text-[11px] font-medium text-foreground">{item.term}</dt>
                <dd className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{item.desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {step === 'environment' && isWindows && (
        <div className="w-full max-w-2xl">
          <h2 className="text-[22px] font-semibold tracking-[-0.02em]">先检查运行环境</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Profer 在 Windows 上需要 Git Bash 或 WSL 才能执行命令。检测不通过也可以先用 Chat。
          </p>

          <div className="mt-5 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
            <EnvironmentCheckPanel autoDetectOnMount />
          </div>

          <div className="mt-5 flex justify-end">
            <Button size="sm" className="h-9 gap-1.5 px-3.5 text-[13px]" onClick={() => setStep('migration')}>
              {shellOk ? '下一步：导入数据' : '跳过环境检测'}
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {step === 'migration' && (
        <div className="w-full max-w-xl rounded-xl border border-border bg-card p-8 text-card-foreground shadow-sm">
          <h2 className="text-[22px] font-semibold tracking-[-0.02em]">要导入已有的配置吗？</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            已经在别处用过 Profer，或者同事有一份配好的环境？导入后会话、Skills、模型渠道和偏好设置都能接着用。
          </p>

          <div className="mt-5 space-y-2">
            <MigrationOption
              icon={<HardDriveDownload className="size-4" aria-hidden="true" />}
              title="从我的其他设备迁移"
              hint="导入原设备导出的 .profer-backup"
              onClick={handleOpenMigration}
            />
            <MigrationOption
              icon={<Users className="size-4" aria-hidden="true" />}
              title="导入同事的配置"
              hint="使用对方导出的 .profer-share 文件"
              onClick={handleOpenMigration}
            />
          </div>

          <div className="mt-6 flex items-center gap-2 border-t border-border pt-5">
            <Button size="sm" className="h-9 gap-1.5 px-3.5 text-[13px]" onClick={() => void handleFinish()}>
              开始使用
              <ArrowRight className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 px-3 text-[12px] text-muted-foreground"
              onClick={() => void handleFinish()}
            >
              先空着
            </Button>
          </div>
        </div>
      )}
    </OnboardingStage>
  )
}

/**
 * 欢迎 / 环境 / 迁移共用的舞台：单列居中，顶栏只有品牌、进度与跳过。
 *
 * 用产品自身的 surface token，深浅色跟随主题；不再有独立的纸张视觉。
 */
function OnboardingStage({
  stepIndex,
  totalSteps,
  stepLabel,
  onSkip,
  children,
}: {
  stepIndex: number
  totalSteps: number
  stepLabel: string
  onSkip: () => void
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex h-screen w-screen flex-col bg-content-area text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-2.5">
          <span className="text-[12px] font-semibold tracking-tight">Profer</span>
          <span className="text-[11px] text-muted-foreground">{stepLabel}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
          onClick={onSkip}
        >
          跳过设置
          <X className="size-3" />
        </Button>
      </header>

      <div className="flex shrink-0 items-center gap-1 px-6 pt-3" aria-hidden="true">
        {Array.from({ length: totalSteps }, (_, index) => (
          <span
            key={index}
            className={
              index < stepIndex
                ? 'h-1 flex-1 rounded-full bg-foreground/60'
                : index === stepIndex
                  ? 'h-1 flex-1 rounded-full bg-foreground'
                  : 'h-1 flex-1 rounded-full bg-muted'
            }
          />
        ))}
      </div>

      <main className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">{children}</main>
    </div>
  )
}

function MigrationOption({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: ReactNode
  title: string
  hint: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-border/80 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{hint}</span>
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        aria-hidden="true"
      />
    </button>
  )
}
