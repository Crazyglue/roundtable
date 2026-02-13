import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CouncilConfig, CouncilEvent, CouncilMemberConfig } from "../types.js";
import { clampText, nowIso } from "../utils.js";

export class MemoryStore {
  constructor(private readonly config: CouncilConfig) {}

  private memberMemoryPath(memberId: string): string {
    return path.join(this.config.storage.memoryDir, memberId, "MEMORY.md");
  }

  private memberProfilePath(memberId: string): string {
    return path.join(this.config.storage.memoryDir, memberId, "AGENT.md");
  }

  private councilFilePath(): string {
    return path.join(this.config.storage.memoryDir, "COUNCIL.md");
  }

  async init(memberConfigs: CouncilMemberConfig[]): Promise<void> {
    await mkdir(this.config.storage.memoryDir, { recursive: true });
    await this.ensureCouncilFile(memberConfigs);
    await Promise.all(memberConfigs.map((member) => this.ensureMemberFiles(member)));
  }

  async readMemberMemory(memberId: string, maxChars = 6000): Promise<string> {
    const p = this.memberMemoryPath(memberId);
    const body = await readFile(p, "utf8");
    return clampText(body, maxChars);
  }

  async appendEventForAll(event: CouncilEvent): Promise<void> {
    const line = `- ${event.timestamp} [${event.phase}] ${event.type} ${JSON.stringify(event.payload)}\n`;
    await Promise.all(
      this.config.members.map(async (member) => {
        const p = this.memberMemoryPath(member.id);
        const current = await readFile(p, "utf8");
        const next = `${current}${line}`;
        await writeFile(p, next, "utf8");
      })
    );
  }

  async appendSessionSummary(memberId: string, sessionId: string, summary: string): Promise<void> {
    const p = this.memberMemoryPath(memberId);
    const current = await readFile(p, "utf8");
    const next = `${current}\n## Session Summary ${sessionId}\n${summary.trim()}\n`;
    await writeFile(p, next, "utf8");
  }

  async appendCouncilSummary(sessionId: string, summary: string): Promise<void> {
    const p = this.councilFilePath();
    const current = await readFile(p, "utf8");
    const next = `${current}\n## Session ${sessionId}\n${summary.trim()}\n`;
    await writeFile(p, next, "utf8");
  }

  private async ensureCouncilFile(memberConfigs: CouncilMemberConfig[]): Promise<void> {
    const p = this.councilFilePath();
    try {
      await readFile(p, "utf8");
      return;
    } catch {
      const body = [
        "# COUNCIL",
        "",
        `- Initialized: ${nowIso()}`,
        `- Council Name: ${this.config.councilName}`,
        `- Purpose: ${this.config.purpose}`,
        `- Max Rounds: ${this.config.maxRounds}`,
        "- Voting Rule: Majority of full council (abstentions count as NO)",
        "",
        "## Members",
        ...memberConfigs.map((m) => `- ${m.id}: ${m.name} (${m.role})`)
      ].join("\n");
      await writeFile(p, `${body}\n`, "utf8");
    }
  }

  private async ensureMemberFiles(member: CouncilMemberConfig): Promise<void> {
    const memberDir = path.join(this.config.storage.memoryDir, member.id);
    await mkdir(memberDir, { recursive: true });

    const profilePath = this.memberProfilePath(member.id);
    const memoryPath = this.memberMemoryPath(member.id);

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

    try {
      await readFile(memoryPath, "utf8");
    } catch {
      const seed = [
        `# MEMORY ${member.id}`,
        "",
        "## Rolling Event Notes",
        ""
      ].join("\n");
      await writeFile(memoryPath, seed, "utf8");
    }
  }
}
