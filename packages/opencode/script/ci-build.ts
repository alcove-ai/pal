#!/usr/bin/env bun
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const target = process.argv[2]
const outfile = process.argv[3]
const version = process.env.OPENCODE_VERSION || "0.0.0"
const channel = process.env.OPENCODE_CHANNEL || "latest"

if (!target || !outfile) {
  console.error("Usage: OPENCODE_VERSION=x.y.z bun run ci-build.ts <target> <outfile>")
  console.error("  target: bun-linux-x64, bun-linux-arm64, bun-darwin-arm64")
  process.exit(1)
}

const plugin = createSolidTransformPlugin()

await Bun.build({
  conditions: ["browser"],
  plugins: [plugin],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  sourcemap: "none",
  splitting: true,
  compile: {
    target: target as any,
    outfile,
  },
  entrypoints: ["./src/index.ts"],
  define: {
    OPENCODE_VERSION: `'${version}'`,
    OPENCODE_CHANNEL: `'${channel}'`,
  },
})

console.log(`Built ${outfile} for ${target}`)
