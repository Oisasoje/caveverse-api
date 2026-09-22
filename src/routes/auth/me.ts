import { Router, Response } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthRequest } from "../../middleware/auth";

const router = Router();

router.get(
  "/",
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        interests: true,
        purpose: true,
        projectNote: true,
        onboarded: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ user });
  },
);

export default router;
