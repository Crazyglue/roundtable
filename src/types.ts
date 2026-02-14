export type CouncilPhase = "DISCUSSION" | "SECONDING" | "VOTING" | "CLOSED";

export type EventType =
  | "SESSION_STARTED"
  | "PASS_STARTED"
  | "PASS_COMPLETED"
  | "CONTINUATION_VOTE_CALLED"
  | "CONTINUATION_VOTE_RESULT"
  | "DOCUMENT_DRAFT_WRITTEN"
  | "DOCUMENT_APPROVAL_VOTE_CALLED"
  | "DOCUMENT_APPROVAL_VOTE_RESULT"
  | "DOCUMENT_FEEDBACK_SUBMITTED"
  | "DOCUMENT_REVISION_WRITTEN"
  | "LEADER_ELECTION_BALLOT"
  | "LEADER_ELECTED"
  | "ROUND_STARTED"
  | "TURN_ACTION"
  | "MESSAGE_CONTRIBUTED"
  | "PASS_RECORDED"
  | "MOTION_CALLED"
  | "SECONDING_RESPONSE"
  | "MOTION_SECONDED"
  | "MOTION_NOT_SECONDED"
  | "VOTE_CAST"
  | "VOTE_RESULT"
  | "ROUND_LIMIT_REACHED"
  | "LEADER_SUMMARY"
  | "OUTPUT_ARTIFACT_WRITTEN"
  | "SESSION_CLOSED";

export type TurnActionType = "CONTRIBUTE" | "PASS" | "CALL_VOTE";

export interface TurnActionContribute {
  action: "CONTRIBUTE";
  message: string;
}

export interface TurnActionPass {
  action: "PASS";
  reason: string;
  note?: string;
}

export interface TurnActionCallVote {
  action: "CALL_VOTE";
  motionTitle: string;
  motionText: string;
  decisionIfPass: string;
}

export type TurnAction = TurnActionContribute | TurnActionPass | TurnActionCallVote;

export interface Motion {
  motionId: string;
  motionTitle: string;
  motionText: string;
  decisionIfPass: string;
  calledBy: string;
  round: number;
  turnIndex: number;
}

export interface SecondingResponse {
  second: boolean;
  rationale: string;
}

export type Ballot = "YES" | "NO" | "ABSTAIN";

export interface VoteResponse {
  ballot: Ballot;
  rationale: string;
}

export interface LeaderElectionBallot {
  candidateId: string;
  rationale: string;
}

export interface LeaderSummary {
  summaryMarkdown: string;
  finalResolution: string;
  requiresExecution: boolean;
  executionBrief?: {
    objective: string;
    recommendedExecutorProfile: string;
    steps: string[];
    risks: string[];
    acceptanceCriteria: string[];
  };
}

export interface CouncilEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  phase: CouncilPhase;
  type: EventType;
  round: number;
  turnIndex: number;
  actorId?: string;
  payload: unknown;
}

export interface ModelConfig {
  provider:
    | "openai-compatible"
    | "openai"
    | "anthropic"
    | "openai-codex"
    | (string & {});
  model: string;
  apiKeyEnv?: string;
  auth?: ModelAuthConfig;
  api?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
}

export interface ApiKeyEnvAuthConfig {
  method: "api-key-env";
  apiKeyEnv: string;
}

export interface OauthDeviceCodeAuthConfig {
  method: "oauth-device-code";
  clientId: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  scopes?: string[];
  audience?: string;
  cacheKey?: string;
  tokenStorePath?: string;
}

export interface CommandAuthConfig {
  method: "command";
  command: string;
  cacheKey?: string;
  cacheTtlSeconds?: number;
  tokenStorePath?: string;
}

export interface CredentialRefAuthConfig {
  method: "credential-ref";
  credentialId: string;
}

export type ModelAuthConfig =
  | ApiKeyEnvAuthConfig
  | OauthDeviceCodeAuthConfig
  | CommandAuthConfig
  | CredentialRefAuthConfig;

export interface CouncilMemberConfig {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  traits: string[];
  focusWeights: Record<string, number>;
  model: ModelConfig;
}

export type CouncilOutputType = "none" | "documentation";

export type PhaseContextVerbosity = "minimal" | "standard" | "full";
export type PhaseTransitionTrigger = "MAJORITY_VOTE" | "ROUND_LIMIT" | "ALWAYS";
export type PhaseFallbackAction = "END_SESSION" | "TRANSITION";

export interface PhaseDeliverableConfig {
  id: string;
  description: string;
  required: boolean;
}

export interface PhaseGovernanceConfig {
  requireSeconding: boolean;
  majorityThreshold: number;
  abstainCountsAsNo: boolean;
}

export interface PhaseStopConditionsConfig {
  maxRounds: number;
  endOnMajorityVote: boolean;
}

export interface PhaseMemoryPolicyConfig {
  readMemberMemory: boolean;
  writeMemberMemory: boolean;
  writeCouncilMemory: boolean;
  includePriorPhaseSummary: boolean;
}

export interface PhaseEvidenceRequirementsConfig {
  minCitations: number;
  requireExplicitAssumptions: boolean;
  requireRiskRegister: boolean;
}

export interface PhaseFallbackConfig {
  resolution: string;
  action: PhaseFallbackAction;
  transitionToPhaseId?: string;
}

export interface PhaseTransitionConfig {
  to: string;
  when: PhaseTransitionTrigger;
  reason?: string;
  priority: number;
}

export interface CouncilSessionPhaseConfig {
  id: string;
  goal: string;
  promptGuidance: string[];
  deliverables: PhaseDeliverableConfig[];
  governance: PhaseGovernanceConfig;
  stopConditions: PhaseStopConditionsConfig;
  memoryPolicy: PhaseMemoryPolicyConfig;
  evidenceRequirements: PhaseEvidenceRequirementsConfig;
  qualityGates: string[];
  fallback: PhaseFallbackConfig;
  transitions: PhaseTransitionConfig[];
}

export interface SessionPolicyConfig {
  entryPhaseId: string;
  maxPhaseTransitions: number;
  phaseContextVerbosity: PhaseContextVerbosity;
}

export interface DocumentationReviewConfig {
  maxRevisionRounds: number;
}

export interface OutputConfig {
  type: CouncilOutputType;
}

export interface CouncilConfig {
  councilName: string;
  purpose: string;
  sessionPolicy: SessionPolicyConfig;
  phases: CouncilSessionPhaseConfig[];
  output: OutputConfig;
  documentationReview: DocumentationReviewConfig;
  members: CouncilMemberConfig[];
  turnOrder?: string[];
  storage: {
    rootDir: string;
    memoryDir: string;
  };
  execution: {
    requireHumanApproval: boolean;
    defaultExecutorProfile: string;
  };
}

export interface SessionRunOptions {
  humanPrompt: string;
  approveExecution: boolean;
}

export interface PhaseContextCurrentPhase {
  id: string;
  goal: string;
  round: number;
  maxRounds: number;
  deliverables: PhaseDeliverableConfig[];
  qualityGates: string[];
  stopConditions: PhaseStopConditionsConfig;
  evidenceRequirements: PhaseEvidenceRequirementsConfig;
  promptGuidance: string[];
  priorPhaseResolution?: string;
}

export interface PhaseContextGraphNodeDigest {
  id: string;
  goal: string;
  transitions: {
    to: string;
    when: PhaseTransitionTrigger;
  }[];
}

export interface PhaseContextProgressState {
  roundsUsed: number;
  deliverablesComplete: string[];
  deliverablesPending: string[];
  qualityGatesPassed: string[];
  qualityGatesPending: string[];
  openEvidenceGaps: string[];
}

export interface PhaseContextPacket {
  verbosity: PhaseContextVerbosity;
  currentPhase: PhaseContextCurrentPhase;
  graphDigest: {
    entryPhaseId: string;
    nodes: PhaseContextGraphNodeDigest[];
  };
  progressState: PhaseContextProgressState;
  transitionHints: {
    to: string;
    when: PhaseTransitionTrigger;
    reason?: string;
  }[];
}

export interface SessionResult {
  sessionId: string;
  leaderId: string;
  endedBy: "MAJORITY_VOTE" | "ROUND_LIMIT";
  finalResolution: string;
  requiresExecution: boolean;
  executionApproved: boolean;
  documentationApproved?: boolean;
  outputType: CouncilOutputType;
  artifacts: {
    sessionDir: string;
    transcriptFile: string;
    eventsFile: string;
    sessionStateFile: string;
    leaderSummaryFile: string;
    executionHandoffFile?: string;
    outputDocumentFile?: string;
  };
}
