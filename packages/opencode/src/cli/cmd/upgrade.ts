import type { Argv } from "yargs"
import { InstallationVersion, InstallationChannel } from "@opencode-ai/core/installation/version"
import fs from "fs"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import { spawnSync } from "child_process"

const CONTENT_BASE = "https://packages.redhat.com/api/pulp-content/public-pal/pal"

function getPlatformAssetName(): string | null {
  const p = os.platform() === "linux" ? "linux" : os.platform() === "darwin" ? "darwin" : null
  const a = os.arch() === "x64" ? "x64" : os.arch() === "arm64" ? "arm64" : null
  return p && a ? `pal-${p}-${a}` : null
}

export const UpgradeCommand = {
  command: "upgrade",
  describe: "upgrade PAL and launch",
  builder: (yargs: Argv) => yargs,
  handler: async () => {
    const current = InstallationVersion

    if (InstallationChannel === "local") {
      process.stderr.write(`PAL v${current} (dev mode)\n`)
      relaunch()
      return
    }

    const assetName = getPlatformAssetName()
    if (!assetName) {
      process.stderr.write(`Unsupported platform: ${os.platform()}/${os.arch()}\n`)
      return
    }

    // Fetch remote version
    let remote: string
    try {
      const resp = await fetch(`${CONTENT_BASE}/latest/version.txt`, { signal: AbortSignal.timeout(5000) })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      remote = (await resp.text()).trim()
    } catch {
      process.stderr.write(`Could not reach update server — launching PAL v${current}\n`)
      relaunch()
      return
    }

    if (remote === current) {
      process.stderr.write(`PAL v${current} is up to date\n`)
      relaunch()
      return
    }

    process.stderr.write(`Upgrading PAL v${current} → v${remote}...\n`)

    // Download binary and checksum in parallel
    const binaryUrl = `${CONTENT_BASE}/v${remote}/${assetName}`
    const checksumUrl = `${CONTENT_BASE}/v${remote}/${assetName}.sha256`

    let binaryBuf: Buffer
    let expectedHash: string
    try {
      const [binResp, hashResp] = await Promise.all([
        fetch(binaryUrl, { signal: AbortSignal.timeout(120_000), redirect: "follow" }),
        fetch(checksumUrl, { signal: AbortSignal.timeout(10_000), redirect: "follow" }),
      ])
      if (!binResp.ok) throw new Error(`Binary download failed: HTTP ${binResp.status}`)
      if (!hashResp.ok) throw new Error(`Checksum download failed: HTTP ${hashResp.status}`)
      binaryBuf = Buffer.from(await binResp.arrayBuffer())
      expectedHash = (await hashResp.text()).trim()
    } catch (e) {
      process.stderr.write(`Download failed: ${e instanceof Error ? e.message : e}\n`)
      relaunch()
      return
    }

    // Verify checksum
    const actualHash = createHash("sha256").update(binaryBuf).digest("hex")
    if (actualHash !== expectedHash) {
      process.stderr.write(`Checksum mismatch — aborting\n`)
      relaunch()
      return
    }

    // Write to disk
    const execPath = process.execPath
    const tmpPath = execPath + `.upgrade-${process.pid}`
    try {
      fs.writeFileSync(tmpPath, binaryBuf, { mode: 0o755 })
      fs.renameSync(tmpPath, execPath)
    } catch (e) {
      try { fs.unlinkSync(tmpPath) } catch {}
      process.stderr.write(`Failed to write binary: ${e instanceof Error ? e.message : e}\n`)
      process.stderr.write(`Manual: curl -fSL "${binaryUrl}" -o "${execPath}" && chmod +x "${execPath}"\n`)
      return
    }

    process.stderr.write(`Updated to v${remote}\n`)
    relaunch()
  },
}

function relaunch(): void {
  const result = spawnSync(process.execPath, [], { stdio: "inherit" })
  process.exit(result.status ?? 0)
}
