import * as React from 'react'
import { Cpu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CORE_SYSTEM_ICONS, type CoreSystemIconId } from './core-system-icons'

const OS_ALIASES: Record<string, CoreSystemIconId> = {
  darwin: 'apple', mac: 'apple', macos: 'apple', osx: 'apple', apple: 'apple',
  win32: 'windows11', windows: 'windows11', win: 'windows11',
  windows11: 'windows11', linux: 'linux', ubuntu: 'ubuntu', debian: 'debian', fedora: 'fedora',
  arch: 'archlinux', archlinux: 'archlinux', manjaro: 'manjaro',
  linuxmint: 'linuxmint', mint: 'linuxmint',
  opensuse: 'opensuse', 'opensuse-leap': 'opensuse', 'opensuse-tumbleweed': 'opensuse', sles: 'opensuse',
  centos: 'centos', rhel: 'redhat', redhat: 'redhat', rocky: 'rockylinux', rockylinux: 'rockylinux',
  almalinux: 'almalinux', alpine: 'alpinelinux', alpinelinux: 'alpinelinux', kali: 'kalilinux', kalilinux: 'kalilinux',
  freebsd: 'freebsd', raspbian: 'raspberrypi', raspberrypi: 'raspberrypi', pop: 'popos', popos: 'popos', elementary: 'elementary',
  deepin: 'deepin', zorin: 'zorin', nixos: 'nixos', android: 'android',
}

/** 发行版只细化 Linux；不得让远端的标识被本机平台或设备名称覆盖。 */
export function resolveCoreSystemIcon(platform?: string, osId?: string): CoreSystemIconId | undefined {
  const system = platform?.trim().toLowerCase()
  if (system === 'linux') {
    const distro = OS_ALIASES[osId?.trim().toLowerCase() ?? '']
    return distro && !['apple', 'windows11', 'freebsd'].includes(distro) ? distro : 'linux'
  }
  return OS_ALIASES[system ?? '']
}

interface CoreSystemIconProps {
  platform?: string
  osId?: string
  /** 仅本机内核允许从 preload 同步平台信息补齐。 */
  local?: boolean
  className?: string
}

export function CoreSystemIcon({ platform, osId, local = false, className }: CoreSystemIconProps): React.ReactElement {
  const localPlatform = !platform && local && typeof window !== 'undefined'
    ? window.electronAPI?.getPlatformInfo?.().platform
    : undefined
  const id = resolveCoreSystemIcon(platform ?? localPlatform, osId)
  if (!id) return <Cpu className={cn('size-5 shrink-0', className)} aria-hidden="true" />
  const icon = CORE_SYSTEM_ICONS[id]
  return <svg viewBox="0 0 24 24" fill="currentColor" className={cn('size-5 shrink-0', className)} role="img" aria-label={icon.label} focusable="false" data-core-system={id}>
    <path d={icon.path} />
  </svg>
}
