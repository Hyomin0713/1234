/**
 * Example integration:
 * - Attach this to your existing Express server where socket.io is initialized.
 *
 * In your server bootstrap:
 *   import http from "http";
 *   import express from "express";
 *   import { Server } from "socket.io";
 *   import { createRealtime } from "./realtime";
 *
 *   const app = express();
 *   const server = http.createServer(app);
 *   const io = new Server(server, { cors: { origin: process.env.WEB_ORIGIN, credentials: true }});
 *   createRealtime(io);
 *   server.listen(process.env.PORT ?? 3000);
 */

import { Server } from "socket.io";
import { PartyStore } from "./realtime/partyStore";
import { registerQueueSocketHandlers } from "./realtime/socketHandlers";

export function createRealtime(io: Server) {
  const store = new PartyStore();

  // background cleanup
  const intervalMs = Number(process.env.CLEANUP_INTERVAL_MS ?? 30_000);
  setInterval(() => store.cleanupExpired(), intervalMs);

  io.on("connection", (socket) => {
    registerQueueSocketHandlers(io, socket, store);
  });

  return store;
}
