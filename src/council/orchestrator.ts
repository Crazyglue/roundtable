import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildModelClient } from "../models/factory.js";
import {
  completeJson,
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
  buildDocumentationOutputPrompt,
  buildLeaderElectionPrompt,
  buildLeaderSummaryPrompt,
  buildMemberSummaryPrompt,
  buildSecondingPrompt,
  buildTurnPrompt,
  buildVotePrompt,
  normalizeLeaderElectionBallot,
  normalizeLeaderSummary,
  normalizeSecondingResponse,
  normalizeTurnAction,
  normalizeVoteResponse
} from "./prompts.js";

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
    await mkdir(this.config.storage.rootDir, { recursive: true });
    await mkdir(this.config.storage.memoryDir, { recursive: true });

    const sessionId = makeId("session");
    const memoryStore = new MemoryStore(this.config);
    await memoryStore.init(this.config.members);

    const recorder = new SessionRecorder(this.config, sessionId);
    await recorder.init(options.humanPrompt);

    let phase: CouncilPhase = "DISCUSSION";
    let eventCounter = 0;
    let turnIndex = 0;

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
        phase,
        type,
        round,
        turnIndex,
        actorId,
        payload
      };
      await recorder.appendEvent(event);
      await memoryStore.appendEventForAll(event);
    };

    await appendEvent("SESSION_STARTED", 0, {
      humanPrompt: options.humanPrompt,
      maxRounds: this.config.maxRounds,
      votingRule: "majority_of_full_council",
      blindVoting: true,
      outputType
    });

    const turnOrder = this.resolveTurnOrder();
    const leaderId = await this.electLeader(sessionId, recorder, appendEvent);
    const leader = this.requireMember(leaderId);
    let closed = false;
    let endedBy: SessionResult["endedBy"] = "ROUND_LIMIT";
    let finalResolution = "No majority resolution reached within round limit.";
    let winningMotion: Motion | undefined;

    for (let round = 1; round <= this.config.maxRounds && !closed; round += 1) {
      await appendEvent("ROUND_STARTED", round, {
        round,
        maxRounds: this.config.maxRounds,
        turnOrder
      });

      for (const speakerId of turnOrder) {
        if (closed) {
          break;
        }

        turnIndex += 1;
        phase = "DISCUSSION";
        const speaker = this.requireMember(speakerId);
        const client = this.requireClient(speakerId);
        const turnsRemainingForSpeaker = this.config.maxRounds - round + 1;

        const turnPrompt = buildTurnPrompt({
          config: this.config,
          member: speaker,
          humanPrompt: options.humanPrompt,
          transcript: recorder.getTranscript(),
          memberMemory: await memoryStore.readMemberMemory(speaker.id),
          currentRound: round,
          maxRounds: this.config.maxRounds,
          turnsRemainingForSpeaker
        });

        const actionRaw = await this.completeJsonSafe<TurnAction>(
          client,
          speaker.systemPrompt,
          turnPrompt,
          {
            stage: "turn_action",
            sessionId,
            memberId: speaker.id,
            round,
            turnIndex
          }
        );
        const action = normalizeTurnAction(actionRaw);
        await appendEvent("TURN_ACTION", round, action, speaker.id);

        if (action.action === "CONTRIBUTE") {
          await appendEvent("MESSAGE_CONTRIBUTED", round, { message: action.message }, speaker.id);
          continue;
        }

        if (action.action === "PASS") {
          await appendEvent(
            "PASS_RECORDED",
            round,
            { reason: action.reason, note: action.note ?? null },
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
          turnIndex
        };

        await appendEvent("MOTION_CALLED", round, motion, speaker.id);
        phase = "SECONDING";

        const nonCallerIds = turnOrder.filter((id) => id !== speaker.id);
        const secondingPairs = await Promise.all(
          nonCallerIds.map(async (memberId) => {
            const member = this.requireMember(memberId);
            const secondingPrompt = buildSecondingPrompt(this.config, member, motion, recorder.getTranscript());
            const secondRaw = await this.completeJsonSafe(
              this.requireClient(memberId),
              member.systemPrompt,
              secondingPrompt,
              {
                stage: "motion_seconding",
                sessionId,
                memberId,
                round,
                turnIndex
              }
            );
            return { memberId, response: normalizeSecondingResponse(secondRaw) };
          })
        );

        for (const item of secondingPairs) {
          await appendEvent("SECONDING_RESPONSE", round, item.response, item.memberId);
        }

        const seconderId = nonCallerIds.find((candidateId) => {
          const item = secondingPairs.find((pair) => pair.memberId === candidateId);
          return item?.response.second;
        });

        if (!seconderId) {
          await appendEvent("MOTION_NOT_SECONDED", round, { motionId: motion.motionId, calledBy: speaker.id });
          phase = "DISCUSSION";
          continue;
        }

        await appendEvent("MOTION_SECONDED", round, { motionId: motion.motionId, secondedBy: seconderId }, seconderId);
        phase = "VOTING";

        const votePairs = await Promise.all(
          turnOrder.map(async (memberId) => {
            const member = this.requireMember(memberId);
            const votePrompt = buildVotePrompt(this.config, member, motion, recorder.getTranscript());
            const voteRaw = await this.completeJsonSafe<VoteResponse>(
              this.requireClient(memberId),
              member.systemPrompt,
              votePrompt,
              {
                stage: "motion_vote",
                sessionId,
                memberId,
                round,
                turnIndex
              }
            );
            return { memberId, vote: normalizeVoteResponse(voteRaw) };
          })
        );

        // Blind collection completed. Only now are ballots written to record.
        for (const pair of votePairs) {
          await appendEvent("VOTE_CAST", round, { motionId: motion.motionId, ...pair.vote }, pair.memberId);
        }

        const passResult = this.computeVotePass(votePairs.map((v) => v.vote.ballot));
        await appendEvent("VOTE_RESULT", round, {
          motionId: motion.motionId,
          passed: passResult.passed,
          yesVotes: passResult.yesVotes,
          noVotesEffective: passResult.noVotesEffective,
          totalCouncilSize: turnOrder.length
        });

        phase = "DISCUSSION";
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
      await appendEvent("ROUND_LIMIT_REACHED", this.config.maxRounds, {
        maxRounds: this.config.maxRounds
      });
    }

    phase = "CLOSED";

    const leaderSummaryPrompt = buildLeaderSummaryPrompt(
      this.config,
      leader,
      recorder.getTranscript(),
      endedBy,
      finalResolution,
      outputType
    );

    const leaderSummaryRaw = await this.completeJsonSafe<LeaderSummary>(
      this.requireClient(leaderId),
      leader.systemPrompt,
      leaderSummaryPrompt,
      {
        stage: "leader_summary",
        sessionId,
        memberId: leaderId,
        round: this.config.maxRounds,
        turnIndex
      }
    );
    const leaderSummary = normalizeLeaderSummary(leaderSummaryRaw, finalResolution, outputType);

    await appendEvent("LEADER_SUMMARY", this.config.maxRounds, leaderSummary, leaderId);
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
          leaderSummary.finalResolution
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
        this.config.maxRounds,
        { outputType, file: outputDocumentFile },
        leaderId
      );
    }

    await Promise.all(
      this.config.members.map(async (member) => {
        const summaryPrompt = buildMemberSummaryPrompt(member, recorder.getTranscript(), leaderSummary.finalResolution);
        const content = await this.requireClient(member.id).completeText(
          [
            { role: "system", content: member.systemPrompt },
            { role: "user", content: summaryPrompt }
          ],
          { temperature: member.model.temperature, maxTokens: member.model.maxTokens }
        ).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[council] member summary generation failed", {
            sessionId,
            memberId: member.id,
            memberName: member.name,
            message
          });
          throw error;
        });
        await memoryStore.appendSessionSummary(member.id, sessionId, content);
      })
    );

    await memoryStore.appendCouncilSummary(
      sessionId,
      `- Leader: ${leaderId}\n- Ended by: ${endedBy}\n- Resolution: ${leaderSummary.finalResolution}`
    );

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
        motionId: winningMotion?.motionId ?? null,
        leaderId,
        executionBrief: leaderSummary.executionBrief
      };
      await writeFile(executionHandoffFile, `${toJsonString(handoffPayload)}\n`, "utf8");
    }

    await appendEvent(
      "SESSION_CLOSED",
      this.config.maxRounds,
      {
        endedBy,
        finalResolution: leaderSummary.finalResolution,
        requiresExecution: leaderSummary.requiresExecution,
        executionApproved,
        outputType
      }
    );

    await recorder.finalize({
      sessionId,
      councilName: this.config.councilName,
      leaderId,
      endedBy,
      finalResolution: leaderSummary.finalResolution,
      requiresExecution: leaderSummary.requiresExecution,
      executionApproved,
      winningMotion,
      outputType,
      outputDocumentFile
    });

    return {
      sessionId,
      leaderId,
      endedBy,
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
        {}
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
