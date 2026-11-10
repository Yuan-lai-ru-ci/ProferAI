const files = [
  'apps/electron/src/main/lib/runtime-contracts/admission.test.ts',
  'apps/electron/src/main/lib/runtime-contracts/final-tool-policy.test.ts',
  'apps/electron/src/main/lib/runtime-contracts/skill-mcp-manifest.test.ts',
  'apps/electron/src/main/lib/runtime-contracts/result-snapshot.test.ts',
]

const result = Bun.spawnSync([process.execPath, 'test', '--isolate', ...files], {
  cwd: new URL('../../..', import.meta.url).pathname,
  stdout: 'pipe',
  stderr: 'pipe',
})
const output = `${result.stdout.toString()}\n${result.stderr.toString()}`
if (result.exitCode !== 0) {
  process.stderr.write(output)
  process.exit(result.exitCode ?? 1)
}
const summary = output.match(/Ran (\d+) tests across (\d+) files/)
if (!summary || Number(summary[1]) === 0 || Number(summary[2]) !== files.length) {
  process.stderr.write(output)
  throw new Error(`runtime-contracts discovery gate expected ${files.length} test files and non-zero tests`)
}
process.stdout.write(`runtime-contracts discovery gate passed: ${summary[1]} tests across ${summary[2]} files\n`)
