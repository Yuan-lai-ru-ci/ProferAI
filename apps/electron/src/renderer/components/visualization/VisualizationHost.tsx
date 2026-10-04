import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { VisualizationContent, VisualizationQuote, VisualizationViewState } from '@profer/shared'
import {
  acceptVisualizationMessage,
  buildVisualizationSrcDoc,
  cloneVisualizationState,
  createVisualizationToken,
  readVisualizationThemeTokens,
  resolveVisualizationQuote,
  serializeVisualizationState,
} from '@/lib/visualization-bridge'

export interface VisualizationHostProps {
  content: VisualizationContent
  state: VisualizationViewState
  onState: (state: VisualizationViewState) => void
  onQuote: (quote: VisualizationQuote) => void
  onInteraction: () => void
  onError: (message: string) => void
  onReady?: () => void
  onHeight?: (height: number) => void
  /** 将 iframe 内聚合后的像素滚轮增量交给外层会话滚动容器。 */
  onWheel?: (deltaX: number, deltaY: number) => void
  className?: string
}

export function VisualizationHost(props: VisualizationHostProps) {
  const { content, state, className } = props
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const readyRef = useRef(false)
  const lastStateJsonRef = useRef<string | null>(null)
  const instance = useMemo(() => ({
    token: createVisualizationToken(),
    generation: createVisualizationToken(),
    revision: content.record.revision,
  }), [content.record.id, content.record.revision, content.html])
  const documentResult = useMemo(() => {
    try {
      return { html: buildVisualizationSrcDoc(content, { ...instance, theme: readVisualizationThemeTokens(), fontFamily: getComputedStyle(document.documentElement).fontFamily }), error: null }
    } catch (error) {
      return { html: undefined, error: error instanceof Error ? error.message : 'Visualization HTML is invalid' }
    }
    // 对象列表与主题变更不会重新加载 iframe；主题走独立消息。
  }, [content.html, instance])

  useEffect(() => {
    if (documentResult.error) propsRef.current.onError(documentResult.error)
  }, [documentResult.error])

  useLayoutEffect(() => {
    readyRef.current = false
    lastStateJsonRef.current = null
    let active = true
    const sendState = () => {
      try {
        const safeState = cloneVisualizationState(propsRef.current.state)
        const json = JSON.stringify(safeState)
        iframeRef.current?.contentWindow?.postMessage({ ...instance, type: 'state', state: safeState }, '*')
        lastStateJsonRef.current = json
      } catch (error) {
        propsRef.current.onError(error instanceof Error ? error.message : 'Visualization state is invalid')
      }
    }
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!active) return
      const message = acceptVisualizationMessage(event, iframeRef.current?.contentWindow ?? null, instance)
      if (!message) return
      const callbacks = propsRef.current
      switch (message.type) {
        case 'ready':
          if (readyRef.current) return
          readyRef.current = true
          sendState()
          callbacks.onReady?.()
          break
        case 'error': callbacks.onError(message.message); break
        case 'resize': callbacks.onHeight?.(message.height); break
        case 'state': {
          if (!readyRef.current) return
          const nextState = cloneVisualizationState(message.state)
          const json = JSON.stringify(nextState)
          if (json === lastStateJsonRef.current) return
          lastStateJsonRef.current = json
          callbacks.onState(nextState)
          break
        }
        case 'selection': {
          const quote = resolveVisualizationQuote(callbacks.content, message.objectId)
          if (!quote) {
            callbacks.onError('Visualization selection references an unknown object')
            return
          }
          callbacks.onQuote(quote)
          break
        }
        case 'wheel': callbacks.onWheel?.(message.deltaX, message.deltaY); break
        case 'interaction': callbacks.onInteraction(); break
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      active = false
      readyRef.current = false
      window.removeEventListener('message', onMessage)
    }
  }, [instance])

  useEffect(() => {
    if (!readyRef.current) return
    try {
      const json = serializeVisualizationState(state)
      if (json === lastStateJsonRef.current) return
      iframeRef.current?.contentWindow?.postMessage({ ...instance, type: 'state', state: JSON.parse(json) }, '*')
      lastStateJsonRef.current = json
    } catch (error) {
      propsRef.current.onError(error instanceof Error ? error.message : 'Visualization state is invalid')
    }
  }, [instance, state])

  useEffect(() => {
    const publishTheme = () => {
      iframeRef.current?.contentWindow?.postMessage({ ...instance, type: 'theme', theme: readVisualizationThemeTokens() }, '*')
    }
    const observer = new MutationObserver(publishTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    return () => observer.disconnect()
  }, [instance])

  if (documentResult.error) return null
  return (
    <iframe
      key={instance.token}
      ref={iframeRef}
      title={content.record.title}
      name={`profer-visualization:${content.record.id}`}
      srcDoc={documentResult.html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      scrolling="no"
      className={className ?? 'h-full w-full border-0'}
    />
  )
}

export default VisualizationHost
