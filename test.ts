import { assertEquals, assertExists } from "@std/assert";
import {
  checkCredentials,
  createLlmToken,
  createRuntime,
  fetchModels,
  initRuntime,
  readLocalZedCredentials,
  sendCompletion,
} from "@lib/zed";
import {
  buildProviderRequest,
  chatToResponsesApiRequest,
} from "@lib/openai";
import { createStreamConverter } from "@lib/openai";

// --- Unit tests for conversion ---

Deno.test("chatToResponsesApiRequest - basic message", () => {
  const result = chatToResponsesApiRequest({
    model: "gpt-5-nano",
    messages: [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
    ],
    stream: true,
  });

  assertEquals(result.model, "gpt-5-nano");
  assertEquals(result.stream, true);
  const input = result.input as {
    type: string;
    role: string;
    content: unknown[];
  }[];
  assertEquals(input.length, 2);
  assertEquals(input[0].role, "system");
  assertEquals(input[1].role, "user");
});

Deno.test("chatToResponsesApiRequest - tool calls", () => {
  const result = chatToResponsesApiRequest({
    model: "gpt-5-nano",
    messages: [{ role: "user", content: "What's the weather?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a location",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      },
    ],
  });

  const tools = result.tools as { name: string }[];
  assertEquals(tools.length, 1);
  assertEquals(tools[0].name, "get_weather");
});

Deno.test("chatToResponsesApiRequest - developer role maps to system", () => {
  const result = chatToResponsesApiRequest({
    model: "gpt-5-nano",
    messages: [
      { role: "developer", content: "Be concise" },
      { role: "user", content: "Hi" },
    ],
  });
  const input = result.input as { type: string; role: string }[];
  assertEquals(input[0].role, "system");
});

Deno.test("chatToResponsesApiRequest - image_url content parts", () => {
  const result = chatToResponsesApiRequest({
    model: "gpt-5-nano",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/cat.jpg" },
          },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw0KGgo=",
              detail: "low",
            },
          },
        ],
      },
    ],
  });

  const input = result.input as {
    type: string;
    role: string;
    content: Record<string, unknown>[];
  }[];
  assertEquals(input.length, 1);
  const content = input[0].content;
  assertEquals(content.length, 3);
  assertEquals(content[0].type, "input_text");
  assertEquals(content[1].type, "input_image");
  assertEquals(content[1].image_url, "https://example.com/cat.jpg");
  assertEquals(content[2].type, "input_image");
  assertEquals(content[2].image_url, "data:image/png;base64,iVBORw0KGgo=");
  assertEquals(content[2].detail, "low");
});

Deno.test("createStreamConverter - skips status messages", () => {
  const convert = createStreamConverter("open_ai", "gpt-5-nano");
  const line = JSON.stringify({ status: "completed" });
  const chunks = convert(line);
  assertEquals(chunks.length, 0);
});

// --- Integration tests with real Zed credentials ---

Deno.test("integration: read local Zed credentials", async () => {
  const creds = await readLocalZedCredentials();
  assertExists(creds, "No Zed credentials found - is Zed signed in?");
  assertExists(creds.userId);
  assertExists(creds.accessToken);
  console.log(`  Found credentials for user: ${creds.userId}`);
});

Deno.test("integration: create LLM token", async () => {
  const creds = await readLocalZedCredentials();
  assertExists(creds);

  const { randomUUID } = await import("node:crypto");
  const token = await createLlmToken(creds, randomUUID());
  assertExists(token);
  console.log(`  LLM token created (length: ${token.length})`);
});

Deno.test("integration: healthcheck (checkCredentials)", async () => {
  const runtime = createRuntime();
  await initRuntime(runtime);

  const result = await checkCredentials(runtime);
  assertEquals(result.ok, true, `Healthcheck failed: ${result.error}`);
  assertExists(result.userId);
  console.log(`  Zed account verified for user: ${result.userId}`);
});

Deno.test("integration: fetch models", async () => {
  const creds = await readLocalZedCredentials();
  assertExists(creds);

  const { randomUUID } = await import("node:crypto");
  const token = await createLlmToken(creds, randomUUID());
  const models = await fetchModels(token);

  assertEquals(models.length > 0, true);
  console.log(`  Found ${models.length} models:`);

  const byProvider = new Map<string, string[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) || [];
    list.push(m.id);
    byProvider.set(m.provider, list);
  }
  for (const [provider, ids] of byProvider) {
    console.log(`    ${provider}: ${ids.join(", ")}`);
  }

  const sonnetModels = models.filter((m) => m.id.includes("sonnet"));
  console.log(`  Sonnet models: ${sonnetModels.map((m) => m.id).join(", ")}`);
});

Deno.test("integration: streaming completion with gpt-5-nano", async () => {
  const runtime = createRuntime();
  await initRuntime(runtime);

  const model = runtime.models.get("gpt-5-nano");
  assertExists(model, "gpt-5-nano not found");
  console.log(`  Using model: ${model.id}`);

  const providerRequest = buildProviderRequest(
    {
      model: model.id,
      messages: [
        { role: "user", content: "Say 'hello world' and nothing else." },
      ],
      stream: true,
      max_tokens: 2000,
    },
    model,
  );

  const response = await sendCompletion(
    runtime.llmToken!,
    model.provider,
    model.id,
    providerRequest,
  );

  assertEquals(response.ok, true, `Request failed: ${response.status}`);

  const converter = createStreamConverter(model.provider, model.id);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n")) {
      const idx = buffer.indexOf("\n");
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);

      const chunks = converter(line);
      for (const chunk of chunks) {
        const parsed = JSON.parse(chunk);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) fullText += content;
      }
    }
  }

  console.log(`  Response: "${fullText.trim()}"`);
  assertEquals(fullText.length > 0, true, "Expected non-empty response");
});

Deno.test("integration: full round-trip with auth and healthcheck", async () => {
  const runtime = createRuntime();
  await initRuntime(runtime);

  const modelId = "gpt-5-nano";
  assertExists(runtime.models.get(modelId), "gpt-5-nano not found");

  const port = 18000 + Math.floor(Math.random() * 1000);
  const apiKey = `test-key-${crypto.randomUUID().slice(0, 8)}`;

  const server = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-net",
      "--allow-run",
      "--allow-env",
      "--allow-read",
      "main.ts",
    ],
    env: { PORT: String(port), API_KEY: apiKey },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  await new Promise((r) => setTimeout(r, 3000));

  try {
    // 1. Health check (always public, no auth needed)
    const healthRes = await fetch(`http://localhost:${port}/health`);
    assertEquals(healthRes.ok, true);
    const healthData = await healthRes.json();
    assertEquals(healthData.status, "ok");
    assertExists(healthData.zed_user_id);
    console.log(
      `  /health: ok, user=${healthData.zed_user_id}, models=${healthData.models_loaded}`,
    );

    // 2. Auth rejection without key
    const noAuthRes = await fetch(`http://localhost:${port}/v1/models`);
    assertEquals(noAuthRes.status, 401);
    await noAuthRes.body?.cancel();
    console.log("  /v1/models without key: 401 (correct)");

    // 3. Auth rejection with wrong key
    const badAuthRes = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    assertEquals(badAuthRes.status, 401);
    await badAuthRes.body?.cancel();
    console.log("  /v1/models with wrong key: 401 (correct)");

    // 4. Success with correct key
    const modelsRes = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assertEquals(modelsRes.ok, true);
    const modelsData = await modelsRes.json();
    assertEquals(modelsData.object, "list");
    console.log(`  /v1/models with key: ${modelsData.data.length} models`);

    // 5. Chat completion with auth
    const chatRes = await fetch(
      `http://localhost:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{
            role: "user",
            content: "Say 'test passed' and nothing else.",
          }],
          stream: true,
          max_tokens: 2000,
        }),
      },
    );

    assertEquals(chatRes.ok, true);
    assertEquals(
      chatRes.headers.get("content-type")?.includes("text/event-stream"),
      true,
    );

    const reader = chatRes.body!.getReader();
    const decoder = new TextDecoder();
    let fullResponse = "";
    let sseBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      while (sseBuffer.includes("\n")) {
        const idx = sseBuffer.indexOf("\n");
        const line = sseBuffer.slice(0, idx).trim();
        sseBuffer = sseBuffer.slice(idx + 1);

        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          const data = JSON.parse(line.slice(6));
          const content = data.choices?.[0]?.delta?.content;
          if (content) fullResponse += content;
        }
      }
    }

    console.log(`  Streaming response: "${fullResponse.trim()}"`);
    assertEquals(fullResponse.length > 0, true);
    // 6. Anthropic Messages API (streaming)
    const msgRes = await fetch(
      `http://localhost:${port}/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          messages: [{
            role: "user",
            content: "Say 'anthropic ok' and nothing else.",
          }],
          max_tokens: 50,
          stream: true,
        }),
      },
    );

    assertEquals(msgRes.ok, true, `Messages endpoint failed: ${msgRes.status}`);
    assertEquals(
      msgRes.headers.get("content-type")?.includes("text/event-stream"),
      true,
    );

    const msgReader = msgRes.body!.getReader();
    let msgBuffer = "";
    let msgText = "";
    let sawMessageStart = false;
    let sawMessageStop = false;

    while (true) {
      const { done, value } = await msgReader.read();
      if (done) break;
      msgBuffer += decoder.decode(value, { stream: true });

      while (msgBuffer.includes("\n")) {
        const idx = msgBuffer.indexOf("\n");
        const line = msgBuffer.slice(0, idx).trim();
        msgBuffer = msgBuffer.slice(idx + 1);

        if (line.startsWith("event: ")) {
          const eventType = line.slice(7);
          if (eventType === "message_start") sawMessageStart = true;
          if (eventType === "message_stop") sawMessageStop = true;
        }
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6));
          if (
            data.type === "content_block_delta" &&
            data.delta?.type === "text_delta"
          ) {
            msgText += data.delta.text;
          }
        }
      }
    }

    console.log(`  /v1/messages streaming: "${msgText.trim()}"`);
    assertEquals(msgText.length > 0, true, "Expected non-empty Anthropic response");
    assertEquals(sawMessageStart, true, "Expected message_start event");
    assertEquals(sawMessageStop, true, "Expected message_stop event");
  } finally {
    server.kill("SIGTERM");
    await server.stdout.cancel();
    await server.stderr.cancel();
    await server.status;
  }
});
