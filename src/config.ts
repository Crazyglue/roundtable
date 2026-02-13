import { readFile } from "node:fs/promises";
import path from "node:path";
import { CouncilConfig, DeliberationConfig, ModelAuthConfig } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Config validation error: ${message}`);
  }
}

function validateAuthConfig(auth: ModelAuthConfig, memberId: string): void {
  if (auth.method === "api-key-env") {
    assert(Boolean(auth.apiKeyEnv), `member ${memberId} auth.apiKeyEnv is required`);
    return;
  }

  if (auth.method === "oauth-device-code") {
    assert(Boolean(auth.clientId), `member ${memberId} auth.clientId is required`);
    assert(
      Boolean(auth.deviceAuthorizationEndpoint),
      `member ${memberId} auth.deviceAuthorizationEndpoint is required`
    );
    assert(Boolean(auth.tokenEndpoint), `member ${memberId} auth.tokenEndpoint is required`);
    return;
  }

  if (auth.method === "command") {
    assert(Boolean(auth.command), `member ${memberId} auth.command is required`);
    if (auth.cacheTtlSeconds !== undefined) {
      assert(auth.cacheTtlSeconds > 0, `member ${memberId} auth.cacheTtlSeconds must be > 0`);
    }
    return;
  }

  if (auth.method === "credential-ref") {
    assert(Boolean(auth.credentialId), `member ${memberId} auth.credentialId is required`);
    return;
  }

  const exhaustive: never = auth;
  throw new Error(`Unhandled auth method for member ${memberId}: ${JSON.stringify(exhaustive)}`);
}

export async function loadConfig(configPath: string): Promise<CouncilConfig> {
  const absolute = path.resolve(configPath);
  const raw = await readFile(absolute, "utf8");
  const parsed = JSON.parse(raw) as Partial<CouncilConfig>;

  assert(typeof parsed.councilName === "string" && parsed.councilName.length > 0, "councilName is required");
  assert(typeof parsed.purpose === "string" && parsed.purpose.length > 0, "purpose is required");
  assert(Array.isArray(parsed.members) && parsed.members.length >= 3, "members must include at least 3 entries");
  assert(parsed.members.length % 2 === 1, "members must be an odd count");
  assert(parsed.storage?.rootDir, "storage.rootDir is required");
  assert(parsed.storage?.memoryDir, "storage.memoryDir is required");
  assert(parsed.execution?.defaultExecutorProfile, "execution.defaultExecutorProfile is required");
  assert(typeof parsed.execution?.requireHumanApproval === "boolean", "execution.requireHumanApproval must be boolean");

  if (parsed.maxRounds !== undefined) {
    assert(typeof parsed.maxRounds === "number" && parsed.maxRounds > 0, "maxRounds must be > 0");
  }

  const defaultRounds =
    typeof parsed.maxRounds === "number" && parsed.maxRounds > 0 ? parsed.maxRounds : 5;
  const deliberationCandidate = parsed.deliberation as Partial<DeliberationConfig> | undefined;
  if (deliberationCandidate !== undefined) {
    assert(typeof deliberationCandidate === "object", "deliberation must be an object");
    if (deliberationCandidate.highLevelRounds !== undefined) {
      assert(
        typeof deliberationCandidate.highLevelRounds === "number" &&
          deliberationCandidate.highLevelRounds > 0,
        "deliberation.highLevelRounds must be > 0"
      );
    }
    if (deliberationCandidate.implementationRounds !== undefined) {
      assert(
        typeof deliberationCandidate.implementationRounds === "number" &&
          deliberationCandidate.implementationRounds > 0,
        "deliberation.implementationRounds must be > 0"
      );
    }
  }

  const members = parsed.members as CouncilConfig["members"];
  const storage = parsed.storage as CouncilConfig["storage"];
  const execution = parsed.execution as CouncilConfig["execution"];
  const deliberation: DeliberationConfig = {
    highLevelRounds: deliberationCandidate?.highLevelRounds ?? defaultRounds,
    implementationRounds: deliberationCandidate?.implementationRounds ?? defaultRounds
  };

  for (const member of members) {
    assert(member.id, "each member requires id");
    assert(member.name, "each member requires name");
    assert(member.role, "each member requires role");
    assert(member.systemPrompt, `member ${member.id} requires systemPrompt`);
    assert(Array.isArray(member.traits), `member ${member.id} requires traits[]`);
    assert(typeof member.focusWeights === "object" && member.focusWeights !== null, `member ${member.id} requires focusWeights`);
    assert(member.model?.provider, `member ${member.id} requires model.provider`);
    assert(member.model?.model, `member ${member.id} requires model.model`);
    if (member.model?.auth) {
      validateAuthConfig(member.model.auth, member.id);
    }
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
    deliberation,
    members,
    turnOrder: parsed.turnOrder,
    storage,
    execution
  };
}
