import type { ZedModel } from "@lib/zed";

// --- Types ---

interface OpenAIChatMessage {
  role: string;
  content?: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string };
}

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function?: { name: string } };
  frequency_penalty?: number;
  presence_penalty?: number;
}

interface OpenAITool {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

// --- Helpers ---

function contentToString(content: string | ContentPart[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("");
}

function jsonParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- OpenAI Responses API format ---

export function chatToResponsesApiRequest(
  req: OpenAIChatRequest,
): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];

  for (const msg of req.messages) {
    const role = msg.role === "developer"
      ? "system"
      : msg.role === "tool"
      ? "user"
      : msg.role;

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: contentToString(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      const text = contentToString(msg.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      continue;
    }

    const contentParts = formatResponsesContent(role, msg.content);
    if (contentParts.length > 0) {
      input.push({ type: "message", role, content: contentParts });
    }
  }

  const result: Record<string, unknown> = {
    model: req.model,
    input,
    stream: req.stream !== false,
  };

  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.max_tokens || req.max_completion_tokens) {
    result.max_output_tokens = req.max_completion_tokens || req.max_tokens;
  }

  if (req.tools?.length) {
    result.tools = req.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      strict: t.function.strict,
    }));
    if (typeof req.tool_choice === "string") {
      result.tool_choice = req.tool_choice;
    }
  }

  return result;
}

function formatResponsesContent(
  role: string,
  content: string | ContentPart[] | undefined,
): Record<string, unknown>[] {
  if (!content) return [];
  if (typeof content === "string") {
    const type = role === "assistant" ? "output_text" : "input_text";
    const part: Record<string, unknown> = { type, text: content };
    if (type === "output_text") part.annotations = [];
    return [part];
  }

  const parts: Record<string, unknown>[] = [];
  for (const p of content) {
    if (p.type === "text" && p.text) {
      const type = role === "assistant" ? "output_text" : "input_text";
      const part: Record<string, unknown> = { type, text: p.text };
      if (type === "output_text") part.annotations = [];
      parts.push(part);
    } else if (p.type === "image_url" && p.image_url?.url) {
      parts.push({
        type: "input_image",
        image_url: p.image_url.url,
        ...(p.image_url.detail ? { detail: p.image_url.detail } : {}),
      });
    }
  }
  return parts;
}

// --- Anthropic format (internal, for Claude models via Zed) ---

function toAnthropicContent(
  content: string | ContentPart[] | undefined,
): { type: string; [k: string]: unknown }[] {
  if (!content) return [];
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }
  const blocks: { type: string; [k: string]: unknown }[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text?.trim()) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url" && part.image_url?.url) {
      const url = part.image_url.url;
      const match = url.match(/^data:([\w/+-]+);base64,(.+)$/);
      if (match) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: match[1], data: match[2] },
        });
      } else {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return blocks;
}

function chatToAnthropicRequest(
  req: OpenAIChatRequest,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: { role: string; content: unknown }[] = [];

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemParts.push(contentToString(msg.content));
      continue;
    }
    if (msg.role === "assistant") {
      const content = [...toAnthropicContent(msg.content)];
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: jsonParse(tc.function.arguments) || {},
          });
        }
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
      continue;
    }
    if (msg.role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: contentToString(msg.content),
        is_error: false,
      };
      const last = messages[messages.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(toolResult);
      } else {
        messages.push({ role: "user", content: [toolResult] });
      }
      continue;
    }
    messages.push({ role: "user", content: toAnthropicContent(msg.content) });
  }

  const result: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: req.stream !== false,
    max_tokens: req.max_completion_tokens || req.max_tokens || 16384,
  };
  if (systemParts.length > 0) result.system = systemParts.join("\n\n");
  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.stop) {
    result.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (req.tools?.length) {
    result.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
    if (req.tool_choice) {
      if (typeof req.tool_choice === "string") {
        result.tool_choice = req.tool_choice === "required"
          ? { type: "any" }
          : { type: "auto" };
      } else if (req.tool_choice.function?.name) {
        result.tool_choice = {
          type: "tool",
          name: req.tool_choice.function.name,
        };
      }
    }
  }
  return result;
}

// --- Google Gemini format ---

function chatToGeminiRequest(
  req: OpenAIChatRequest,
): Record<string, unknown> {
  const contents: Record<string, unknown>[] = [];
  let systemInstruction: Record<string, unknown> | undefined;

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemInstruction = {
        parts: [{ text: contentToString(msg.content) }],
      };
      continue;
    }

    const role = msg.role === "assistant" ? "model" : "user";
    const parts: Record<string, unknown>[] = [];

    if (msg.role === "assistant" && msg.tool_calls) {
      const text = contentToString(msg.content);
      if (text) parts.push({ text });
      for (const tc of msg.tool_calls) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: jsonParse(tc.function.arguments) || {},
          },
        });
      }
    } else if (msg.role === "tool") {
      parts.push({
        functionResponse: {
          name: "tool",
          response: { result: contentToString(msg.content) },
        },
      });
    } else {
      const content = msg.content;
      if (typeof content === "string") {
        parts.push({ text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text" && part.text) {
            parts.push({ text: part.text });
          } else if (part.type === "image_url" && part.image_url?.url) {
            const url = part.image_url.url;
            const match = url.match(/^data:([\w/+-]+);base64,(.+)$/);
            if (match) {
              parts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            }
          }
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  const result: Record<string, unknown> = { contents };
  if (systemInstruction) result.systemInstruction = systemInstruction;

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) {
    generationConfig.temperature = req.temperature;
  }
  if (req.top_p !== undefined) generationConfig.topP = req.top_p;
  if (req.max_tokens || req.max_completion_tokens) {
    generationConfig.maxOutputTokens = req.max_completion_tokens ||
      req.max_tokens;
  }
  if (req.stop) {
    generationConfig.stopSequences = Array.isArray(req.stop)
      ? req.stop
      : [req.stop];
  }
  if (Object.keys(generationConfig).length > 0) {
    result.generationConfig = generationConfig;
  }

  if (req.tools?.length) {
    result.tools = [{
      functionDeclarations: req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        parameters: sanitizeGeminiSchema(t.function.parameters) || {},
      })),
    }];
  }

  return result;
}

// Gemini rejects non-standard JSON Schema keywords that MCP tool schemas
// commonly include ($schema, $id, const, enumTitles, patternProperties, ...).
// Strip them recursively so upstream doesn't return a 400 for the whole batch.
const GEMINI_SCHEMA_KEYWORDS = new Set([
  "type",
  "enum",
  "nullable",
  "format",
  "description",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "default",
  "oneOf",
  "anyOf",
  "allOf",
]);

function sanitizeGeminiSchema(
  node: unknown,
): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return { type: "object" };
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_KEYWORDS.has(key)) {
      if (
        key === "$schema" || key === "$id" || key === "const" ||
        key === "enumTitles" || key === "patternProperties" ||
        key.startsWith("$")
      ) {
        continue;
      }
      if (key === "title") continue;
      continue;
    }

    if (key === "properties") {
      const props: Record<string, unknown> = {};
      for (
        const [propName, propSchema] of Object.entries(
          value as Record<string, unknown>,
        )
      ) {
        props[propName] = sanitizeGeminiSchema(propSchema);
      }
      result.properties = props;
    } else if (key === "items") {
      result.items = sanitizeGeminiSchema(value);
    } else if (key === "oneOf" || key === "anyOf" || key === "allOf") {
      if (Array.isArray(value)) {
        // Gemini only accepts oneOf alongside other keys; anyOf/allOf are
        // unsupported ("must be the only field set" / unknown). Rewrite them.
        result.oneOf = value.map((v) => sanitizeGeminiSchema(v));
      }
    } else {
      result[key] = value;
    }
  }

  if (!("type" in result)) result.type = "object";
  return result;
}

// --- Chat Completions format (for xAI and other OpenAI-chat-compatible providers) ---

function chatToChatCompletionsRequest(
  req: OpenAIChatRequest,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];

  for (const msg of req.messages) {
    const role = msg.role === "developer" ? "system" : msg.role;

    if (msg.role === "assistant" && msg.tool_calls) {
      messages.push({
        role: "assistant",
        content: contentToString(msg.content) || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      });
      continue;
    }

    if (msg.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: msg.tool_call_id,
        content: contentToString(msg.content),
      });
      continue;
    }

    messages.push({ role, content: msg.content });
  }

  const result: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: req.stream !== false,
  };

  // xAI requires temperature to be present
  result.temperature = req.temperature ?? 1;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.max_tokens || req.max_completion_tokens) {
    result.max_tokens = req.max_completion_tokens || req.max_tokens;
  }
  if (req.stop) result.stop = req.stop;

  if (req.tools?.length) {
    result.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
    if (req.tool_choice) result.tool_choice = req.tool_choice;
  }

  return result;
}

// --- Build provider request ---

function clampMaxTokens(
  req: OpenAIChatRequest,
  model: ZedModel,
): OpenAIChatRequest {
  const requested = req.max_completion_tokens || req.max_tokens;
  const limit = model.max_output_tokens;
  if (limit && requested && requested > limit) {
    return { ...req, max_tokens: limit, max_completion_tokens: undefined };
  }
  return req;
}

export function buildProviderRequest(
  req: OpenAIChatRequest,
  model: ZedModel,
): Record<string, unknown> {
  const clamped = clampMaxTokens(req, model);
  if (model.provider === "anthropic") return chatToAnthropicRequest(clamped);
  if (model.provider === "google") return chatToGeminiRequest(clamped);
  if (model.provider === "x_ai") return chatToChatCompletionsRequest(clamped);
  // Default: OpenAI Responses API
  return chatToResponsesApiRequest(clamped);
}
