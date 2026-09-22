import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { signAccessToken, signRefreshToken } from "../../lib/jwt";
import { validate } from "../../middleware/validate";

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

router.post("/", validate(registerSchema), async (req: Request, res: Response): Promise<void> => {
  const { name, email, password } = req.body as z.infer<typeof registerSchema>;

  // Check for existing user
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 12);

  // Create user
  const user = await prisma.user.create({
    data: { name, email, passwordHash },
  });

  // Issue tokens
  const accessToken = signAccessToken({ userId: user.id, email: user.email });
  const refreshTokenValue = signRefreshToken({ userId: user.id });

  await prisma.refreshToken.create({
    data: {
      token: refreshTokenValue,
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  res.status(201).json({
    accessToken,
    refreshToken: refreshTokenValue,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      onboarded: user.onboarded,
    },
  });
});

export default router;
