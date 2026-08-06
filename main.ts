import { createRuntime, initRuntime, type RuntimeState } from "@lib/zed";
import {
  authenticate,
  handleChatCompletions,
  handleHealthCheck,
  handleMessages,
  handleModels,
  handleResponses,
} from "@lib/server";

const HOST = Deno.env.get("HOST") || "::";
const PORT = parseInt(Deno.env.get("PORT") || "8080");
const API_KEY = Deno.env.get("API_KEY") || null;

let runtime: RuntimeState;

async function init() {
  runtime = createRuntime();
  console.log("[zed-openai-api] Initializing...");
  await initRuntime(runtime);
  console.log(`[zed-openai-api] Ready. ${runtime.models.size} models loaded.`);
  if (API_KEY) {
    console.log("[zed-openai-api] API key authentication enabled.");
  } else {
    console.log(
      "[zed-openai-api] WARNING: No API_KEY set, endpoints are unauthenticated.",
    );
  }
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  console.log(
    `[zed-openai-api] ${req.method} ${path}${url.search} (model: ${
      req.method === "POST"
        ? ((await req.clone().json().catch(() => ({}))) as { model?: string })
          .model ?? "-"
        : "-"
    })`,
  );

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // Health check is always public
  if (path === "/health" && req.method === "GET") {
    return await handleHealthCheck(runtime);
  }

  // All other endpoints require auth
  const authError = authenticate(req, API_KEY);
  if (authError) return authError;

  try {
    if (path === "/v1/models" && req.method === "GET") {
      return handleModels(runtime);
    }
    if (path === "/v1/chat/completions" && req.method === "POST") {
      return await handleChatCompletions(req, runtime);
    }
    if (path === "/v1/responses" && req.method === "POST") {
      return await handleResponses(req, runtime);
    }
    if (path === "/v1/messages" && req.method === "POST") {
      return await handleMessages(req, runtime);
    }
    if (path === "/") {
      return Response.json({ status: "ok", models: runtime.models.size });
    }
    return Response.json(
      { error: { message: "Not found", type: "invalid_request_error" } },
      { status: 404 },
    );
  } catch (err) {
    console.error("[zed-openai-api] Error:", err);
    return Response.json(
      {
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: "internal_error",
        },
      },
      { status: 500 },
    );
  }
}

await init();

console.log(`[zed-openai-api] Listening on http://${HOST}:${PORT}`);
console.log(
  `[zed-openai-api] Use as OpenAI base URL: http://${HOST}:${PORT}/v1`,
);

Deno.serve({ hostname: HOST, port: PORT }, handler);
