import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CouncilConfig,
  CouncilEvent,
  CouncilMemberConfig,
  CouncilOutputType,
  LeaderSummary,
  SessionResult
} from "../types.js";
import { nowIso, toJsonString } from "../utils.js";

type MemoryKind =
  | "preference"
  | "constraint"
  | "decision"
  | "assumption"
  | "risk_pattern"
  | "lesson"
  | "open_loop"
  | "outcome";

type MemoryStatus = "active" | "resolved" | "superseded" | "stale";

interface EvidenceRef {
  sessionId: string;
  eventType?: string;
  artifactPath?: string;
  note?: string;
}

interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  summary: string;
  detail?: string;
  tags: string[];
  confidence: number;
  importance: 1 | 2 | 3 | 4 | 5;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  supersedes?: string[];
  evidence: EvidenceRef[];
}

interface PromptContextV2 {
  constraints: string[];
  keyDecisions: string[];
  topRisks: string[];
  openLoops: string[];
  preferences: string[];
  antiPatterns: string[];
  updatedAt: string;
}

interface SessionDigest {
  sessionId: string;
  timestamp: string;
  finalResolution: string;
  stance: string;
}

interface MemberMemoryV2 {
  version: "2";
  memberId: string;
  records: MemoryRecord[];
  promptContext: PromptContextV2;
  recentSessions: SessionDigest[];
  createdAt: string;
  updatedAt: string;
}

interface CouncilSessionDigest {
  sessionId: string;
  timestamp: string;
  leaderId: string;
  endedBy: SessionResult["endedBy"];
  finalResolution: string;
  outputType: CouncilOutputType;
}

interface CouncilMemoryV2 {
  version: "2";
  councilName: string;
  globalDecisions: MemoryRecord[];
  crossAgentLessons: MemoryRecord[];
  sessions: CouncilSessionDigest[];
  createdAt: string;
  updatedAt: string;
}

interface RecordSessionInput {
  sessionId: string;
  humanPrompt: string;
  leaderId: string;
  endedBy: SessionResult["endedBy"];
  finalResolution: string;
  outputType: CouncilOutputType;
  leaderSummary: LeaderSummary;
  events: CouncilEvent[];
  executionApproved: boolean;
}

const MEMBER_RECORD_LIMIT = 80;
const SESSION_DIGEST_LIMIT = 40;
const PROMPT_CONTEXT_SESSION_WINDOW = 25;
const COUNCIL_SESSION_LIMIT = 50;
const COUNCIL_RECORD_LIMIT = 80;

export class MemoryStore {
  constructor(private readonly config: CouncilConfig) {}

  private memberMemoryMarkdownPath(memberId: string): string {
    return path.join(this.config.storage.memoryDir, memberId, "MEMORY.md");
  }

  private memberMemoryJsonPath(memberId: string): string {
    return path.join(this.config.storage.memoryDir, memberId, "MEMORY.json");
  }

  private memberProfilePath(memberId: string): string {
    return path.join(this.config.storage.memoryDir, memberId, "AGENT.md");
  }

  private councilMarkdownPath(): string {
    return path.join(this.config.storage.memoryDir, "COUNCIL.md");
  }

  private councilJsonPath(): string {
    return path.join(this.config.storage.memoryDir, "COUNCIL.json");
  }

  async init(memberConfigs: CouncilMemberConfig[]): Promise<void> {
    await mkdir(this.config.storage.memoryDir, { recursive: true });
    await this.ensureCouncilFiles(memberConfigs);
    await Promise.all(memberConfigs.map(async (member) => this.ensureMemberFiles(member)));
  }

  async readMemberMemory(memberId: string, maxChars = 6000): Promise<string> {
    const memory = await this.readMemberMemoryJson(memberId);
    const promptSnapshot = this.renderPromptSnapshot(memory);
    if (promptSnapshot.length <= maxChars) {
      return promptSnapshot;
    }
    return promptSnapshot.slice(0, maxChars);
  }

  async recordSession(input: RecordSessionInput): Promise<void> {
    await Promise.all(
      this.config.members.map(async (member) => {
        const memory = await this.readMemberMemoryJson(member.id);
        const next = this.applySessionToMemberMemory(memory, member, input);
        await this.writeMemberMemory(next);
      })
    );

    const council = await this.readCouncilMemoryJson();
    const nextCouncil = this.applySessionToCouncilMemory(council, input);
    await this.writeCouncilMemory(nextCouncil);
  }

  private async ensureCouncilFiles(memberConfigs: CouncilMemberConfig[]): Promise<void> {
    const council = await this.readCouncilMemoryJsonOrNull();
    if (council) {
      await this.writeCouncilMemory(council);
      return;
    }

    const createdAt = nowIso();
    const seed: CouncilMemoryV2 = {
      version: "2",
      councilName: this.config.councilName,
      globalDecisions: [],
      crossAgentLessons: [],
      sessions: [],
      createdAt,
      updatedAt: createdAt
    };
    await this.writeCouncilMemory(seed, memberConfigs);
  }

  private async ensureMemberFiles(member: CouncilMemberConfig): Promise<void> {
    const memberDir = path.join(this.config.storage.memoryDir, member.id);
    await mkdir(memberDir, { recursive: true });

    const profilePath = this.memberProfilePath(member.id);
    try {
      await readFile(profilePath, "utf8");
    } catch {
      const profile = [
        `# AGENT ${member.id}`,
        "",
        `- Name: ${member.name}`,
        `- Role: ${member.role}`,
        `- Traits: ${member.traits.join(", ")}`,
        `- Focus Weights: ${JSON.stringify(member.focusWeights)}`,
        "",
        "## System Prompt",
        "",
        member.systemPrompt
      ].join("\n");
      await writeFile(profilePath, `${profile}\n`, "utf8");
    }

    const existing = await this.readMemberMemoryJsonOrNull(member.id);
    if (existing) {
      await this.writeMemberMemory(existing);
      return;
    }

    const createdAt = nowIso();
    const seed: MemberMemoryV2 = {
      version: "2",
      memberId: member.id,
      records: [],
      promptContext: {
        constraints: [],
        keyDecisions: [],
        topRisks: [],
        openLoops: [],
        preferences: [],
        antiPatterns: [],
        updatedAt: createdAt
      },
      recentSessions: [],
      createdAt,
      updatedAt: createdAt
    };
    await this.writeMemberMemory(seed);
  }

  private applySessionToMemberMemory(
    memory: MemberMemoryV2,
    member: CouncilMemberConfig,
    input: RecordSessionInput
  ): MemberMemoryV2 {
    const now = nowIso();
    const records = [...memory.records];
    const memberMessages = this.getMemberMessages(input.events, member.id);

    this.upsertRecord(records, {
      id: `decision:${input.sessionId}`,
      kind: "decision",
      status: "active",
      summary: this.clamp(input.finalResolution, 220),
      detail: this.clamp(
        `Session result for task "${input.humanPrompt}". Ended by ${input.endedBy}. Leader: ${input.leaderId}.`,
        800
      ),
      tags: ["resolution", "session"],
      confidence: 0.9,
      importance: 5,
      createdAt: now,
      updatedAt: now,
      evidence: [{ sessionId: input.sessionId, eventType: "LEADER_SUMMARY", artifactPath: "leader-summary.md" }]
    });

    this.upsertRecord(records, {
      id: `outcome:${input.sessionId}:${member.id}`,
      kind: "outcome",
      status: "active",
      summary: this.clamp(
        memberMessages.length > 0
          ? `Stance this session: ${memberMessages[memberMessages.length - 1]}`
          : "No direct contribution captured from this member in this session.",
        220
      ),
      detail: this.clamp(
        memberMessages.length > 0
          ? `Captured ${memberMessages.length} contribution(s) from ${member.id}.`
          : `Member ${member.id} did not contribute MESSAGE_CONTRIBUTED content.`,
        800
      ),
      tags: ["stance", "member", member.id],
      confidence: memberMessages.length > 0 ? 0.8 : 0.55,
      importance: 3,
      createdAt: now,
      updatedAt: now,
      evidence: [{ sessionId: input.sessionId, eventType: "MESSAGE_CONTRIBUTED" }]
    });

    const parseFallbackCount = this.countParseFallbacks(input.events, member.id);
    if (parseFallbackCount > 0) {
      this.upsertRecord(records, {
        id: `risk_pattern:parse_fallback:${member.id}`,
        kind: "risk_pattern",
        status: "active",
        summary: this.clamp(
          `${parseFallbackCount} turn action(s) used JSON parse fallback this session.`,
          220
        ),
        detail: this.clamp(
          "Model responses failed strict JSON parsing and were converted into PASS actions. Keep outputs strictly schema-compliant.",
          800
        ),
        tags: ["model-output", "json", "reliability", member.id],
        confidence: 0.95,
        importance: 4,
        createdAt: now,
        updatedAt: now,
        evidence: [{ sessionId: input.sessionId, eventType: "TURN_ACTION" }]
      });
    }

    if (input.endedBy === "ROUND_LIMIT") {
      this.upsertRecord(records, {
        id: `open_loop:consensus:${input.sessionId}`,
        kind: "open_loop",
        status: "active",
        summary: "No majority resolution reached before round limit.",
        detail: this.clamp(
          "Re-enter this topic with a narrower decision scope or a pre-committed tie-break process to force convergence.",
          800
        ),
        tags: ["consensus", "process", "follow-up"],
        confidence: 0.9,
        importance: 4,
        createdAt: now,
        updatedAt: now,
        evidence: [{ sessionId: input.sessionId, eventType: "ROUND_LIMIT_REACHED" }]
      });
    }

    if (input.leaderSummary.requiresExecution) {
      const status = input.executionApproved ? "Execution approved." : "Execution pending human approval.";
      this.upsertRecord(records, {
        id: `open_loop:execution:${input.sessionId}`,
        kind: "open_loop",
        status: input.executionApproved ? "resolved" : "active",
        summary: this.clamp(status, 220),
        detail: this.clamp(
          input.leaderSummary.executionBrief?.objective ?? "Execution brief present in leader summary.",
          800
        ),
        tags: ["execution", "handoff"],
        confidence: 0.95,
        importance: 5,
        createdAt: now,
        updatedAt: now,
        resolvedAt: input.executionApproved ? now : undefined,
        evidence: [{ sessionId: input.sessionId, eventType: "SESSION_CLOSED", artifactPath: "execution-handoff.json" }]
      });
    }

    const recentSessions = [
      {
        sessionId: input.sessionId,
        timestamp: now,
        finalResolution: this.clamp(input.finalResolution, 300),
        stance: this.clamp(
          memberMessages.length > 0
            ? memberMessages[memberMessages.length - 1]
            : "No direct member contribution recorded.",
          220
        )
      },
      ...memory.recentSessions.filter((item) => item.sessionId !== input.sessionId)
    ].slice(0, SESSION_DIGEST_LIMIT);

    const compactRecords = this.pruneRecords(records, MEMBER_RECORD_LIMIT);
    const promptContext = this.buildPromptContext(compactRecords, recentSessions);

    return {
      ...memory,
      records: compactRecords,
      promptContext,
      recentSessions,
      updatedAt: now
    };
  }

  private applySessionToCouncilMemory(council: CouncilMemoryV2, input: RecordSessionInput): CouncilMemoryV2 {
    const now = nowIso();
    const globalDecisions = [...council.globalDecisions];
    const crossAgentLessons = [...council.crossAgentLessons];

    this.upsertRecord(globalDecisions, {
      id: `decision:${input.sessionId}`,
      kind: "decision",
      status: "active",
      summary: this.clamp(input.finalResolution, 220),
      detail: this.clamp(
        `Council resolution for task "${input.humanPrompt}" (ended by ${input.endedBy}, leader ${input.leaderId}).`,
        800
      ),
      tags: ["resolution", "council"],
      confidence: 0.9,
      importance: 5,
      createdAt: now,
      updatedAt: now,
      evidence: [{ sessionId: input.sessionId, eventType: "LEADER_SUMMARY", artifactPath: "leader-summary.md" }]
    });

    const parseFallbackCount = this.countParseFallbacks(input.events);
    if (parseFallbackCount > 0) {
      this.upsertRecord(crossAgentLessons, {
        id: "lesson:json_parse_fallback",
        kind: "lesson",
        status: "active",
        summary: this.clamp(
          `Session ${input.sessionId} recorded ${parseFallbackCount} fallback PASS conversion(s) from invalid JSON output.`,
          220
        ),
        detail: this.clamp(
          "Strict JSON contracts are brittle under long prompts. Keep schema instructions explicit and bounded to reduce conversion-to-PASS failures.",
          800
        ),
        tags: ["model-output", "json", "quality"],
        confidence: 0.95,
        importance: 4,
        createdAt: now,
        updatedAt: now,
        evidence: [{ sessionId: input.sessionId, eventType: "TURN_ACTION" }]
      });
    }

    const sessions = [
      {
        sessionId: input.sessionId,
        timestamp: now,
        leaderId: input.leaderId,
        endedBy: input.endedBy,
        finalResolution: this.clamp(input.finalResolution, 300),
        outputType: input.outputType
      },
      ...council.sessions.filter((item) => item.sessionId !== input.sessionId)
    ].slice(0, COUNCIL_SESSION_LIMIT);

    return {
      ...council,
      globalDecisions: this.pruneRecords(globalDecisions, COUNCIL_RECORD_LIMIT),
      crossAgentLessons: this.pruneRecords(crossAgentLessons, COUNCIL_RECORD_LIMIT),
      sessions,
      updatedAt: now
    };
  }

  private getMemberMessages(events: CouncilEvent[], memberId: string): string[] {
    return events
      .filter((event) => event.type === "MESSAGE_CONTRIBUTED" && event.actorId === memberId)
      .map((event) => {
        if (!event.payload || typeof event.payload !== "object") {
          return "";
        }
        const payload = event.payload as { message?: unknown };
        return typeof payload.message === "string" ? this.normalizeInline(payload.message) : "";
      })
      .filter((value) => value.length > 0)
      .map((value) => this.clamp(value, 200));
  }

  private countParseFallbacks(events: CouncilEvent[], memberId?: string): number {
    return events.filter((event) => {
      if (event.type !== "TURN_ACTION") {
        return false;
      }
      if (memberId && event.actorId !== memberId) {
        return false;
      }
      if (!event.payload || typeof event.payload !== "object") {
        return false;
      }
      const payload = event.payload as { action?: unknown; reason?: unknown };
      if (payload.action !== "PASS") {
        return false;
      }
      return typeof payload.reason === "string" && payload.reason.toLowerCase().includes("json parse error");
    }).length;
  }

  private pruneRecords(records: MemoryRecord[], limit: number): MemoryRecord[] {
    const dedup = new Map<string, MemoryRecord>();
    for (const record of records) {
      dedup.set(record.id, record);
    }
    return [...dedup.values()]
      .sort((a, b) => {
        if (a.importance !== b.importance) {
          return b.importance - a.importance;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, limit);
  }

  private upsertRecord(records: MemoryRecord[], incoming: MemoryRecord): void {
    const index = records.findIndex((record) => record.id === incoming.id);
    if (index >= 0) {
      const previous = records[index];
      records[index] = {
        ...previous,
        ...incoming,
        createdAt: previous.createdAt,
        updatedAt: incoming.updatedAt,
        evidence: this.mergeEvidence(previous.evidence, incoming.evidence)
      };
      return;
    }
    records.push(incoming);
  }

  private mergeEvidence(previous: EvidenceRef[], incoming: EvidenceRef[]): EvidenceRef[] {
    const merged = [...previous, ...incoming];
    const keyFor = (item: EvidenceRef): string =>
      `${item.sessionId}|${item.eventType ?? ""}|${item.artifactPath ?? ""}|${item.note ?? ""}`;
    const dedup = new Map<string, EvidenceRef>();
    for (const item of merged) {
      dedup.set(keyFor(item), item);
    }
    return [...dedup.values()].slice(-8);
  }

  private buildPromptContext(records: MemoryRecord[], recentSessions: SessionDigest[]): PromptContextV2 {
    const activeSessionIds = new Set(
      recentSessions.slice(0, PROMPT_CONTEXT_SESSION_WINDOW).map((session) => session.sessionId)
    );
    const scopedRecords = records.filter((record) => {
      if (record.evidence.length === 0) {
        return true;
      }
      return record.evidence.some((item) => activeSessionIds.has(item.sessionId));
    });

    const pick = (kind: MemoryKind, limit: number): string[] =>
      scopedRecords
        .filter((record) => record.kind === kind && record.status === "active")
        .slice(0, limit)
        .map((record) => record.summary);

    const constraints = pick("constraint", 4);
    const keyDecisions = pick("decision", 5);
    const topRisks = [
      ...pick("risk_pattern", 3),
      ...pick("assumption", 2)
    ].slice(0, 4);
    const openLoops = pick("open_loop", 4);
    const preferences = pick("preference", 3);
    const antiPatterns = pick("lesson", 3);

    return {
      constraints,
      keyDecisions,
      topRisks,
      openLoops,
      preferences,
      antiPatterns,
      updatedAt: nowIso()
    };
  }

  private renderPromptSnapshot(memory: MemberMemoryV2): string {
    const lines: string[] = [
      `# Memory Snapshot (${memory.memberId})`,
      `- Updated: ${memory.updatedAt}`,
      "",
      "## Constraints"
    ];

    this.appendLines(lines, memory.promptContext.constraints, "No durable constraints recorded yet.");

    lines.push("", "## Key Decisions");
    this.appendLines(lines, memory.promptContext.keyDecisions, "No durable decisions recorded yet.");

    lines.push("", "## Top Risks");
    this.appendLines(lines, memory.promptContext.topRisks, "No major recurring risks recorded yet.");

    lines.push("", "## Open Loops");
    this.appendLines(lines, memory.promptContext.openLoops, "No open loops.");

    lines.push("", "## Preferences");
    this.appendLines(lines, memory.promptContext.preferences, "No explicit preferences recorded yet.");

    lines.push("", "## Anti-Patterns");
    this.appendLines(lines, memory.promptContext.antiPatterns, "No anti-patterns recorded yet.");

    lines.push("", "## Recent Sessions");
    if (memory.recentSessions.length === 0) {
      lines.push("- None");
    } else {
      for (const session of memory.recentSessions.slice(0, 5)) {
        lines.push(
          `- ${session.sessionId}: ${this.clamp(session.finalResolution, 160)} (stance: ${this.clamp(session.stance, 120)})`
        );
      }
    }

    return lines.join("\n");
  }

  private renderMemberMarkdown(memory: MemberMemoryV2): string {
    const lines: string[] = [
      `# MEMORY ${memory.memberId}`,
      "",
      `- Version: ${memory.version}`,
      `- Updated: ${memory.updatedAt}`,
      `- Records: ${memory.records.length}`,
      "",
      "## Prompt Context",
      "",
      "### Constraints"
    ];

    this.appendLines(lines, memory.promptContext.constraints, "None");

    lines.push("", "### Key Decisions");
    this.appendLines(lines, memory.promptContext.keyDecisions, "None");

    lines.push("", "### Top Risks");
    this.appendLines(lines, memory.promptContext.topRisks, "None");

    lines.push("", "### Open Loops");
    this.appendLines(lines, memory.promptContext.openLoops, "None");

    lines.push("", "### Preferences");
    this.appendLines(lines, memory.promptContext.preferences, "None");

    lines.push("", "### Anti-Patterns");
    this.appendLines(lines, memory.promptContext.antiPatterns, "None");

    lines.push("", "## Active Records");
    const active = memory.records.filter((record) => record.status === "active");
    if (active.length === 0) {
      lines.push("- None");
    } else {
      for (const record of active.slice(0, 25)) {
        lines.push(
          `- [${record.kind}] ${record.summary} (importance ${record.importance}, confidence ${record.confidence.toFixed(2)})`
        );
      }
    }

    lines.push("", "## Recent Sessions");
    if (memory.recentSessions.length === 0) {
      lines.push("- None");
    } else {
      for (const session of memory.recentSessions) {
        lines.push(`- ${session.sessionId} (${session.timestamp}): ${session.finalResolution}`);
      }
    }

    return lines.join("\n");
  }

  private renderCouncilMarkdown(council: CouncilMemoryV2, memberConfigs?: CouncilMemberConfig[]): string {
    const lines: string[] = [
      "# COUNCIL",
      "",
      `- Version: ${council.version}`,
      `- Initialized: ${council.createdAt}`,
      `- Updated: ${council.updatedAt}`,
      `- Council Name: ${this.config.councilName}`,
      `- Purpose: ${this.config.purpose}`,
      `- Entry Phase: ${this.config.sessionPolicy.entryPhaseId}`,
      `- Max Phase Transitions: ${this.config.sessionPolicy.maxPhaseTransitions}`,
      "- Voting Rule: Per-phase governance thresholds (see session config)",
      ""
    ];

    const members = memberConfigs ?? this.config.members;
    lines.push("## Members");
    for (const member of members) {
      lines.push(`- ${member.id}: ${member.name} (${member.role})`);
    }

    lines.push("", "## Global Decisions");
    if (council.globalDecisions.length === 0) {
      lines.push("- None");
    } else {
      for (const record of council.globalDecisions.slice(0, 20)) {
        lines.push(`- ${record.summary}`);
      }
    }

    lines.push("", "## Cross-Agent Lessons");
    if (council.crossAgentLessons.length === 0) {
      lines.push("- None");
    } else {
      for (const record of council.crossAgentLessons.slice(0, 20)) {
        lines.push(`- ${record.summary}`);
      }
    }

    lines.push("", "## Recent Sessions");
    if (council.sessions.length === 0) {
      lines.push("- None");
    } else {
      for (const session of council.sessions) {
        lines.push(
          `- ${session.sessionId} | leader=${session.leaderId} | endedBy=${session.endedBy} | output=${session.outputType}`
        );
        lines.push(`  - resolution: ${session.finalResolution}`);
      }
    }

    return lines.join("\n");
  }

  private appendLines(target: string[], values: string[], fallback: string): void {
    if (values.length === 0) {
      target.push(`- ${fallback}`);
      return;
    }
    for (const item of values) {
      target.push(`- ${item}`);
    }
  }

  private normalizeInline(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  private clamp(value: string, maxChars: number): string {
    const normalized = this.normalizeInline(value);
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  private async readMemberMemoryJson(memberId: string): Promise<MemberMemoryV2> {
    const existing = await this.readMemberMemoryJsonOrNull(memberId);
    if (!existing) {
      const createdAt = nowIso();
      return {
        version: "2",
        memberId,
        records: [],
        promptContext: {
          constraints: [],
          keyDecisions: [],
          topRisks: [],
          openLoops: [],
          preferences: [],
          antiPatterns: [],
          updatedAt: createdAt
        },
        recentSessions: [],
        createdAt,
        updatedAt: createdAt
      };
    }
    return existing;
  }

  private async readMemberMemoryJsonOrNull(memberId: string): Promise<MemberMemoryV2 | null> {
    const p = this.memberMemoryJsonPath(memberId);
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as Partial<MemberMemoryV2>;
      if (parsed.version !== "2" || parsed.memberId !== memberId) {
        return null;
      }
      if (!Array.isArray(parsed.records) || !Array.isArray(parsed.recentSessions) || !parsed.promptContext) {
        return null;
      }
      return parsed as MemberMemoryV2;
    } catch {
      return null;
    }
  }

  private async writeMemberMemory(memory: MemberMemoryV2): Promise<void> {
    const jsonPath = this.memberMemoryJsonPath(memory.memberId);
    const mdPath = this.memberMemoryMarkdownPath(memory.memberId);
    await writeFile(jsonPath, `${toJsonString(memory)}\n`, "utf8");
    await writeFile(mdPath, `${this.renderMemberMarkdown(memory)}\n`, "utf8");
  }

  private async readCouncilMemoryJson(): Promise<CouncilMemoryV2> {
    const existing = await this.readCouncilMemoryJsonOrNull();
    if (existing) {
      return existing;
    }
    const createdAt = nowIso();
    return {
      version: "2",
      councilName: this.config.councilName,
      globalDecisions: [],
      crossAgentLessons: [],
      sessions: [],
      createdAt,
      updatedAt: createdAt
    };
  }

  private async readCouncilMemoryJsonOrNull(): Promise<CouncilMemoryV2 | null> {
    const p = this.councilJsonPath();
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as Partial<CouncilMemoryV2>;
      if (parsed.version !== "2" || parsed.councilName !== this.config.councilName) {
        return null;
      }
      if (!Array.isArray(parsed.globalDecisions) || !Array.isArray(parsed.crossAgentLessons) || !Array.isArray(parsed.sessions)) {
        return null;
      }
      return parsed as CouncilMemoryV2;
    } catch {
      return null;
    }
  }

  private async writeCouncilMemory(council: CouncilMemoryV2, memberConfigs?: CouncilMemberConfig[]): Promise<void> {
    const jsonPath = this.councilJsonPath();
    const mdPath = this.councilMarkdownPath();
    await writeFile(jsonPath, `${toJsonString(council)}\n`, "utf8");
    await writeFile(mdPath, `${this.renderCouncilMarkdown(council, memberConfigs)}\n`, "utf8");
  }
}
