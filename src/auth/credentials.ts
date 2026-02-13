import { exec as execCb } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  getOAuthApiKey,
  type OAuthCredentials,
  type OAuthProviderId
} from "@mariozechner/pi-ai";
import {
  ApiKeyEnvAuthConfig,
  CommandAuthConfig,
  CredentialRefAuthConfig,
  ModelAuthConfig,
  ModelConfig,
  OauthDeviceCodeAuthConfig
} from "../types.js";

const exec = promisify(execCb);

interface LegacyTokenEntry {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

type LegacyTokenStore = Record<string, LegacyTokenEntry>;

export interface OAuthCredentialStoreEntry {
  kind: "oauth";
  oauthProviderId: OAuthProviderId;
  credentials: OAuthCredentials;
  updatedAt: string;
}

export interface ApiKeyCredentialStoreEntry {
  kind: "api-key";
  apiKey: string;
  providerHint?: string;
  updatedAt: string;
}

export type CredentialStoreEntry = OAuthCredentialStoreEntry | ApiKeyCredentialStoreEntry;

export interface CredentialStoreFile {
  version: 1;
  updatedAt: string;
  entries: Record<string, CredentialStoreEntry>;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultCredentialStorePath(): string {
  return (
    process.env.ROUNDTABLE_CREDENTIAL_STORE ??
    process.env.LLM_COUNCIL_CREDENTIAL_STORE ??
    path.join(process.cwd(), ".council", "credentials.json")
  );
}

function defaultLegacyTokenStorePath(): string {
  return path.join(os.homedir(), ".roundtable", "tokens.json");
}

function buildCacheKey(config: ModelConfig, auth: ModelAuthConfig): string {
  if (auth.method === "oauth-device-code" && auth.cacheKey) {
    return auth.cacheKey;
  }
  if (auth.method === "command" && auth.cacheKey) {
    return auth.cacheKey;
  }
  return `${config.provider}:${config.model}`;
}

function legacyTokenStorePathFor(auth: ModelAuthConfig): string {
  if (auth.method === "oauth-device-code" && auth.tokenStorePath) {
    return auth.tokenStorePath;
  }
  if (auth.method === "command" && auth.tokenStorePath) {
    return auth.tokenStorePath;
  }
  return process.env.ROUNDTABLE_TOKEN_STORE ?? process.env.LLM_COUNCIL_TOKEN_STORE ?? defaultLegacyTokenStorePath();
}

async function loadLegacyTokenStore(filePath: string): Promise<LegacyTokenStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as LegacyTokenStore;
  } catch {
    return {};
  }
}

async function saveLegacyTokenStore(filePath: string, store: LegacyTokenStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function isLegacyTokenValid(entry: LegacyTokenEntry | undefined): boolean {
  if (!entry || !entry.accessToken) {
    return false;
  }
  if (!entry.expiresAt) {
    return true;
  }
  const expiry = new Date(entry.expiresAt).getTime();
  const now = Date.now();
  return now + 60_000 < expiry;
}

function asFormBody(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  return params.toString();
}

async function postForm<T>(url: string, body: Record<string, string | undefined>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: asFormBody(body)
  });

  const text = await res.text();
  const parsed = (text ? JSON.parse(text) : {}) as T;
  if (!res.ok) {
    throw new Error(`OAuth request failed (${res.status}): ${text}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadCredentialStore(filePath = defaultCredentialStorePath()): Promise<CredentialStoreFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CredentialStoreFile>;
    const entries = parsed.entries ?? {};
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
      entries
    };
  } catch {
    return {
      version: 1,
      updatedAt: nowIso(),
      entries: {}
    };
  }
}

export async function saveCredentialStore(
  store: CredentialStoreFile,
  filePath = defaultCredentialStorePath()
): Promise<void> {
  const normalized: CredentialStoreFile = {
    version: 1,
    updatedAt: nowIso(),
    entries: store.entries
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function upsertCredentialStoreEntry(
  credentialId: string,
  entry: CredentialStoreEntry,
  filePath = defaultCredentialStorePath()
): Promise<void> {
  const store = await loadCredentialStore(filePath);
  store.entries[credentialId] = entry;
  await saveCredentialStore(store, filePath);
}

async function resolveFromApiKeyEnv(auth: ApiKeyEnvAuthConfig): Promise<string> {
  const token = process.env[auth.apiKeyEnv] ?? "";
  if (!token) {
    throw new Error(`Missing API credential in env var: ${auth.apiKeyEnv}`);
  }
  return token;
}

async function resolveFromCommand(auth: CommandAuthConfig, config: ModelConfig): Promise<string> {
  const cacheKey = buildCacheKey(config, auth);
  const storePath = legacyTokenStorePathFor(auth);
  const store = await loadLegacyTokenStore(storePath);
  const cached = store[cacheKey];
  if (isLegacyTokenValid(cached)) {
    return cached.accessToken;
  }

  const { stdout, stderr } = await exec(auth.command, { shell: "/bin/zsh" });
  const token = stdout.trim();
  if (!token) {
    throw new Error(`Auth command returned empty token. stderr=${stderr.trim()}`);
  }

  if (auth.cacheTtlSeconds && auth.cacheTtlSeconds > 0) {
    store[cacheKey] = {
      accessToken: token,
      expiresAt: new Date(Date.now() + auth.cacheTtlSeconds * 1000).toISOString()
    };
    await saveLegacyTokenStore(storePath, store);
  }

  return token;
}

async function refreshAccessToken(
  auth: OauthDeviceCodeAuthConfig,
  refreshToken: string
): Promise<LegacyTokenEntry | undefined> {
  try {
    const token = await postForm<TokenResponse>(auth.tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: auth.clientId,
      refresh_token: refreshToken
    });

    if (!token.access_token) {
      return undefined;
    }

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? refreshToken,
      expiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : undefined
    };
  } catch {
    return undefined;
  }
}

async function runDeviceCodeFlow(auth: OauthDeviceCodeAuthConfig): Promise<LegacyTokenEntry> {
  const device = await postForm<DeviceCodeResponse>(auth.deviceAuthorizationEndpoint, {
    client_id: auth.clientId,
    scope: auth.scopes?.join(" "),
    audience: auth.audience
  });

  if (!device.device_code) {
    throw new Error("Device flow response missing device_code.");
  }

  const verifyUrl = device.verification_uri_complete ?? device.verification_uri;
  if (!verifyUrl) {
    throw new Error("Device flow response missing verification URL.");
  }

  const intervalSeconds = Math.max(2, device.interval ?? 5);
  const started = Date.now();
  const hardStopMs = ((device.expires_in ?? 900) + 30) * 1000;

  console.log("[auth] OAuth device authorization required.");
  console.log(`[auth] Open this URL and complete authorization: ${verifyUrl}`);
  console.log(`[auth] User code: ${device.user_code}`);
  if (device.message) {
    console.log(`[auth] ${device.message}`);
  }

  while (Date.now() - started < hardStopMs) {
    await sleep(intervalSeconds * 1000);

    const token = await postForm<TokenResponse>(auth.tokenEndpoint, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: auth.clientId,
      device_code: device.device_code
    });

    if (token.access_token) {
      return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000).toISOString()
          : undefined
      };
    }

    if (token.error === "authorization_pending" || token.error === "slow_down") {
      continue;
    }

    if (token.error) {
      const details = token.error_description ? ` (${token.error_description})` : "";
      throw new Error(`OAuth device flow error: ${token.error}${details}`);
    }
  }

  throw new Error("OAuth device authorization timed out before completion.");
}

async function resolveFromOauthDevice(auth: OauthDeviceCodeAuthConfig, config: ModelConfig): Promise<string> {
  const cacheKey = buildCacheKey(config, auth);
  const storePath = legacyTokenStorePathFor(auth);
  const store = await loadLegacyTokenStore(storePath);
  const existing = store[cacheKey];

  if (isLegacyTokenValid(existing)) {
    return existing.accessToken;
  }

  if (existing?.refreshToken) {
    const refreshed = await refreshAccessToken(auth, existing.refreshToken);
    if (refreshed && isLegacyTokenValid(refreshed)) {
      store[cacheKey] = refreshed;
      await saveLegacyTokenStore(storePath, store);
      return refreshed.accessToken;
    }
  }

  const issued = await runDeviceCodeFlow(auth);
  store[cacheKey] = issued;
  await saveLegacyTokenStore(storePath, store);
  return issued.accessToken;
}

async function resolveFromCredentialRef(
  config: ModelConfig,
  auth: CredentialRefAuthConfig
): Promise<string> {
  const storePath = defaultCredentialStorePath();
  const store = await loadCredentialStore(storePath);
  const entry = store.entries[auth.credentialId];
  if (!entry) {
    throw new Error(
      `Missing credential ID "${auth.credentialId}" in ${storePath}. Run onboarding first.`
    );
  }

  if (entry.kind === "api-key") {
    if (!entry.apiKey) {
      throw new Error(`Credential "${auth.credentialId}" has empty API key.`);
    }
    return entry.apiKey;
  }

  const providerCredentialMap: Record<string, OAuthCredentials> = {
    [entry.oauthProviderId]: entry.credentials
  };
  const resolved = await getOAuthApiKey(entry.oauthProviderId, providerCredentialMap);
  if (!resolved) {
    throw new Error(
      `Credential "${auth.credentialId}" has no OAuth credentials for provider "${entry.oauthProviderId}".`
    );
  }

  const prevExpiry = entry.credentials.expires;
  if (resolved.newCredentials.expires !== prevExpiry) {
    store.entries[auth.credentialId] = {
      kind: "oauth",
      oauthProviderId: entry.oauthProviderId,
      credentials: resolved.newCredentials,
      updatedAt: nowIso()
    };
    await saveCredentialStore(store, storePath);
  }

  return resolved.apiKey;
}

function resolveAuthConfig(config: ModelConfig): ModelAuthConfig | undefined {
  if (config.auth) {
    return config.auth;
  }
  if (config.apiKeyEnv) {
    return {
      method: "api-key-env",
      apiKeyEnv: config.apiKeyEnv
    };
  }
  return undefined;
}

function defaultCredentialIdFor(config: ModelConfig): string {
  return config.provider;
}

export async function resolveModelCredential(config: ModelConfig): Promise<string> {
  const auth = resolveAuthConfig(config);
  if (!auth) {
    return resolveFromCredentialRef(config, {
      method: "credential-ref",
      credentialId: defaultCredentialIdFor(config)
    });
  }

  if (auth.method === "api-key-env") {
    return resolveFromApiKeyEnv(auth);
  }
  if (auth.method === "command") {
    return resolveFromCommand(auth, config);
  }
  if (auth.method === "oauth-device-code") {
    return resolveFromOauthDevice(auth, config);
  }
  if (auth.method === "credential-ref") {
    return resolveFromCredentialRef(config, auth);
  }
  const exhaustive: never = auth;
  throw new Error(`Unsupported auth method: ${JSON.stringify(exhaustive)}`);
}
