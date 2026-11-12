// The wire's public side (spec/README.md):
//
//   GET /headlines?since=<ISO time>   headlines at or after that time, oldest first
//   GET /health                       {"ok": true, "clients": n}
//   WS  /headlines                    each new headline as one JSON text message
//
// Clients send nothing on the WebSocket. A client too slow to keep up (its unsent messages
// pass MAX_BUFFERED_BYTES) is disconnected; it reconnects and catches up over HTTP, rather
// than the wire holding messages for it forever.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

import { WebSocketServer } from "ws";

import type { Headline, Wire } from "./wire.ts";

const MAX_BUFFERED_BYTES = 1_000_000;

export function createWireServer(wire: Wire): { http: Server; clients: () => number; close: () => Promise<void> } {
  const http = createServer((request, response) => handle(wire, request, response, sockets.clients.size));
  const sockets = new WebSocketServer({ server: http, path: "/headlines" });

  const stopListening = wire.listen((headline: Headline) => {
    const message = JSON.stringify(headline);
    for (const socket of sockets.clients) {
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) socket.terminate();
      else socket.send(message);
    }
  });

  return {
    http,
    clients: () => sockets.clients.size,
    close: () =>
      new Promise((resolve) => {
        stopListening();
        for (const socket of sockets.clients) socket.terminate();
        sockets.close(() => http.close(() => resolve()));
      }),
  };
}

function handle(wire: Wire, request: IncomingMessage, response: ServerResponse, clients: number): void {
  const url = new URL(request.url ?? "/", "http://wire");
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  if (request.method !== "GET") return send(405, { error: "only GET" });
  if (url.pathname === "/health") return send(200, { ok: true, clients });
  if (url.pathname === "/headlines") {
    const since = url.searchParams.get("since");
    if (since === null) return send(400, { error: "since is required, an ISO 8601 time" });
    const time = new Date(since);
    if (Number.isNaN(time.getTime())) return send(400, { error: `since is not a time: ${since}` });
    return send(200, { headlines: wire.since(time) });
  }
  send(404, { error: "not found" });
}
