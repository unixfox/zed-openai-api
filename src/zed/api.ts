import type { ZedCredentials } from "./credentials.ts";

const CLOUD_URL = "https://cloud.zed.dev";
const ZED_VERSION = "0.227.1+stable";

const HEADERS = {
  expiredToken: "x-zed-expired-token",
  outdatedToken: "x-zed-outdated-token",
  supportsXai: "x-zed-client-supports-x-ai",
  systemId: "x-zed-system-id",
  version: "x-zed-version",
  supportsStatusMessages: "x-zed-client-supports-status-messages",
  supportsStreamEndedStatus:
    "x-zed-client-supports-stream-ended-request-completion-status",
};

export interface ZedModel {
  id: string;
  provider: string;
  display_name: string;
  max_token_count: number;
  max_output_tokens: number;
  supports_tools: boolean;
  supports_images: boolean;
  supports_thinking: boolean;
}

function buildAuth(creds: ZedCredentials): string {
  return `${creds.userId} ${creds.accessToken}`;
}

/** Thrown when the Zed *access token* (not the LLM token) is rejected. */
export class ZedAuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ZedAuthError";
    this.status = status;
  }
}

export async function createLlmToken(
  creds: ZedCredentials,
  systemId: string,
  organizationId: string | null = null,
): Promise<string> {
  const res = await fetch(`${CLOUD_URL}/client/llm_tokens`, {
    method: "POST",
    headers: {
      Authorization: buildAuth(creds),
      "Content-Type": "application/json",
      [HEADERS.systemId]: systemId,
    },
    body: JSON.stringify({ organization_id: organizationId }),
  });
  if (!res.ok) {
    const text = await res.text();
    const message = `Failed to create LLM token (${res.status}): ${text}`;
    // 401/403 mean the access token itself is stale — signal the caller so it
    // can reload fresh credentials from the keyring and retry.
    if (res.status === 401 || res.status === 403) {
      throw new ZedAuthError(res.status, message);
    }
    throw new Error(message);
  }
  const data = await res.json();
  return data.token;
}

export async function fetchModels(token: string): Promise<ZedModel[]> {
  const res = await fetch(`${CLOUD_URL}/models`, {
    headers: {
      Authorization: `Bearer ${token}`,
      [HEADERS.supportsXai]: "true",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch models (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.models || [];
}

export async function sendCompletion(
  token: string,
  provider: string,
  model: string,
  providerRequest: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${CLOUD_URL}/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [HEADERS.version]: ZED_VERSION,
      [HEADERS.supportsStatusMessages]: "true",
      [HEADERS.supportsStreamEndedStatus]: "true",
    },
    body: JSON.stringify({
      intent: "user_prompt",
      provider,
      model,
      provider_request: providerRequest,
    }),
  });
}

export function shouldRefreshToken(response: Response): boolean {
  return (
    response.status === 401 ||
    Boolean(response.headers.get(HEADERS.expiredToken)) ||
    Boolean(response.headers.get(HEADERS.outdatedToken))
  );
}

export async function checkAccount(
  creds: ZedCredentials,
): Promise<{ ok: boolean; userId: string; error?: string }> {
  try {
    const res = await fetch(`${CLOUD_URL}/client/users/me`, {
      headers: { Authorization: buildAuth(creds) },
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        ok: false,
        userId: creds.userId,
        error: `Zed API returned ${res.status}: ${text}`,
      };
    }
    await res.json();
    return { ok: true, userId: creds.userId };
  } catch (err) {
    return {
      ok: false,
      userId: creds.userId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
