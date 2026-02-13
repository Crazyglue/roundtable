import path from "node:path";
import { loadConfig } from "./config.js";
import { CouncilOrchestrator } from "./council/orchestrator.js";
import { runOnboarding } from "./onboarding/onboard.js";
import { CouncilOutputType } from "./types.js";

interface CliArgs {
  command: string;
  configPath: string;
  credentialStorePath?: string;
  prompt: string;
  approveExecution: boolean;
  outputType: CouncilOutputType;
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

  const outputTypeFlag = map.get("--output-type");
  const outputType: CouncilOutputType =
    outputTypeFlag === "documentation" ? "documentation" : "none";
  const promptValue = map.get("--prompt") ?? "";
  const inlineOutputTypeMatch = promptValue.match(/\[output:(documentation)\]/i);
  const inlineOutputType = inlineOutputTypeMatch?.[1]?.toLowerCase() as
    | "documentation"
    | undefined;
  const cleanedPrompt = promptValue.replace(/\[output:(documentation)\]/ig, "").trim();

  return {
    command: command ?? "run",
    configPath: map.get("--config") ?? "council.config.json",
    credentialStorePath: map.get("--credentials"),
    prompt: cleanedPrompt,
    approveExecution: flags.has("--approve-execution"),
    outputType: inlineOutputType ?? outputType
  };
}

function usage(): string {
  return [
    "Usage:",
    '  npm run start -- run --config council.config.json --prompt "Your task prompt"',
    "  npm run start -- onboard --config council.config.json",
    "",
    "Options:",
    "  --config <path>            Path to council config JSON",
    "  --credentials <path>       Path to credential store JSON",
    "  --prompt <text>            Human task prompt",
    "  --output-type <type>       Output artifact type (documentation)",
    "  --approve-execution        Mark execution handoff as approved"
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "onboard") {
    await runOnboarding({
      configPath: args.configPath,
      credentialStorePath: args.credentialStorePath
    });
    return;
  }

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
    approveExecution: args.approveExecution,
    outputType: args.outputType
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
  console.log(`- outputType: ${result.outputType}`);
  console.log("- artifacts:");
  console.log(`  - transcript: ${maybeRelative(result.artifacts.transcriptFile)}`);
  console.log(`  - events: ${maybeRelative(result.artifacts.eventsFile)}`);
  console.log(`  - session: ${maybeRelative(result.artifacts.sessionStateFile)}`);
  console.log(`  - leaderSummary: ${maybeRelative(result.artifacts.leaderSummaryFile)}`);
  if (result.artifacts.executionHandoffFile) {
    console.log(`  - executionHandoff: ${maybeRelative(result.artifacts.executionHandoffFile)}`);
  }
  if (result.artifacts.outputDocumentFile) {
    console.log(`  - outputDocument: ${maybeRelative(result.artifacts.outputDocumentFile)}`);
  }
}

main().catch((error) => {
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
  } else {
    console.error(`Error: ${String(error)}`);
  }
  process.exitCode = 1;
});
