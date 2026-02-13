import { readFile } from "node:fs/promises";
import path from "node:path";
import { CouncilConfig } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Config validation error: ${message}`);
  }
}

export async function loadConfig(configPath: string): Promise<CouncilConfig> {
  const absolute = path.resolve(configPath);
  const raw = await readFile(absolute, "utf8");
  const parsed = JSON.parse(raw) as Partial<CouncilConfig>;

  assert(typeof parsed.councilName === "string" && parsed.councilName.length > 0, "councilName is required");
  assert(typeof parsed.purpose === "string" && parsed.purpose.length > 0, "purpose is required");
  assert(typeof parsed.maxRounds === "number" && parsed.maxRounds > 0, "maxRounds must be > 0");
  assert(Array.isArray(parsed.members) && parsed.members.length >= 3, "members must include at least 3 entries");
  assert(parsed.members.length % 2 === 1, "members must be an odd count");
  assert(parsed.storage?.rootDir, "storage.rootDir is required");
  assert(parsed.storage?.memoryDir, "storage.memoryDir is required");
  assert(parsed.execution?.defaultExecutorProfile, "execution.defaultExecutorProfile is required");
  assert(typeof parsed.execution?.requireHumanApproval === "boolean", "execution.requireHumanApproval must be boolean");

  const members = parsed.members as CouncilConfig["members"];
  const storage = parsed.storage as CouncilConfig["storage"];
  const execution = parsed.execution as CouncilConfig["execution"];

  for (const member of members) {
    assert(member.id, "each member requires id");
    assert(member.name, "each member requires name");
    assert(member.role, "each member requires role");
    assert(member.systemPrompt, `member ${member.id} requires systemPrompt`);
    assert(Array.isArray(member.traits), `member ${member.id} requires traits[]`);
    assert(typeof member.focusWeights === "object" && member.focusWeights !== null, `member ${member.id} requires focusWeights`);
    assert(member.model?.provider, `member ${member.id} requires model.provider`);
    assert(member.model?.model, `member ${member.id} requires model.model`);
    assert(member.model?.apiKeyEnv, `member ${member.id} requires model.apiKeyEnv`);
  }

  if (parsed.turnOrder) {
    assert(Array.isArray(parsed.turnOrder), "turnOrder must be an array when provided");
    assert(parsed.turnOrder.length === members.length, "turnOrder must include every member");
    const allIds = new Set(members.map((m) => m.id));
    for (const id of parsed.turnOrder) {
      assert(allIds.has(id), `turnOrder references unknown member id: ${id}`);
    }
  }

  return {
    councilName: parsed.councilName,
    purpose: parsed.purpose,
    maxRounds: parsed.maxRounds,
    members,
    turnOrder: parsed.turnOrder,
    storage,
    execution
  };
}
