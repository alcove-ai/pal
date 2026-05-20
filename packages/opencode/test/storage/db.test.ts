import { describe, expect, test } from "bun:test"
import path from "path"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Database } from "@/storage/db"

describe("Database.Path", () => {
  test("returns database path in .opencode directory", () => {
    const dir = path.join(process.cwd(), ".opencode")
    const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
      ? path.join(dir, "data.db")
      : path.join(dir, `data-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })
})
