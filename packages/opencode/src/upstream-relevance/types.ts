export type RelevanceLevel = "noise" | "watch" | "review" | "must-act"

export interface RelevanceResult {
  level: RelevanceLevel
  reasoning: string
  /** Which layer produced this result: 1 = rule-based, 2 = LLM */
  layer: 1 | 2
}

export interface UpstreamRule {
  /** Glob patterns for file paths that matter */
  paths?: string[]
  /** GitHub/GitLab labels that indicate relevance */
  labels?: string[]
  /** Keywords to match in title/body */
  keywords?: string[]
}

export interface UpstreamConfig {
  /** Rules that auto-classify as must-act */
  "must-act": UpstreamRule
  /** Rules that auto-classify as review */
  review: UpstreamRule
  /** Rules that auto-classify as watch */
  watch: UpstreamRule
  /** Rules that auto-classify as noise */
  noise: UpstreamRule
  /** Layer 2 LLM budget settings */
  layer2: {
    /** Max LLM calls per poll cycle (default 20) */
    maxCallsPerPoll: number
    /** Daily soft cap (default 200) */
    dailySoftCap: number
    /** Consecutive failures before circuit opens (default 3) */
    circuitBreakerThreshold: number
    /** Model to use (default claude-sonnet-4-5-20250514) */
    model: string
  }
}

/** An upstream event that can be classified */
export interface ClassifiableEvent {
  title: string
  summary: string | null
  event_type: string
  source: string
  actor: string | null
  metadata: Record<string, unknown> | null
}
