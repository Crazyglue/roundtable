import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CouncilConfig, CouncilEvent } from "../types.js";
import { toJsonString } from "../utils.js";

export interface RecorderArtifacts {
  sessionDir: string;
  transcriptFile: string;
  eventsFile: string;
  sessionStateFile: string;
  leaderSummaryFile: string;
}

export class SessionRecorder {
  private readonly events: CouncilEvent[] = [];
  private readonly transcriptLines: string[] = [];
  private readonly artifacts: RecorderArtifacts;

  constructor(
    private readonly config: CouncilConfig,
    private readonly sessionId: string
  ) {
    const sessionDir = path.join(config.storage.rootDir, "sessions", sessionId);
    this.artifacts = {
      sessionDir,
      transcriptFile: path.join(sessionDir, "transcript.md"),
      eventsFile: path.join(sessionDir, "events.json"),
      sessionStateFile: path.join(sessionDir, "session.json"),
      leaderSummaryFile: path.join(sessionDir, "leader-summary.md")
    };
  }

  async init(humanPrompt: string): Promise<void> {
    await mkdir(this.artifacts.sessionDir, { recursive: true });
    const intro = [
      `# Session ${this.sessionId}`,
      "",
      `- Council: ${this.config.councilName}`,
      `- Purpose: ${this.config.purpose}`,
      `- Prompt: ${humanPrompt}`,
      ""
    ].join("\n");
    this.transcriptLines.push(intro);
    await this.flush();
  }

  async appendEvent(event: CouncilEvent): Promise<void> {
    this.events.push(event);
    this.transcriptLines.push(this.renderEventLine(event));
    await this.flush();
  }

  getTranscript(): string {
    return this.transcriptLines.join("\n");
  }

  getEvents(): CouncilEvent[] {
    return [...this.events];
  }

  async writeLeaderSummary(content: string): Promise<void> {
    await writeFile(this.artifacts.leaderSummaryFile, `${content.trim()}\n`, "utf8");
  }

  async finalize(payload: unknown): Promise<void> {
    await writeFile(this.artifacts.sessionStateFile, `${toJsonString(payload)}\n`, "utf8");
    await this.flush();
  }

  getArtifacts(): RecorderArtifacts {
    return this.artifacts;
  }

  private renderEventLine(event: CouncilEvent): string {
    const actor = event.actorId ? ` actor=${event.actorId}` : "";
    return `- ${event.timestamp} [${event.phase}] ${event.type}${actor} :: ${JSON.stringify(event.payload)}`;
  }

  private async flush(): Promise<void> {
    await writeFile(this.artifacts.eventsFile, `${toJsonString(this.events)}\n`, "utf8");
    await writeFile(this.artifacts.transcriptFile, `${this.transcriptLines.join("\n")}\n`, "utf8");
  }
}
