// Converts Zed NDJSON stream events → Anthropic SSE format
// Anthropic SSE uses `event: <type>\ndata: <json>\n\n`

function jsonParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function unwrapZedEvent(
  line: string,
): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parsed = jsonParse(trimmed);
  if (!parsed) return null;
  if (typeof parsed.event === "object" && parsed.event !== null) {
    return parsed.event as Record<string, unknown>;
  }
  if (parsed.status) return null;
  return parsed;
}

// For Anthropic provider: events are already Anthropic-native, just format as SSE
function formatAnthropicSse(event: Record<string, unknown>): string {
  const type = event.type as string;
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// For OpenAI provider: convert Responses API events to Anthropic events
function convertOpenAiToAnthropicEvents(
  event: Record<string, unknown>,
  state: { messageId: string; inputTokens: number; outputTokens: number },
): string[] {
  const results: string[] = [];
  const type = event.type as string;

  if (type === "response.content_part.added") {
    const part = event.part as Record<string, unknown> | undefined;
    if (part?.type === "output_text") {
      results.push(formatAnthropicSse({
        type: "content_block_start",
        index: event.content_index ?? 0,
        content_block: { type: "text", text: "" },
      }));
    }
  } else if (type === "response.output_text.delta") {
    results.push(formatAnthropicSse({
      type: "content_block_delta",
      index: event.content_index ?? 0,
      delta: { type: "text_delta", text: event.delta as string },
    }));
  } else if (type === "response.output_text.done") {
    results.push(formatAnthropicSse({
      type: "content_block_stop",
      index: event.content_index ?? 0,
    }));
  } else if (type === "response.output_item.added") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "function_call") {
      results.push(formatAnthropicSse({
        type: "content_block_start",
        index: event.output_index ?? 0,
        content_block: {
          type: "tool_use",
          id: item.call_id as string,
          name: item.name as string,
          input: {},
        },
      }));
    }
  } else if (type === "response.function_call_arguments.delta") {
    results.push(formatAnthropicSse({
      type: "content_block_delta",
      index: event.output_index ?? 0,
      delta: {
        type: "input_json_delta",
        partial_json: event.delta as string,
      },
    }));
  } else if (type === "response.completed") {
    const resp = event.response as Record<string, unknown> | undefined;
    const usage = resp?.usage as Record<string, number> | undefined;
    if (usage) {
      state.inputTokens = usage.input_tokens || 0;
      state.outputTokens = usage.output_tokens || 0;
    }
    const incomplete = resp?.status === "incomplete";
    results.push(formatAnthropicSse({
      type: "message_delta",
      delta: {
        stop_reason: incomplete ? "max_tokens" : "end_turn",
        stop_sequence: null,
      },
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
      },
    }));
    results.push(formatAnthropicSse({ type: "message_stop" }));
  }

  return results;
}

export function createAnthropicStreamConverter(
  provider: string,
  model: string,
): (line: string) => string[] {
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let sentStart = false;
  const state = { messageId, inputTokens: 0, outputTokens: 0 };

  return (line: string): string[] => {
    const event = unwrapZedEvent(line);
    if (!event) return [];

    const results: string[] = [];

    if (provider === "anthropic") {
      // Native Anthropic events — pass through as SSE
      // Inject message_start if first event isn't one
      const type = event.type as string;
      if (!sentStart && type !== "message_start") {
        sentStart = true;
        results.push(formatAnthropicSse({
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        }));
      }
      if (type === "message_start") sentStart = true;
      results.push(formatAnthropicSse(event));
      return results;
    }

    // OpenAI Responses API events → Anthropic events
    const type = event.type as string;
    if (!type?.startsWith("response.")) return [];

    if (!sentStart) {
      sentStart = true;
      results.push(formatAnthropicSse({
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    }

    results.push(...convertOpenAiToAnthropicEvents(event, state));
    return results;
  };
}
