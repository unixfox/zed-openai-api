import { randomUUID } from "node:crypto";
import type { ZedCredentials } from "./credentials.ts";
import {
  readCredentialsFromSecretTool,
  readLocalZedCredentials,
} from "./credentials.ts";
import {
  checkAccount,
  createLlmToken,
  fetchModels,
  ZedAuthError,
  type ZedModel,
} from "./api.ts";

export type { ZedModel };
export type { ZedCredentials };

export interface RuntimeState {
  llmToken: string | null;
  organizationId: string | null;
  systemId: string;
  models: Map<string, ZedModel>;
  credentials: ZedCredentials | null;
}

export function createRuntime(): RuntimeState {
  return {
    llmToken: null,
    organizationId: null,
    systemId: randomUUID(),
    models: new Map(),
    credentials: null,
  };
}

export async function initRuntime(state: RuntimeState): Promise<void> {
  if (!state.credentials) {
    const creds = await readLocalZedCredentials();
    if (!creds) {
      throw new Error(
        "No Zed credentials found. Either:\n" +
          "  - Set ZED_USER_ID and ZED_ACCESS_TOKEN env vars, or\n" +
          "  - Sign into Zed desktop (check: secret-tool search --all --unlock url https://zed.dev)",
      );
    }
    state.credentials = creds;
  }

  if (!state.llmToken) {
    state.llmToken = await mintToken(state);
  }

  if (state.models.size === 0) {
    const models = await fetchModels(state.llmToken);
    for (const m of models) {
      state.models.set(m.id, m);
    }
  }
}

/**
 * Re-read the access token straight from the OS keyring (secret-tool),
 * bypassing any stale value cached from env/startup. Returns true when a
 * different, fresh credential was found and adopted.
 *
 * This is what gives us desktop-app parity: as long as the user is signed
 * into Zed desktop, the live keyring always holds a valid access token, so
 * we never need the user to paste one again.
 */
async function reloadCredentialsFromKeyring(
  state: RuntimeState,
): Promise<boolean> {
  const fresh = await readCredentialsFromSecretTool();
  if (!fresh) return false;
  if (
    state.credentials &&
    fresh.userId === state.credentials.userId &&
    fresh.accessToken === state.credentials.accessToken
  ) {
    return false; // keyring holds the same token we already tried
  }
  state.credentials = fresh;
  return true;
}

/**
 * Mint an LLM token from the access token. If the access token is rejected
 * (401/403), reload the live credentials from the keyring and try once more —
 * mirroring how the desktop app re-reads the keychain instead of forcing a
 * re-login.
 */
async function mintToken(state: RuntimeState): Promise<string> {
  if (!state.credentials) {
    throw new Error("No Zed credentials configured");
  }
  try {
    return await createLlmToken(
      state.credentials,
      state.systemId,
      state.organizationId,
    );
  } catch (err) {
    if (
      err instanceof ZedAuthError && await reloadCredentialsFromKeyring(state)
    ) {
      return await createLlmToken(
        state.credentials,
        state.systemId,
        state.organizationId,
      );
    }
    throw err;
  }
}

export async function ensureToken(state: RuntimeState): Promise<string> {
  if (!state.llmToken && state.credentials) {
    state.llmToken = await mintToken(state);
  }
  return state.llmToken!;
}

export function refreshToken(state: RuntimeState): Promise<string> {
  state.llmToken = null;
  return ensureToken(state);
}

export function checkCredentials(
  state: RuntimeState,
): Promise<{ ok: boolean; userId: string; error?: string }> {
  if (!state.credentials) {
    return Promise.resolve({
      ok: false,
      userId: "",
      error: "No credentials configured",
    });
  }
  return checkAccount(state.credentials);
}
