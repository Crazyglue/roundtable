import {
  CouncilOutputType,
  CouncilConfig,
  CouncilMemberConfig,
  LeaderElectionBallot,
  LeaderSummary,
  PhaseContextPacket,
  PhaseGovernanceConfig,
  SecondingResponse,
  TurnAction,
  VoteResponse
} from "../types.js";
import { Motion } from "../types.js";

interface ParseErrorEnvelope {
  __errorType?: string;
  message?: string;
  raw?: string;
}

function getParseErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as ParseErrorEnvelope;
  if (candidate.__errorType !== "json_parse_error") {
    return undefined;
  }
  return typeof candidate.message === "string" && candidate.message.trim()
    ? candidate.message.trim()
    : "Model response was not valid JSON.";
}

export interface TurnPromptInput {
  config: CouncilConfig;
  member: CouncilMemberConfig;
  humanPrompt: string;
  transcript: string;
  memberMemory: string;
  phaseId: string;
  phaseGoal: string;
  phaseContext: PhaseContextPacket;
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
    `Current Phase: ${input.phaseId}`,
    `Phase Goal: ${input.phaseGoal}`,
    input.phaseContext.currentPhase.priorPhaseResolution
      ? `Prior phase resolution: ${input.phaseContext.currentPhase.priorPhaseResolution}`
      : undefined,
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
    "Phase guidance:",
    ...(input.phaseContext.currentPhase.promptGuidance.length > 0
      ? input.phaseContext.currentPhase.promptGuidance.map((item) => `- ${item}`)
      : ["- No extra guidance configured."]),
    "",
    "Current-phase guardrails:",
    "- Focus on the active phase goal, gates, and deliverables.",
    "- Do not produce outputs that belong to later phases unless explicitly required now.",
    "- If evidence requirements are unmet, call out concrete gaps before proposing closure.",
    "",
    "Phase Context Packet:",
    renderPhaseContextPacket(input.phaseContext),
    "",
    "Town-hall rules:",
    "- You may take exactly one action this turn: CONTRIBUTE, PASS, or CALL_VOTE.",
    "- If you CONTRIBUTE, provide your argument to influence the council.",
    "- If you PASS, provide a brief reason and optional note for the record.",
    "- If you CALL_VOTE, provide a clear motion and decision statement.",
    "",
    "Hard output limits:",
    "- CONTRIBUTE.message <= 1200 characters.",
    "- PASS.reason <= 220 characters; PASS.note <= 220 characters.",
    "- CALL_VOTE.motionTitle <= 140 characters; motionText <= 600 characters; decisionIfPass <= 300 characters.",
    "- Do not include any field beyond the schema.",
    "- Output a single JSON object on one line.",
    "- Do not include literal newline characters in string values; use \\n if needed.",
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
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderPhaseContextPacket(packet: PhaseContextPacket): string {
  const lines: string[] = [];
  lines.push(`- Verbosity: ${packet.verbosity}`);
  lines.push(
    `- Current: ${packet.currentPhase.id} (round ${packet.currentPhase.round}/${packet.currentPhase.maxRounds})`
  );
  lines.push(`- Goal: ${packet.currentPhase.goal}`);
  const deliverablesPending =
    packet.progressState.deliverablesPending.length > 0
      ? packet.progressState.deliverablesPending.join(", ")
      : "none";
  const gatesPending =
    packet.progressState.qualityGatesPending.length > 0
      ? packet.progressState.qualityGatesPending.join(", ")
      : "none";
  const evidenceGaps =
    packet.progressState.openEvidenceGaps.length > 0
      ? packet.progressState.openEvidenceGaps.join("; ")
      : "none";
  lines.push(`- Pending deliverables: ${deliverablesPending}`);
  lines.push(`- Pending quality gates: ${gatesPending}`);
  lines.push(`- Open evidence gaps: ${evidenceGaps}`);
  if (packet.transitionHints.length > 0) {
    lines.push(
      `- Legal next phases: ${packet.transitionHints
        .map((hint) => `${hint.to} (${hint.when})`)
        .join(", ")}`
    );
  } else {
    lines.push("- Legal next phases: none (session may close after this phase).");
  }

  if (packet.verbosity !== "minimal") {
    lines.push("- Graph digest:");
    for (const node of packet.graphDigest.nodes) {
      const transitions =
        node.transitions.length > 0
          ? node.transitions.map((transition) => `${transition.to}:${transition.when}`).join(", ")
          : "none";
      lines.push(`  - ${node.id}: ${node.goal} -> ${transitions}`);
    }
  }

  if (packet.verbosity === "full") {
    lines.push("- Full packet JSON:");
    lines.push(JSON.stringify(packet));
  }

  return lines.join("\n");
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
    "Output a single JSON object on one line.",
    "Do not include literal newline characters in string values; use \\n if needed.",
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
  transcript: string,
  phaseId: string,
  phaseGoal: string
): string {
  return [
    `Council Name: ${config.councilName}`,
    `You are ${member.name} (${member.id}).`,
    `Current Phase: ${phaseId}`,
    `Phase Goal: ${phaseGoal}`,
    "",
    "A motion has been called. Decide whether to second it.",
    `Motion title: ${motion.motionTitle}`,
    `Motion text: ${motion.motionText}`,
    `Decision if pass: ${motion.decisionIfPass}`,
    "",
    "Output JSON only:",
    "Output a single JSON object on one line.",
    "Do not include literal newline characters in string values; use \\n if needed.",
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
  transcript: string,
  phaseId: string,
  phaseGoal: string,
  governance: PhaseGovernanceConfig
): string {
  return [
    `Council Name: ${config.councilName}`,
    `You are ${member.name} (${member.id}).`,
    `Current Phase: ${phaseId}`,
    `Phase Goal: ${phaseGoal}`,
    "",
    "A motion has been seconded. Cast a blind ballot.",
    `Motion title: ${motion.motionTitle}`,
    `Motion text: ${motion.motionText}`,
    `Decision if pass: ${motion.decisionIfPass}`,
    "",
    `Voting rule: YES ratio must meet threshold ${governance.majorityThreshold.toFixed(2)} of full council.`,
    governance.abstainCountsAsNo
      ? "Abstain counts effectively as NO for the decision."
      : "Abstain is neutral and does not count as NO.",
    "",
    "Output JSON only:",
    "Output a single JSON object on one line.",
    "Do not include literal newline characters in string values; use \\n if needed.",
    '{"ballot":"YES","rationale":"..."}',
    '{"ballot":"NO","rationale":"..."}',
    '{"ballot":"ABSTAIN","rationale":"..."}',
    "",
    "Transcript context:",
    transcript
  ].join("\n");
}

export function buildContinuationVotePrompt(
  config: CouncilConfig,
  member: CouncilMemberConfig,
  phaseId: string,
  phaseGoal: string,
  currentResolution: string,
  nextPhaseId: string,
  transcript: string
): string {
  return [
    `Council Name: ${config.councilName}`,
    `You are ${member.name} (${member.id}).`,
    `Current Phase: ${phaseId}`,
    `Phase Goal: ${phaseGoal}`,
    "",
    `The ${phaseId} phase reached its round limit. A continuation vote has been called.`,
    `Current phase resolution: ${currentResolution}`,
    `Question: Should the council continue to the ${nextPhaseId} phase?`,
    "",
    "Vote YES only if there is enough aligned direction to proceed to implementation specifics.",
    "Vote NO if the session should end now.",
    "Voting rule: majority of FULL council is required. Abstain counts effectively as NO.",
    "",
    "Output JSON only:",
    "Output a single JSON object on one line.",
    "Do not include literal newline characters in string values; use \\n if needed.",
    '{"ballot":"YES","rationale":"..."}',
    '{"ballot":"NO","rationale":"..."}',
    '{"ballot":"ABSTAIN","rationale":"..."}',
    "",
    "Transcript context:",
    transcript
  ].join("\n");
}

export function buildDocumentApprovalVotePrompt(
  config: CouncilConfig,
  member: CouncilMemberConfig,
  draftMarkdown: string,
  revision: number
): string {
  return [
    `Council Name: ${config.councilName}`,
    `You are ${member.name} (${member.id}).`,
    "Stage: DOCUMENT_APPROVAL",
    `Draft revision: v${revision}`,
    "",
    "Vote on whether this draft should be approved as the final documentation artifact.",
    "Voting rule: majority of FULL council is required. Abstain counts effectively as NO.",
    "",
    "Output JSON only:",
    "Output a single JSON object on one line.",
    "Do not include literal newline characters in string values; use \\n if needed.",
    '{"ballot":"YES","rationale":"..."}',
    '{"ballot":"NO","rationale":"..."}',
    '{"ballot":"ABSTAIN","rationale":"..."}',
    "",
    "Draft:",
    draftMarkdown
  ].join("\n");
}

export function buildDocumentFeedbackPrompt(
  config: CouncilConfig,
  member: CouncilMemberConfig,
  draftMarkdown: string,
  revision: number
): string {
  return [
    `Council Name: ${config.councilName}`,
    `You are ${member.name} (${member.id}).`,
    "Stage: DOCUMENT_FEEDBACK",
    `Draft revision: v${revision}`,
    "",
    "The approval vote did not pass. Provide actionable feedback for the leader.",
    "Critical blockers are must-fix issues required for your approval.",
    "Suggested changes are non-blocking improvements.",
    "",
    "Output JSON only:",
    "Output a single JSON object on one line.",
    "Do not include literal newline characters in string values; use \\n if needed.",
    '{"criticalBlockers":[{"id":"B1","section":"...","problem":"...","impact":"...","requiredChange":"...","severity":"critical"}],"suggestedChanges":["..."]}',
    "Limits: max 5 criticalBlockers, max 6 suggestedChanges.",
    "",
    "Draft:",
    draftMarkdown
  ].join("\n");
}

export function buildDocumentRevisionPrompt(
  config: CouncilConfig,
  leader: CouncilMemberConfig,
  humanPrompt: string,
  phaseResolutionSummary: string,
  currentDraft: string,
  feedbackJson: string,
  revision: number
): string {
  return [
    `Council Name: ${config.councilName}`,
    `Purpose: ${config.purpose}`,
    `You are leader ${leader.name} (${leader.id}).`,
    "Stage: DOCUMENT_REVISION",
    `Write revision: v${revision}`,
    "",
    `Original task: ${humanPrompt}`,
    "Session phase resolutions:",
    phaseResolutionSummary,
    "",
    "Revise the documentation draft using council feedback.",
    "Output markdown only. No JSON.",
    "At top of the document, include section `## Revision Notes (vX)` mapping each blocker id to how it was resolved.",
    "Address all critical blockers explicitly. If a blocker cannot be fully resolved, state why and residual risk.",
    "",
    "Current draft:",
    currentDraft,
    "",
    "Feedback JSON:",
    feedbackJson
  ].join("\n");
}

export function buildLeaderSummaryPrompt(
  config: CouncilConfig,
  leader: CouncilMemberConfig,
  transcript: string,
  endedBy: string,
  finalResolution: string,
  outputType: CouncilOutputType
): string {
  const summaryConstraint =
    outputType === "documentation"
      ? '- summaryMarkdown must be a short description of the documentation file (1-2 sentences, <= 220 chars).'
      : "- summaryMarkdown <= 1800 characters.";

  return [
    `Council Name: ${config.councilName}`,
    `Purpose: ${config.purpose}`,
    `You are leader ${leader.name} (${leader.id}).`,
    "",
    `Ended by: ${endedBy}`,
    `Final resolution: ${finalResolution}`,
    "",
    "Write the final session entry as JSON only.",
    "Keep it concise. Avoid long prose and keep fields bounded.",
    "Hard limits:",
    summaryConstraint,
    "- finalResolution <= 300 characters.",
    "- If executionBrief is present: objective <= 240 chars; each list has max 5 items; each item <= 160 chars.",
    "- Output a single JSON object on one line.",
    "- Do not include literal newline characters in string values; use \\n if needed.",
    "Schema:",
    '{"summaryMarkdown":"...","finalResolution":"...","requiresExecution":true,"executionBrief":{"objective":"...","recommendedExecutorProfile":"...","steps":["..."],"risks":["..."],"acceptanceCriteria":["..."]}}',
    'If no execution is needed, set "requiresExecution" to false and omit executionBrief.',
    "",
    "Transcript:",
    transcript
  ].join("\n");
}

export function buildDocumentationOutputPrompt(
  config: CouncilConfig,
  leader: CouncilMemberConfig,
  humanPrompt: string,
  transcript: string,
  phaseResolutionSummary: string
): string {
  return [
    `Council Name: ${config.councilName}`,
    `Purpose: ${config.purpose}`,
    `You are leader ${leader.name} (${leader.id}).`,
    "",
    `Original task: ${humanPrompt}`,
    "Session phase resolutions:",
    phaseResolutionSummary,
    "",
    "Generate a complete markdown document from the council discussion.",
    "Output markdown only. No JSON.",
    "Do not assume scale targets that were not in the task.",
    "List known risks explicitly. For each risk include: why it matters, likely trigger, impact, and mitigation.",
    "Adapt section names to the task while keeping this minimum structure:",
    "1. # System Design",
    "2. ## Executive Summary",
    "3. ## High-Level Plan",
    "4. ## Acceptance Criteria",
    "5. ## Implementation Plan",
    "6. ## Technology Decisions and Tradeoffs",
    "7. ## API and Control Surface",
    "8. ## Data and State Model",
    "9. ## Known Risks and Mitigations",
    "10. ## Failure Handling and Operations",
    "11. ## Rollout Plan",
    "",
    "Transcript:",
    transcript
  ].join("\n");
}

export function normalizeTurnAction(value: unknown): TurnAction {
  const parseError = getParseErrorMessage(value);
  if (parseError) {
    return {
      action: "PASS",
      reason: `Model JSON parse error: ${parseError}`,
      note: "Auto-converted to PASS to preserve deterministic flow."
    };
  }

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
  const parseError = getParseErrorMessage(value);
  if (parseError) {
    return { second: false, rationale: `Model JSON parse error: ${parseError}` };
  }

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
  const parseError = getParseErrorMessage(value);
  if (parseError) {
    return { ballot: "ABSTAIN", rationale: `Model JSON parse error: ${parseError}` };
  }

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
  const parseError = getParseErrorMessage(value);
  if (parseError) {
    const fallbackCandidateId = Array.from(memberIds)[0] ?? "";
    return {
      candidateId: fallbackCandidateId,
      rationale: `Model JSON parse error: ${parseError}`
    };
  }

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

export function normalizeLeaderSummary(
  value: unknown,
  fallbackResolution: string,
  outputType: CouncilOutputType
): LeaderSummary {
  const parseError = getParseErrorMessage(value);
  if (parseError) {
    const summaryMarkdown =
      outputType === "documentation"
        ? `See session documentation for full details. Resolution: ${fallbackResolution}`.slice(0, 220)
        : `- Leader summary parse error: ${parseError}\n- Final resolution: ${fallbackResolution}`;
    return {
      summaryMarkdown,
      finalResolution: fallbackResolution,
      requiresExecution: false
    };
  }

  const candidate = value as Partial<LeaderSummary>;
  if (typeof candidate.summaryMarkdown !== "string" || !candidate.summaryMarkdown.trim()) {
    return {
      summaryMarkdown: `- Final resolution: ${fallbackResolution}`,
      finalResolution: fallbackResolution,
      requiresExecution: false
    };
  }

  return {
    summaryMarkdown:
      outputType === "documentation"
        ? candidate.summaryMarkdown.trim().slice(0, 220)
        : candidate.summaryMarkdown.trim(),
    finalResolution:
      typeof candidate.finalResolution === "string" && candidate.finalResolution.trim()
        ? candidate.finalResolution.trim()
        : fallbackResolution,
    requiresExecution: Boolean(candidate.requiresExecution),
    executionBrief: candidate.executionBrief
  };
}
