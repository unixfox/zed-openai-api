export interface ZedCredentials {
  userId: string;
  accessToken: string;
}

export function normalizeAccessToken(value: string): string {
  const token = value.replace(/^secret\s*=\s*/i, "").trim();
  const parsed = token.startsWith("{") ? jsonParse(token) : null;
  if (parsed?.id && parsed?.token) {
    return JSON.stringify({
      version: parsed.version ?? 2,
      id: String(parsed.id),
      token: String(parsed.token),
    });
  }
  return token;
}

function jsonParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readCredentialsFromEnv(): ZedCredentials | null {
  const userId = Deno.env.get("ZED_USER_ID");
  const accessToken = Deno.env.get("ZED_ACCESS_TOKEN");
  if (userId && accessToken) {
    return { userId, accessToken: normalizeAccessToken(accessToken) };
  }
  return null;
}

function parseSecretToolOutput(output: string): ZedCredentials | null {
  const userIds = Array.from(
    output.matchAll(/^attribute\.username = (.+)$/gm),
    (m) => m[1].trim(),
  ).filter(Boolean);
  const accessTokens = Array.from(
    output.matchAll(/^secret = (.+)$/gm),
    (m) => normalizeAccessToken(m[1]),
  ).filter(Boolean);

  return userIds[0] && accessTokens[0]
    ? { userId: userIds[0], accessToken: accessTokens[0] }
    : null;
}

export async function readCredentialsFromSecretTool(): Promise<
  ZedCredentials | null
> {
  try {
    const cmd = new Deno.Command("secret-tool", {
      args: ["search", "--all", "--unlock", "url", "https://zed.dev"],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout, stderr } = await cmd.output();
    const text = new TextDecoder().decode(stdout) +
      "\n" +
      new TextDecoder().decode(stderr);
    return parseSecretToolOutput(text);
  } catch {
    return null;
  }
}

export async function readLocalZedCredentials(): Promise<
  ZedCredentials | null
> {
  return readCredentialsFromEnv() ?? await readCredentialsFromSecretTool();
}
