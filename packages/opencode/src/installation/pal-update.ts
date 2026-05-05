/**
 * PAL auto-update check on startup.
 *
 * - Non-blocking, fire-and-forget
 * - 500ms connect timeout, 3s total timeout
 * - Compares remote version.txt against embedded version (semver)
 * - If newer: silently downloads platform binary + sha256, verifies checksum,
 *   atomic rename(2) over current binary
 * - Displays one-line notice: "pal: updated to v0.4.0, restart to apply"
 * - If unwritable path: prints manual curl command
 * - If network failure: silent skip, debug log only
 * - Skip entirely if running from source (dev mode) or PAL_NO_UPDATE_CHECK=1
 */

import fs from "fs"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "pal-update" })

const GITLAB_BASE = "https://gitlab.cee.redhat.com/hosted-pulp/pal"
const VERSION_URL = `${GITLAB_BASE}/-/releases/permalink/latest/downloads/version.txt`
const CONNECT_TIMEOUT_MS = 500
const TOTAL_TIMEOUT_MS = 3000

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

function isDevMode(): boolean {
  // Running from source (e.g., bun run dev) — version will be "local"
  return InstallationChannel === "local"
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
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

async function fetchText(url: string): Promise<string | null> {
  try {
    const resp = await fetchWithTimeout(url, TOTAL_TIMEOUT_MS)
    if (!resp.ok) {
      log.debug("fetch failed", { url, status: resp.status })
      return null
    }
    return (await resp.text()).trim()
  } catch (e) {
    log.debug("fetch error", { url, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

async function fetchBinary(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetchWithTimeout(url, TOTAL_TIMEOUT_MS)
    if (!resp.ok) {
      log.debug("binary fetch failed", { url, status: resp.status })
      return null
    }
    const ab = await resp.arrayBuffer()
    return Buffer.from(ab)
  } catch (e) {
    log.debug("binary fetch error", { url, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/**
 * Check for updates and auto-apply if possible.
 * This function is fire-and-forget; it never throws.
 */
export async function checkForUpdate(): Promise<void> {
  try {
    // Skip if disabled via env
    if (process.env.PAL_NO_UPDATE_CHECK === "1") {
      log.debug("update check disabled via PAL_NO_UPDATE_CHECK")
      return
    }

    // Skip if running from source
    if (isDevMode()) {
      log.debug("update check skipped in dev mode")
      return
    }

    // Current version
    const current = InstallationVersion
    if (!semver.valid(current)) {
      log.debug("current version is not valid semver, skipping", { current })
      return
    }

    // Fetch remote version
    const remoteVersion = await fetchText(VERSION_URL)
    if (!remoteVersion || !semver.valid(remoteVersion)) {
      log.debug("could not fetch or parse remote version", { remoteVersion })
      return
    }

    // Compare
    if (!semver.gt(remoteVersion, current)) {
      log.debug("already up to date", { current, remote: remoteVersion })
      return
    }

    log.info("newer version available", { current, remote: remoteVersion })

    // Determine platform binary name
    const assetName = getPlatformAssetName()
    if (!assetName) {
      log.debug("unsupported platform for auto-update", { platform: os.platform(), arch: os.arch() })
      return
    }

    const binaryUrl = `${GITLAB_BASE}/-/releases/v${remoteVersion}/downloads/${assetName}`
    const checksumUrl = `${GITLAB_BASE}/-/releases/v${remoteVersion}/downloads/${assetName}.sha256`

    // Check if we can write to the current binary location
    const execPath = process.execPath
    const execDir = path.dirname(execPath)

    let writable = false
    try {
      fs.accessSync(execDir, fs.constants.W_OK)
      fs.accessSync(execPath, fs.constants.W_OK)
      writable = true
    } catch {
      writable = false
    }

    if (!writable) {
      // Cannot auto-update; print manual instructions
      process.stderr.write(
        `pal: v${remoteVersion} available. Update manually:\n` +
          `  curl -fSL "${binaryUrl}" -o "${execPath}" && chmod +x "${execPath}"\n`,
      )
      return
    }

    // Download binary and checksum
    const [binaryData, checksumData] = await Promise.all([fetchBinary(binaryUrl), fetchText(checksumUrl)])

    if (!binaryData || !checksumData) {
      log.debug("failed to download binary or checksum")
      return
    }

    // Verify checksum
    const expectedHash = checksumData.trim()
    const actualHash = sha256(binaryData)

    if (expectedHash !== actualHash) {
      log.warn("checksum mismatch, aborting update", { expected: expectedHash, actual: actualHash })
      return
    }

    // Atomic update: write to temp file then rename(2)
    const tmpPath = execPath + `.update-${process.pid}`
    try {
      fs.writeFileSync(tmpPath, binaryData, { mode: 0o755 })
      fs.renameSync(tmpPath, execPath)
    } catch (e) {
      // Clean up temp file on failure
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        // ignore cleanup errors
      }

      // Fall back to manual instructions
      process.stderr.write(
        `pal: v${remoteVersion} available but auto-update failed. Update manually:\n` +
          `  curl -fSL "${binaryUrl}" -o "${execPath}" && chmod +x "${execPath}"\n`,
      )
      log.debug("auto-update write failed", { error: e instanceof Error ? e.message : String(e) })
      return
    }

    process.stderr.write(`pal: updated to v${remoteVersion}, restart to apply\n`)
  } catch (e) {
    // Catch-all: never let update check crash the app
    log.debug("update check failed", { error: e instanceof Error ? e.message : String(e) })
  }
}
