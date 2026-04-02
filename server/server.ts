import { createServer } from "node:http";
import WebSocket from "ws";
const WebSocketServer = WebSocket.Server;
// @ts-ignore — y-websocket/bin/utils has no types
import { setupWSConnection } from "y-websocket/bin/utils";

const PORT = parseInt(process.env.PORT || "1234", 10);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.COLLAB_TOKEN || "";

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.headers.upgrade === "websocket") return;
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  if (TOKEN) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.searchParams.get("token") !== TOKEN) {
      ws.close(4001, "Unauthorized");
      return;
    }
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const roomName = url.pathname.slice(1) || "default";
  console.log(`[ws] connected: ${roomName}`);
  setupWSConnection(ws, req, { docName: roomName, gc: true });
  ws.on("close", () => console.log(`[ws] disconnected: ${roomName}`));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Collab server on ws://${HOST}:${PORT}${TOKEN ? " (token required)" : ""}`);
});
