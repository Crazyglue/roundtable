import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildModelClient } from "../models/factory.js";
import {
  completeJson,
  CompletionOptions,
  JsonResponseParseError,
  ModelClient
} from "../models/modelClient.js";
import {
  Ballot,
  CouncilConfig,
  CouncilEvent,
  CouncilMemberConfig,
  CouncilOutputType,
  CouncilPhase,
  CouncilSessionPhaseConfig,
  LeaderElectionBallot,
  LeaderSummary,
  Motion,
  PhaseContextGraphNodeDigest,
  PhaseContextPacket,
  PhaseGovernanceConfig,
  PhaseTransitionConfig,
  SessionResult,
  SessionRunOptions,
  TurnAction,
  VoteResponse
} from "../types.js";
import { makeId, nowIso, sortByStableOrder, toJsonString } from "../utils.js";
import { MemoryStore } from "../storage/memoryStore.js";
import { SessionRecorder } from "../storage/sessionRecorder.js";
import {
  buildDocumentApprovalVotePrompt,
  buildDocumentFeedbackPrompt,
  buildDocumentRevisionPrompt,
  buildDocumentationOutputPrompt,
  buildLeaderElectionPrompt,
  buildLeaderSummaryPrompt,
  buildSecondingPrompt,
  buildTurnPrompt,
  buildVotePrompt,
  normalizeLeaderElectionBallot,
  normalizeLeaderSummary,
  normalizeSecondingResponse,
  normalizeTurnAction,
  normalizeVoteResponse
} from "./prompts.js";

interface DeliberationPhaseResult {
  phaseId: string;
  phaseGoal: string;
  endedBy: SessionResult["endedBy"];
  finalResolution: string;
  winningMotion?: Motion;
  roundsCompleted: number;
}

interface RuntimeState {
  phase: CouncilPhase;
  turnIndex: number;
}

interface DocumentCriticalBlocker {
  id: string;
  section: string;
  problem: string;
  impact: string;
  requiredChange: string;
  severity: "critical" | "major";
}

interface DocumentReviewFeedback {
  memberId: string;
  criticalBlockers: DocumentCriticalBlocker[];
  suggestedChanges: string[];
}

interface ApprovalVotePair {
  memberId: string;
  vote: VoteResponse;
}

interface VotePassResult {
  passed: boolean;
  yesVotes: number;
  noVotesEffective: number;
}

interface DocumentApprovalVoteResult extends VotePassResult {
  votePairs: ApprovalVotePair[];
}

interface DocumentationApprovalOutcome {
  approved: boolean;
  outputDocumentFile: string;
}

export class CouncilOrchestrator {
  private readonly modelClients: Map<string, ModelClient>;
  private readonly memberById: Map<string, CouncilMemberConfig>;
  private readonly phaseById: Map<string, CouncilSessionPhaseConfig>;

  constructor(private readonly config: CouncilConfig) {
    this.memberById = new Map(config.members.map((member) => [member.id, member]));
    this.phaseById = new Map(config.phases.map((phase) => [phase.id, phase]));
    this.modelClients = new Map(
      config.members.map((member) => [member.id, buildModelClient(member.model)])
    );
  }

  async run(options: SessionRunOptions): Promise<SessionResult> {
    const outputType: CouncilOutputType = this.config.output.type;
    await mkdir(this.config.storage.rootDir, { recursive: true });
    await mkdir(this.config.storage.memoryDir, { recursive: true });

    const sessionId = makeId("session");
    const memoryStore = new MemoryStore(this.config);
    await memoryStore.init(this.config.members);

    const recorder = new SessionRecorder(this.config, sessionId);
    await recorder.init(options.humanPrompt);

    const state: RuntimeState = { phase: "DISCUSSION", turnIndex: 0 };
    let eventCounter = 0;
    const appendEvent = async (
      type: CouncilEvent["type"],
      round: number,
      payload: unknown,
      actorId?: string
    ): Promise<void> => {
      eventCounter += 1;
      const event: CouncilEvent = {
        id: `evt_${eventCounter}`,
        sessionId,
        timestamp: nowIso(),
        phase: state.phase,
        type,
        round,
        turnIndex: state.turnIndex,
        actorId,
        payload
      };
      await recorder.appendEvent(event);
    };

    await appendEvent("SESSION_STARTED", 0, {
      humanPrompt: options.humanPrompt,
      sessionPolicy: this.config.sessionPolicy,
      phases: this.config.phases.map((phase) => ({
        id: phase.id,
        goal: phase.goal,
        maxRounds: phase.stopConditions.maxRounds
      })),
      votingRule: "configurable_majority_threshold",
      blindVoting: true,
      outputType
    });

    const turnOrder = this.resolveTurnOrder();
    const leaderId = await this.electLeader(sessionId, recorder, appendEvent);
    const leader = this.requireMember(leaderId);

    const phaseResults: DeliberationPhaseResult[] = [];
    let priorPhaseResolution: string | undefined;
    let nextPhaseId: string | undefined = this.config.sessionPolicy.entryPhaseId;
    let forcedStopReason: string | undefined;

    while (nextPhaseId) {
      if (phaseResults.length >= this.config.sessionPolicy.maxPhaseTransitions) {
        forcedStopReason = `Session stopped at maxPhaseTransitions=${this.config.sessionPolicy.maxPhaseTransitions} before entering phase ${nextPhaseId}.`;
        break;
      }

      const phaseConfig = this.requirePhase(nextPhaseId);
      const result = await this.runDeliberationPhase({
        phaseConfig,
        priorPhaseResolution,
        sessionId,
        humanPrompt: options.humanPrompt,
        turnOrder,
        recorder,
        memoryStore,
        appendEvent,
        state
      });
      phaseResults.push(result);

      const transition = this.resolveNextPhaseTransition(phaseConfig, result.endedBy);
      if (!transition) {
        break;
      }
      priorPhaseResolution = result.finalResolution;
      nextPhaseId = transition.to;
    }

    if (phaseResults.length === 0) {
      throw new Error("Session terminated before running any configured phase.");
    }

    const latestPhase = phaseResults[phaseResults.length - 1];
    const terminalResult: DeliberationPhaseResult = forcedStopReason
      ? {
          ...latestPhase,
          endedBy: "ROUND_LIMIT",
          finalResolution: forcedStopReason
        }
      : latestPhase;

    state.phase = "CLOSED";
    const totalRoundsExecuted = phaseResults.reduce((sum, result) => sum + result.roundsCompleted, 0);

    const leaderSummaryPrompt = buildLeaderSummaryPrompt(
      this.config,
      leader,
      recorder.getTranscript(),
      terminalResult.endedBy,
      terminalResult.finalResolution,
      outputType
    );

    const leaderSummaryRaw = await this.completeJsonSafe<LeaderSummary>(
      this.requireClient(leaderId),
      leader.systemPrompt,
      leaderSummaryPrompt,
      { temperature: leader.model.temperature, maxTokens: leader.model.maxTokens },
      {
        stage: "leader_summary",
        sessionId,
        memberId: leaderId,
        round: totalRoundsExecuted,
        turnIndex: state.turnIndex
      }
    );
    const leaderSummary = normalizeLeaderSummary(
      leaderSummaryRaw,
      terminalResult.finalResolution,
      outputType
    );

    await appendEvent("LEADER_SUMMARY", totalRoundsExecuted, leaderSummary, leaderId);
    await recorder.writeLeaderSummary(leaderSummary.summaryMarkdown);

    const phaseResolutionSummary = this.buildPhaseResolutionSummary(phaseResults);
    let outputDocumentFile: string | undefined;
    let documentationApproved: boolean | undefined;
    if (outputType === "documentation") {
      const docOutcome = await this.runDocumentationApprovalLoop({
        sessionId,
        leader,
        humanPrompt: options.humanPrompt,
        phaseResolutionSummary,
        recorder,
        appendEvent,
        state
      });
      outputDocumentFile = docOutcome.outputDocumentFile;
      documentationApproved = docOutcome.approved;
      await appendEvent(
        "OUTPUT_ARTIFACT_WRITTEN",
        totalRoundsExecuted,
        { outputType, file: outputDocumentFile, approved: documentationApproved },
        leaderId
      );
    }

    const executionApproved =
      !this.config.execution.requireHumanApproval || options.approveExecution;

    const artifacts = recorder.getArtifacts();
    let executionHandoffFile: string | undefined;
    if (leaderSummary.requiresExecution && leaderSummary.executionBrief) {
      executionHandoffFile = path.join(artifacts.sessionDir, "execution-handoff.json");
      const handoffPayload = {
        sessionId,
        approved: executionApproved,
        approvalRequired: this.config.execution.requireHumanApproval,
        defaultExecutorProfile: this.config.execution.defaultExecutorProfile,
        motionId: terminalResult.winningMotion?.motionId ?? null,
        leaderId,
        executionBrief: leaderSummary.executionBrief
      };
      await writeFile(executionHandoffFile, `${toJsonString(handoffPayload)}\n`, "utf8");
    }

    await appendEvent("SESSION_CLOSED", totalRoundsExecuted, {
      endedBy: terminalResult.endedBy,
      finalResolution: leaderSummary.finalResolution,
      requiresExecution: leaderSummary.requiresExecution,
      executionApproved,
      documentationApproved: documentationApproved ?? null,
      outputType
    });

    const shouldWriteMemory = phaseResults.some((result) => {
      const phase = this.requirePhase(result.phaseId);
      return phase.memoryPolicy.writeCouncilMemory || phase.memoryPolicy.writeMemberMemory;
    });

    if (shouldWriteMemory) {
      await memoryStore.recordSession({
        sessionId,
        humanPrompt: options.humanPrompt,
        leaderId,
        endedBy: terminalResult.endedBy,
        finalResolution: leaderSummary.finalResolution,
        outputType,
        leaderSummary,
        events: recorder.getEvents(),
        executionApproved
      });
    }

    await recorder.finalize({
      sessionId,
      councilName: this.config.councilName,
      leaderId,
      sessionPolicy: this.config.sessionPolicy,
      phaseResults,
      transitionLimitReached: Boolean(forcedStopReason),
      endedBy: terminalResult.endedBy,
      finalResolution: leaderSummary.finalResolution,
      requiresExecution: leaderSummary.requiresExecution,
      executionApproved,
      documentationApproved: documentationApproved ?? null,
      winningMotion: terminalResult.winningMotion,
      outputType,
      outputDocumentFile
    });

    return {
      sessionId,
      leaderId,
      endedBy: terminalResult.endedBy,
      finalResolution: leaderSummary.finalResolution,
      requiresExecution: leaderSummary.requiresExecution,
      executionApproved,
      documentationApproved,
      outputType,
      artifacts: {
        ...artifacts,
        executionHandoffFile,
        outputDocumentFile
      }
    };
  }

  private async runDeliberationPhase(input: {
    phaseConfig: CouncilSessionPhaseConfig;
    priorPhaseResolution?: string;
    sessionId: string;
    humanPrompt: string;
    turnOrder: string[];
    recorder: SessionRecorder;
    memoryStore: MemoryStore;
    appendEvent: (
      type: CouncilEvent["type"],
      round: number,
      payload: unknown,
      actorId?: string
    ) => Promise<void>;
    state: RuntimeState;
  }): Promise<DeliberationPhaseResult> {
    const {
      phaseConfig,
      priorPhaseResolution,
      sessionId,
      humanPrompt,
      turnOrder,
      recorder,
      memoryStore,
      appendEvent,
      state
    } = input;

    await appendEvent("PASS_STARTED", 0, {
      passId: phaseConfig.id,
      objective: phaseConfig.goal,
      maxRounds: phaseConfig.stopConditions.maxRounds,
      deliverables: phaseConfig.deliverables,
      qualityGates: phaseConfig.qualityGates,
      priorPhaseResolution: priorPhaseResolution ?? null
    });

    let closed = false;
    let endedBy: SessionResult["endedBy"] = "ROUND_LIMIT";
    let finalResolution = phaseConfig.fallback.resolution;
    let winningMotion: Motion | undefined;
    let roundsCompleted = 0;

    for (
      let round = 1;
      round <= phaseConfig.stopConditions.maxRounds && !closed;
      round += 1
    ) {
      roundsCompleted = round;
      await appendEvent("ROUND_STARTED", round, {
        passId: phaseConfig.id,
        objective: phaseConfig.goal,
        round,
        maxRounds: phaseConfig.stopConditions.maxRounds,
        turnOrder
      });

      for (const speakerId of turnOrder) {
        if (closed) {
          break;
        }

        state.turnIndex += 1;
        state.phase = "DISCUSSION";

        const speaker = this.requireMember(speakerId);
        const client = this.requireClient(speakerId);
        const turnsRemainingForSpeaker = phaseConfig.stopConditions.maxRounds - round + 1;
        const phaseContext = this.buildPhaseContextPacket({
          phaseConfig,
          currentRound: round,
          priorPhaseResolution:
            phaseConfig.memoryPolicy.includePriorPhaseSummary ? priorPhaseResolution : undefined
        });

        const memberMemory = phaseConfig.memoryPolicy.readMemberMemory
          ? await memoryStore.readMemberMemory(speaker.id)
          : "Member memory access disabled for this phase.";

        const turnPrompt = buildTurnPrompt({
          config: this.config,
          member: speaker,
          humanPrompt,
          transcript: recorder.getTranscript(),
          memberMemory,
          phaseId: phaseConfig.id,
          phaseGoal: phaseConfig.goal,
          phaseContext,
          currentRound: round,
          maxRounds: phaseConfig.stopConditions.maxRounds,
          turnsRemainingForSpeaker
        });

        const actionRaw = await this.completeJsonSafe<TurnAction>(
          client,
          speaker.systemPrompt,
          turnPrompt,
          { temperature: speaker.model.temperature, maxTokens: speaker.model.maxTokens },
          {
            stage: "turn_action",
            sessionId,
            memberId: speaker.id,
            round,
            turnIndex: state.turnIndex
          }
        );
        const action = normalizeTurnAction(actionRaw);
        await appendEvent("TURN_ACTION", round, { ...action, passId: phaseConfig.id }, speaker.id);

        if (action.action === "CONTRIBUTE") {
          await appendEvent(
            "MESSAGE_CONTRIBUTED",
            round,
            { message: action.message, passId: phaseConfig.id },
            speaker.id
          );
          continue;
        }

        if (action.action === "PASS") {
          await appendEvent(
            "PASS_RECORDED",
            round,
            { reason: action.reason, note: action.note ?? null, passId: phaseConfig.id },
            speaker.id
          );
          continue;
        }

        const motion: Motion = {
          motionId: makeId("motion"),
          motionTitle: action.motionTitle,
          motionText: action.motionText,
          decisionIfPass: action.decisionIfPass,
          calledBy: speaker.id,
          round,
          turnIndex: state.turnIndex
        };

        await appendEvent("MOTION_CALLED", round, { ...motion, passId: phaseConfig.id }, speaker.id);

        let motionSeconded = true;
        if (phaseConfig.governance.requireSeconding) {
          state.phase = "SECONDING";
          const nonCallerIds = turnOrder.filter((id) => id !== speaker.id);
          const secondingPairs = await Promise.all(
            nonCallerIds.map(async (memberId) => {
              const member = this.requireMember(memberId);
              const secondingPrompt = buildSecondingPrompt(
                this.config,
                member,
                motion,
                recorder.getTranscript(),
                phaseConfig.id,
                phaseConfig.goal
              );
              const secondRaw = await this.completeJsonSafe(
                this.requireClient(memberId),
                member.systemPrompt,
                secondingPrompt,
                { temperature: member.model.temperature, maxTokens: member.model.maxTokens },
                {
                  stage: "motion_seconding",
                  sessionId,
                  memberId,
                  round,
                  turnIndex: state.turnIndex
                }
              );
              return { memberId, response: normalizeSecondingResponse(secondRaw) };
            })
          );

          for (const item of secondingPairs) {
            await appendEvent(
              "SECONDING_RESPONSE",
              round,
              { ...item.response, passId: phaseConfig.id },
              item.memberId
            );
          }

          const seconderId = secondingPairs.find((pair) => pair.response.second)?.memberId;
          if (!seconderId) {
            await appendEvent("MOTION_NOT_SECONDED", round, {
              motionId: motion.motionId,
              calledBy: speaker.id,
              passId: phaseConfig.id
            });
            motionSeconded = false;
            state.phase = "DISCUSSION";
          } else {
            await appendEvent(
              "MOTION_SECONDED",
              round,
              { motionId: motion.motionId, secondedBy: seconderId, passId: phaseConfig.id },
              seconderId
            );
          }
        }

        if (!motionSeconded) {
          continue;
        }

        state.phase = "VOTING";
        const votePairs = await Promise.all(
          turnOrder.map(async (memberId) => {
            const member = this.requireMember(memberId);
            const votePrompt = buildVotePrompt(
              this.config,
              member,
              motion,
              recorder.getTranscript(),
              phaseConfig.id,
              phaseConfig.goal,
              phaseConfig.governance
            );
            const voteRaw = await this.completeJsonSafe<VoteResponse>(
              this.requireClient(memberId),
              member.systemPrompt,
              votePrompt,
              { temperature: member.model.temperature, maxTokens: member.model.maxTokens },
              {
                stage: "motion_vote",
                sessionId,
                memberId,
                round,
                turnIndex: state.turnIndex
              }
            );
            return { memberId, vote: normalizeVoteResponse(voteRaw) };
          })
        );

        for (const pair of votePairs) {
          await appendEvent(
            "VOTE_CAST",
            round,
            { motionId: motion.motionId, ...pair.vote, passId: phaseConfig.id },
            pair.memberId
          );
        }

        const passResult = this.computeVotePass(
          votePairs.map((item) => item.vote.ballot),
          phaseConfig.governance
        );
        await appendEvent("VOTE_RESULT", round, {
          passId: phaseConfig.id,
          motionId: motion.motionId,
          passed: passResult.passed,
          yesVotes: passResult.yesVotes,
          noVotesEffective: passResult.noVotesEffective,
          totalCouncilSize: turnOrder.length,
          majorityThreshold: phaseConfig.governance.majorityThreshold
        });

        state.phase = "DISCUSSION";
        if (passResult.passed && phaseConfig.stopConditions.endOnMajorityVote) {
          closed = true;
          endedBy = "MAJORITY_VOTE";
          finalResolution = motion.decisionIfPass;
          winningMotion = motion;
        }
      }
    }

    if (!closed) {
      await appendEvent("ROUND_LIMIT_REACHED", roundsCompleted, {
        passId: phaseConfig.id,
        maxRounds: phaseConfig.stopConditions.maxRounds,
        fallback: phaseConfig.fallback
      });
    }

    await appendEvent("PASS_COMPLETED", roundsCompleted, {
      passId: phaseConfig.id,
      endedBy,
      finalResolution,
      motionId: winningMotion?.motionId ?? null
    });

    return {
      phaseId: phaseConfig.id,
      phaseGoal: phaseConfig.goal,
      endedBy,
      finalResolution,
      winningMotion,
      roundsCompleted
    };
  }

  private async runDocumentationApprovalLoop(input: {
    sessionId: string;
    leader: CouncilMemberConfig;
    humanPrompt: string;
    phaseResolutionSummary: string;
    recorder: SessionRecorder;
    appendEvent: (
      type: CouncilEvent["type"],
      round: number,
      payload: unknown,
      actorId?: string
    ) => Promise<void>;
    state: RuntimeState;
  }): Promise<DocumentationApprovalOutcome> {
    const {
      sessionId,
      leader,
      humanPrompt,
      phaseResolutionSummary,
      recorder,
      appendEvent,
      state
    } = input;
    const sessionDir = recorder.getArtifacts().sessionDir;

    const initialPrompt = buildDocumentationOutputPrompt(
      this.config,
      leader,
      humanPrompt,
      recorder.getTranscript(),
      phaseResolutionSummary
    );
    let draft = await this.requireClient(leader.id).completeText(
      [
        { role: "system", content: leader.systemPrompt },
        { role: "user", content: initialPrompt }
      ],
      { temperature: leader.model.temperature, maxTokens: leader.model.maxTokens }
    );
    draft = draft.trim();

    const maxRevisionRounds = this.config.documentationReview.maxRevisionRounds;
    let latestFeedback: DocumentReviewFeedback[] = [];
    for (let revision = 1; revision <= maxRevisionRounds + 1; revision += 1) {
      const draftFile = path.join(sessionDir, `documentation.draft.v${revision}.md`);
      await writeFile(draftFile, `${draft}\n`, "utf8");
      await appendEvent(
        revision === 1 ? "DOCUMENT_DRAFT_WRITTEN" : "DOCUMENT_REVISION_WRITTEN",
        revision,
        { revision, file: draftFile },
        leader.id
      );

      const voteResult = await this.runDocumentApprovalVote({
        sessionId,
        revision,
        draftMarkdown: draft,
        appendEvent,
        state
      });
      if (voteResult.passed) {
        const approvedFile = path.join(sessionDir, "documentation.md");
        await writeFile(approvedFile, `${draft}\n`, "utf8");
        return {
          approved: true,
          outputDocumentFile: approvedFile
        };
      }

      if (revision > maxRevisionRounds) {
        break;
      }

      latestFeedback = await this.collectDocumentFeedback({
        sessionId,
        revision,
        draftMarkdown: draft,
        votePairs: voteResult.votePairs,
        appendEvent,
        state
      });
      const feedbackArtifact = path.join(sessionDir, `documentation.review.v${revision}.json`);
      await writeFile(feedbackArtifact, `${toJsonString(latestFeedback)}\n`, "utf8");

      const revisionPrompt = buildDocumentRevisionPrompt(
        this.config,
        leader,
        humanPrompt,
        phaseResolutionSummary,
        draft,
        toJsonString(latestFeedback),
        revision + 1
      );
      draft = (
        await this.requireClient(leader.id).completeText(
          [
            { role: "system", content: leader.systemPrompt },
            { role: "user", content: revisionPrompt }
          ],
          { temperature: leader.model.temperature, maxTokens: leader.model.maxTokens }
        )
      ).trim();
    }

    const unapprovedFile = path.join(sessionDir, "documentation.unapproved.md");
    await writeFile(unapprovedFile, `${draft}\n`, "utf8");
    const unresolvedBlockers = latestFeedback.flatMap((feedback) =>
      feedback.criticalBlockers.map((blocker) => ({
        memberId: feedback.memberId,
        ...blocker
      }))
    );
    const unresolvedFile = path.join(sessionDir, "documentation.unresolved-blockers.json");
    await writeFile(unresolvedFile, `${toJsonString(unresolvedBlockers)}\n`, "utf8");
    return {
      approved: false,
      outputDocumentFile: unapprovedFile
    };
  }

  private async runDocumentApprovalVote(input: {
    sessionId: string;
    revision: number;
    draftMarkdown: string;
    appendEvent: (
      type: CouncilEvent["type"],
      round: number,
      payload: unknown,
      actorId?: string
    ) => Promise<void>;
    state: RuntimeState;
  }): Promise<DocumentApprovalVoteResult> {
    const { sessionId, revision, draftMarkdown, appendEvent, state } = input;
    const turnOrder = this.resolveTurnOrder();

    state.phase = "VOTING";
    await appendEvent("DOCUMENT_APPROVAL_VOTE_CALLED", revision, {
      revision,
      voteType: "DOCUMENT_APPROVAL"
    });

    const votePairs = await Promise.all(
      turnOrder.map(async (memberId) => {
        const member = this.requireMember(memberId);
        const prompt = buildDocumentApprovalVotePrompt(
          this.config,
          member,
          draftMarkdown,
          revision
        );
        const voteRaw = await this.completeJsonSafe<VoteResponse>(
          this.requireClient(memberId),
          member.systemPrompt,
          prompt,
          { temperature: member.model.temperature, maxTokens: member.model.maxTokens },
          {
            stage: "document_approval_vote",
            sessionId,
            memberId,
            round: revision
          }
        );
        return { memberId, vote: normalizeVoteResponse(voteRaw) };
      })
    );

    for (const pair of votePairs) {
      await appendEvent(
        "VOTE_CAST",
        revision,
        { voteType: "DOCUMENT_APPROVAL", revision, ...pair.vote },
        pair.memberId
      );
    }

    const passResult = this.computeVotePass(votePairs.map((item) => item.vote.ballot), {
      requireSeconding: true,
      majorityThreshold: 0.5,
      abstainCountsAsNo: true
    });
    await appendEvent("DOCUMENT_APPROVAL_VOTE_RESULT", revision, {
      revision,
      passed: passResult.passed,
      yesVotes: passResult.yesVotes,
      noVotesEffective: passResult.noVotesEffective,
      totalCouncilSize: turnOrder.length
    });
    state.phase = "DISCUSSION";
    return {
      ...passResult,
      votePairs
    };
  }

  private async collectDocumentFeedback(input: {
    sessionId: string;
    revision: number;
    draftMarkdown: string;
    votePairs: ApprovalVotePair[];
    appendEvent: (
      type: CouncilEvent["type"],
      round: number,
      payload: unknown,
      actorId?: string
    ) => Promise<void>;
    state: RuntimeState;
  }): Promise<DocumentReviewFeedback[]> {
    const { sessionId, revision, draftMarkdown, votePairs, appendEvent, state } = input;
    const reviewerIds = votePairs
      .filter((pair) => pair.vote.ballot !== "YES")
      .map((pair) => pair.memberId);
    if (reviewerIds.length === 0) {
      return [];
    }

    state.phase = "DISCUSSION";
    const feedback = await Promise.all(
      reviewerIds.map(async (memberId) => {
        const member = this.requireMember(memberId);
        const prompt = buildDocumentFeedbackPrompt(this.config, member, draftMarkdown, revision);
        const raw = await this.completeJsonSafe<unknown>(
          this.requireClient(memberId),
          member.systemPrompt,
          prompt,
          { temperature: member.model.temperature, maxTokens: member.model.maxTokens },
          {
            stage: "document_feedback",
            sessionId,
            memberId,
            round: revision
          }
        );
        const normalized = this.normalizeDocumentFeedback(raw, memberId);
        await appendEvent(
          "DOCUMENT_FEEDBACK_SUBMITTED",
          revision,
          {
            revision,
            criticalBlockerCount: normalized.criticalBlockers.length,
            suggestedChangeCount: normalized.suggestedChanges.length
          },
          memberId
        );
        return normalized;
      })
    );
    return feedback;
  }

  private normalizeDocumentFeedback(raw: unknown, memberId: string): DocumentReviewFeedback {
    if (!raw || typeof raw !== "object") {
      return {
        memberId,
        criticalBlockers: [
          {
            id: "B0",
            section: "unknown",
            problem: "Feedback response was not valid JSON object.",
            impact: "Leader cannot reliably resolve reviewer blockers.",
            requiredChange: "Re-run review with strict JSON schema compliance.",
            severity: "critical"
          }
        ],
        suggestedChanges: []
      };
    }

    const candidate = raw as {
      criticalBlockers?: unknown;
      suggestedChanges?: unknown;
    };
    const criticalBlockersRaw = Array.isArray(candidate.criticalBlockers)
      ? candidate.criticalBlockers
      : [];
    const criticalBlockers: DocumentCriticalBlocker[] = criticalBlockersRaw
      .map((value, index) => {
        if (!value || typeof value !== "object") {
          return null;
        }
        const item = value as Record<string, unknown>;
        const severity = item.severity === "major" ? "major" : "critical";
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `B${index + 1}`;
        const section = typeof item.section === "string" ? item.section.trim() : "";
        const problem = typeof item.problem === "string" ? item.problem.trim() : "";
        const impact = typeof item.impact === "string" ? item.impact.trim() : "";
        const requiredChange =
          typeof item.requiredChange === "string" ? item.requiredChange.trim() : "";
        if (!section || !problem || !impact || !requiredChange) {
          return null;
        }
        return {
          id,
          section,
          problem,
          impact,
          requiredChange,
          severity
        };
      })
      .filter((value): value is DocumentCriticalBlocker => value !== null)
      .slice(0, 5);

    const suggestedChanges = Array.isArray(candidate.suggestedChanges)
      ? candidate.suggestedChanges
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];

    return {
      memberId,
      criticalBlockers,
      suggestedChanges
    };
  }

  private async electLeader(
    sessionId: string,
    recorder: SessionRecorder,
    appendEvent: (
      type: CouncilEvent["type"],
      round: number,
      payload: unknown,
      actorId?: string
    ) => Promise<void>
  ): Promise<string> {
    const memberIds = new Set(this.config.members.map((member) => member.id));
    const ballots = await Promise.all(
      this.config.members.map(async (member) => {
        const prompt = buildLeaderElectionPrompt(this.config, member, recorder.getTranscript());
        const raw = await this.completeJsonSafe<LeaderElectionBallot>(
          this.requireClient(member.id),
          member.systemPrompt,
          prompt,
          { temperature: member.model.temperature, maxTokens: member.model.maxTokens },
          {
            stage: "leader_election",
            sessionId,
            memberId: member.id,
            round: 0
          }
        );
        const normalized = normalizeLeaderElectionBallot(raw, memberIds);
        await appendEvent("LEADER_ELECTION_BALLOT", 0, normalized, member.id);
        return normalized;
      })
    );

    const tally = new Map<string, number>();
    for (const ballot of ballots) {
      tally.set(ballot.candidateId, (tally.get(ballot.candidateId) ?? 0) + 1);
    }

    const ranked = sortByStableOrder([...tally.keys()]).map((candidateId) => ({
      candidateId,
      votes: tally.get(candidateId) ?? 0
    }));

    ranked.sort((a, b) => {
      if (a.votes === b.votes) {
        return a.candidateId.localeCompare(b.candidateId);
      }
      return b.votes - a.votes;
    });

    const winner = ranked[0]?.candidateId ?? this.config.members[0].id;
    await appendEvent("LEADER_ELECTED", 0, { winner, tally: ranked }, winner);
    return winner;
  }

  private computeVotePass(ballots: Ballot[], governance: PhaseGovernanceConfig): VotePassResult {
    const total = ballots.length;
    const yesVotes = ballots.filter((ballot) => ballot === "YES").length;
    const noVotesEffective = governance.abstainCountsAsNo
      ? total - yesVotes
      : ballots.filter((ballot) => ballot === "NO").length;

    const requiredYesVotes =
      governance.majorityThreshold === 0.5
        ? Math.floor(total / 2) + 1
        : Math.ceil(total * governance.majorityThreshold);

    return {
      passed: yesVotes >= requiredYesVotes,
      yesVotes,
      noVotesEffective
    };
  }

  private resolveNextPhaseTransition(
    phaseConfig: CouncilSessionPhaseConfig,
    endedBy: SessionResult["endedBy"]
  ): PhaseTransitionConfig | undefined {
    const trigger = endedBy === "MAJORITY_VOTE" ? "MAJORITY_VOTE" : "ROUND_LIMIT";
    const candidates = phaseConfig.transitions
      .filter((transition) => transition.when === "ALWAYS" || transition.when === trigger)
      .sort((a, b) => {
        if (a.priority === b.priority) {
          return a.to.localeCompare(b.to);
        }
        return a.priority - b.priority;
      });
    if (candidates.length > 0) {
      return candidates[0];
    }

    if (
      endedBy === "ROUND_LIMIT" &&
      phaseConfig.fallback.action === "TRANSITION" &&
      phaseConfig.fallback.transitionToPhaseId
    ) {
      return {
        to: phaseConfig.fallback.transitionToPhaseId,
        when: "ROUND_LIMIT",
        reason: "fallback_transition",
        priority: Number.MAX_SAFE_INTEGER
      };
    }

    return undefined;
  }

  private buildPhaseContextPacket(input: {
    phaseConfig: CouncilSessionPhaseConfig;
    currentRound: number;
    priorPhaseResolution?: string;
  }): PhaseContextPacket {
    const { phaseConfig, currentRound, priorPhaseResolution } = input;
    const requiredDeliverables = phaseConfig.deliverables.filter((deliverable) => deliverable.required);
    const openEvidenceGaps: string[] = [];
    if (phaseConfig.evidenceRequirements.minCitations > 0) {
      openEvidenceGaps.push(
        `Need at least ${phaseConfig.evidenceRequirements.minCitations} references or citations.`
      );
    }
    if (phaseConfig.evidenceRequirements.requireExplicitAssumptions) {
      openEvidenceGaps.push("Explicit assumptions must be listed.");
    }
    if (phaseConfig.evidenceRequirements.requireRiskRegister) {
      openEvidenceGaps.push("Risk register entries are required.");
    }

    return {
      verbosity: this.config.sessionPolicy.phaseContextVerbosity,
      currentPhase: {
        id: phaseConfig.id,
        goal: phaseConfig.goal,
        round: currentRound,
        maxRounds: phaseConfig.stopConditions.maxRounds,
        deliverables: phaseConfig.deliverables,
        qualityGates: phaseConfig.qualityGates,
        stopConditions: phaseConfig.stopConditions,
        evidenceRequirements: phaseConfig.evidenceRequirements,
        promptGuidance: phaseConfig.promptGuidance,
        priorPhaseResolution
      },
      graphDigest: {
        entryPhaseId: this.config.sessionPolicy.entryPhaseId,
        nodes: this.buildGraphDigest(phaseConfig.id)
      },
      progressState: {
        roundsUsed: currentRound,
        deliverablesComplete: [],
        deliverablesPending: requiredDeliverables.map((deliverable) => deliverable.id),
        qualityGatesPassed: [],
        qualityGatesPending: phaseConfig.qualityGates,
        openEvidenceGaps
      },
      transitionHints: phaseConfig.transitions
        .slice()
        .sort((a, b) => {
          if (a.priority === b.priority) {
            return a.to.localeCompare(b.to);
          }
          return a.priority - b.priority;
        })
        .map((transition) => ({
          to: transition.to,
          when: transition.when,
          reason: transition.reason
        }))
    };
  }

  private buildGraphDigest(currentPhaseId: string): PhaseContextGraphNodeDigest[] {
    const verbosity = this.config.sessionPolicy.phaseContextVerbosity;
    if (verbosity === "full") {
      return this.config.phases.map((phase) => ({
        id: phase.id,
        goal: phase.goal,
        transitions: phase.transitions.map((transition) => ({
          to: transition.to,
          when: transition.when
        }))
      }));
    }

    if (verbosity === "minimal") {
      const current = this.requirePhase(currentPhaseId);
      return [
        {
          id: current.id,
          goal: current.goal,
          transitions: current.transitions.map((transition) => ({
            to: transition.to,
            when: transition.when
          }))
        }
      ];
    }

    const current = this.requirePhase(currentPhaseId);
    const ids = new Set<string>([current.id]);
    for (const transition of current.transitions) {
      ids.add(transition.to);
    }
    for (const phase of this.config.phases) {
      if (phase.transitions.some((transition) => transition.to === current.id)) {
        ids.add(phase.id);
      }
    }

    return this.config.phases
      .filter((phase) => ids.has(phase.id))
      .map((phase) => ({
        id: phase.id,
        goal: phase.goal,
        transitions: phase.transitions.map((transition) => ({
          to: transition.to,
          when: transition.when
        }))
      }));
  }

  private buildPhaseResolutionSummary(results: DeliberationPhaseResult[]): string {
    return results
      .map(
        (result, index) =>
          `${index + 1}. ${result.phaseId} (${result.endedBy}): ${result.finalResolution}`
      )
      .join("\n");
  }

  private async completeJsonSafe<T>(
    client: ModelClient,
    systemPrompt: string,
    userPrompt: string,
    options?: CompletionOptions,
    context?: {
      stage: string;
      memberId?: string;
      round?: number;
      turnIndex?: number;
      sessionId?: string;
    }
  ): Promise<T> {
    try {
      return await completeJson<T>(
        client,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        options
      );
    } catch (error) {
      if (error instanceof JsonResponseParseError) {
        console.error("[council] model returned non-JSON content", {
          stage: context?.stage,
          sessionId: context?.sessionId,
          memberId: context?.memberId,
          round: context?.round,
          turnIndex: context?.turnIndex,
          message: error.message,
          rawPreview: error.rawResponse.slice(0, 1200)
        });
        return {
          __errorType: "json_parse_error",
          message: error.message,
          raw: error.rawResponse.slice(0, 800)
        } as T;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error("[council] model completion failed", {
        stage: context?.stage,
        sessionId: context?.sessionId,
        memberId: context?.memberId,
        round: context?.round,
        turnIndex: context?.turnIndex,
        message
      });
      throw new Error(`Model completion failed: ${message}`);
    }
  }

  private resolveTurnOrder(): string[] {
    if (this.config.turnOrder) {
      return this.config.turnOrder;
    }
    return this.config.members.map((member) => member.id);
  }

  private requireMember(memberId: string): CouncilMemberConfig {
    const member = this.memberById.get(memberId);
    if (!member) {
      throw new Error(`Unknown member id: ${memberId}`);
    }
    return member;
  }

  private requireClient(memberId: string): ModelClient {
    const client = this.modelClients.get(memberId);
    if (!client) {
      throw new Error(`Missing model client for member id: ${memberId}`);
    }
    return client;
  }

  private requirePhase(phaseId: string): CouncilSessionPhaseConfig {
    const phase = this.phaseById.get(phaseId);
    if (!phase) {
      throw new Error(`Unknown phase id: ${phaseId}`);
    }
    return phase;
  }
}
