import { randomUUID } from "node:crypto";
import type { ZedCredentials } from "./credentials.ts";
import { readLocalZedCredentials } from "./credentials.ts";
import {
  checkAccount,
  createLlmToken,
  fetchModels,
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
    state.llmToken = await createLlmToken(
      state.credentials,
      state.systemId,
      state.organizationId,
    );
  }

  if (state.models.size === 0) {
    const models = await fetchModels(state.llmToken);
    for (const m of models) {
      state.models.set(m.id, m);
    }
  }
}

export async function ensureToken(state: RuntimeState): Promise<string> {
  if (!state.llmToken && state.credentials) {
    state.llmToken = await createLlmToken(
      state.credentials,
      state.systemId,
      state.organizationId,
    );
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
