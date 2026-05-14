import type { Argv } from "yargs"
import { InstallationVersion, InstallationChannel } from "@opencode-ai/core/installation/version"
import { checkForUpdate } from "../../installation/pal-update"

export const UpgradeCommand = {
  command: "upgrade",
  describe: "check for and apply PAL updates",
  builder: (yargs: Argv) => yargs,
  handler: async () => {
    if (InstallationChannel === "local") {
      process.stderr.write(`PAL v${InstallationVersion} (dev mode — skipping upgrade)\n`)
      return
    }

    await checkForUpdate({ verbose: true })
  },
}
