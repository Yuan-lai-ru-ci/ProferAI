#!/usr/bin/env node

const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const expectedTarget = process.argv[2]
const bundlePath = process.argv[3] || 'dist/main.cjs'

if (!['oss', 'commercial'].includes(expectedTarget)) {
  console.error('Usage: node scripts/verify-build-target.cjs <oss|commercial> [bundlePath]')
  process.exit(2)
}

const bundle = readFileSync(resolve(bundlePath), 'utf8')
const ossLiteral = 'false ? "oss" : "oss"'
const commercialLiteral = 'false ? "oss" : "commercial"'
const githubMarker = 'GitHub Releases'
const domesticFeed = 'http://47.109.108.57/profer-updates/'

const hasOssTarget = bundle.includes(ossLiteral)
const hasCommercialTarget = bundle.includes(commercialLiteral)
const hasGithubUpdater = bundle.includes(githubMarker)
const hasDomesticFeed = bundle.includes(domesticFeed)

if (expectedTarget === 'oss') {
  if (!hasOssTarget || hasCommercialTarget) {
    console.error('[verify-build-target] GitHub build target mismatch: expected oss bundle.')
    process.exit(1)
  }
  if (!hasGithubUpdater) {
    console.error('[verify-build-target] GitHub build is missing GitHub updater marker.')
    process.exit(1)
  }
}

if (expectedTarget === 'commercial') {
  if (!hasCommercialTarget || hasOssTarget) {
    console.error('[verify-build-target] Commercial build target mismatch: expected commercial bundle.')
    process.exit(1)
  }
  if (!hasDomesticFeed) {
    console.error('[verify-build-target] Commercial build is missing domestic update feed.')
    process.exit(1)
  }
}

console.log(`[verify-build-target] ${expectedTarget} bundle verified: ${bundlePath}`)
