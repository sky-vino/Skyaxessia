import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./logger";

interface Client {
  ws: WebSocket;
  userId?: string;
  scanId?: string;
}

class WsManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, Client> = new Map();

  init(wss: WebSocketServer) {
    this.wss = wss;
    wss.on("connection", (ws, req) => {
      const clientId = Math.random().toString(36).slice(2);
      this.clients.set(clientId, { ws });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "subscribe" && msg.scanId) {
            const client = this.clients.get(clientId);
            if (client) client.scanId = msg.scanId;
          }
        } catch {}
      });

      ws.on("close", () => {
        this.clients.delete(clientId);
      });

      ws.on("error", (err) => {
        logger.error("WS client error:", err);
        this.clients.delete(clientId);
      });
    });
  }

  broadcast(scanId: string, payload: object) {
    const msg = JSON.stringify(payload);
    this.clients.forEach(({ ws, scanId: sid }) => {
      if (sid === scanId && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    });
  }

  broadcastAll(payload: object) {
    const msg = JSON.stringify(payload);
    this.clients.forEach(({ ws }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
  }
}

export const wsManager = new WsManager();
