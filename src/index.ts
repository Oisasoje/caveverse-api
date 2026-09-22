import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

import registerRoute from "./routes/auth/register";
import loginRoute from "./routes/auth/login";
import refreshRoute from "./routes/auth/refresh";
import logoutRoute from "./routes/auth/logout";
import meRoute from "./routes/auth/me";
import onboardingRoute from "./routes/onboarding/index";

const app = express();
const PORT = process.env.PORT ?? 4000;

// ── Security & parsing ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_ORIGIN ?? "http://localhost:3000",
  credentials: true,
}));
app.use(express.json());

// ── Rate limiting on auth routes (100 req / 15 min per IP) ──────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/auth/register", authLimiter, registerRoute);
app.use("/auth/login", authLimiter, loginRoute);
app.use("/auth/refresh", authLimiter, refreshRoute);
app.use("/auth/logout", logoutRoute);
app.use("/auth/me", meRoute);
app.use("/onboarding", onboardingRoute);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[Error]", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`caveverse-api running on http://localhost:${PORT}`);
});

export default app;
