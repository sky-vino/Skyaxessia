"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wsManager = void 0;
const ws_1 = require("ws");
const logger_1 = require("./logger");
class WsManager {
    constructor() {
        this.wss = null;
        this.clients = new Map();
    }
    init(wss) {
        this.wss = wss;
        wss.on("connection", (ws, req) => {
            const clientId = Math.random().toString(36).slice(2);
            this.clients.set(clientId, { ws });
            ws.on("message", (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === "subscribe" && msg.scanId) {
                        const client = this.clients.get(clientId);
                        if (client)
                            client.scanId = msg.scanId;
                    }
                }
                catch { }
            });
            ws.on("close", () => {
                this.clients.delete(clientId);
            });
            ws.on("error", (err) => {
                logger_1.logger.error("WS client error:", err);
                this.clients.delete(clientId);
            });
        });
    }
    broadcast(scanId, payload) {
        const msg = JSON.stringify(payload);
        this.clients.forEach(({ ws, scanId: sid }) => {
            if (sid === scanId && ws.readyState === ws_1.WebSocket.OPEN) {
                ws.send(msg);
            }
        });
    }
    broadcastAll(payload) {
        const msg = JSON.stringify(payload);
        this.clients.forEach(({ ws }) => {
            if (ws.readyState === ws_1.WebSocket.OPEN)
                ws.send(msg);
        });
    }
}
exports.wsManager = new WsManager();
