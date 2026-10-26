import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { requireAuth, AuthRequest } from "../../middleware/auth";
import { prisma } from "../../lib/prisma";

const router = Router();

const JoinRequestSchema = z.object({
  initials: z.string().trim().max(4).optional(),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Must be a valid hex color code").optional(),
});

function getInitials(name?: string | null, email?: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (email?.slice(0, 2) ?? "ME").toUpperCase();
}

/**
 * POST /refuel/members/request
 * Authenticated user requests membership in the Refuel programme.
 */
router.post(
  "/request",
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const user = req.user!;
    const parseResult = JoinRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request payload",
        details: parseResult.error.format(),
      });
      return;
    }

    try {
      const existingMember = await prisma.refuelMember.findUnique({
        where: { userId: user.userId },
      });

      if (existingMember) {
        if (existingMember.status === "ACTIVE") {
          res.status(400).json({
            error: "You are already an active Refuel member.",
            member: existingMember,
          });
          return;
        }
        if (existingMember.status === "REQUESTED") {
          res.status(200).json({
            message: "Your membership request is currently awaiting admin approval.",
            member: existingMember,
          });
          return;
        }
        if (existingMember.status === "REMOVED") {
          res.status(403).json({
            error: "Your membership was removed. Please contact a Refuel administrator.",
          });
          return;
        }
      }

      // Fetch user profile for default initials
      const dbUser = await prisma.user.findUnique({
        where: { id: user.userId },
        select: { name: true, email: true },
      });

      const initials = parseResult.data.initials || getInitials(dbUser?.name, dbUser?.email || user.email);
      const color = parseResult.data.color || "#8a7d9a";

      const created = await prisma.$transaction(async (tx) => {
        const member = await tx.refuelMember.create({
          data: {
            userId: user.userId,
            status: "REQUESTED",
            role: "MEMBER",
            initials,
            color,
          },
        });

        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: "MEMBER",
            action: "MEMBERSHIP_REQUESTED",
            entityType: "MEMBER",
            entityId: member.id,
            targetMemberId: member.id,
            afterState: {
              userId: user.userId,
              initials,
              color,
              status: "REQUESTED",
            },
          },
        });

        return member;
      });

      res.status(201).json({
        success: true,
        message: "Membership request submitted successfully.",
        member: created,
      });
    } catch (err: any) {
      console.error("[RefuelMembershipRequestError]", err);
      res.status(500).json({ error: "Failed to submit membership request." });
    }
  }
);

/**
 * GET /refuel/members/me
 * Returns authenticated user's Refuel membership status.
 */
router.get(
  "/me",
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const user = req.user!;

    try {
      const member = await prisma.refuelMember.findUnique({
        where: { userId: user.userId },
        include: {
          assignedTo: {
            select: { id: true, initials: true, color: true },
          },
        },
      });

      if (!member) {
        res.status(404).json({
          error: "Not a Refuel member.",
          status: "NOT_MEMBER",
        });
        return;
      }

      res.json({ member });
    } catch (err: any) {
      console.error("[GetMyMemberStatusError]", err);
      res.status(500).json({ error: "Failed to fetch member status." });
    }
  }
);

/**
 * GET /refuel/members
 * Directory of active Refuel members.
 */
router.get(
  "/",
  requireAuth,
  async (_req: AuthRequest, res: Response): Promise<void> => {
    try {
      const members = await prisma.refuelMember.findMany({
        where: { status: "ACTIVE" },
        orderBy: { joinedAt: "asc" },
        select: {
          id: true,
          role: true,
          initials: true,
          color: true,
          joinedAt: true,
          user: {
            select: { name: true },
          },
        },
      });

      res.json({ members });
    } catch (err: any) {
      console.error("[GetMembersDirectoryError]", err);
      res.status(500).json({ error: "Failed to fetch members directory." });
    }
  }
);

export default router;
