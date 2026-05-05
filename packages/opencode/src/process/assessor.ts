/**
 * Mechanical assessment of Jira issue descriptions.
 * Pure regex + word count — NO LLM calls.
 *
 * Phases:  needs_problem → has_problem → needs_scope (epics only) → ready
 */

// --- Types ---

export type Phase = "needs_problem" | "has_problem" | "needs_scope" | "ready"
export type ProblemQuality = "missing" | "present" | "weak"
export type ScopeQuality = "missing" | "present"

export interface AssessmentResult {
  phase: Phase
  problemQuality: ProblemQuality
  scopeQuality: ScopeQuality
  exemptionReason: string | null
}

export type IssueType = "Epic" | "Task" | "Bug" | "Story" | "Sub-task" | string

export interface IssueInput {
  key: string
  summary: string
  issueType: IssueType
  description: string | null
  labels: string[]
}

// --- Constants ---

/** Implementation-oriented verbs (signal a spec is prescriptive, not problem-oriented) */
const IMPLEMENTATION_VERBS = /\b(build|create|implement|add|deploy|develop|set\s+up|configure|install|migrate|write|make)\b/i

/** Problem-oriented verbs (signal the description articulates a problem) */
const PROBLEM_VERBS = /\b(broken|missing|fails|cannot|blocks|prevents|causes|error|crash|slow|wrong|incorrect|unable|stuck|degraded|outage|regression)\b/i

/** Bug reproduction keywords — if present, a Bug satisfies the problem requirement without a header */
const BUG_REPRO_PATTERN = /\b(steps?\s+to\s+reproduce|expected|actual)\b/i

/** Epic problem statement header (Jira wiki markup h2) */
const EPIC_PROBLEM_HEADER = /^h2\.\s*Problem\s+Statement\s*$/im

/** Epic scope header */
const EPIC_SCOPE_HEADER = /^h2\.\s*Scope\s+of\s+Work\s*$/im

/** Task/Bug problem statement header (h3) */
const TASK_PROBLEM_HEADER = /^h3\.\s*Problem\s+Statement\s*$/im

/** Auto-exempt summary patterns */
const EXEMPT_SUMMARY_PATTERNS = [
  /^Document\s+/i,
  /\bbump\s+version\b/i,
  /\bfix\s+typo\b/i,
  /\brename\b/i,
]

/** Auto-exempt labels */
const EXEMPT_LABELS = new Set(["chore", "housekeeping"])

// --- Helpers ---

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length
}

/**
 * Extract the section body following a header regex up to the next h2/h3 or end of text.
 */
function extractSection(text: string, headerRegex: RegExp): string | null {
  const match = headerRegex.exec(text)
  if (!match) return null
  const afterHeader = text.slice(match.index + match[0].length)
  // Section ends at the next h2/h3 header or end of string
  const nextHeader = afterHeader.search(/^h[23]\.\s/im)
  const body = nextHeader >= 0 ? afterHeader.slice(0, nextHeader) : afterHeader
  return body.trim()
}

/**
 * Check if the description essentially restates the summary (too similar).
 */
function restatesSummary(summary: string, description: string): boolean {
  const normSummary = summary.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim()
  const normDesc = description.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim()
  if (normDesc.length === 0) return false
  // If the description (minus whitespace variations) starts with the summary text, it's a restatement
  if (normDesc.startsWith(normSummary) && wordCount(normDesc) <= wordCount(normSummary) + 5) return true
  return false
}

function detectWeakness(summary: string, description: string): boolean {
  // Has implementation verbs without problem verbs
  if (IMPLEMENTATION_VERBS.test(description) && !PROBLEM_VERBS.test(description)) return true
  // Under overall word threshold
  if (wordCount(description) < 10) return true
  // Restates summary
  if (restatesSummary(summary, description)) return true
  return false
}

// --- Auto-exemption ---

function checkExemption(input: IssueInput): string | null {
  for (const pattern of EXEMPT_SUMMARY_PATTERNS) {
    if (pattern.test(input.summary)) {
      return `summary matches exempt pattern: ${pattern.source}`
    }
  }
  for (const label of input.labels) {
    if (EXEMPT_LABELS.has(label.toLowerCase())) {
      return `label "${label}" is auto-exempt`
    }
  }
  return null
}

// --- Main assessor ---

/**
 * Assess a single Jira issue description mechanically.
 * Returns the lifecycle phase and quality signals.
 */
export function assess(input: IssueInput): AssessmentResult {
  // Check auto-exemptions first
  const exemption = checkExemption(input)
  if (exemption) {
    return {
      phase: "ready",
      problemQuality: "present",
      scopeQuality: "present",
      exemptionReason: exemption,
    }
  }

  const description = input.description ?? ""
  const isEpic = input.issueType === "Epic"
  const isBug = input.issueType === "Bug"

  // --- Problem statement assessment ---
  let problemQuality: ProblemQuality = "missing"

  if (isEpic) {
    const section = extractSection(description, EPIC_PROBLEM_HEADER)
    if (section && wordCount(section) >= 20) {
      problemQuality = "present"
    } else if (section) {
      problemQuality = "weak"
    }
  } else {
    // Task / Bug / Story / Sub-task
    const section = extractSection(description, TASK_PROBLEM_HEADER)
    if (section && wordCount(section) >= 15) {
      problemQuality = "present"
    } else if (section) {
      problemQuality = "weak"
    }

    // Bugs with reproduction steps satisfy even without a header
    if (isBug && problemQuality !== "present" && BUG_REPRO_PATTERN.test(description)) {
      problemQuality = "present"
    }
  }

  // Weak detection overlay: if nominally "present" but content is weak, downgrade
  if (problemQuality === "present" && detectWeakness(input.summary, description)) {
    problemQuality = "weak"
  }

  // If still missing, check if there's any substance at all
  if (problemQuality === "missing" && description.length > 0) {
    // There's text but no proper header — check if it looks weak
    if (PROBLEM_VERBS.test(description) && wordCount(description) >= 15) {
      problemQuality = "weak" // has problem language but no proper header
    }
  }

  // --- Scope assessment (epics only) ---
  let scopeQuality: ScopeQuality = isEpic ? "missing" : "present" // non-epics don't need scope

  if (isEpic) {
    const section = extractSection(description, EPIC_SCOPE_HEADER)
    if (section && wordCount(section) >= 15) {
      scopeQuality = "present"
    }
  }

  // --- Phase determination ---
  let phase: Phase
  if (problemQuality === "missing") {
    phase = "needs_problem"
  } else if (problemQuality === "weak") {
    phase = "needs_problem"
  } else if (isEpic && scopeQuality === "missing") {
    phase = "needs_scope"
  } else {
    phase = "ready"
  }

  // Intermediate: if problem is present but not yet at scope check (non-epic), mark has_problem
  if (problemQuality === "present" && !isEpic) {
    phase = "ready"
  }
  if (problemQuality === "present" && isEpic && scopeQuality === "missing") {
    phase = "needs_scope"
  }
  if (problemQuality === "present" && isEpic && scopeQuality === "present") {
    phase = "ready"
  }

  return {
    phase,
    problemQuality,
    scopeQuality,
    exemptionReason: null,
  }
}
