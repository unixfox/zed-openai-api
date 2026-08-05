// Converts Zed NDJSON stream events → OpenAI Chat Completions SSE chunks

interface StreamState {
  id: string;
  model: string;
  created: number;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  currentToolIndex: number;
}

function jsonParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function makeChunk(
  state: StreamState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return JSON.stringify({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

// --- OpenAI Responses API events ---

function convertOpenAiResponseEvent(
  event: Record<string, unknown>,
  state: StreamState,
): string[] {
  const chunks: string[] = [];
  const type = event.type as string;

  if (type === "response.output_text.delta") {
    chunks.push(makeChunk(state, { content: event.delta as string }));
  } else if (type === "response.content_part.added") {
    if ((event.content_index as number) === 0) {
      const part = event.part as Record<string, unknown> | undefined;
      if (part?.type === "output_text") {
        chunks.push(makeChunk(state, { role: "assistant", content: "" }));
      }
    }
  } else if (type === "response.completed") {
    chunks.push(makeChunk(state, {}, "stop"));
  } else if (type === "response.function_call_arguments.delta") {
    const idx = (event.output_index as number) ?? 0;
    chunks.push(
      makeChunk(state, {
        tool_calls: [{
          index: idx,
          function: { arguments: event.delta as string },
        }],
      }),
    );
  } else if (type === "response.output_item.added") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "function_call") {
      const idx = (event.output_index as number) ?? 0;
      chunks.push(
        makeChunk(state, {
          tool_calls: [{
            index: idx,
            id: item.call_id as string,
            type: "function",
            function: { name: item.name as string, arguments: "" },
          }],
        }),
      );
    }
  }

  return chunks;
}

// --- Anthropic events ---

function convertAnthropicEvent(
  event: Record<string, unknown>,
  state: StreamState,
): string[] {
  const chunks: string[] = [];
  const type = event.type as string;

  if (type === "message_start") {
    chunks.push(makeChunk(state, { role: "assistant", content: "" }));
  } else if (type === "content_block_start") {
    const block = event.content_block as Record<string, unknown> | undefined;
    if (block?.type === "tool_use") {
      const idx = state.currentToolIndex++;
      state.toolCalls.set(idx, {
        id: block.id as string,
        name: block.name as string,
        arguments: "",
      });
      chunks.push(
        makeChunk(state, {
          tool_calls: [{
            index: idx,
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: "" },
          }],
        }),
      );
    }
  } else if (type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta") {
      chunks.push(makeChunk(state, { content: delta.text as string }));
    } else if (delta?.type === "input_json_delta") {
      const idx = (event.index as number) ?? state.currentToolIndex - 1;
      const tc = state.toolCalls.get(idx);
      if (tc) tc.arguments += delta.partial_json as string;
      chunks.push(
        makeChunk(state, {
          tool_calls: [{
            index: idx,
            function: { arguments: delta.partial_json as string },
          }],
        }),
      );
    }
  } else if (type === "message_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    const sr = delta?.stop_reason as string | undefined;
    chunks.push(
      makeChunk(
        state,
        {},
        sr === "tool_use"
          ? "tool_calls"
          : sr === "max_tokens"
          ? "length"
          : "stop",
      ),
    );
  }

  return chunks;
}

// --- Google Gemini events ---

function convertGeminiEvent(
  event: Record<string, unknown>,
  state: StreamState,
): string[] {
  const chunks: string[] = [];
  const candidates = event.candidates as Record<string, unknown>[] | undefined;
  if (!candidates?.length) return [];

  const candidate = candidates[0];
  const content = candidate.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Record<string, unknown>[] | undefined;
  const finishReason = candidate.finishReason as string | undefined;

  if (parts) {
    for (const part of parts) {
      if (part.text) {
        chunks.push(makeChunk(state, { content: part.text as string }));
      }
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const idx = state.currentToolIndex++;
        chunks.push(
          makeChunk(state, {
            tool_calls: [{
              index: idx,
              id: `call_${crypto.randomUUID().slice(0, 8)}`,
              type: "function",
              function: {
                name: fc.name as string,
                arguments: JSON.stringify(fc.args || {}),
              },
            }],
          }),
        );
      }
    }
  }

  if (finishReason === "STOP") {
    chunks.push(makeChunk(state, {}, "stop"));
  } else if (finishReason === "MAX_TOKENS") {
    chunks.push(makeChunk(state, {}, "length"));
  }

  return chunks;
}

// --- Chat Completions chunk events (xAI) ---

function convertChatCompletionsEvent(
  event: Record<string, unknown>,
  state: StreamState,
): string[] {
  // Already in OpenAI Chat Completions format — re-wrap with our ID
  const choices = event.choices as Record<string, unknown>[];
  if (!choices || choices.length === 0) return [];

  const choice = choices[0];
  const delta = choice.delta as Record<string, unknown> | undefined;
  const finishReason = (choice.finish_reason as string) || null;

  if (!delta && !finishReason) return [];

  const newDelta: Record<string, unknown> = {};
  if (delta?.role) newDelta.role = delta.role;
  if (delta?.content) newDelta.content = delta.content;
  if (delta?.tool_calls) newDelta.tool_calls = delta.tool_calls;

  return [makeChunk(state, newDelta, finishReason)];
}

// --- Public API ---

export function createStreamConverter(
  provider: string,
  model: string,
): (line: string) => string[] {
  const state: StreamState = {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    model,
    created: Math.floor(Date.now() / 1000),
    toolCalls: new Map(),
    currentToolIndex: 0,
  };
  let sentRole = false;

  function withRole(chunks: string[]): string[] {
    if (chunks.length === 0 || sentRole) return chunks;
    sentRole = true;
    const first = jsonParse(chunks[0]);
    const firstChoices = first?.choices as
      | Record<string, unknown>[]
      | undefined;
    const firstDelta = firstChoices?.[0]?.delta as
      | Record<string, unknown>
      | undefined;
    if (firstDelta?.role === "assistant") return chunks;
    return [
      makeChunk(state, { role: "assistant", content: "" }),
      ...chunks,
    ];
  }

  return (line: string): string[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];

    const parsed = jsonParse(trimmed);
    if (!parsed) return [];

    // Zed wraps events in {"event": {...}}
    const event = (
      typeof parsed.event === "object" && parsed.event !== null
        ? parsed.event
        : parsed.status
        ? null
        : parsed
    ) as Record<string, unknown> | null;

    if (!event) return [];

    // Route based on event format
    const type = event.type as string;

    // OpenAI Responses API (have a "type" field starting with "response.")
    if (type?.startsWith("response.")) {
      return withRole(convertOpenAiResponseEvent(event, state));
    }

    // Google Gemini events (have "candidates" array)
    if (Array.isArray(event.candidates)) {
      return withRole(convertGeminiEvent(event, state));
    }

    // Chat Completions chunk format (xAI — have "choices" array, no "type")
    if (Array.isArray(event.choices)) {
      return withRole(convertChatCompletionsEvent(event, state));
    }

    // Anthropic events (message_start, content_block_*, message_delta, etc.)
    if (
      provider === "anthropic" &&
      !sentRole &&
      type !== "message_start"
    ) {
      sentRole = true;
      return [
        makeChunk(state, { role: "assistant", content: "" }),
        ...convertAnthropicEvent(event, state),
      ];
    }
    if (type === "message_start" || type === "content_block_start") {
      sentRole = true;
    }
    return convertAnthropicEvent(event, state);
  };
}
