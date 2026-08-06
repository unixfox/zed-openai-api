// OpenAI Responses API bridge: accepts /v1/responses requests and converts
// the upstream stream (via chat completions chunks) back into Responses SSE.

interface ResponsesContentPart {
  type?: string;
  text?: string;
  image_url?: string;
  detail?: string;
  file_id?: string;
}

interface ResponsesItem {
  type?: string;
  role?: string;
  content?: string | ResponsesContentPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: unknown;
}

interface ChatMessage {
  role: string;
  content?: string | {
    type: string;
    text?: string;
    image_url?: { url: string };
  }[];
  tool_calls?: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

interface ChatCompletionChunk {
  id?: string;
  model?: string;
  created?: number;
  choices?: {
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function randId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p: ResponsesContentPart) =>
          (p.type === "text" || p.type === "input_text" ||
            p.type === "output_text") &&
          typeof p.text === "string",
      )
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}

function contentToParts(
  content: unknown,
): { type: string; text?: string; image_url?: { url: string } }[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: { type: string; text?: string; image_url?: { url: string } }[] =
    [];
  for (const p of content as ResponsesContentPart[]) {
    if (
      (p.type === "text" || p.type === "input_text" ||
        p.type === "output_text") && p.text
    ) {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "input_image" && p.image_url) {
      parts.push({ type: "image_url", image_url: { url: p.image_url } });
    }
  }
  return parts;
}

// Convert a Responses API request body into an OpenAI Chat Completions
// request so the existing provider conversion can be reused.
export function responsesRequestToChatRequest(
  body: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  const messages: ChatMessage[] = [];
  const input = body.input as ResponsesItem[] | undefined;
  if (Array.isArray(input)) {
    for (const item of input) {
      const kind = item?.type ?? (item?.role ? "message" : undefined);
      if (kind === "message") {
        messages.push({
          role: item.role ?? "user",
          content: contentToParts(item.content),
        });
      } else if (item?.type === "function_call") {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [{
            id: item.call_id ?? randId("call_"),
            type: "function",
            function: {
              name: item.name ?? "",
              arguments: item.arguments ?? "{}",
            },
          }],
        });
      } else if (item?.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output ?? ""),
        });
      }
    }
  }

  // Merge consecutive system/developer messages (Responses API allows multiple)
  const merged: ChatMessage[] = [];
  for (const m of messages) {
    const isSys = m.role === "system" || m.role === "developer";
    const last = merged[merged.length - 1];
    if (
      isSys && last &&
      (last.role === "system" || last.role === "developer")
    ) {
      last.content = contentToString(last.content) + "\n\n" +
        contentToString(m.content);
      continue;
    }
    merged.push(m);
  }

  const result: Record<string, unknown> = {
    model: modelId,
    messages: merged,
    stream: body.stream !== false,
  };
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.max_output_tokens) {
    result.max_completion_tokens = body.max_output_tokens;
  }

  if (Array.isArray(body.tools)) {
    result.tools = (body.tools as {
      type?: string;
      name?: string;
      description?: string;
      parameters?: Record<string, unknown>;
      strict?: boolean;
    }[])
      .filter((t) => t?.type === "function" && t.name)
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: t.strict,
        },
      }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice as Record<string, unknown>;
    if (
      typeof tc === "object" && tc && tc.type === "function" && tc.name
    ) {
      result.tool_choice = {
        type: "function",
        function: { name: tc.name },
      };
    } else {
      result.tool_choice = tc;
    }
  }

  return result;
}

// Convert a collected non-streaming Chat Completions response into a
// Responses API JSON response.
export function chatCompletionToResponsesResponse(
  chat: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  const choices = chat.choices as Record<string, unknown>[] | undefined;
  const message = (choices?.[0]?.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === "string" ? message.content : "";

  const output: Record<string, unknown>[] = [{
    id: randId("msg_"),
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: content, annotations: [] }],
  }];

  const toolCalls = message.tool_calls as
    | { id?: string; function?: { name?: string; arguments?: string } }[]
    | undefined;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      output.push({
        type: "function_call",
        id: tc.id ?? randId("call_"),
        call_id: tc.id ?? randId("call_"),
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
        status: "completed",
      });
    }
  }

  const usage = chat.usage as
    | {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    }
    | undefined;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;

  return {
    id: randId("resp_"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: modelId,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// Convert Chat Completions SSE chunk JSON into Responses API SSE events.
// Returns fully-formatted "event: ...\ndata: ...\n\n" strings.
export function createResponsesStreamConverter(
  modelId: string,
): (chunkJson: string) => string[] {
  const responseId = randId("resp_");
  const itemId = randId("msg_");
  const created = Math.floor(Date.now() / 1000);
  const toolItems = new Map<
    number,
    { callId: string; name: string; arguments: string }
  >();
  let started = false;
  let finished = false;
  let text = "";

  function sse(name: string, data: Record<string, unknown>): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function baseResponse(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: responseId,
      object: "response",
      created_at: created,
      status: "in_progress",
      model: modelId,
      output: [],
      ...overrides,
    };
  }

  function complete(): string[] {
    const events: string[] = [];
    events.push(
      sse("response.output_text.done", {
        type: "response.output_text.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text,
      }),
    );
    events.push(
      sse("response.content_part.done", {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      }),
    );

    const messageItem: Record<string, unknown> = {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    events.push(
      sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: messageItem,
      }),
    );

    const output: Record<string, unknown>[] = [messageItem];
    for (const [idx, t] of toolItems) {
      const item: Record<string, unknown> = {
        type: "function_call",
        id: t.callId,
        call_id: t.callId,
        name: t.name,
        arguments: t.arguments,
        status: "completed",
      };
      output.push(item);
      events.push(
        sse("response.output_item.done", {
          type: "response.output_item.done",
          output_index: idx + 1,
          item,
        }),
      );
    }

    events.push(
      sse("response.completed", {
        type: "response.completed",
        response: {
          id: responseId,
          object: "response",
          created_at: created,
          status: "completed",
          model: modelId,
          output,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      }),
    );
    return events;
  }

  return (chunkJson: string): string[] => {
    const out: string[] = [];
    const trimmed = chunkJson.trim();
    if (trimmed === "[DONE]") {
      if (!finished) {
        finished = true;
        out.push(...complete());
      }
      return out;
    }

    let parsed: ChatCompletionChunk;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
    const choices = parsed.choices;
    if (!choices?.length) return [];
    const choice = choices[0];
    const delta = choice.delta ?? {};

    if (!started) {
      started = true;
      out.push(
        sse("response.created", {
          type: "response.created",
          response: baseResponse(),
        }),
      );
      out.push(
        sse("response.in_progress", {
          type: "response.in_progress",
          response: baseResponse(),
        }),
      );
      out.push(
        sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: itemId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }),
      );
      out.push(
        sse("response.content_part.added", {
          type: "response.content_part.added",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      );
    }

    if (delta.content) {
      text += delta.content;
      out.push(
        sse("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        }),
      );
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (tc.id) {
          toolItems.set(idx, {
            callId: tc.id,
            name: tc.function?.name ?? "",
            arguments: "",
          });
          out.push(
            sse("response.output_item.added", {
              type: "response.output_item.added",
              output_index: idx + 1,
              item: {
                type: "function_call",
                id: tc.id,
                call_id: tc.id,
                name: tc.function?.name ?? "",
                arguments: "",
              },
            }),
          );
        } else if (tc.function?.arguments) {
          const t = toolItems.get(idx);
          if (t) t.arguments += tc.function.arguments;
          out.push(
            sse("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: t?.callId ?? "",
              output_index: idx + 1,
              delta: tc.function.arguments,
            }),
          );
        }
      }
    }

    if (choice.finish_reason && !finished) {
      finished = true;
      out.push(...complete());
    }

    return out;
  };
}
