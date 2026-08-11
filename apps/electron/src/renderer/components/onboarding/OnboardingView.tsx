/**
 * Onboarding 视图组件
 *
 * 首次启动时显示的全屏欢迎界面。
 *
 * 流程：
 *  Step 0：开屏水波纹动画（Profer 从水面具现，自动进入下一步）
 *  Step 1：欢迎 + 迁移入口
 *  Step 2：核心功能导览
 *  Step 3：Windows 环境检测（仅 Windows，其他平台自动跳过）
 */

import { useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { ChevronRight, ChevronLeft, HardDriveDownload, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EnvironmentCheckPanel } from '@/components/environment/EnvironmentCheckPanel'
import { isShellEnvironmentOkAtom } from '@/atoms/environment'
import { detectIsWindows } from '@/lib/platform'
import { migrationImportDialogOpenAtom } from '@/atoms/migration-atoms'
import { IntroWaterRipple } from './IntroWaterRipple'
import { FeatureTour } from './FeatureTour'

interface OnboardingViewProps {
  onComplete: (openTutorial?: boolean) => void
  /** 供主界面测试入口复用首次引导页；默认仍从开屏开始。 */
  initialStep?: 'intro' | 'welcome' | 'featureTour' | 'environment'
  /** 测试重放完成时不写入用户的首次 onboarding 状态。 */
  persistCompletion?: boolean
}

export function OnboardingView({
  onComplete,
  initialStep = 'intro',
  persistCompletion = true,
}: OnboardingViewProps) {
  const [step, setStep] = useState<'intro' | 'welcome' | 'featureTour' | 'environment'>(initialStep)
  const isWindows = useMemo(() => detectIsWindows(), [])
  const shellOk = useAtomValue(isShellEnvironmentOkAtom)
  const setMigrationImportDialogOpen = useSetAtom(migrationImportDialogOpenAtom)

  const handleFinish = async (openTutorial?: boolean) => {
    if (persistCompletion) {
      await window.electronAPI.updateSettings({ onboardingCompleted: true })
    }
    onComplete(openTutorial)
  }

  const handleNextFromWelcome = () => {
    setStep('featureTour')
  }

  const handleNextFromFeatureTour = () => {
    if (isWindows) {
      setStep('environment')
    } else {
      handleFinish()
    }
  }

  const handleOpenMigration = () => {
    setMigrationImportDialogOpen(true)
  }

  return (
    <div className={cn(
      'flex h-screen w-screen overflow-hidden flex-col items-center justify-center',
      step === 'intro'
        ? 'bg-black'
        : 'bg-gradient-to-br from-background via-background to-muted/20 p-8',
    )}>
      {step === 'intro' && (
        <IntroWaterRipple
          onDone={() => {
            // 开屏结束后先进入欢迎页；用户再按需进入环境配置或导入配置。
            setStep('welcome')
          }}
        />
      )}

      {step === 'welcome' && (
        <>
          <div className="mb-12 text-center">
            <h1 className="text-4xl font-bold mb-4">欢迎使用 Profer</h1>
            <p className="text-lg text-muted-foreground">
              下一代桌面 AI 软件，让通用 Agent 触手可及
            </p>
            <p className="text-sm text-muted-foreground/60 mt-2">
              基于开源项目 Proma 深度改造
            </p>
          </div>

          <div className="w-full max-w-2xl">
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground pt-2">
                自己或身边的人已经在用 Profer？直接导入现有配置
              </p>

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={handleOpenMigration}
                  className="rounded-xl bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 border border-primary/15 p-4 flex items-center gap-3 hover:from-primary/10 hover:via-primary/15 hover:to-primary/10 transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <HardDriveDownload size={20} className="text-primary" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-foreground">从其他设备迁移</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      导入自己其他设备上的配置
                      <br/>
                      <br/>
                      需要先在原设备上导出 .profer-backup 文件，再双击导入即可
                    </p>
                  </div>
                </button>
                <button
                  onClick={handleOpenMigration}
                  className="rounded-xl bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 border border-primary/15 p-4 flex items-center gap-3 hover:from-primary/10 hover:via-primary/15 hover:to-primary/10 transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Users size={20} className="text-primary" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-foreground">导入其他用户的配置</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      从同事或团队成员处导入环境
                      <br/>
                      <br/>
                      需要先导出 .profer-share 文件，再双击导入即可
                    </p>
                  </div>
                </button>
              </div>
            </div>
          </div>

          <div className="w-full max-w-2xl mt-8 flex flex-col items-center gap-2">
            <Button className="w-full h-12 text-base" onClick={handleNextFromWelcome}>
              <>
                了解 Profer 能做什么
                <ChevronRight className="ml-1 h-4 w-4" />
              </>
            </Button>
            <p className="text-xs text-muted-foreground/60">
              这些内容之后也能在设置中找到，不用担心错过
            </p>
          </div>
        </>
      )}

      {step === 'featureTour' && (
        <FeatureTour
          finishLabel={isWindows ? '下一步：环境检测' : '开始使用'}
          onNext={handleNextFromFeatureTour}
          onSkip={handleNextFromFeatureTour}
        />
      )}

      {step === 'environment' && isWindows && (
        <div className="w-full max-w-2xl">
          <div className="mb-6 text-center">
            <h2 className="text-2xl font-semibold mb-2">先检查一下环境</h2>
            <p className="text-sm text-muted-foreground">
              Profer 在 Windows 上需要 Git Bash 或 WSL 才能执行命令
            </p>
          </div>

          <div className="rounded-xl border bg-card p-5 mb-6">
            <EnvironmentCheckPanel autoDetectOnMount />
          </div>

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep('featureTour')}
              className="text-muted-foreground"
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              上一步
            </Button>
            <div className="flex gap-3">
              <Button
                onClick={() => handleFinish()}
                variant={shellOk ? 'default' : 'outline'}
              >
                {shellOk ? '开始使用' : '稍后处理（进入主界面）'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
