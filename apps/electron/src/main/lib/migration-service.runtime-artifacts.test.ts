import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { createAgentSession, updateAgentSessionMeta } from './agent-session-manager'
import { createAgentWorkspace, listAgentWorkspaces } from './agent-workspace-manager'
import {
  __testRewriteRuntimeCwd,
  __testSdkProjectKey,
  exportDataV2,
  parseImportFile,
} from './migration-service'
import {
  getAgentSessionMessagesPath,
  getAgentSessionsIndexPath,
  getAgentSessionWorkspacePath,
  getSdkConfigDir,
} from './config-paths'

const originalConfigDir = process.env.PROFER_CONFIG_DIR
let root = ''
let secondaryRoot = ''

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

function writeJsonl(path: string, values: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf-8')
}

function createSession(runtime: 'claude' | 'pi', sdkSessionId: string): { id: string; workspaceId: string; workspaceSlug: string } {
  const suffix = sdkSessionId.replace(/[^a-z0-9]/gi, '-')
  const workspace = createAgentWorkspace(`Migration ${runtime} ${suffix}`)
  const session = createAgentSession(`${runtime} session`, undefined, workspace.id, undefined, runtime)
  updateAgentSessionMeta(session.id, { sdkSessionId })
  writeJsonl(getAgentSessionMessagesPath(session.id), [{ type: 'user', message: `${runtime} metadata` }])
  return { id: session.id, workspaceId: workspace.id, workspaceSlug: workspace.slug }
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  if (root) rmSync(root, { recursive: true, force: true })
  if (secondaryRoot) rmSync(secondaryRoot, { recursive: true, force: true })
  root = ''
  secondaryRoot = ''
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-migration-runtime-test-'))
  process.env.PROFER_CONFIG_DIR = root
})

describe('migration runtime artifacts', () => {
  test('exports selected Claude and Pi native transcripts and records runtime metadata', async () => {
    const claude = createSession('claude', 'claude-export-id')
    const pi = createSession('pi', 'pi-export-id')
    const skipped = createSession('pi', 'pi-not-exported')

    const claudeCwd = getAgentSessionWorkspacePath(claude.workspaceSlug, claude.id)
    writeJsonl(join(getSdkConfigDir(), 'projects', __testSdkProjectKey(claudeCwd), 'claude-export-id.jsonl'), [
      { type: 'system', cwd: claudeCwd, session_id: 'claude-export-id' },
    ])
    writeJsonl(join(getSdkConfigDir(), 'sessions', 'pi', '2026-08-31_pi-export-id.jsonl'), [
      { type: 'session', id: 'pi-export-id', cwd: root },
    ])
    writeJsonl(join(getSdkConfigDir(), 'sessions', 'pi', '2026-08-31_pi-not-exported.jsonl'), [
      { type: 'session', id: 'pi-not-exported', cwd: root },
    ])

    const outputPath = join(root, 'migration.profer-backup')
    await exportDataV2({
      mode: 'personal',
      components: ['sessions'],
      workspaceSelections: [
        { workspaceId: claude.workspaceId },
        { workspaceId: pi.workspaceId },
      ],
      sessionIds: [claude.id, pi.id],
      outputPath,
    })

    const zip = new AdmZip(outputPath)
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as {
      runtimeArtifacts?: { claudeProjects: Array<{ sessionId: string; runtime?: string }>; piSessions: Array<{ sessionId: string; runtime?: string }> }
    }
    const names = zip.getEntries().map((entry) => entry.entryName)

    expect(names).toContain('runtime/claude/claude-export-id.jsonl')
    expect(names).toContain('runtime/pi/pi-export-id.jsonl')
    expect(manifest.runtimeArtifacts?.claudeProjects).toEqual([
      expect.objectContaining({ sessionId: 'claude-export-id', runtime: 'claude' }),
    ])
    expect(manifest.runtimeArtifacts?.piSessions).toEqual([
      expect.objectContaining({ sessionId: 'pi-export-id', runtime: 'pi' }),
    ])
    expect(names).not.toContain(`sessions/agent/${skipped.id}.jsonl`)
  })

  test('imports Claude/Pi artifacts into the mapped workspace and rebinds Pi metadata', async () => {
    const claude = createSession('claude', 'claude-import-id')
    const pi = createSession('pi', 'pi-import-id')
    const claudeCwd = getAgentSessionWorkspacePath(claude.workspaceSlug, claude.id)
    writeJsonl(join(getSdkConfigDir(), 'projects', __testSdkProjectKey(claudeCwd), 'claude-import-id.jsonl'), [
      { type: 'system', cwd: claudeCwd, session_id: 'claude-import-id' },
    ])
    writeJsonl(join(getSdkConfigDir(), 'sessions', 'pi', '2026-08-31_pi-import-id.jsonl'), [
      { type: 'session', id: 'pi-import-id', cwd: root },
    ])

    const archivePath = join(root, 'round-trip.profer-backup')
    await exportDataV2({
      mode: 'personal',
      components: ['sessions'],
      workspaceSelections: [
        { workspaceId: claude.workspaceId },
        { workspaceId: pi.workspaceId },
      ],
      outputPath: archivePath,
    })

    secondaryRoot = mkdtempSync(join(tmpdir(), 'profer-migration-import-test-'))
    process.env.PROFER_CONFIG_DIR = secondaryRoot
    const preview = await parseImportFile(archivePath)
    await import('./migration-service').then(({ confirmImport }) => confirmImport({
      tempDir: preview.tempDir,
      manifest: preview.manifest,
      pathMappings: {},
    }))

    const importedIndex = JSON.parse(readFileSync(getAgentSessionsIndexPath(), 'utf-8')) as {
      sessions: Array<{ id: string; agentRuntime?: string; piSessionFile?: string; workspaceId: string; sdkSessionId?: string }>
    }
    const importedPi = importedIndex.sessions.find((session) => session.id === pi.id)
    const importedClaude = importedIndex.sessions.find((session) => session.id === claude.id)
    const importedPiWorkspace = listAgentWorkspaces().find((workspace) => workspace.id === importedPi?.workspaceId)
    const importedClaudeWorkspace = listAgentWorkspaces().find((workspace) => workspace.id === importedClaude?.workspaceId)

    expect(importedPi?.agentRuntime).toBe('pi')
    expect(importedPi?.piSessionFile).toBe(join(getSdkConfigDir(), 'sessions', 'pi', 'pi-import-id.jsonl'))
    expect(existsSync(importedPi?.piSessionFile ?? '')).toBe(true)
    const importedPiTranscript = JSON.parse(readFileSync(importedPi?.piSessionFile ?? '', 'utf-8').trim()) as { cwd?: string }
    expect(importedPiTranscript.cwd).toContain(secondaryRoot)
    expect(importedClaude?.agentRuntime).toBe('claude')
    expect(importedClaudeWorkspace).toBeDefined()
    expect(importedClaude?.sdkSessionId).toBe('claude-import-id')
    const importedClaudeCwd = getAgentSessionWorkspacePath(importedClaudeWorkspace!.slug, claude.id)
    expect(existsSync(join(getSdkConfigDir(), 'projects', __testSdkProjectKey(importedClaudeCwd), 'claude-import-id.jsonl'))).toBe(true)
    const importedClaudeTranscript = JSON.parse(readFileSync(join(getSdkConfigDir(), 'projects', __testSdkProjectKey(importedClaudeCwd), 'claude-import-id.jsonl'), 'utf-8').trim()) as { cwd?: string }
    expect(importedClaudeTranscript.cwd).toBe(importedClaudeCwd)
  })

  test('rewrites cwd on every valid runtime JSONL record without changing malformed lines', () => {
    const filePath = join(root, 'runtime.jsonl')
    writeFileSync(filePath, `${JSON.stringify({ type: 'system', cwd: 'C:/old' })}\nnot-json\n${JSON.stringify({ type: 'message', cwd: 'C:/old', text: 'x' })}\n`, 'utf-8')

    __testRewriteRuntimeCwd(filePath, 'C:/new/session')

    const lines = readFileSync(filePath, 'utf-8').trimEnd().split('\n')
    expect(JSON.parse(lines[0]!).cwd).toBe('C:/new/session')
    expect(lines[1]).toBe('not-json')
    expect(JSON.parse(lines[2]!).cwd).toBe('C:/new/session')
  })

  test('uses a stable bounded SDK project key for long paths', () => {
    const path = `C:/Users/test/${'nested/'.repeat(80)}session`
    const first = __testSdkProjectKey(path)
    const second = __testSdkProjectKey(path)

    expect(first).toBe(second)
    expect(first.length).toBeLessThanOrEqual(240)
    expect(first).toMatch(/-[0-9a-z]+$/)
  })

  test('parseImportFile exposes a runtime artifact manifest from the generated archive', async () => {
    const session = createSession('pi', 'pi-preview-id')
    const piPath = join(getSdkConfigDir(), 'sessions', 'pi', '2026-08-31_pi-preview-id.jsonl')
    writeJsonl(piPath, [{ type: 'session', id: 'pi-preview-id', cwd: root }])

    const outputPath = join(root, 'preview.profer-backup')
    await exportDataV2({
      mode: 'personal',
      components: ['sessions'],
      workspaceSelections: [{ workspaceId: session.workspaceId }],
      outputPath,
    })

    const preview = await parseImportFile(outputPath)
    expect(preview.manifest.runtimeArtifacts?.piSessions).toEqual([
      expect.objectContaining({ sessionId: 'pi-preview-id', runtime: 'pi' }),
    ])
    expect(existsSync(outputPath)).toBe(true)
    expect(basename(outputPath)).toBe('preview.profer-backup')
  })
})
