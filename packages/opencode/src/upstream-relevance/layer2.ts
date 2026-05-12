import * as Log from "@opencode-ai/core/util/log"
import { generateObject } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import z from "zod"
import path from "path"
import { existsSync, readFileSync } from "fs"
import type { UpstreamConfig, ClassifiableEvent, RelevanceResult, RelevanceLevel } from "./types"

const log = Log.create({ service: "upstream-relevance.layer2" })

const RELEVANCE_SCHEMA = z.object({
  level: z.enum(["noise", "watch", "review", "must-act"]),
  reasoning: z.string().max(200),
})

/** Circuit breaker + budget state for Layer 2 */
interface Layer2State {
  consecutiveFailures: number
  circuitOpen: boolean
  callsThisPoll: number
  callsToday: number
  todayDate: string
}

let state: Layer2State = {
  consecutiveFailures: 0,
  circuitOpen: false,
  callsThisPoll: 0,
  callsToday: 0,
  todayDate: todayKey(),
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Reset per-poll counter. Call at the start of each poll cycle. */
export function resetPollBudget(): void {
  state.callsThisPoll = 0
}

/** Check whether Layer 2 can accept another call given budget/circuit state. */
export function canCallLayer2(config: UpstreamConfig): boolean {
  // Rotate daily counter
  const today = todayKey()
  if (state.todayDate !== today) {
    state.todayDate = today
    state.callsToday = 0
    // Reset circuit breaker on new day
    state.circuitOpen = false
    state.consecutiveFailures = 0
  }

  if (state.circuitOpen) {
    log.debug("layer2 circuit is open, skipping")
    return false
  }

  if (state.callsThisPoll >= config.layer2.maxCallsPerPoll) {
    log.debug("layer2 per-poll budget exhausted", {
      calls: state.callsThisPoll,
      max: config.layer2.maxCallsPerPoll,
    })
    return false
  }

  if (state.callsToday >= config.layer2.dailySoftCap) {
    log.debug("layer2 daily soft cap reached", {
      calls: state.callsToday,
      cap: config.layer2.dailySoftCap,
    })
    return false
  }

  return true
}

function loadDeploymentContext(config: UpstreamConfig): string {
  // 1. Check config-provided deployment context first
  if (config.deploymentContext) {
    return config.deploymentContext
  }

  // 2. Try reading deployment-context.md from disk
  const contextPath = path.join(process.cwd(), "deployment-context.md")
  if (existsSync(contextPath)) {
    try {
      return readFileSync(contextPath, "utf-8")
    } catch {
      // fall through to default
    }
  }

  // 3. Generic fallback
  return DEFAULT_DEPLOYMENT_CONTEXT
}

const DEFAULT_DEPLOYMENT_CONTEXT =
  "No deployment context configured. Classify based on the event's labels, title, and description."

/**
 * Layer 2: LLM-based classifier.
 * Uses Anthropic Sonnet to classify events that Layer 1 couldn't determine.
 * Budget-capped with circuit breaker.
 */
export async function classifyLayer2(
  event: ClassifiableEvent,
  config: UpstreamConfig,
): Promise<RelevanceResult | null> {
  if (!canCallLayer2(config)) {
    return null
  }

  const deploymentContext = loadDeploymentContext(config)

  const prompt = buildPrompt(event, deploymentContext)

  try {
    state.callsThisPoll++
    state.callsToday++

    const anthropic = createAnthropic()
    const model = anthropic.languageModel(config.layer2.model)

    const result = await generateObject({
      model,
      schema: RELEVANCE_SCHEMA,
      prompt,
      maxOutputTokens: 300,
      temperature: 0,
    })

    // Success - reset circuit breaker
    state.consecutiveFailures = 0

    const level = result.object.level as RelevanceLevel
    const reasoning = result.object.reasoning

    log.debug("layer2 classified event", {
      title: event.title.slice(0, 80),
      level,
      reasoning: reasoning.slice(0, 100),
    })

    return {
      level,
      reasoning: `Layer 2: ${reasoning}`,
      layer: 2,
    }
  } catch (err) {
    state.consecutiveFailures++
    log.error("layer2 classification failed", {
      error: err,
      consecutiveFailures: state.consecutiveFailures,
      threshold: config.layer2.circuitBreakerThreshold,
    })

    if (state.consecutiveFailures >= config.layer2.circuitBreakerThreshold) {
      state.circuitOpen = true
      log.warn("layer2 circuit breaker opened after consecutive failures", {
        failures: state.consecutiveFailures,
      })
    }

    return null
  }
}

function buildPrompt(event: ClassifiableEvent, deploymentContext: string): string {
  const metadata = event.metadata
    ? Object.entries(event.metadata)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n")
    : "  (none)"

  return `You are classifying upstream open-source activity events for relevance to our deployment.

## Deployment Context
${deploymentContext}

## Event to Classify
Title: ${event.title}
Type: ${event.event_type}
Source: ${event.source}
Summary: ${event.summary ?? "(none)"}
Actor: ${event.actor ?? "(unknown)"}
Metadata:
${metadata}

## Classification Levels
- must-act: Security fixes, CVEs, breaking changes, critical bugs that require immediate attention
- review: Bug fixes, regressions, performance issues in components we use — worth reviewing soon
- watch: New features, enhancements, refactors — interesting but not urgent
- noise: CI changes, test-only changes, typos, changelog fragments — can be safely ignored

Classify this event. Be concise in your reasoning (1-2 sentences max).`
}

/** Get current Layer 2 state for diagnostics. */
export function getLayer2State(): Readonly<Layer2State> {
  return { ...state }
}

/** Reset state (for testing). */
export function resetLayer2State(): void {
  state = {
    consecutiveFailures: 0,
    circuitOpen: false,
    callsThisPoll: 0,
    callsToday: 0,
    todayDate: todayKey(),
  }
}
