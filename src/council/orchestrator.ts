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
  LeaderElectionBallot,
  LeaderSummary,
  Motion,
  SessionResult,
  SessionRunOptions,
  TurnAction,
  VoteResponse
} from "../types.js";
import { makeId, nowIso, sortByStableOrder, toJsonString } from "../utils.js";
import { MemoryStore } from "../storage/memoryStore.js";
import { SessionRecorder } from "../storage/sessionRecorder.js";
import {
  buildContinuationVotePrompt,
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

type DeliberationPassId = "HIGH_LEVEL" | "IMPLEMENTATION";

interface DeliberationPassPlan {
  id: DeliberationPassId;
  objective: string;
  maxRounds: number;
  fallbackResolution: string;
  priorPassResolution?: string;
}

interface DeliberationPassResult {
  passId: DeliberationPassId;
  endedBy: SessionResult["endedBy"];
  finalResolution: string;
  winningMotion?: Motion;
}

interface RuntimeState {
  phase: CouncilPhase;
  turnIndex: number;
}

interface ContinuationVoteResult {
  passed: boolean;
  yesVotes: number;
  noVotesEffective: number;
}

export class CouncilOrchestrator {
  private readonly modelClients: Map<string, ModelClient>;
  private readonly memberById: Map<string, CouncilMemberConfig>;

  constructor(private readonly config: CouncilConfig) {
    this.memberById = new Map(config.members.map((m) => [m.id, m]));
    this.modelClients = new Map(
      config.members.map((m) => [m.id, buildModelClient(m.model)])
    );
  }

  async run(options: SessionRunOptions): Promise<SessionResult> {
    const outputType: CouncilOutputType = options.outputType ?? "none";
    const deliberation = this.resolveDeliberationRounds();
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
      deliberation,
      votingRule: "majority_of_full_council",
      blindVoting: true,
      outputType
    });

    const turnOrder = this.resolveTurnOrder();
    const leaderId = await this.electLeader(sessionId, recorder, appendEvent);
    const leader = this.requireMember(leaderId);

    const highLevelPlan: DeliberationPassPlan = {
      id: "HIGH_LEVEL",
      objective: this.buildHighLevelObjective(),
      maxRounds: deliberation.highLevelRounds,
      fallbackResolution: "No majority high-level plan reached within configured rounds."
    };

    const highLevelResult = await this.runDeliberationPass({
      plan: highLevelPlan,
      sessionId,
      humanPrompt: options.humanPrompt,
      turnOrder,
      recorder,
      memoryStore,
      appendEvent,
      state
    });

    const implementationPlan: DeliberationPassPlan = {
      id: "IMPLEMENTATION",
      objective: this.buildImplementationObjective(),
      maxRounds: deliberation.implementationRounds,
      fallbackResolution: "No majority implementation plan reached within configured rounds.",
      priorPassResolution: highLevelResult.finalResolution
    };

    let implementationResult: DeliberationPassResult | undefined;
    let implementationSkippedReason: string | undefined;

    if (highLevelResult.endedBy === "ROUND_LIMIT") {
      const continuationVote = await this.runContinuationVote({
        sessionId,
        turnOrder,
        recorder,
        appendEvent,
        state,
        highLevelResolution: highLevelResult.finalResolution,
        highLevelRoundLimit: deliberation.highLevelRounds
      });
      if (continuationVote.passed) {
        implementationResult = await this.runDeliberationPass({
          plan: implementationPlan,
          sessionId,
          humanPrompt: options.humanPrompt,
          turnOrder,
          recorder,
          memoryStore,
          appendEvent,
          state
        });
      } else {
        implementationSkippedReason =
          "Session closed after high-level round limit; continuation vote to implementation did not pass.";
      }
    } else {
      implementationResult = await this.runDeliberationPass({
        plan: implementationPlan,
        sessionId,
        humanPrompt: options.humanPrompt,
        turnOrder,
        recorder,
        memoryStore,
        appendEvent,
        state
      });
    }

    const finalPass: DeliberationPassResult = implementationResult ?? {
      passId: "HIGH_LEVEL",
      endedBy: "ROUND_LIMIT",
      finalResolution:
        implementationSkippedReason ??
        "Session closed: continuation to implementation did not pass.",
      winningMotion: highLevelResult.winningMotion
    };
    state.phase = "CLOSED";
    const totalConfiguredRounds =
      deliberation.highLevelRounds +
      (implementationResult ? deliberation.implementationRounds : 0);

    const leaderSummaryPrompt = buildLeaderSummaryPrompt(
      this.config,
      leader,
      recorder.getTranscript(),
      finalPass.endedBy,
      finalPass.finalResolution,
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
        round: totalConfiguredRounds,
        turnIndex: state.turnIndex
      }
    );
    const leaderSummary = normalizeLeaderSummary(leaderSummaryRaw, finalPass.finalResolution, outputType);

    await appendEvent("LEADER_SUMMARY", totalConfiguredRounds, leaderSummary, leaderId);
    await recorder.writeLeaderSummary(leaderSummary.summaryMarkdown);

    let outputDocumentFile: string | undefined;
    if (outputType === "documentation") {
      outputDocumentFile = path.join(recorder.getArtifacts().sessionDir, "documentation.md");
      try {
        const docPrompt = buildDocumentationOutputPrompt(
          this.config,
          leader,
          options.humanPrompt,
          recorder.getTranscript(),
          highLevelResult.finalResolution,
          implementationResult
            ? leaderSummary.finalResolution
            : `Implementation pass skipped. ${implementationSkippedReason ?? "Continuation vote failed."}`
        );
        const documentation = await this.requireClient(leaderId).completeText(
          [
            { role: "system", content: leader.systemPrompt },
            { role: "user", content: docPrompt }
          ],
          { temperature: leader.model.temperature, maxTokens: leader.model.maxTokens }
        );
        await writeFile(outputDocumentFile, `${documentation.trim()}\n`, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[council] documentation artifact generation failed", {
          sessionId,
          leaderId,
          message
        });
        const fallback = [
          "# System Design",
          "",
          "## Executive Summary",
          leaderSummary.finalResolution,
          "",
          "## High-Level Plan Resolution",
          highLevelResult.finalResolution,
          "",
          "## Implementation Plan Resolution",
          implementationResult
            ? leaderSummary.finalResolution
            : `Implementation pass skipped. ${implementationSkippedReason ?? "Continuation vote failed."}`,
          "",
          "## Notes",
          "Generated fallback document due to documentation generation error.",
          "",
          "## Session Transcript",
          recorder.getTranscript()
        ].join("\n");
        await writeFile(outputDocumentFile, `${fallback}\n`, "utf8");
      }
      await appendEvent(
        "OUTPUT_ARTIFACT_WRITTEN",
        totalConfiguredRounds,
        { outputType, file: outputDocumentFile },
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
        motionId: finalPass.winningMotion?.motionId ?? null,
        leaderId,
        executionBrief: leaderSummary.executionBrief
      };
      await writeFile(executionHandoffFile, `${toJsonString(handoffPayload)}\n`, "utf8");
    }

    await appendEvent(
      "SESSION_CLOSED",
      totalConfiguredRounds,
      {
        endedBy: finalPass.endedBy,
        finalResolution: leaderSummary.finalResolution,
        requiresExecution: leaderSummary.requiresExecution,
        executionApproved,
        outputType
      }
    );

    await memoryStore.recordSession({
      sessionId,
      humanPrompt: options.humanPrompt,
      leaderId,
      endedBy: finalPass.endedBy,
      finalResolution: leaderSummary.finalResolution,
      outputType,
      leaderSummary,
      events: recorder.getEvents(),
      executionApproved
    });

    await recorder.finalize({
      sessionId,
      councilName: this.config.councilName,
      leaderId,
      deliberation,
      passResolutions: {
        highLevel: highLevelResult,
        implementation:
          implementationResult ??
          ({
            passId: "IMPLEMENTATION",
            skipped: true,
            reason:
              implementationSkippedReason ??
              "High-level pass reached round limit and continuation vote did not pass."
          } as const)
      },
      endedBy: finalPass.endedBy,
      finalResolution: leaderSummary.finalResolution,
      requiresExecution: leaderSummary.requiresExecution,
      executionApproved,
      winningMotion: finalPass.winningMotion,
      outputType,
      outputDocumentFile
    });

    return {
      sessionId,
      leaderId,
      endedBy: finalPass.endedBy,
      finalResolution: leaderSummary.finalResolution,
      requiresExecution: leaderSummary.requiresExecution,
      executionApproved,
      outputType,
      artifacts: {
        ...artifacts,
        executionHandoffFile,
        outputDocumentFile
      }
    };
  }

  private async runDeliberationPass(input: {
    plan: DeliberationPassPlan;
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
  }): Promise<DeliberationPassResult> {
    const { plan, sessionId, humanPrompt, turnOrder, recorder, memoryStore, appendEvent, state } = input;

    await appendEvent("PASS_STARTED", 0, {
      passId: plan.id,
      objective: plan.objective,
      maxRounds: plan.maxRounds,
      priorPassResolution: plan.priorPassResolution ?? null
    });

    let closed = false;
    let endedBy: SessionResult["endedBy"] = "ROUND_LIMIT";
    let finalResolution = plan.fallbackResolution;
    let winningMotion: Motion | undefined;

    for (let round = 1; round <= plan.maxRounds && !closed; round += 1) {
      await appendEvent("ROUND_STARTED", round, {
        passId: plan.id,
        objective: plan.objective,
        round,
        maxRounds: plan.maxRounds,
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
        const turnsRemainingForSpeaker = plan.maxRounds - round + 1;

        const turnPrompt = buildTurnPrompt({
          config: this.config,
          member: speaker,
          humanPrompt,
          transcript: recorder.getTranscript(),
          memberMemory: await memoryStore.readMemberMemory(speaker.id),
          passId: plan.id,
          passObjective: plan.objective,
          priorPassResolution: plan.priorPassResolution,
          currentRound: round,
          maxRounds: plan.maxRounds,
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
        await appendEvent("TURN_ACTION", round, { ...action, passId: plan.id }, speaker.id);

        if (action.action === "CONTRIBUTE") {
          await appendEvent(
            "MESSAGE_CONTRIBUTED",
            round,
            { message: action.message, passId: plan.id },
            speaker.id
          );
          continue;
        }

        if (action.action === "PASS") {
          await appendEvent(
            "PASS_RECORDED",
            round,
            { reason: action.reason, note: action.note ?? null, passId: plan.id },
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

        await appendEvent("MOTION_CALLED", round, { ...motion, passId: plan.id }, speaker.id);
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
              plan.id,
              plan.objective
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
          await appendEvent("SECONDING_RESPONSE", round, { ...item.response, passId: plan.id }, item.memberId);
        }

        const seconderId = nonCallerIds.find((candidateId) => {
          const item = secondingPairs.find((pair) => pair.memberId === candidateId);
          return item?.response.second;
        });

        if (!seconderId) {
          await appendEvent(
            "MOTION_NOT_SECONDED",
            round,
            { motionId: motion.motionId, calledBy: speaker.id, passId: plan.id }
          );
          state.phase = "DISCUSSION";
          continue;
        }

        await appendEvent(
          "MOTION_SECONDED",
          round,
          { motionId: motion.motionId, secondedBy: seconderId, passId: plan.id },
          seconderId
        );
        state.phase = "VOTING";

        const votePairs = await Promise.all(
          turnOrder.map(async (memberId) => {
            const member = this.requireMember(memberId);
            const votePrompt = buildVotePrompt(
              this.config,
              member,
              motion,
              recorder.getTranscript(),
              plan.id,
              plan.objective
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

        // Blind collection completed. Only now are ballots written to record.
        for (const pair of votePairs) {
          await appendEvent(
            "VOTE_CAST",
            round,
            { motionId: motion.motionId, ...pair.vote, passId: plan.id },
            pair.memberId
          );
        }

        const passResult = this.computeVotePass(votePairs.map((v) => v.vote.ballot));
        await appendEvent("VOTE_RESULT", round, {
          passId: plan.id,
          motionId: motion.motionId,
          passed: passResult.passed,
          yesVotes: passResult.yesVotes,
          noVotesEffective: passResult.noVotesEffective,
          totalCouncilSize: turnOrder.length
        });

        state.phase = "DISCUSSION";
        if (passResult.passed) {
          closed = true;
          endedBy = "MAJORITY_VOTE";
          finalResolution = motion.decisionIfPass;
          winningMotion = motion;
          break;
        }
      }
    }

    if (!closed) {
      await appendEvent("ROUND_LIMIT_REACHED", plan.maxRounds, {
        passId: plan.id,
        maxRounds: plan.maxRounds
      });
    }

    await appendEvent("PASS_COMPLETED", plan.maxRounds, {
      passId: plan.id,
      endedBy,
      finalResolution,
      motionId: winningMotion?.motionId ?? null
    });

    return {
      passId: plan.id,
      endedBy,
      finalResolution,
      winningMotion
    };
  }

  private async runContinuationVote(input: {
    sessionId: string;
    turnOrder: string[];
    recorder: SessionRecorder;
    appendEvent: (
      type: CouncilEvent["type"],
      round: number,
      payload: unknown,
      actorId?: string
    ) => Promise<void>;
    state: RuntimeState;
    highLevelResolution: string;
    highLevelRoundLimit: number;
  }): Promise<ContinuationVoteResult> {
    const { sessionId, turnOrder, recorder, appendEvent, state, highLevelResolution, highLevelRoundLimit } =
      input;

    state.phase = "VOTING";
    await appendEvent("CONTINUATION_VOTE_CALLED", highLevelRoundLimit, {
      fromPass: "HIGH_LEVEL",
      toPass: "IMPLEMENTATION",
      reason: "High-level pass reached configured round limit.",
      highLevelResolution
    });

    const votePairs = await Promise.all(
      turnOrder.map(async (memberId) => {
        const member = this.requireMember(memberId);
        const votePrompt = buildContinuationVotePrompt(
          this.config,
          member,
          highLevelResolution,
          recorder.getTranscript()
        );
        const voteRaw = await this.completeJsonSafe<VoteResponse>(
          this.requireClient(memberId),
          member.systemPrompt,
          votePrompt,
          { temperature: member.model.temperature, maxTokens: member.model.maxTokens },
          {
            stage: "continuation_vote",
            sessionId,
            memberId,
            round: highLevelRoundLimit,
            turnIndex: state.turnIndex
          }
        );
        return { memberId, vote: normalizeVoteResponse(voteRaw) };
      })
    );

    for (const pair of votePairs) {
      await appendEvent(
        "VOTE_CAST",
        highLevelRoundLimit,
        { voteType: "CONTINUATION_TO_IMPLEMENTATION", ...pair.vote, passId: "HIGH_LEVEL" },
        pair.memberId
      );
    }

    const passResult = this.computeVotePass(votePairs.map((v) => v.vote.ballot));
    await appendEvent("CONTINUATION_VOTE_RESULT", highLevelRoundLimit, {
      voteType: "CONTINUATION_TO_IMPLEMENTATION",
      passed: passResult.passed,
      yesVotes: passResult.yesVotes,
      noVotesEffective: passResult.noVotesEffective,
      totalCouncilSize: turnOrder.length
    });
    state.phase = "DISCUSSION";

    return passResult;
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
    const memberIds = new Set(this.config.members.map((m) => m.id));
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

  private computeVotePass(ballots: Ballot[]): {
    passed: boolean;
    yesVotes: number;
    noVotesEffective: number;
  } {
    const total = ballots.length;
    const yesVotes = ballots.filter((b) => b === "YES").length;
    const noVotesEffective = total - yesVotes;
    return {
      passed: yesVotes > total / 2,
      yesVotes,
      noVotesEffective
    };
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
        // Deterministic fallback handled by normalizers.
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

  private resolveDeliberationRounds(): {
    highLevelRounds: number;
    implementationRounds: number;
  } {
    const fallback = this.config.maxRounds ?? 5;
    return {
      highLevelRounds: this.config.deliberation?.highLevelRounds ?? fallback,
      implementationRounds: this.config.deliberation?.implementationRounds ?? fallback
    };
  }

  private buildHighLevelObjective(): string {
    return [
      "Define high-level architecture, principal risks, and decision boundaries.",
      "Produce measurable acceptance criteria that implementation must satisfy."
    ].join(" ");
  }

  private buildImplementationObjective(): string {
    return [
      "Critique unresolved ambiguities from the high-level pass and resolve them.",
      "Produce concrete implementation specifics: APIs, state/resources, scheduler behavior, lease/coordination mechanics, failure modes, and staged rollout tasks."
    ].join(" ");
  }

  private resolveTurnOrder(): string[] {
    if (this.config.turnOrder) {
      return this.config.turnOrder;
    }
    return this.config.members.map((m) => m.id);
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
}
