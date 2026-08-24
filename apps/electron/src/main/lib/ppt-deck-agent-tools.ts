import { isAbsolute, resolve, sep } from 'node:path'
import type { PptMaterialItem } from '@profer/shared'
import { inspectDeckSources } from './ppt-deck-context-service'
import {
  assertDeckCompilable,
  createDeckProject,
  getDeckBriefConfirmationToken,
  readDeckProject,
  recordDeckBriefConfirmation,
  writeDeckSourceLineage,
  writeJsonForDeckProject,
} from './ppt-deck-project-service'
import { parseDeckBrief } from './ppt-deck-schema'
import { auditPptDelivery } from './ppt-delivery-audit-service'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details?: unknown
}

function result(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  }
}

export interface PptDeckAgentContext {
  sessionId: string
  agentCwd: string
  allowedRoots: string[]
  workspaceSlug?: string
}

export interface PptDeckAgentToolOptions {
  /** Task 7 接入后由编排器注入真正 compiler；Task 6 只负责确认门禁。 */
  compile?: (projectDir: string) => Promise<unknown>
}

function assertContext(ctx: PptDeckAgentContext): void {
  if (!ctx.sessionId.trim()) throw new Error('sessionId 必填')
  if (!ctx.agentCwd.trim()) throw new Error('当前会话没有 Agent 工作目录')
}

function isInside(root: string, target: string): boolean {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const rootKey = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath
  const targetKey = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath
  const prefix = rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`
  return targetKey.startsWith(prefix)
}

function assertSessionProject(ctx: PptDeckAgentContext, projectDir: string): string {
  if (!isAbsolute(projectDir)) throw new Error('projectDir 必须是当前会话创建的绝对项目路径')
  const expectedRoot = resolve(ctx.agentCwd, '.context', 'deck-projects')
  const resolvedProject = resolve(projectDir)
  if (!isInside(expectedRoot, resolvedProject)) {
    throw new Error('projectDir 不属于当前会话，已拒绝访问')
  }
  return resolvedProject
}

function publicSource(source: {
  id: string
  relativePath: string
  kind: string
  size: number
  mtimeMs: number
  contentHash: string
  status: string
  locator?: string
  title?: string
  excerpt?: string
  versionSignals?: string[]
}): Record<string, unknown> {
  return {
    id: source.id,
    relativePath: source.relativePath,
    kind: source.kind,
    size: source.size,
    mtimeMs: source.mtimeMs,
    contentHash: source.contentHash,
    status: source.status,
    locator: source.locator,
    title: source.title,
    excerpt: source.excerpt,
    versionSignals: source.versionSignals,
  }
}

async function inspectSources(ctx: PptDeckAgentContext, paths: string[]): Promise<ToolResult> {
  assertContext(ctx)
  const inspected = await inspectDeckSources({
    paths,
    agentCwd: ctx.agentCwd,
    allowedRoots: ctx.allowedRoots,
  })
  return result({
    schemaVersion: 1,
    sources: inspected.sources.map(publicSource),
    conflicts: inspected.conflicts,
    gaps: inspected.gaps,
    next: inspected.conflicts.length > 0
      ? '先向用户追问冲突版本，不能静默选择 current。'
      : '可据此生成 Deck Brief；来源仍需绑定到具体 slide evidenceRefs。',
  })
}

async function createProject(ctx: PptDeckAgentContext, rawBrief: unknown, sourceLineage?: unknown): Promise<ToolResult> {
  assertContext(ctx)
  const parsedBrief = parseDeckBrief(rawBrief)
  const project = await createDeckProject({ agentCwd: ctx.agentCwd, brief: parsedBrief })
  if (sourceLineage !== undefined) await writeDeckSourceLineage(project.projectDir, sourceLineage)
  const confirmationToken = await getDeckBriefConfirmationToken(project.projectDir)
  return result({
    schemaVersion: 1,
    projectDir: project.projectDir,
    deckId: project.deckId,
    state: 'awaiting_confirmation',
    confirmationToken,
    confirmation: {
      kind: 'deck-brief',
      instruction: '调用 AskUserQuestion 展示 Deck Brief，并将此 token 作为受管 proferConfirmation metadata 传入；不要把 token 展示给用户。',
    },
    next: '先由用户确认 Deck Brief；确认收据写入后才能调用 compile_deck_project。',
  })
}

async function confirmProject(ctx: PptDeckAgentContext, projectDir: string, input: Record<string, unknown>): Promise<ToolResult> {
  assertContext(ctx)
  const safeProjectDir = assertSessionProject(ctx, projectDir)
  if (input.confirmed === true) throw new Error('confirm_deck_brief 不接受 confirmed 布尔值；确认必须来自 AskUserQuestion 的主进程 receipt')
  const snapshot = await readDeckProject(safeProjectDir)
  if (snapshot.brief.state !== 'confirmed' && snapshot.brief.state !== 'compiled') {
    throw new Error('Deck Brief 尚未确认；必须先通过 AskUserQuestion 选择“确认 Deck Brief”')
  }
  if (!snapshot.brief.confirmationHash || !snapshot.brief.confirmedAt || !snapshot.brief.confirmedByRequestId) {
    throw new Error('Deck Brief 缺少主进程确认收据')
  }
  return result({
    schemaVersion: 1,
    projectDir: safeProjectDir,
    deckId: snapshot.brief.deckId,
    state: snapshot.brief.state,
    confirmedAt: snapshot.brief.confirmedAt,
    confirmedByRequestId: snapshot.brief.confirmedByRequestId,
    next: '可以调用 compile_deck_project。',
  })
}

async function compileProject(ctx: PptDeckAgentContext, projectDir: string, options: PptDeckAgentToolOptions): Promise<ToolResult> {
  assertContext(ctx)
  const safeProjectDir = assertSessionProject(ctx, projectDir)
  // 确认门禁必须在 compiler 之前执行，未确认时不会加载/运行编译器。
  await assertDeckCompilable(safeProjectDir)
  const compile = options.compile ?? (async (dir: string) => {
    const { compileDeckProject } = await import('./ppt-deck-compiler')
    return compileDeckProject(dir)
  })
  const compiled = await compile(safeProjectDir) as { outputPath?: string }
  if (!compiled.outputPath) throw new Error('Deck compiler 未返回 outputPath')
  const compiledSnapshot = await readDeckProject(safeProjectDir)
  const audit = auditPptDelivery(compiled.outputPath, undefined, {
    deckSpec: compiledSnapshot.deckSpec,
    sourceLineage: compiledSnapshot.sourceLineage,
  })
  writeJsonForDeckProject(safeProjectDir, 'qa/ppt-delivery-audit.json', audit)
  return result({
    schemaVersion: 1,
    projectDir: safeProjectDir,
    state: 'compiled',
    result: compiled,
    audit,
    next: audit.needsRevision
      ? '审计发现问题，先按 slideId 修订并重新编译，再打开预览。'
      : '打开内置 PPTX 预览并继续 source/editability QA。',
  })
}

interface ClaudeSdkLike {
  // The SDK has a generic overload tied to the concrete Zod shape. This adapter
  // deliberately erases that generic at the boundary so Claude and test stubs
  // share the same governed tool contract.
  tool: (...args: any[]) => any
  createSdkMcpServer: (...args: any[]) => any
}

export async function injectPptDeckMcpServer(
  sdk: ClaudeSdkLike,
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: PptDeckAgentContext,
  options: PptDeckAgentToolOptions = {},
): Promise<void> {
  const { z } = await import('zod')
  const tools = [
    sdk.tool(
      'inspect_deck_sources',
      'Inspect authorized session sources for a student PPTX. Classify current/superseded/historical/conflicted/unknown versions; never silently choose a conflicted source.',
      { paths: z.array(z.string().min(1)).min(1) },
      async ({ paths }: { paths: string[] }) => inspectSources(ctx, paths),
    ),
    sdk.tool(
      'create_deck_project',
      'Create a session-local governed Deck Project from a confirmed-in-dialog Brief draft. This does not confirm the project.',
      { brief: z.record(z.string(), z.unknown()), sourceLineage: z.record(z.string(), z.unknown()).optional() },
      async ({ brief, sourceLineage }: { brief: unknown; sourceLineage?: unknown }) => createProject(ctx, brief, sourceLineage),
    ),
    sdk.tool(
      'confirm_deck_brief',
      'Read the main-process Deck Brief confirmation receipt. Do not accept confirmed=true or self-written confirmation fields.',
      { projectDir: z.string().min(1), confirmed: z.boolean().optional() },
      async (input: Record<string, unknown>) => confirmProject(ctx, String(input.projectDir), input),
    ),
    sdk.tool(
      'compile_deck_project',
      'Compile only a project with a valid user confirmation receipt. The compiler must produce native editable PPTX and then run QA.',
      { projectDir: z.string().min(1) },
      async ({ projectDir }: { projectDir: string }) => compileProject(ctx, projectDir, options),
    ),
  ]
  mcpServers['ppt-decks'] = sdk.createSdkMcpServer({ name: 'ppt-decks', version: '1.0.0', tools }) as Record<string, unknown>
}

interface PiSdkLike {
  // Pi's defineTool is generic over TypeBox schemas; the adapter owns the
  // concrete schema and exposes a runtime-independent boundary here.
  defineTool: (input: any) => any
}

export function buildPiPptDeckTools(
  sdk: PiSdkLike,
  ctx: PptDeckAgentContext,
  options: PptDeckAgentToolOptions = {},
): Array<Record<string, unknown>> {
  const define = (name: string, label: string, description: string, parameters: unknown, execute: (toolCallId: string, params: unknown) => Promise<ToolResult>) => sdk.defineTool({ name, label, description, promptSnippet: `${name}: governed Deck Project workflow.`, parameters, execute }) as Record<string, unknown>
  const toolType = require('typebox').Type as typeof import('typebox').Type
  return [
    define('inspect_deck_sources', '检查 PPT 来源', 'Inspect only authorized session sources and return governed version status.', toolType.Object({ paths: toolType.Array(toolType.String({ minLength: 1 })) }), async (_id, params) => inspectSources(ctx, (params as { paths: string[] }).paths)),
    define('create_deck_project', '创建 Deck Project', 'Create a session-local Deck Project in awaiting_confirmation state.', toolType.Object({ brief: toolType.Record(toolType.String(), toolType.Unknown()), sourceLineage: toolType.Optional(toolType.Record(toolType.String(), toolType.Unknown())) }), async (_id, params) => {
      const input = params as { brief: unknown; sourceLineage?: unknown }
      return createProject(ctx, input.brief, input.sourceLineage)
    }),
    define('confirm_deck_brief', '确认 Deck Brief', 'Read the main-process receipt; confirmed=true is not accepted.', toolType.Object({ projectDir: toolType.String({ minLength: 1 }), confirmed: toolType.Optional(toolType.Boolean()) }), async (_id, params) => {
      const input = params as Record<string, unknown>
      return confirmProject(ctx, String(input.projectDir), input)
    }),
    define('compile_deck_project', '编译 Deck Project', 'Compile only after the user confirmation receipt passes.', toolType.Object({ projectDir: toolType.String({ minLength: 1 }) }), async (_id, params) => compileProject(ctx, String((params as Record<string, unknown>).projectDir), options)),
  ]
}
