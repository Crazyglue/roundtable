import {
  CouncilConfig,
  CouncilMemberConfig,
  LeaderElectionBallot,
  LeaderSummary,
  SecondingResponse,
  TurnAction,
  VoteResponse
} from "../types.js";
import { Motion } from "../types.js";

export interface TurnPromptInput {
  config: CouncilConfig;
  member: CouncilMemberConfig;
  humanPrompt: string;
  transcript: string;
  memberMemory: string;
  currentRound: number;
  maxRounds: number;
  turnsRemainingForSpeaker: number;
}

export function buildTurnPrompt(input: TurnPromptInput): string {
  const lastChance =
    input.turnsRemainingForSpeaker === 1
      ? "This is your last scheduled turn. Make your strongest argument now if needed."
      : "You will have more turns after this.";

  return [
    `Council Name: ${input.config.councilName}`,
    `Council Purpose: ${input.config.purpose}`,
    `Task Prompt: ${input.humanPrompt}`,
    "",
    `You are: ${input.member.name} (${input.member.id})`,
    `Role: ${input.member.role}`,
    `Traits: ${input.member.traits.join(", ")}`,
    `Focus Weights: ${JSON.stringify(input.member.focusWeights)}`,
    "",
    `Round: ${input.currentRound}/${input.maxRounds}`,
    `Turns remaining for you (including this turn): ${input.turnsRemainingForSpeaker}`,
    lastChance,
    "",
    "Town-hall rules:",
    "- You may take exactly one action this turn: CONTRIBUTE, PASS, or CALL_VOTE.",
    "- If you CONTRIBUTE, provide your argument to influence the council.",
    "- If you PASS, provide a brief reason and optional note for the record.",
    "- If you CALL_VOTE, provide a clear motion and decision statement.",
    "",
    "Output MUST be valid JSON only. No markdown.",
    "Schemas:",
    '{"action":"CONTRIBUTE","message":"..."}',
    '{"action":"PASS","reason":"...","note":"optional"}',
    '{"action":"CALL_VOTE","motionTitle":"...","motionText":"...","decisionIfPass":"..."}',
    "",
    "Recent Transcript:",
    input.transcript,
    "",
    "Your Memory:",
    input.memberMemory
  ].join("\n");
}

export function buildLeaderElectionPrompt(
  config: CouncilConfig,
  member: CouncilMemberConfig,
  transcript: string
): string {
  return [
    `Council Name: ${config.councilName}`,
    `Purpose: ${config.purpose}`,
    `You are ${member.name} (${member.id}).`,
    "",
    "Elect one leader for this session.",
    "Choose the best mediator for convergence and fairness.",
    `Candidate IDs: ${config.members.map((m) => m.id).join(", ")}`,
    "Output JSON only:",
    '{"candidateId":"member-id","rationale":"..."}',
    "",
    "Transcript context:",
    transcript
  ].join("\n");
}

export function buildSecondingPrompt(
  config: CouncilConfig,
  member: CouncilMemberConfig,
  motion: Motion,
  transcript: string
): string {
  return [
    `Council Name: ${config.councilName}`,
    `You are ${member.name} (${member.id}).`,
    "",
    "A motion has been called. Decide whether to second it.",
    `Motion title: ${motion.motionTitle}`,
    `Motion text: ${motion.motionText}`,
    `Decision if pass: ${motion.decisionIfPass}`,
    "",
    "Output JSON only:",
    '{"second":true,"rationale":"..."}',
    '{"second":false,"rationale":"..."}',
    "",
    "Transcript context:",
    transcript
  ].join("\n");
}

export function buildVotePrompt(
  config: CouncilConfig,
  member: CouncilMemberConfig,
  motion: Motion,
  transcript: string
): string {
  return [
    `Council Name: ${config.councilName}`,
    `You are ${member.name} (${member.id}).`,
    "",
    "A motion has been seconded. Cast a blind ballot.",
    `Motion title: ${motion.motionTitle}`,
    `Motion text: ${motion.motionText}`,
    `Decision if pass: ${motion.decisionIfPass}`,
    "",
    "Voting rule: majority of FULL council is required. Abstain counts effectively as NO.",
    "",
    "Output JSON only:",
    '{"ballot":"YES","rationale":"..."}',
    '{"ballot":"NO","rationale":"..."}',
    '{"ballot":"ABSTAIN","rationale":"..."}',
    "",
    "Transcript context:",
    transcript
  ].join("\n");
}

export function buildLeaderSummaryPrompt(
  config: CouncilConfig,
  leader: CouncilMemberConfig,
  transcript: string,
  endedBy: string,
  finalResolution: string
): string {
  return [
    `Council Name: ${config.councilName}`,
    `Purpose: ${config.purpose}`,
    `You are leader ${leader.name} (${leader.id}).`,
    "",
    `Ended by: ${endedBy}`,
    `Final resolution: ${finalResolution}`,
    "",
    "Write the final session entry as JSON only.",
    "Schema:",
    '{"summaryMarkdown":"...","finalResolution":"...","requiresExecution":true,"executionBrief":{"objective":"...","recommendedExecutorProfile":"...","steps":["..."],"risks":["..."],"acceptanceCriteria":["..."]}}',
    'If no execution is needed, set "requiresExecution" to false and omit executionBrief.',
    "",
    "Transcript:",
    transcript
  ].join("\n");
}

export function buildMemberSummaryPrompt(
  member: CouncilMemberConfig,
  transcript: string,
  finalResolution: string
): string {
  return [
    `You are ${member.name} (${member.id}).`,
    `Role: ${member.role}`,
    `Traits: ${member.traits.join(", ")}`,
    "",
    "Create a concise MEMORY.md session summary from your perspective.",
    "Include: what mattered, why you voted as you did, and what to watch next.",
    `Final resolution: ${finalResolution}`,
    "",
    "Output plain markdown (no JSON).",
    "",
    "Transcript:",
    transcript
  ].join("\n");
}

export function normalizeTurnAction(value: unknown): TurnAction {
  const candidate = value as Partial<TurnAction>;
  if (candidate.action === "CONTRIBUTE" && typeof candidate.message === "string" && candidate.message.trim()) {
    return { action: "CONTRIBUTE", message: candidate.message.trim() };
  }
  if (candidate.action === "PASS" && typeof candidate.reason === "string" && candidate.reason.trim()) {
    return {
      action: "PASS",
      reason: candidate.reason.trim(),
      note: typeof candidate.note === "string" && candidate.note.trim() ? candidate.note.trim() : undefined
    };
  }
  if (
    candidate.action === "CALL_VOTE" &&
    typeof candidate.motionTitle === "string" &&
    typeof candidate.motionText === "string" &&
    typeof candidate.decisionIfPass === "string" &&
    candidate.motionTitle.trim() &&
    candidate.motionText.trim() &&
    candidate.decisionIfPass.trim()
  ) {
    return {
      action: "CALL_VOTE",
      motionTitle: candidate.motionTitle.trim(),
      motionText: candidate.motionText.trim(),
      decisionIfPass: candidate.decisionIfPass.trim()
    };
  }
  return {
    action: "PASS",
    reason: "Invalid response format from model.",
    note: "Auto-converted to PASS to preserve deterministic flow."
  };
}

export function normalizeSecondingResponse(value: unknown): SecondingResponse {
  const candidate = value as Partial<SecondingResponse>;
  if (typeof candidate.second !== "boolean") {
    return { second: false, rationale: "Invalid response format." };
  }
  return {
    second: candidate.second,
    rationale: typeof candidate.rationale === "string" && candidate.rationale.trim() ? candidate.rationale.trim() : "No rationale provided."
  };
}

export function normalizeVoteResponse(value: unknown): VoteResponse {
  const candidate = value as Partial<VoteResponse>;
  const ballot = candidate.ballot;
  if (ballot !== "YES" && ballot !== "NO" && ballot !== "ABSTAIN") {
    return { ballot: "ABSTAIN", rationale: "Invalid response format." };
  }
  return {
    ballot,
    rationale: typeof candidate.rationale === "string" && candidate.rationale.trim() ? candidate.rationale.trim() : "No rationale provided."
  };
}

export function normalizeLeaderElectionBallot(
  value: unknown,
  memberIds: Set<string>
): LeaderElectionBallot {
  const candidate = value as Partial<LeaderElectionBallot>;
  const fallbackCandidateId = Array.from(memberIds)[0] ?? "";
  if (!candidate.candidateId || !memberIds.has(candidate.candidateId)) {
    return {
      candidateId: fallbackCandidateId,
      rationale: "Invalid candidate. Defaulted to first member."
    };
  }
  return {
    candidateId: candidate.candidateId,
    rationale:
      typeof candidate.rationale === "string" && candidate.rationale.trim()
        ? candidate.rationale.trim()
        : "No rationale provided."
  };
}

export function normalizeLeaderSummary(value: unknown, fallbackResolution: string): LeaderSummary {
  const candidate = value as Partial<LeaderSummary>;
  if (typeof candidate.summaryMarkdown !== "string" || !candidate.summaryMarkdown.trim()) {
    return {
      summaryMarkdown: `- Final resolution: ${fallbackResolution}`,
      finalResolution: fallbackResolution,
      requiresExecution: false
    };
  }

  return {
    summaryMarkdown: candidate.summaryMarkdown.trim(),
    finalResolution:
      typeof candidate.finalResolution === "string" && candidate.finalResolution.trim()
        ? candidate.finalResolution.trim()
        : fallbackResolution,
    requiresExecution: Boolean(candidate.requiresExecution),
    executionBrief: candidate.executionBrief
  };
}
