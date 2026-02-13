export type CouncilPhase = "DISCUSSION" | "SECONDING" | "VOTING" | "CLOSED";

export type EventType =
  | "SESSION_STARTED"
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
  provider: "openai-compatible" | "openai" | "anthropic";
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
}

export interface CouncilMemberConfig {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  traits: string[];
  focusWeights: Record<string, number>;
  model: ModelConfig;
}

export interface CouncilConfig {
  councilName: string;
  purpose: string;
  maxRounds: number;
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

export interface SessionResult {
  sessionId: string;
  leaderId: string;
  endedBy: "MAJORITY_VOTE" | "ROUND_LIMIT";
  finalResolution: string;
  requiresExecution: boolean;
  executionApproved: boolean;
  artifacts: {
    sessionDir: string;
    transcriptFile: string;
    eventsFile: string;
    sessionStateFile: string;
    leaderSummaryFile: string;
    executionHandoffFile?: string;
  };
}
