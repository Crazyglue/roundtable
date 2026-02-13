import path from "node:path";
import { loadConfig } from "./config.js";
import { CouncilOrchestrator } from "./council/orchestrator.js";

interface CliArgs {
  command: string;
  configPath: string;
  prompt: string;
  approveExecution: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  const map = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < rest.length; i += 1) {
    const current = rest[i];
    const next = rest[i + 1];
    if (current.startsWith("--")) {
      if (!next || next.startsWith("--")) {
        flags.add(current);
        continue;
      }
      map.set(current, next);
      i += 1;
    }
  }

  return {
    command: command ?? "run",
    configPath: map.get("--config") ?? "council.config.json",
    prompt: map.get("--prompt") ?? "",
    approveExecution: flags.has("--approve-execution")
  };
}

function usage(): string {
  return [
    "Usage:",
    '  npm run start -- run --config council.config.json --prompt "Your task prompt"',
    "",
    "Options:",
    "  --config <path>            Path to council config JSON",
    "  --prompt <text>            Human task prompt",
    "  --approve-execution        Mark execution handoff as approved"
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "run") {
    throw new Error(`Unsupported command: ${args.command}\n\n${usage()}`);
  }

  if (!args.prompt.trim()) {
    throw new Error(`Missing required --prompt argument.\n\n${usage()}`);
  }

  const config = await loadConfig(args.configPath);
  const orchestrator = new CouncilOrchestrator(config);
  const result = await orchestrator.run({
    humanPrompt: args.prompt.trim(),
    approveExecution: args.approveExecution
  });

  const cwd = process.cwd();
  const maybeRelative = (p: string): string => {
    const rel = path.relative(cwd, p);
    return rel.startsWith("..") ? p : rel;
  };

  console.log("Council session complete:");
  console.log(`- sessionId: ${result.sessionId}`);
  console.log(`- leaderId: ${result.leaderId}`);
  console.log(`- endedBy: ${result.endedBy}`);
  console.log(`- finalResolution: ${result.finalResolution}`);
  console.log(`- requiresExecution: ${result.requiresExecution}`);
  console.log(`- executionApproved: ${result.executionApproved}`);
  console.log("- artifacts:");
  console.log(`  - transcript: ${maybeRelative(result.artifacts.transcriptFile)}`);
  console.log(`  - events: ${maybeRelative(result.artifacts.eventsFile)}`);
  console.log(`  - session: ${maybeRelative(result.artifacts.sessionStateFile)}`);
  console.log(`  - leaderSummary: ${maybeRelative(result.artifacts.leaderSummaryFile)}`);
  if (result.artifacts.executionHandoffFile) {
    console.log(`  - executionHandoff: ${maybeRelative(result.artifacts.executionHandoffFile)}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
