# zed-openai-api

OpenAI-compatible API server that proxies requests through [Zed](https://zed.dev)'s hosted AI infrastructure. Reuses your existing Zed desktop credentials to access all models available on your Zed plan.

Built with Deno. Compiles to a single binary.

## Supported models

All models from your Zed subscription are exposed, including:

| Provider | Models |
|----------|--------|
| Anthropic | claude-sonnet-5, claude-sonnet-4-6, claude-sonnet-4-5, claude-haiku-4-5 |
| OpenAI | gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.3-codex, gpt-5.2, gpt-5-mini, gpt-5-nano |
| Google | gemini-3.1-pro-preview, gemini-3.5-flash, gemini-3-flash |
| xAI | grok-4, grok-4-fast-reasoning, grok-code-fast-1 |

The full list is fetched dynamically from Zed's `/models` endpoint at startup.

Can also be found at https://zed.dev/docs/ai/models

## Quick start

```bash
# Copy and configure environment
cp .env.example .env

# Run directly
deno task run

# Run with auto-reload (development)
deno task dev

# Or compile and run as a single binary
deno task compile
./zed-openai-api
```

The server starts on port `8080` on all interfaces (IPv4 + IPv6) by default.

## Authentication

### Zed credentials

The server needs your Zed credentials. Two methods, checked in order:

1. **Environment variables** (preferred for deployment):
   ```bash
   export ZED_USER_ID="695994"
   export ZED_ACCESS_TOKEN='{"version":2,"id":"...","token":"..."}'
   ```

2. **Local Zed desktop credentials** (automatic on Linux):
   Reads from `secret-tool` if you're signed into Zed desktop.
   ```bash
   # Verify your credentials are available:
   secret-tool search --all --unlock url https://zed.dev
   ```

#### Headless server (no Zed desktop)

Zed's access token is **long-lived** — there is no refresh flow; Zed only
re-authenticates when the token is actually invalidated (e.g. you sign out).
So you extract it **once** on a machine where Zed desktop is signed in, then
drop the values into your server's environment.

On your local (Zed desktop) machine:

```bash
# Print ZED_USER_ID / ZED_ACCESS_TOKEN, ready to paste into the server's .env
./scripts/extract-credentials.sh

# ...or write them straight into a local .env
./scripts/extract-credentials.sh --env-file

# ...or emit `export ...` lines
./scripts/extract-credentials.sh --export
```

Copy the two values to the server and set them as `ZED_USER_ID` /
`ZED_ACCESS_TOKEN`. They keep working until you sign out of Zed on the machine
you extracted them from — no re-passing per session.

### API key

Protect the server with an API key:

```bash
export API_KEY="my-secret-key"
```

When set, all endpoints (except `/health`) require `Authorization: Bearer my-secret-key`. Without `API_KEY`, endpoints are open.

## Endpoints

### `GET /health`

Public (no auth required). Validates Zed credentials against `cloud.zed.dev` without making any LLM calls.

```bash
curl http://localhost:8080/health
```
```json
{"status":"ok","zed_user_id":"695994","models_loaded":15,"has_llm_token":true}
```

### `GET /v1/models`

List available models. Includes `context_window` and `max_output_tokens` for each model.

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer $API_KEY"
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-sonnet-4-6",
      "object": "model",
      "owned_by": "zed/anthropic",
      "context_window": 1000000,
      "max_output_tokens": 64000
    }
  ]
}
```

### `POST /v1/chat/completions`

OpenAI-compatible chat completions. Supports streaming and non-streaming.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

If `max_tokens` exceeds the model's output limit, it is automatically clamped server-side.

#### Image support

Models that support vision accept images via `image_url` content parts:

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "What's in this image?"},
      {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo..."}}
    ]
  }]
}
```

Supported formats: JPEG, PNG, GIF, WebP. Both HTTP URLs and base64 data URIs work.

### `POST /v1/messages`

Anthropic Messages API compatible endpoint. Supports streaming and non-streaming.

```bash
curl http://localhost:8080/v1/messages \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

Streaming responses use Anthropic's SSE format (`event:` + `data:` lines). For Claude models, requests are passed through natively. Non-Claude models are automatically converted.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HOST` | No | `::` | Listen address (dual-stack IPv4+IPv6) |
| `PORT` | No | `8080` | Listen port |
| `API_KEY` | No | | API key for endpoint authentication |
| `ZED_USER_ID` | No | | Zed user ID (falls back to secret-tool) |
| `ZED_ACCESS_TOKEN` | No | | Zed access token JSON (falls back to secret-tool) |

See [`.env.example`](.env.example) for a template.

## Usage with other tools

Use as a drop-in OpenAI base URL:

```bash
# With curl
export OPENAI_BASE_URL=http://localhost:8080/v1
export OPENAI_API_KEY=$API_KEY

# With Python openai library
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="my-secret-key")
response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Development

```bash
deno task run           # Run server (loads .env)
deno task dev           # Run with auto-reload
deno task test          # Run tests (uses real Zed credentials)
deno task fmt           # Format code
deno task fmt:check     # Check formatting
deno task lint          # Lint code
deno task check         # Type check
deno task compile       # Compile to single binary
```

## Project structure

```
main.ts                 Entry point, routing
test.ts                 Unit + integration tests
src/
  server.ts             HTTP handlers, auth middleware
  zed/
    credentials.ts      Credential resolution (env, secret-tool)
    api.ts              Zed API calls (tokens, models, completions)
    runtime.ts          Runtime state management
    mod.ts              Re-exports
  openai/
    convert.ts          OpenAI request format conversion
    stream.ts           NDJSON to OpenAI SSE conversion
    mod.ts              Re-exports
  anthropic/
    stream.ts           NDJSON to Anthropic SSE conversion
    mod.ts              Re-exports
```

## License

MIT
