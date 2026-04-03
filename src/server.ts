import {
  checkCredentials,
  refreshToken,
  type RuntimeState,
  sendCompletion,
  shouldRefreshToken,
  type ZedModel,
} from "@lib/zed";
import { buildProviderRequest, createStreamConverter } from "@lib/openai";
import { createAnthropicStreamConverter } from "@lib/anthropic";

// --- Auth middleware ---

export function authenticate(
  req: Request,
  apiKey: string | null,
): Response | null {
  if (!apiKey) return null;

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (token !== apiKey) {
    return Response.json(
      {
        error: {
          message:
            "Invalid or missing API key. Set Authorization: Bearer <API_KEY>.",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      },
      { status: 401 },
    );
  }
  return null;
}

// --- Route handlers ---

export function handleModels(runtime: RuntimeState): Response {
  const models = Array.from(runtime.models.values()).map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 0,
    owned_by: `zed/${m.provider}`,
    permission: [],
    root: m.id,
    parent: null,
    // Non-standard but useful for clients to discover limits
    context_window: m.max_token_count,
    max_output_tokens: m.max_output_tokens,
  }));
  return Response.json({ object: "list", data: models });
}

export async function handleHealthCheck(
  runtime: RuntimeState,
): Promise<Response> {
  const result = await checkCredentials(runtime);
  return Response.json(
    {
      status: result.ok ? "ok" : "error",
      zed_user_id: result.userId || null,
      models_loaded: runtime.models.size,
      has_llm_token: Boolean(runtime.llmToken),
      ...(result.error ? { error: result.error } : {}),
    },
    { status: result.ok ? 200 : 503 },
  );
}

export async function handleChatCompletions(
  req: Request,
  runtime: RuntimeState,
): Promise<Response> {
  const body = await req.json();
  const modelId: string = body.model;
  const stream: boolean = body.stream !== false;

  let model: ZedModel | undefined = runtime.models.get(modelId);
  if (!model) {
    for (const [id, m] of runtime.models) {
      if (id.startsWith(modelId) || m.display_name === modelId) {
        model = m;
        break;
      }
    }
  }

  if (!model) {
    return Response.json(
      {
        error: {
          message:
            `Model '${modelId}' not found. Use GET /v1/models to list available models.`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      { status: 404 },
    );
  }

  const providerRequest = buildProviderRequest(
    { ...body, model: model.id },
    model,
  );

  let token = runtime.llmToken!;
  let response = await sendCompletion(
    token,
    model.provider,
    model.id,
    providerRequest,
  );

  if (shouldRefreshToken(response)) {
    token = await refreshToken(runtime);
    response = await sendCompletion(
      token,
      model.provider,
      model.id,
      providerRequest,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `[zed-openai-api] Completion failed (${response.status}): ${text}`,
    );
    return Response.json(
      {
        error: {
          message: `Upstream error (${response.status}): ${text}`,
          type: "upstream_error",
          code: "upstream_error",
        },
      },
      { status: response.status },
    );
  }

  if (!stream) return collectNonStreamingResponse(response, model);
  return streamResponse(response, model);
}

// --- Anthropic Messages API handler ---

export async function handleMessages(
  req: Request,
  runtime: RuntimeState,
): Promise<Response> {
  const body = await req.json();
  const modelId: string = body.model;
  const stream: boolean = body.stream === true;

  let model: ZedModel | undefined = runtime.models.get(modelId);
  if (!model) {
    for (const [id, m] of runtime.models) {
      if (id.startsWith(modelId) || m.display_name === modelId) {
        model = m;
        break;
      }
    }
  }

  if (!model) {
    return Response.json(
      {
        type: "error",
        error: {
          type: "not_found_error",
          message:
            `Model '${modelId}' not found. Use GET /v1/models to list available models.`,
        },
      },
      { status: 404 },
    );
  }

  // Build the provider request — for anthropic models, pass through nearly as-is
  const providerRequest = buildAnthropicProviderRequest(body, model);

  let token = runtime.llmToken!;
  let response = await sendCompletion(
    token,
    model.provider,
    model.id,
    providerRequest,
  );

  if (shouldRefreshToken(response)) {
    token = await refreshToken(runtime);
    response = await sendCompletion(
      token,
      model.provider,
      model.id,
      providerRequest,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `[zed-openai-api] Messages failed (${response.status}): ${text}`,
    );
    return Response.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: `Upstream error (${response.status}): ${text}`,
        },
      },
      { status: response.status },
    );
  }

  if (!stream) return collectAnthropicNonStreamingResponse(response, model);
  return streamAnthropicResponse(response, model);
}

function buildAnthropicProviderRequest(
  body: Record<string, unknown>,
  model: ZedModel,
): Record<string, unknown> {
  // Clamp max_tokens
  const maxTokens = body.max_tokens as number | undefined;
  const limit = model.max_output_tokens;
  const clampedMaxTokens = limit && maxTokens && maxTokens > limit
    ? limit
    : maxTokens;

  if (model.provider === "anthropic") {
    // Pass through as Anthropic format, normalizing content to arrays for Zed
    const messages = body.messages as
      | { role: string; content: unknown }[]
      | undefined;
    const normalizedMessages = messages?.map((m) => ({
      ...m,
      content: typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content,
    }));
    return {
      ...body,
      model: model.id,
      messages: normalizedMessages,
      stream: body.stream === true,
      ...(clampedMaxTokens ? { max_tokens: clampedMaxTokens } : {}),
    };
  }

  // For non-Anthropic models, convert Anthropic messages to OpenAI Responses API
  return buildProviderRequest(
    anthropicToOpenAIChatRequest(body, model.id) as Parameters<typeof buildProviderRequest>[0],
    model,
  );
}

function anthropicToOpenAIChatRequest(
  body: Record<string, unknown>,
  modelId: string,
): {
  model: string;
  messages: { role: string; content: unknown }[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: { type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
} {
  const messages: { role: string; content: unknown }[] = [];

  // System message
  const system = body.system;
  if (typeof system === "string" && system) {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = (system as { type: string; text: string }[])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
    if (text) messages.push({ role: "system", content: text });
  }

  // Messages
  const anthropicMessages = body.messages as
    | { role: string; content: unknown }[]
    | undefined;
  if (anthropicMessages) {
    for (const msg of anthropicMessages) {
      messages.push({ role: msg.role, content: contentToString(msg.content) });
    }
  }

  const result: ReturnType<typeof anthropicToOpenAIChatRequest> = {
    model: modelId,
    messages,
    stream: body.stream === true,
  };

  if (body.max_tokens) result.max_tokens = body.max_tokens as number;
  if (body.temperature !== undefined) {
    result.temperature = body.temperature as number;
  }
  if (body.top_p !== undefined) result.top_p = body.top_p as number;
  if (body.stop_sequences) result.stop = body.stop_sequences as string[];

  // Convert tools
  const tools = body.tools as
    | { name: string; description?: string; input_schema?: Record<string, unknown> }[]
    | undefined;
  if (tools?.length) {
    result.tools = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  return result;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === "text")
      .map((b: Record<string, unknown>) => b.text as string)
      .join("");
  }
  return "";
}

async function collectAnthropicNonStreamingResponse(
  response: Response,
  model: ZedModel,
): Promise<Response> {
  const text = await response.text();
  const lines = text.split("\n").filter((l) => l.trim());

  let fullText = "";
  const contentBlocks: Record<string, unknown>[] = [];
  let stopReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls: {
    id: string;
    name: string;
    arguments: string;
  }[] = [];

  for (const line of lines) {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const event = (
      typeof parsed!.event === "object" && parsed!.event !== null
        ? parsed!.event
        : parsed!.status
        ? null
        : parsed
    ) as Record<string, unknown> | null;
    if (!event) continue;

    const type = event.type as string;
    // Anthropic events
    if (type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown>;
      if (delta?.type === "text_delta") fullText += delta.text as string;
      else if (delta?.type === "input_json_delta" && toolCalls.length > 0) {
        toolCalls[toolCalls.length - 1].arguments +=
          delta.partial_json as string;
      }
    } else if (type === "content_block_start") {
      const block = event.content_block as Record<string, unknown>;
      if (block?.type === "tool_use") {
        toolCalls.push({
          id: block.id as string,
          name: block.name as string,
          arguments: "",
        });
      }
    } else if (type === "message_start") {
      const msg = event.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, number> | undefined;
      if (usage) inputTokens = usage.input_tokens || 0;
    } else if (type === "message_delta") {
      const delta = event.delta as Record<string, unknown>;
      stopReason = (delta?.stop_reason as string) || "end_turn";
      const usage = event.usage as Record<string, number> | undefined;
      if (usage) outputTokens = usage.output_tokens || 0;
    }
    // OpenAI Responses API events
    else if (type === "response.output_text.delta") {
      fullText += event.delta as string;
    } else if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        toolCalls.push({
          id: item.call_id as string,
          name: item.name as string,
          arguments: "",
        });
      }
    } else if (type === "response.function_call_arguments.delta") {
      const idx = (event.output_index as number) ?? toolCalls.length - 1;
      if (toolCalls[idx]) toolCalls[idx].arguments += event.delta as string;
    } else if (type === "response.completed") {
      const resp = event.response as Record<string, unknown> | undefined;
      const usage = resp?.usage as Record<string, number> | undefined;
      if (usage) {
        inputTokens = usage.input_tokens || 0;
        outputTokens = usage.output_tokens || 0;
      }
      if (resp?.status === "incomplete") stopReason = "max_tokens";
    }
  }

  if (fullText) {
    contentBlocks.push({ type: "text", text: fullText });
  }
  for (const tc of toolCalls) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.arguments);
    } catch { /* use empty object */ }
    contentBlocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input,
    });
    if (stopReason === "end_turn") stopReason = "tool_use";
  }

  return Response.json({
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: model.id,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  });
}

function streamAnthropicResponse(
  response: Response,
  model: ZedModel,
): Response {
  const converter = createAnthropicStreamConverter(model.provider, model.id);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const stream = new ReadableStream({
    async pull(controller) {
      while (true) {
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
          buffer = buffer.slice(newlineIdx + 1);
          const sseChunks = converter(line);
          for (const chunk of sseChunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          if (sseChunks.length > 0) return;
          continue;
        }

        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            const sseChunks = converter(buffer);
            for (const chunk of sseChunks) {
              controller.enqueue(encoder.encode(chunk));
            }
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// --- OpenAI Response handling ---

async function collectNonStreamingResponse(
  response: Response,
  model: ZedModel,
): Promise<Response> {
  const text = await response.text();
  const lines = text.split("\n").filter((l) => l.trim());

  let fullText = "";
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  let stopReason = "stop";

  for (const line of lines) {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const event = (
      typeof parsed!.event === "object" && parsed!.event !== null
        ? parsed!.event
        : parsed!.status
        ? null
        : parsed
    ) as Record<string, unknown> | null;
    if (!event) continue;

    const type = event.type as string;
    // OpenAI Responses API events
    if (type === "response.output_text.delta") {
      fullText += event.delta as string;
    } else if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        toolCalls.push({
          id: item.call_id as string,
          name: item.name as string,
          arguments: "",
        });
      }
    } else if (type === "response.function_call_arguments.delta") {
      const idx = (event.output_index as number) ?? toolCalls.length - 1;
      if (toolCalls[idx]) toolCalls[idx].arguments += event.delta as string;
    } else if (type === "response.completed") {
      const resp = event.response as Record<string, unknown> | undefined;
      if (resp?.status === "incomplete") stopReason = "length";
    } // Anthropic events
    else if (type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown>;
      if (delta?.type === "text_delta") fullText += delta.text as string;
      else if (delta?.type === "input_json_delta" && toolCalls.length > 0) {
        toolCalls[toolCalls.length - 1].arguments += delta
          .partial_json as string;
      }
    } else if (type === "content_block_start") {
      const block = event.content_block as Record<string, unknown>;
      if (block?.type === "tool_use") {
        toolCalls.push({
          id: block.id as string,
          name: block.name as string,
          arguments: "",
        });
      }
    } else if (type === "message_delta") {
      const delta = event.delta as Record<string, unknown>;
      const sr = delta?.stop_reason as string;
      if (sr === "tool_use") stopReason = "tool_calls";
      else if (sr === "max_tokens") stopReason = "length";
      else if (sr === "end_turn") stopReason = "stop";
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: fullText || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: tc.id,
      type: "function",
      index: i,
      function: { name: tc.name, arguments: tc.arguments },
    }));
    if (!fullText) stopReason = "tool_calls";
  }

  return Response.json({
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [{ index: 0, message, finish_reason: stopReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

function streamResponse(response: Response, model: ZedModel): Response {
  const converter = createStreamConverter(model.provider, model.id);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const stream = new ReadableStream({
    async pull(controller) {
      while (true) {
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
          buffer = buffer.slice(newlineIdx + 1);
          const chunks = converter(line);
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          }
          if (chunks.length > 0) return;
          continue;
        }

        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            const chunks = converter(buffer);
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
