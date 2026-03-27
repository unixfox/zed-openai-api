import {
  checkCredentials,
  refreshToken,
  type RuntimeState,
  sendCompletion,
  shouldRefreshToken,
  type ZedModel,
} from "@lib/zed";
import { buildProviderRequest, createStreamConverter } from "@lib/openai";

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

// --- Response handling ---

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
