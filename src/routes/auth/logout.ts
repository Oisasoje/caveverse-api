import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { validate } from "../../middleware/validate";

const router = Router();

const logoutSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

router.post("/", validate(logoutSchema), async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as z.infer<typeof logoutSchema>;

  // Delete the token from DB — silently succeed even if not found
  await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });

  res.json({ message: "Logged out successfully" });
});

export default router;
