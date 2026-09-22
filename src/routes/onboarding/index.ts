import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthRequest } from "../../middleware/auth";
import { validate } from "../../middleware/validate";

const router = Router();

const onboardingSchema = z.object({
  role: z.string().min(1, "Role is required"),
  interests: z.array(z.string()).min(1, "Select at least one interest").max(3),
  purpose: z.string().min(1, "Purpose is required"),
  projectNote: z.string().max(280).optional(),
});

/**
 * PATCH /onboarding
 * Saves onboarding data for the authenticated user.
 * Can be called once at the end of the onboarding flow.
 */
router.patch("/", requireAuth, validate(onboardingSchema), async (req: AuthRequest, res: Response): Promise<void> => {
  const { role, interests, purpose, projectNote } = req.body as z.infer<typeof onboardingSchema>;

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: {
      role,
      interests,
      purpose,
      projectNote: projectNote ?? null,
      onboarded: true,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      interests: true,
      purpose: true,
      projectNote: true,
      onboarded: true,
    },
  });

  res.json({ user });
});

export default router;
