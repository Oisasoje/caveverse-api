import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { signAccessToken, verifyRefreshToken } from "../../lib/jwt";
import { validate } from "../../middleware/validate";

const router = Router();

const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

router.post("/", validate(refreshSchema), async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as z.infer<typeof refreshSchema>;

  // Verify the JWT signature first
  let payload: { userId: string };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  // Check it exists in DB and hasn't expired
  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: true },
  });

  if (!stored || stored.expiresAt < new Date()) {
    // Clean up if found but expired
    if (stored) {
      await prisma.refreshToken.delete({ where: { id: stored.id } });
    }
    res.status(401).json({ error: "Refresh token expired or revoked" });
    return;
  }

  if (stored.userId !== payload.userId) {
    res.status(401).json({ error: "Token mismatch" });
    return;
  }

  const newAccessToken = signAccessToken({
    userId: stored.user.id,
    email: stored.user.email,
  });

  res.json({ accessToken: newAccessToken });
});

export default router;
