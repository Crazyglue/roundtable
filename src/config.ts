import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CouncilConfig, ModelAuthConfig } from "./types.js";

const apiKeyEnvAuthSchema = z
  .object({
    method: z.literal("api-key-env"),
    apiKeyEnv: z.string().min(1)
  })
  .strict();

const oauthDeviceCodeAuthSchema = z
  .object({
    method: z.literal("oauth-device-code"),
    clientId: z.string().min(1),
    deviceAuthorizationEndpoint: z.string().min(1),
    tokenEndpoint: z.string().min(1),
    scopes: z.array(z.string().min(1)).optional(),
    audience: z.string().min(1).optional(),
    cacheKey: z.string().min(1).optional(),
    tokenStorePath: z.string().min(1).optional()
  })
  .strict();

const commandAuthSchema = z
  .object({
    method: z.literal("command"),
    command: z.string().min(1),
    cacheKey: z.string().min(1).optional(),
    cacheTtlSeconds: z.number().positive().optional(),
    tokenStorePath: z.string().min(1).optional()
  })
  .strict();

const credentialRefAuthSchema = z
  .object({
    method: z.literal("credential-ref"),
    credentialId: z.string().min(1)
  })
  .strict();

const modelAuthSchema = z.discriminatedUnion("method", [
  apiKeyEnvAuthSchema,
  oauthDeviceCodeAuthSchema,
  commandAuthSchema,
  credentialRefAuthSchema
]);

const modelSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).optional(),
    auth: modelAuthSchema.optional(),
    api: z.string().min(1).optional(),
    baseUrl: z.string().min(1).optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    headers: z.record(z.string(), z.string()).optional()
  })
  .strict();

const councilMemberSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    systemPrompt: z.string().min(1),
    traits: z.array(z.string()),
    focusWeights: z.record(z.string(), z.number().finite()),
    model: modelSchema
  })
  .strict();

const phaseDeliverableSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    required: z.boolean().default(true)
  })
  .strict();

const phaseGovernanceSchema = z
  .object({
    requireSeconding: z.boolean().default(true),
    majorityThreshold: z.number().gt(0).lte(1).default(0.5),
    abstainCountsAsNo: z.boolean().default(true)
  })
  .strict();

const phaseStopConditionsSchema = z
  .object({
    maxRounds: z.number().int().positive(),
    endOnMajorityVote: z.boolean().default(true)
  })
  .strict();

const phaseMemoryPolicySchema = z
  .object({
    readMemberMemory: z.boolean().default(true),
    writeMemberMemory: z.boolean().default(true),
    writeCouncilMemory: z.boolean().default(true),
    includePriorPhaseSummary: z.boolean().default(true)
  })
  .strict();

const phaseEvidenceRequirementsSchema = z
  .object({
    minCitations: z.number().int().min(0).default(0),
    requireExplicitAssumptions: z.boolean().default(false),
    requireRiskRegister: z.boolean().default(false)
  })
  .strict();

const phaseTransitionSchema = z
  .object({
    to: z.string().min(1),
    when: z.enum(["MAJORITY_VOTE", "ROUND_LIMIT", "ALWAYS"]),
    reason: z.string().min(1).optional(),
    priority: z.number().int().nonnegative().default(100)
  })
  .strict();

const phaseFallbackSchema = z
  .object({
    resolution: z.string().min(1),
    action: z.enum(["END_SESSION", "TRANSITION"]).default("END_SESSION"),
    transitionToPhaseId: z.string().min(1).optional()
  })
  .strict();

const councilSessionPhaseSchema = z
  .object({
    id: z.string().min(1),
    goal: z.string().min(1),
    promptGuidance: z.array(z.string().min(1)).default([]),
    deliverables: z.array(phaseDeliverableSchema).default([]),
    governance: phaseGovernanceSchema.default({}),
    stopConditions: phaseStopConditionsSchema,
    memoryPolicy: phaseMemoryPolicySchema.default({}),
    evidenceRequirements: phaseEvidenceRequirementsSchema.default({}),
    qualityGates: z.array(z.string().min(1)).default([]),
    fallback: phaseFallbackSchema,
    transitions: z.array(phaseTransitionSchema).default([])
  })
  .strict();

const sessionPolicySchema = z
  .object({
    entryPhaseId: z.string().min(1),
    maxPhaseTransitions: z.number().int().positive().default(12),
    phaseContextVerbosity: z.enum(["minimal", "standard", "full"]).default("standard")
  })
  .strict();

const documentationReviewSchema = z
  .object({
    maxRevisionRounds: z.number().int().min(0).default(2)
  })
  .strict();

const outputSchema = z
  .object({
    type: z.enum(["none", "documentation"]).default("none")
  })
  .strict();

const councilConfigSchema = z
  .object({
    councilName: z.string().min(1),
    purpose: z.string().min(1),
    sessionPolicy: sessionPolicySchema,
    phases: z.array(councilSessionPhaseSchema).min(1),
    output: outputSchema,
    documentationReview: documentationReviewSchema.default({}),
    members: z.array(councilMemberSchema).min(3),
    turnOrder: z.array(z.string().min(1)).optional(),
    storage: z
      .object({
        rootDir: z.string().min(1),
        memoryDir: z.string().min(1)
      })
      .strict(),
    execution: z
      .object({
        requireHumanApproval: z.boolean(),
        defaultExecutorProfile: z.string().min(1)
      })
      .strict()
  })
  .strict();

function validateAuthConfig(auth: ModelAuthConfig, memberId: string): void {
  if (auth.method === "api-key-env" && !auth.apiKeyEnv) {
    throw new Error(`Config validation error: member ${memberId} auth.apiKeyEnv is required`);
  }
  if (auth.method === "oauth-device-code") {
    if (!auth.clientId || !auth.deviceAuthorizationEndpoint || !auth.tokenEndpoint) {
      throw new Error(
        `Config validation error: member ${memberId} oauth-device-code auth requires clientId, deviceAuthorizationEndpoint, and tokenEndpoint`
      );
    }
  }
  if (auth.method === "command" && !auth.command) {
    throw new Error(`Config validation error: member ${memberId} auth.command is required`);
  }
  if (auth.method === "credential-ref" && !auth.credentialId) {
    throw new Error(`Config validation error: member ${memberId} auth.credentialId is required`);
  }
}

function assertGraphIntegrity(config: CouncilConfig): void {
  if (config.members.length % 2 !== 1) {
    throw new Error("Config validation error: members must be an odd count");
  }

  const memberIds = config.members.map((member) => member.id);
  const memberIdSet = new Set(memberIds);
  if (memberIdSet.size !== memberIds.length) {
    throw new Error("Config validation error: member ids must be unique");
  }

  if (config.turnOrder) {
    if (config.turnOrder.length !== config.members.length) {
      throw new Error("Config validation error: turnOrder must include every member exactly once");
    }
    const seen = new Set<string>();
    for (const memberId of config.turnOrder) {
      if (!memberIdSet.has(memberId)) {
        throw new Error(`Config validation error: turnOrder references unknown member id: ${memberId}`);
      }
      if (seen.has(memberId)) {
        throw new Error(`Config validation error: turnOrder contains duplicate member id: ${memberId}`);
      }
      seen.add(memberId);
    }
  }

  const phaseIds = config.phases.map((phase) => phase.id);
  const phaseIdSet = new Set(phaseIds);
  if (phaseIdSet.size !== phaseIds.length) {
    throw new Error("Config validation error: phase ids must be unique");
  }

  if (!phaseIdSet.has(config.sessionPolicy.entryPhaseId)) {
    throw new Error(
      `Config validation error: sessionPolicy.entryPhaseId references unknown phase: ${config.sessionPolicy.entryPhaseId}`
    );
  }

  for (const phase of config.phases) {
    const deliverableIds = phase.deliverables.map((deliverable) => deliverable.id);
    const deliverableIdSet = new Set(deliverableIds);
    if (deliverableIdSet.size !== deliverableIds.length) {
      throw new Error(`Config validation error: phase ${phase.id} has duplicate deliverable ids`);
    }

    for (const transition of phase.transitions) {
      if (!phaseIdSet.has(transition.to)) {
        throw new Error(
          `Config validation error: phase ${phase.id} transition points to unknown phase ${transition.to}`
        );
      }
    }

    if (phase.fallback.action === "TRANSITION") {
      if (!phase.fallback.transitionToPhaseId) {
        throw new Error(
          `Config validation error: phase ${phase.id} fallback.action=TRANSITION requires fallback.transitionToPhaseId`
        );
      }
      if (!phaseIdSet.has(phase.fallback.transitionToPhaseId)) {
        throw new Error(
          `Config validation error: phase ${phase.id} fallback.transitionToPhaseId references unknown phase ${phase.fallback.transitionToPhaseId}`
        );
      }
    }

    if (phase.fallback.action === "END_SESSION" && phase.fallback.transitionToPhaseId) {
      throw new Error(
        `Config validation error: phase ${phase.id} fallback.transitionToPhaseId is only valid when fallback.action=TRANSITION`
      );
    }
  }

  const reachable = new Set<string>();
  const stack = [config.sessionPolicy.entryPhaseId];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || reachable.has(currentId)) {
      continue;
    }
    reachable.add(currentId);
    const current = config.phases.find((phase) => phase.id === currentId);
    if (!current) {
      continue;
    }
    for (const transition of current.transitions) {
      if (!reachable.has(transition.to)) {
        stack.push(transition.to);
      }
    }
    if (current.fallback.action === "TRANSITION" && current.fallback.transitionToPhaseId) {
      if (!reachable.has(current.fallback.transitionToPhaseId)) {
        stack.push(current.fallback.transitionToPhaseId);
      }
    }
  }

  const unreachable = config.phases
    .filter((phase) => !reachable.has(phase.id))
    .map((phase) => phase.id);
  if (unreachable.length > 0) {
    throw new Error(
      `Config validation error: unreachable phases from entryPhaseId ${config.sessionPolicy.entryPhaseId}: ${unreachable.join(", ")}`
    );
  }
}

export async function loadConfig(configPath: string): Promise<CouncilConfig> {
  const absolute = path.resolve(configPath);
  const raw = await readFile(absolute, "utf8");

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Config validation error: invalid JSON in ${absolute}: ${message}`);
  }

  const parsed = councilConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const pathText = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${pathText}: ${issue.message}`;
    });
    throw new Error(`Config validation error:\n- ${issues.join("\n- ")}`);
  }

  const config = parsed.data as CouncilConfig;
  for (const member of config.members) {
    if (member.model.auth) {
      validateAuthConfig(member.model.auth, member.id);
    }
  }
  assertGraphIntegrity(config);
  return config;
}
