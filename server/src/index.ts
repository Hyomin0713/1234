import path from "path";
import express from "express";
import cors from "cors";
import session from "express-session";
import { Server } from "socket.io";
import http from "http";

const PORT = Number(process.env.PORT || 8000);
const ORIGIN = process.env.ORIGIN || process.env.WEB_ORIGIN || `http://localhost:${PORT}`;

const app = express();
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json());

app.set("trust proxy", 1);

app.use(
  session({
    name: "ml_session",
    secret: process.env.SESSION_SECRET || "dev_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: true, // Railway는 https
    },
  })
);

// --- OAuth 라우트(실서비스에서는 passport-discord로 구현) ---
app.get("/auth/discord", (req, res) => {
  res.status(501).send("OAuth not wired in this minimal bundle. Use your full server implementation.");
});

app.get("/auth/discord/callback", (req, res) => {
  res.status(501).send("OAuth callback not wired in this minimal bundle.");
});

app.get("/api/me", (req, res) => {
  res.status(401).json({ ok: false, error: "not_authenticated" });
});

// --- 정적 서빙: Next export 결과물(web/out) ---
const webOut = path.join(__dirname, "../../web/out");
app.use(express.static(webOut));
app.get("*", (req, res) => {
  res.sendFile(path.join(webOut, "index.html"));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGIN, credentials: true },
});

io.on("connection", (socket) => {
  socket.emit("hello", { ok: true });
});

server.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
