/**
 * 受管浏览器「整页翻译」：用户阅读用途。
 *
 * 背景：Profer 内置浏览器是 Electron WebContentsView，无法加载 Chrome/Edge 扩展，
 * 所以翻译不走插件，而是用「主进程注入式翻译」：
 *   1. 主进程通过已 attach 的 CDP 在页面内遍历 DOM 文本节点、给节点打 tid 标记并备份原文。
 *   2. 主进程用全局 fetch 调微软免鉴权接口批量翻译（主进程无 CORS 限制）。
 *   3. CDP 把译文写回对应节点，节点加 data-profer-translated 标记。
 *   4. 再点一次 → CDP 从 data-profer-original 恢复原文并清理标记。
 *
 * 本文件只提供纯函数与可注入脚本字符串；实际 CDP 调用与状态管理在 BrowserController 内完成。
 */

/** 微软 Edge 免鉴权翻译端点（非公开，可能调整路径/风控；失败需降级提示）。 */
export const MICROSOFT_TRANSLATE_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'
/** 默认目标语言：简体中文。 */
export const DEFAULT_TRANSLATE_TO = 'zh-Hans'
/** from 留空 = 自动检测源语言。 */
export const MICROSOFT_TRANSLATE_FROM = ''

/** 单批最大文本条数与最大总字符，保守对齐 Azure 约束，避免端点拒绝。 */
export const TRANSLATE_BATCH_MAX_ITEMS = 25
export const TRANSLATE_BATCH_MAX_CHARS = 5000
/** 单段文本超过该长度时拆分，避免超长段落拖垮整批或触发长度限制。 */
export const TRANSLATE_SEGMENT_MAX_CHARS = 1800
/** 采集阶段最多处理的文本节点数，防止超大长文页面卡死 CDP。 */
export const TRANSLATE_MAX_NODES = 4000

/** 节点标记：翻译态 vs 原文备份。 */
export const TRANSLATED_FLAG = 'data-profer-translated'
export const TRANSLATED_TID = 'data-profer-tid'
export const TRANSLATED_ORIGINAL = 'data-profer-original'
/** 译文/标记的 CSS 选择器，用于恢复原文与清理。 */
export const TRANSLATED_SELECTOR = `[${TRANSLATED_FLAG}]`

/** 与 Profer 其余受管脚本一致的命名空间，避免与页面全局冲突。 */
const TID_PREFIX = '__profer_translate__'

/**
 * 收集脚本：标记可见文本节点并导出 { tid, text } 列表。
 * 返回对象：`{ ok, total, items: [{ tid, pieces: string[] }] }`。
 * 对已翻译节点（data-profer-translated 存在）跳过本步标记 —— 由外层判断当前是翻译还是恢复。
 */
export const BUILD_COLLECT_SCRIPT = `(() => {
  const excludeTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE']);
  const nodes = [];
  let tid = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let guard = 0;
  while (walker.nextNode()) {
    if (++guard > ${TRANSLATE_MAX_NODES}) break;
    const node = walker.currentNode;
    if (!node.parentElement) continue;
    const parent = node.parentElement;
    if (excludeTags.has(parent.tagName)) continue;
    if (parent.closest('script,style,noscript,template,svg,iframe,textarea,input,select,option,code,pre')) continue;
    if (parent.hasAttribute(${JSON.stringify('data-profer-translated')})) continue;
    const text = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length < 2) continue;
    if (/^[\\d\\s%.,;:?!()\\[\\]'\"-]+$/.test(text)) continue;
    if (/^https?:\\/\\//i.test(text) || /^\\w+@[\\w.]+$/.test(text)) continue;
    const style = window.getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const rect = parent.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const pieces = [];
    if (text.length > ${TRANSLATE_SEGMENT_MAX_CHARS}) {
      for (let head = 0; head < text.length; head += ${TRANSLATE_SEGMENT_MAX_CHARS}) {
        pieces.push(text.slice(head, head + ${TRANSLATE_SEGMENT_MAX_CHARS}));
      }
    } else {
      pieces.push(text);
    }
    const pid = '${TID_PREFIX}' + (++tid);
    parent.setAttribute(${JSON.stringify('data-profer-tid')}, pid);
    parent.setAttribute(${JSON.stringify('data-profer-original')}, text);
    nodes.push({ tid: pid, pieces });
  }
  return { ok: true, total: nodes.length, items: nodes };
})()`

/**
 * 写回脚本：把 pid → 译文段数组回写到已标记节点。
 * @param entries 由 pidToTranslated 传入：`[{ pid, translated: string[] }]`。
 */
export function buildWriteScript(entries: Array<{ pid: string; translated: string[] }>): string {
  const payload = JSON.stringify(entries)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `(() => {
    const maps = ${payload};
    const byPid = new Map(maps.map((m) => [m.pid, m.translated]));
    let applied = 0;
    const nodes = document.querySelectorAll(${JSON.stringify('[' + 'data-profer-tid]')});
    for (const node of nodes) {
      const pid = node.getAttribute(${JSON.stringify('data-profer-tid')});
      const translated = pid != null ? byPid.get(pid) : undefined;
      if (translated === undefined) continue;
      node.textContent = translated.join(' ');
      node.setAttribute(${JSON.stringify('data-profer-translated')}, '1');
      applied++;
    }
    return { ok: true, applied };
  })()`
}

/**
 * 恢复脚本：读取 data-profer-original 恢复原文并清理所有翻译标记，返回恢复数量。
 */
export const BUILD_RESTORE_SCRIPT = `(() => {
  let restored = 0;
  const nodes = document.querySelectorAll(${JSON.stringify('[data-profer-translated]')});
  for (const node of nodes) {
    const original = node.getAttribute(${JSON.stringify('data-profer-original')});
    if (original != null) node.textContent = original;
    node.removeAttribute(${JSON.stringify('data-profer-tid')});
    node.removeAttribute(${JSON.stringify('data-profer-original')});
    node.removeAttribute(${JSON.stringify('data-profer-translated')});
    restored++;
  }
  return { ok: true, restored };
})()`

/**
 * 主进程调微软免费接口批量翻译文本列表，返回与输入顺序一致的译文数组。
 * 拆批处理、保序。失败抛错交由调用方降级提示。
 */
export async function translateTexts(texts: string[], to = DEFAULT_TRANSLATE_TO, timeoutMs = 15_000): Promise<string[]> {
  if (texts.length === 0) return []
  const results: string[] = new Array(texts.length).fill('')
  for (let start = 0; start < texts.length; start += TRANSLATE_BATCH_MAX_ITEMS) {
    const batch = texts.slice(start, start + TRANSLATE_BATCH_MAX_ITEMS)
    const translatedBatch = await translateBatch(batch, to, timeoutMs)
    for (let i = 0; i < batch.length; i++) {
      const source = batch[i] ?? ''
      const target = translatedBatch[i]
      results[start + i] = target !== undefined ? target : source
    }
  }
  return results
}

async function translateBatch(texts: string[], to: string, timeoutMs: number): Promise<string[]> {
  const query = new URLSearchParams({
    from: MICROSOFT_TRANSLATE_FROM,
    to,
    isEnterpriseClient: 'false',
  }).toString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${MICROSOFT_TRANSLATE_ENDPOINT}?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(texts),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`翻译接口返回 ${response.status}`)
    const data = (await response.json()) as Array<{ translations?: Array<{ text?: string }> }> | null
    if (!Array.isArray(data)) throw new Error('翻译接口响应格式异常')
    return data.map((item): string => item?.translations?.[0]?.text ?? '')
  } finally {
    clearTimeout(timer)
  }
}
