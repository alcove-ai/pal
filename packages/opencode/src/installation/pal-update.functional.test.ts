/**
 * Functional tests for PAL auto-updater against REAL packages.redhat.com infrastructure.
 *
 * Tests verify:
 *   - version.txt is reachable and returns valid semver
 *   - Binary URLs for latest version exist (HTTP 200/302)
 *   - Checksum URLs return valid SHA256 hex strings
 *   - `which pal` resolves to a real path
 *   - Resolved binary is writable by current user
 *
 * Requirements:
 *   - Network access to packages.redhat.com
 *   - `pal` binary installed and in PATH
 *
 * Run: bun run src/installation/pal-update.functional.test.ts
 * (NOT bun test — Bun's test runner deadlocks on subprocess calls)
 */
import { execSync } from "child_process"
import fs from "fs"
import os from "os"

const CONTENT_BASE = "https://packages.redhat.com/api/pulp-content/public-pal/pal"
const VERSION_URL = `${CONTENT_BASE}/latest/version.txt`
const METADATA_TIMEOUT_MS = 5_000

let passed = 0
let failed = 0

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
  }
}

function getPlatformAssetName(): string | null {
  const platform = os.platform()
  const arch = os.arch()

  let p: string
  switch (platform) {
    case "linux":
      p = "linux"
      break
    case "darwin":
      p = "darwin"
      break
    default:
      return null
  }

  let a: string
  switch (arch) {
    case "x64":
      a = "x64"
      break
    case "arm64":
      a = "arm64"
      break
    default:
      return null
  }

  return `pal-${p}-${a}`
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    })
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  console.log("Functional tests: PAL auto-updater against packages.redhat.com\n")

  // --- Test 1: version.txt is reachable and returns valid semver ---
  console.log("Version endpoint:")
  let remoteVersion: string | null = null
  try {
    const resp = await fetchWithTimeout(VERSION_URL, METADATA_TIMEOUT_MS)
    assert(resp.ok, "version.txt returns HTTP 200")

    const text = await resp.text()
    remoteVersion = text.trim()
    assert(!!remoteVersion, "version.txt returns non-empty content")

    // Valid semver regex: https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
    const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
    assert(semverPattern.test(remoteVersion), `version.txt returns valid semver (got: ${remoteVersion})`)
  } catch (e) {
    assert(false, `version.txt fetch failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (!remoteVersion) {
    console.error("\nFATAL: Cannot fetch remote version — aborting remaining tests")
    process.exit(1)
  }

  console.log(`\nRemote version: v${remoteVersion}`)

  // --- Test 2 & 3: Binary and checksum URLs exist ---
  console.log("\nAsset availability:")
  const assetName = getPlatformAssetName()
  if (!assetName) {
    console.error(`\nWARNING: Unsupported platform ${os.platform()}/${os.arch()} — skipping asset tests`)
  } else {
    const binaryUrl = `${CONTENT_BASE}/v${remoteVersion}/${assetName}`
    const checksumUrl = `${CONTENT_BASE}/v${remoteVersion}/${assetName}.sha256`

    // Test binary URL with HEAD request (don't download 130MB)
    try {
      const resp = await fetchWithTimeout(binaryUrl, METADATA_TIMEOUT_MS)
      assert(resp.ok, `binary URL returns HTTP 200/302 (${binaryUrl})`)
    } catch (e) {
      assert(false, `binary URL fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Test checksum URL
    try {
      const resp = await fetchWithTimeout(checksumUrl, METADATA_TIMEOUT_MS)
      assert(resp.ok, `checksum URL returns HTTP 200 (${checksumUrl})`)

      const checksumText = await resp.text()
      const checksum = checksumText.trim()
      assert(!!checksum, "checksum URL returns non-empty content")

      // SHA256 is exactly 64 hex characters
      const sha256Pattern = /^[a-f0-9]{64}$/
      assert(sha256Pattern.test(checksum), `checksum is valid SHA256 hex (got: ${checksum.substring(0, 16)}...)`)
      assert(checksum.length === 64, "checksum is exactly 64 characters")
    } catch (e) {
      assert(false, `checksum URL fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // --- Test 5: `which pal` resolves to a real path ---
  console.log("\nBinary path resolution:")
  let palPath: string | null = null
  try {
    palPath = execSync("which pal", { encoding: "utf-8" }).trim()
    assert(!!palPath, "`which pal` returns non-empty path")
    assert(palPath.startsWith("/"), "`which pal` returns absolute path")
    console.log(`  Resolved path: ${palPath}`)

    // --- Test 6: Resolved binary is writable ---
    try {
      const stats = fs.statSync(palPath)
      assert(stats.isFile(), "resolved path is a file")

      // Check if writable by current user
      try {
        fs.accessSync(palPath, fs.constants.W_OK)
        assert(true, "pal binary is writable by current user")
      } catch {
        assert(false, "pal binary is NOT writable by current user")
        console.log(`  (This is expected if pal is installed system-wide — auto-update will require sudo)`)
      }
    } catch (e) {
      assert(false, `pal binary stat failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  } catch (e) {
    assert(false, "`which pal` failed — pal not in PATH or not installed")
    console.log(`  (Install pal first for this test to pass)`)
  }

  // --- Summary ---
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Test error:", err)
  process.exit(1)
})
