import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  getOAuthProvider,
  type OAuthLoginCallbacks,
  type OAuthProviderId
} from "@mariozechner/pi-ai";
import { loadConfig } from "../config.js";
import {
  defaultCredentialStorePath,
  loadCredentialStore,
  saveCredentialStore,
  type ApiKeyCredentialStoreEntry,
  type CredentialStoreEntry,
  type OAuthCredentialStoreEntry
} from "../auth/credentials.js";
import { CouncilConfig, CouncilMemberConfig } from "../types.js";

interface OnboardOptions {
  configPath: string;
  credentialStorePath?: string;
}

interface CredentialAssignment {
  provider: string;
  credentialId: string;
  memberIds: string[];
}

const OAUTH_PROVIDER_BY_MODEL_PROVIDER: Record<string, OAuthProviderId> = {
  "openai-codex": "openai-codex",
  anthropic: "anthropic",
  "google-gemini-cli": "google-gemini-cli",
  "google-antigravity": "google-antigravity",
  "github-copilot": "github-copilot"
};

function nowIso(): string {
  return new Date().toISOString();
}

function defaultCredentialIdFor(provider: string): string {
  return provider;
}

function getCredentialIdForMember(member: CouncilMemberConfig): string {
  if (member.model.auth?.method === "credential-ref") {
    return member.model.auth.credentialId;
  }
  return defaultCredentialIdFor(member.model.provider);
}

function formatEntryKind(entry: CredentialStoreEntry | undefined): string {
  if (!entry) {
    return "none";
  }
  if (entry.kind === "oauth") {
    return `oauth:${entry.oauthProviderId}`;
  }
  return "api-key";
}

function buildAssignments(config: CouncilConfig): CredentialAssignment[] {
  const map = new Map<string, CredentialAssignment>();
  for (const member of config.members) {
    const provider = member.model.provider;
    const credentialId = getCredentialIdForMember(member);
    const current = map.get(credentialId);
    if (!current) {
      map.set(credentialId, {
        provider,
        credentialId,
        memberIds: [member.id]
      });
      continue;
    }
    if (current.provider !== provider) {
      throw new Error(
        `Credential ID "${credentialId}" is reused across different providers (${current.provider} vs ${provider}).`
      );
    }
    current.memberIds.push(member.id);
  }
  return [...map.values()];
}

async function askYesNo(
  question: string,
  defaultYes: boolean,
  ask: (prompt: string) => Promise<string>
): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await ask(`${question}${suffix}`)).trim().toLowerCase();
  if (!answer) {
    return defaultYes;
  }
  if (["y", "yes"].includes(answer)) {
    return true;
  }
  if (["n", "no"].includes(answer)) {
    return false;
  }
  return defaultYes;
}

async function askNonEmpty(
  question: string,
  ask: (prompt: string) => Promise<string>
): Promise<string> {
  while (true) {
    const value = (await ask(question)).trim();
    if (value) {
      return value;
    }
    console.log("Value cannot be empty.");
  }
}

function toOAuthEntry(
  oauthProviderId: OAuthProviderId,
  credentials: OAuthCredentialStoreEntry["credentials"]
): OAuthCredentialStoreEntry {
  return {
    kind: "oauth",
    oauthProviderId,
    credentials,
    updatedAt: nowIso()
  };
}

function toApiKeyEntry(apiKey: string, providerHint: string): ApiKeyCredentialStoreEntry {
  return {
    kind: "api-key",
    apiKey,
    providerHint,
    updatedAt: nowIso()
  };
}

async function runOAuthLogin(
  oauthProviderId: OAuthProviderId,
  ask: (prompt: string) => Promise<string>
): Promise<OAuthCredentialStoreEntry["credentials"]> {
  const provider = getOAuthProvider(oauthProviderId);
  if (!provider) {
    throw new Error(`OAuth provider "${oauthProviderId}" is not available in pi-ai.`);
  }

  const callbacks: OAuthLoginCallbacks = {
    onAuth: (info) => {
      console.log(`\n[oauth:${provider.id}] Open this URL in your browser:`);
      console.log(info.url);
      if (info.instructions) {
        console.log(info.instructions);
      }
    },
    onPrompt: async (prompt) => {
      const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
      return ask(`${prompt.message}${suffix}: `);
    },
    onProgress: (message) => {
      console.log(`[oauth:${provider.id}] ${message}`);
    }
  };

  return provider.login(callbacks);
}

function updateConfigForCredentialRefs(
  raw: unknown,
  memberCredentialIds: Map<string, string>
): string {
  const parsed = raw as {
    members?: Array<{ id?: string; model?: Record<string, unknown> }>;
  };
  const members = parsed.members ?? [];
  for (const member of members) {
    if (!member.id) {
      continue;
    }
    const credentialId = memberCredentialIds.get(member.id);
    if (!credentialId) {
      continue;
    }
    const model = member.model ?? {};
    model.auth = {
      method: "credential-ref",
      credentialId
    };
    delete model.apiKeyEnv;
    member.model = model;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export async function runOnboarding(options: OnboardOptions): Promise<void> {
  const absoluteConfigPath = path.resolve(options.configPath);
  const credentialStorePath = options.credentialStorePath
    ? path.resolve(options.credentialStorePath)
    : defaultCredentialStorePath();

  const config = await loadConfig(absoluteConfigPath);
  const assignments = buildAssignments(config);

  console.log(`Starting onboarding for ${assignments.length} credential reference(s).`);
  console.log(`Credential store: ${credentialStorePath}`);

  const credentialStore = await loadCredentialStore(credentialStorePath);
  const memberCredentialIds = new Map<string, string>();
  for (const member of config.members) {
    memberCredentialIds.set(member.id, getCredentialIdForMember(member));
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = async (prompt: string): Promise<string> => readline.question(prompt);

  try {
    for (const assignment of assignments) {
      const existing = credentialStore.entries[assignment.credentialId];
      console.log(
        `\nCredential "${assignment.credentialId}" (provider=${assignment.provider}, members=${assignment.memberIds.join(", ")})`
      );

      if (existing) {
        const reuse = await askYesNo(
          `Existing credential found (${formatEntryKind(existing)}). Reuse it?`,
          true,
          ask
        );
        if (reuse) {
          continue;
        }
      }

      const oauthProviderId = OAUTH_PROVIDER_BY_MODEL_PROVIDER[assignment.provider];
      if (oauthProviderId) {
        const oauthProvider = getOAuthProvider(oauthProviderId);
        if (oauthProvider) {
          const useOauth = await askYesNo(
            `Use OAuth login for ${oauthProvider.name}?`,
            true,
            ask
          );
          if (useOauth) {
            const credentials = await runOAuthLogin(oauthProviderId, ask);
            credentialStore.entries[assignment.credentialId] = toOAuthEntry(
              oauthProviderId,
              credentials
            );
            console.log(`Saved OAuth credential "${assignment.credentialId}".`);
            continue;
          }
        }
      }

      const apiKey = await askNonEmpty(
        `Enter API key/token for provider "${assignment.provider}": `,
        ask
      );
      credentialStore.entries[assignment.credentialId] = toApiKeyEntry(
        apiKey,
        assignment.provider
      );
      console.log(`Saved API key credential "${assignment.credentialId}".`);
    }
  } finally {
    readline.close();
  }

  await saveCredentialStore(credentialStore, credentialStorePath);

  const rawConfigText = await readFile(absoluteConfigPath, "utf8");
  const rawConfig = JSON.parse(rawConfigText) as unknown;
  const updatedConfigText = updateConfigForCredentialRefs(rawConfig, memberCredentialIds);
  await writeFile(absoluteConfigPath, updatedConfigText, "utf8");

  console.log(`\nOnboarding complete.`);
  console.log(`- Credentials saved to: ${credentialStorePath}`);
  console.log(`- Config updated to credential references: ${absoluteConfigPath}`);
}
