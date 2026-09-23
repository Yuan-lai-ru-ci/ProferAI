/** 插件安装列表由主进程配置恢复，使用 Jotai 在界面间共享。 */
import { atom } from 'jotai'
import type { ProferInstalledPlugin } from '@profer/plugin-api'
export const installedPluginsAtom = atom<ProferInstalledPlugin[]>([])

export const pluginPanelsAtom = atom(new Map<string, { pluginId: string; pageId: string; title: string }>())
