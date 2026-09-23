import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthRequest } from "../../middleware/auth";
import { validate } from "../../middleware/validate";

const router = Router();

const createBuildSchema = z.object({
  name: z.string().min(1, "Project name is required").max(100, "Project name is too long"),
  industry: z.string().min(1, "Industry is required"),
  icon: z.string().optional().default("laptop"),
  color: z.string().optional().default("paper"),
  stage: z.number().int().min(1).max(10).optional().default(1),
  description: z.string().max(1000).optional(),
});

const updateBuildSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  industry: z.string().min(1).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  stage: z.number().int().min(1).max(10).optional(),
  description: z.string().max(1000).nullable().optional(),
});

/**
 * GET /builds
 * Fetch all builds for the authenticated user.
 */
router.get("/", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.userId;

  const builds = await prisma.build.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });

  res.json({ builds });
});

/**
 * POST /builds
 * Create a new build project.
 */
router.post(
  "/",
  requireAuth,
  validate(createBuildSchema),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const { name, industry, icon, color, stage, description } = req.body as z.infer<
      typeof createBuildSchema
    >;

    const build = await prisma.build.create({
      data: {
        userId,
        name,
        industry,
        icon: icon ?? "laptop",
        color: color ?? "paper",
        stage: stage ?? 1,
        description: description ?? null,
      },
    });

    res.status(201).json({ build });
  }
);

/**
 * GET /builds/:id
 * Fetch a specific build by ID.
 */
router.get("/:id", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.userId;
  const id = req.params.id as string;

  const build = await prisma.build.findFirst({
    where: { id, userId },
  });

  if (!build) {
    res.status(404).json({ error: "Build not found" });
    return;
  }

  res.json({ build });
});

/**
 * PATCH /builds/:id
 * Update an existing build.
 */
router.patch(
  "/:id",
  requireAuth,
  validate(updateBuildSchema),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const data = req.body as z.infer<typeof updateBuildSchema>;

    const existing = await prisma.build.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      res.status(404).json({ error: "Build not found" });
      return;
    }

    const updated = await prisma.build.update({
      where: { id },
      data,
    });

    res.json({ build: updated });
  }
);

/**
 * DELETE /builds/:id
 * Delete a build.
 */
router.delete("/:id", requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.userId;
  const id = req.params.id as string;

  const existing = await prisma.build.findFirst({
    where: { id, userId },
  });

  if (!existing) {
    res.status(404).json({ error: "Build not found" });
    return;
  }

  await prisma.build.delete({
    where: { id },
  });

  res.json({ message: "Build deleted successfully" });
});

export default router;
