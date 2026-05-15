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

type UpdateListener = (version: string) => void
const _listeners: UpdateListener[] = []
let _completedVersion: string | null = null

export function onUpdateComplete(cb: UpdateListener): void {
  if (_completedVersion) cb(_completedVersion)
  _listeners.push(cb)
}

const CONTENT_BASE = "https://packages.redhat.com/api/pulp-content/public-pal/pal"
const VERSION_URL = `${CONTENT_BASE}/latest/version.txt`
const METADATA_TIMEOUT_MS = 5_000
const BINARY_TIMEOUT_MS = 120_000

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
    const resp = await fetchWithTimeout(url, METADATA_TIMEOUT_MS)
    if (!resp.ok) {
      log.info("fetch failed", { url, status: resp.status })
      return null
    }
    return (await resp.text()).trim()
  } catch (e) {
    log.info("fetch error", { url, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

async function fetchBinary(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetchWithTimeout(url, BINARY_TIMEOUT_MS)
    if (!resp.ok) {
      log.info("binary fetch failed", { url, status: resp.status })
      return null
    }
    const ab = await resp.arrayBuffer()
    return Buffer.from(ab)
  } catch (e) {
    log.info("binary fetch error", { url, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/**
 * Check for updates and auto-apply if possible.
 * This function is fire-and-forget; it never throws.
 */
export async function checkForUpdate(opts?: { verbose?: boolean }): Promise<boolean> {
  const say = (msg: string) => { if (opts?.verbose) process.stderr.write(msg) }
  try {
    if (process.env.PAL_NO_UPDATE_CHECK === "1") {
      log.debug("update check disabled via PAL_NO_UPDATE_CHECK")
      return false
    }

    if (isDevMode()) {
      log.debug("update check skipped in dev mode")
      return false
    }

    const current = InstallationVersion
    if (!semver.valid(current)) {
      log.debug("current version is not valid semver, skipping", { current })
      return false
    }

    const remoteVersion = await fetchText(VERSION_URL)
    if (!remoteVersion || !semver.valid(remoteVersion)) {
      say("Could not reach update server\n")
      return false
    }

    if (!semver.gt(remoteVersion, current)) {
      say(`Already up to date (v${current})\n`)
      return false
    }

    say(`Update available: v${current} → v${remoteVersion}\n`)
    log.info("newer version available", { current, remote: remoteVersion })

    const assetName = getPlatformAssetName()
    if (!assetName) {
      log.info("unsupported platform for auto-update", { platform: os.platform(), arch: os.arch() })
      return false
    }

    const binaryUrl = `${CONTENT_BASE}/v${remoteVersion}/${assetName}`
    const checksumUrl = `${CONTENT_BASE}/v${remoteVersion}/${assetName}.sha256`
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
      say(`Cannot write to ${execPath} — run with sudo or update manually:\n`)
      say(`  curl -fSL "${binaryUrl}" -o "${execPath}" && chmod +x "${execPath}"\n`)
      return false
    }

    say("Downloading...")
    log.info("downloading update", { binaryUrl, checksumUrl })
    const [binaryData, checksumData] = await Promise.all([fetchBinary(binaryUrl), fetchText(checksumUrl)])

    if (!binaryData || !checksumData) {
      say(" failed\n")
      log.info("failed to download binary or checksum", { hasBinary: !!binaryData, hasChecksum: !!checksumData })
      return false
    }
    say(" done\n")

    const expectedHash = checksumData.trim()
    const actualHash = sha256(binaryData)

    if (expectedHash !== actualHash) {
      say("Checksum mismatch — update aborted\n")
      log.warn("checksum mismatch, aborting update", { expected: expectedHash, actual: actualHash })
      return false
    }

    say("Applying update...")
    log.info("applying update", { execPath, size: binaryData.length })
    const tmpPath = execPath + `.update-${process.pid}`
    try {
      fs.writeFileSync(tmpPath, binaryData, { mode: 0o755 })
      fs.renameSync(tmpPath, execPath)
    } catch (e) {
      try { fs.unlinkSync(tmpPath) } catch {}
      say(" failed\n")
      log.info("auto-update write failed", { error: e instanceof Error ? e.message : String(e) })
      return false
    }

    say(` updated to v${remoteVersion}\n`)
    _completedVersion = remoteVersion
    for (const cb of _listeners) cb(remoteVersion)
    log.info("auto-update complete", { version: remoteVersion })
    return true
  } catch (e) {
    log.info("update check failed", { error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000

export function startPeriodicUpdateCheck(): void {
  checkForUpdate().catch(() => {})
  setInterval(() => checkForUpdate().catch(() => {}), UPDATE_CHECK_INTERVAL_MS)
}
