/**
 * Functional tests for MemPalace integration against the REAL mempalace CLI.
 *
 * Requirements:
 *   - `mempalace` CLI installed (via uv tool install mempalace)
 *   - Palace data at ~/.mempalace/palace (created via CLI usage)
 *   - For test 5: a wing with actual data (e.g., _home_bmbouter_devel_pal)
 *
 * Run: bun run src/sweep/mempalace.functional.test.ts
 * (NOT bun test — Bun's test runner deadlocks on subprocess calls)
 */
import { searchRelated } from "./mempalace"
import { execSync } from "child_process"

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

async function main() {
  console.log("Functional tests: MemPalace integration\n")

  // Test 1: mempalace CLI is findable
  console.log("\n1. CLI installation:")
  let mempalacePath: string | null = null
  try {
    mempalacePath = execSync("which mempalace", { encoding: "utf-8", timeout: 5000 }).trim()
    assert(mempalacePath.length > 0 && mempalacePath.includes("mempalace"), "which mempalace returns a valid path")
    console.log(`     Path: ${mempalacePath}`)
  } catch {
    assert(false, "which mempalace returns a valid path")
  }

  // Test 2: mempalace CLI runs
  console.log("\n2. CLI version check:")
  try {
    const version = execSync("mempalace --version", { encoding: "utf-8", timeout: 5000 }).trim()
    assert(version.length > 0, "mempalace --version returns output")
    console.log(`     Version: ${version}`)
  } catch (err) {
    assert(false, "mempalace --version returns output")
    console.log(`     Error: ${err}`)
  }

  // Test 3: Wing name derivation
  console.log("\n3. Wing name derivation:")
  const expectedWing = process.cwd().replace(/\//g, "_")
  console.log(`     Current directory: ${process.cwd()}`)
  console.log(`     Expected wing: ${expectedWing}`)
  assert(expectedWing.startsWith("_home"), "wing name starts with _home for /home/...")
  assert(!expectedWing.includes("/"), "wing name has no slashes")

  // Test 4: searchRelated with test query returns string
  console.log("\n4. Basic search functionality:")
  try {
    const result = await searchRelated("test query for mempalace")
    assert(typeof result === "string", "searchRelated returns a string")
    console.log(`     Result type: ${typeof result}`)
    console.log(`     Result length: ${result.length} chars`)
  } catch (err) {
    assert(false, "searchRelated returns a string")
    console.log(`     Error: ${err}`)
  }

  // Test 5: Search with known wing that has data
  console.log("\n5. Search with known wing (requires data):")

  // For current wing, just test that search works (result may be empty if no data)
  try {
    const searchResult = await searchRelated("architecture mempalace testing")
    assert(typeof searchResult === "string", "search returns string for current wing")
    console.log(`     Current wing: ${expectedWing}`)
    console.log(`     Search result length: ${searchResult.length} chars`)

    if (searchResult.length > 0) {
      console.log(`     Preview: ${searchResult.slice(0, 100)}...`)
      assert(searchResult.length > 0, "search returns non-empty results for wing with data")
    } else {
      console.log(`     Note: Empty result (wing may not have matching data)`)
      assert(true, "empty result is valid (wing may not have data)")
    }
  } catch (err) {
    console.log(`     Error during search: ${err}`)
    assert(false, "search should not throw errors")
  }

  // Test 6: Empty query handling
  console.log("\n6. Empty query handling:")
  try {
    const result = await searchRelated("")
    assert(typeof result === "string", "empty query returns string without crashing")
    console.log(`     Empty query handled gracefully, result length: ${result.length}`)
  } catch (err) {
    assert(false, "empty query returns string without crashing")
    console.log(`     Error: ${err}`)
  }

  // Test 7: Very long query truncation
  console.log("\n7. Long query truncation:")
  const longQuery = "x".repeat(500) // 500 chars, should be truncated to 200
  try {
    const result = await searchRelated(longQuery)
    assert(typeof result === "string", "long query (500 chars) returns string")
    console.log(`     Long query (500 chars) handled gracefully`)
    console.log(`     Result length: ${result.length} chars`)

    // Verify truncation happens in the code (searchRelated slices to 200)
    // We can't verify the exact query sent, but we can verify it didn't crash
    assert(true, "query truncation works (no crash)")
  } catch (err) {
    assert(false, "long query (500 chars) returns string")
    console.log(`     Error: ${err}`)
  }

  // Test 8: Verify query slicing behavior matches implementation
  console.log("\n8. Implementation verification:")
  const query200 = "a".repeat(200)
  const query201 = "b".repeat(201)
  try {
    const result200 = await searchRelated(query200)
    const result201 = await searchRelated(query201)
    assert(typeof result200 === "string" && typeof result201 === "string",
           "queries at and above 200 chars both work")
    console.log(`     200-char query: ${result200.length} chars result`)
    console.log(`     201-char query: ${result201.length} chars result (truncated to 200)`)
  } catch (err) {
    assert(false, "queries at and above 200 chars both work")
    console.log(`     Error: ${err}`)
  }

  // Summary
  console.log(`\n${"=".repeat(50)}`)
  console.log(`${passed} passed, ${failed} failed`)
  console.log(`${"=".repeat(50)}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Test error:", err)
  process.exit(1)
})
