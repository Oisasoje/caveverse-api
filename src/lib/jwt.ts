import jwt from "jsonwebtoken";

function getAccessSecret(): string {
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: ACCESS_TOKEN_SECRET");
  }
  return secret;
}

function getRefreshSecret(): string {
  const secret = process.env.REFRESH_TOKEN_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: REFRESH_TOKEN_SECRET");
  }
  return secret;
}

export interface AccessTokenPayload {
  userId: string;
  email: string;
}

/** Signs a short-lived access token (15 minutes) */
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, getAccessSecret(), { expiresIn: "15m" });
}

/** Signs a long-lived refresh token (7 days) */
export function signRefreshToken(payload: { userId: string }): string {
  return jwt.sign(payload, getRefreshSecret(), { expiresIn: "7d" });
}

/** Verifies an access token. Throws if invalid/expired. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, getAccessSecret()) as AccessTokenPayload;
}

/** Verifies a refresh token. Throws if invalid/expired. */
export function verifyRefreshToken(token: string): { userId: string } {
  return jwt.verify(token, getRefreshSecret()) as { userId: string };
}
