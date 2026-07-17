/**
 * Agent 知识库工具
 *
 * 通过 SDK MCP Server 暴露知识库的搜索、列表、读取和导入能力。
 * 遵循 injectAutomationMcpServer 的 MCP 模式。
 */

import type {
  KBImportInput,
  KBImportResult,
  KBSearchResult,
  PaperMeta,
} from '@profer/shared'

interface KbAgentToolContext {
  sessionId: string
  workspaceId?: string
}

interface KbToolResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
}

type ZodModule = typeof import('zod')

function jsonResult(payload: unknown): KbToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

function buildKbSchemas(z: ZodModule['z']) {
  return {
    search: {
      query: z.string().describe('搜索查询文本，用自然语言描述你想找的内容'),
      topK: z.number().int().min(1).max(20).optional().describe('返回结果数量，默认 5'),
    },
    getPaper: {
      paperId: z.string().describe('论文 ID'),
    },
    import: {
      source: z.string().describe('论文来源：本地 PDF 的绝对路径，或 arXiv ID（如 "2401.12345"）'),
    },
  }
}

export async function injectKbMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  _ctx: KbAgentToolContext,
): Promise<void> {
  // 延迟导入，避免循环依赖
  const { searchPapers, listPapers, getPaper } = await import('./kb-service')
  const { importPaper } = await import('./kb-service')
  const { searchArxiv } = await import('./kb-arxiv')

  let z: ZodModule['z']
  try {
    ({ z } = await import('zod') as ZodModule)
  } catch {
    z = require('zod').z
  }
  const schemas = buildKbSchemas(z)

  const server = sdk.createSdkMcpServer({
    name: 'knowledge-base',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'search_knowledge_base',
        '在科研知识库中语义搜索论文。传入自然语言查询，返回最相关的论文段落及其来源信息（标题、作者、arXiv ID）。当用户问学术/研究问题时，应优先调用此工具检索相关论文，再基于检索结果回答。',
        schemas.search,
        async (args) => {
          const results: KBSearchResult[] = await searchPapers(args.query, args.topK ?? 5)
          if (results.length === 0) {
            return jsonResult({ results: [], message: '知识库中未找到相关论文内容' })
          }
          return jsonResult({
            results: results.map((r) => ({
              paperTitle: r.paper.title,
              paperId: r.paper.id,
              authors: r.paper.authors,
              arxivId: r.paper.arxivId,
              year: r.paper.year,
              sectionTitle: r.chunk.sectionTitle,
              content: r.chunk.content,
              relevanceScore: Math.round(r.score * 100) / 100,
            })),
          })
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'list_papers',
        '列出知识库中的所有论文。返回论文ID、标题、作者、年份、arXiv ID、标签和摘要。',
        {},
        async () => {
          const papers: PaperMeta[] = listPapers()
          if (papers.length === 0) {
            return jsonResult({ papers: [], message: '知识库为空，还没有导入论文' })
          }
          return jsonResult({
            papers: papers.map((p) => ({
              id: p.id,
              title: p.title,
              authors: p.authors,
              year: p.year,
              arxivId: p.arxivId,
              doi: p.doi,
              tags: p.tags,
              abstract: p.abstract?.slice(0, 200) + (p.abstract?.length > 200 ? '...' : ''),
              pageCount: p.pageCount,
              importedAt: p.importedAt,
            })),
          })
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'get_paper',
        '获取知识库中某篇论文的完整 Markdown 内容（含 LaTeX 公式和表格）。参数 paperId 来自 list_papers 返回的论文 ID。',
        schemas.getPaper,
        async (args) => {
          const paper = getPaper(args.paperId)
          if (!paper) {
            throw new Error(`论文不存在: ${args.paperId}`)
          }
          return jsonResult({
            id: paper.meta.id,
            title: paper.meta.title,
            authors: paper.meta.authors,
            arxivId: paper.meta.arxivId,
            year: paper.meta.year,
            abstract: paper.meta.abstract,
            markdown: paper.markdown,
          })
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'import_paper_to_kb',
        '导入一篇论文到知识库。可传入本地 PDF 的绝对路径（如 C:\\papers\\xxx.pdf），或 arXiv ID（如 "2401.12345"）。论文会通过 MinerU 解析为结构化 Markdown，自动分块并生成向量用于语义搜索。',
        schemas.import,
        async (args) => {
          const source = args.source.trim()

          // 判断是 arXiv ID 还是本地路径
          const arxivMatch = source.match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/)
          let input: KBImportInput

          if (arxivMatch && arxivMatch[1]) {
            input = { source: { type: 'arxiv', arxivId: arxivMatch[1] } }
          } else {
            // 本地路径
            const { existsSync } = require('node:fs')
            if (!existsSync(source)) {
              throw new Error(`文件不存在: ${source}。请提供有效的 PDF 文件路径。`)
            }
            input = { source: { type: 'file', filePath: source } }
          }

          const result: KBImportResult = await importPaper(input)
          return jsonResult({
            id: result.paper.id,
            title: result.paper.title,
            authors: result.paper.authors,
            pageCount: result.paper.pageCount,
            chunkCount: result.chunkCount,
            creditsUsed: result.creditsUsed,
            message: `论文「${result.paper.title}」已导入知识库（${result.paper.pageCount} 页，${result.chunkCount} 个分块，消耗 ${result.creditsUsed} 积分）`,
          })
        },
      ),
      sdk.tool(
        'search_arxiv',
        '在 arXiv 上搜索论文。返回论文标题、作者、摘要、arXiv ID 和 PDF 链接。用于发现论文或确认要导入的论文 ID。',
        {
          query: z.string().describe('搜索查询，如 "attention mechanism transformer"'),
          maxResults: z.number().int().min(1).max(20).optional().describe('最大结果数，默认 10'),
        },
        async (args) => {
          const papers = await searchArxiv(args.query, args.maxResults ?? 10)
          return jsonResult({
            results: papers.map((p) => ({
              arxivId: p.arxivId,
              title: p.title,
              authors: p.authors,
              year: p.year,
              abstract: p.abstract?.slice(0, 300) + (p.abstract?.length > 300 ? '...' : ''),
              primaryCategory: p.primaryCategory,
              arxivUrl: p.arxivUrl,
            })),
          })
        },
        { annotations: { readOnlyHint: true } },
      ),
    ],
  })

  mcpServers['knowledge-base'] = server
}
