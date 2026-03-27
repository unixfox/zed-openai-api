FROM denoland/deno:latest AS builder
WORKDIR /app
COPY deno.json .
COPY main.ts .
COPY src/ src/
RUN deno compile --allow-net --allow-run --allow-env --allow-read --output zed-openai-api main.ts

FROM gcr.io/distroless/cc-debian12
COPY --from=builder /app/zed-openai-api /zed-openai-api
EXPOSE 8080
ENTRYPOINT ["/zed-openai-api"]
