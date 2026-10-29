import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { requireAuth } from "../../../middleware/auth";
import {
  requireRefuelSuperAdmin,
  RefuelAuthRequest,
} from "../../../middleware/refuelAuth";
import { prisma } from "../../../lib/prisma";
import { RefuelInvitationStatus } from "@prisma/client";

const router = Router();

const CreateInvitationSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Invalid email format")
      .optional()
      .or(z.literal("")),
    role: z.enum(["ADMIN", "SUPER_ADMIN"]).default("ADMIN"),
    expiresInDays: z.number().int().min(1).max(30).default(7),
  })
  .refine(
    (data) => {
      if (data.role === "SUPER_ADMIN") {
        return Boolean(data.email && data.email.trim().length > 0);
      }
      return true;
    },
    {
      message:
        "An email address is required when generating a Super Admin invitation.",
      path: ["email"],
    }
  );

/**
 * POST /refuel/admin/invitations
 * Super Admin generates a single-use invitation link for a new Refuel Admin or Super Admin.
 * Can be email-restricted or general (email mandatory for Super Admin).
 */
router.post(
  "/",
  requireAuth,
  requireRefuelSuperAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const superAdmin = req.refuelMember!;
    const user = req.user!;

    const parseResult = CreateInvitationSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request payload",
        details: parseResult.error.format(),
      });
      return;
    }

    const { email, role, expiresInDays } = parseResult.data;
    const normalizedEmail = email && email.trim() ? email.trim().toLowerCase() : null;

    // Generate 32-byte cryptographically secure token
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    try {
      const created = await prisma.refuelAdminInvitation.create({
        data: {
          token,
          email: normalizedEmail,
          role,
          createdById: superAdmin.id,
          expiresAt,
          status: RefuelInvitationStatus.PENDING,
        },
        include: {
          createdBy: {
            select: {
              id: true,
              initials: true,
              color: true,
              user: { select: { name: true, email: true } },
            },
          },
        },
      });

      await prisma.refuelAuditEvent.create({
        data: {
          correlationId: crypto.randomUUID(),
          actorMemberId: superAdmin.id,
          actorUserId: user.userId,
          actorEmail: user.email,
          actorRole: superAdmin.role,
          action: "ADMIN_INVITATION_CREATED",
          entityType: "ADMIN_INVITATION",
          entityId: created.id,
          afterState: {
            invitationId: created.id,
            email: normalizedEmail,
            role: created.role,
            expiresAt: expiresAt.toISOString(),
            tokenPrefix: token.slice(0, 8),
          },
        },
      }).catch((auditErr) => {
        console.error("[AuditLogError] Non-blocking audit log error:", auditErr);
      });

      res.status(201).json({
        success: true,
        invitation: {
          id: created.id,
          token: created.token,
          email: created.email,
          role: created.role,
          status: created.status,
          expiresAt: created.expiresAt,
          createdAt: created.createdAt,
          createdBy: created.createdBy,
        },
      });
    } catch (err: any) {
      console.error("[CreateAdminInvitationError]", err);
      res.status(500).json({
        error: err?.message || "Failed to generate admin invitation.",
      });
    }
  }
);

/**
 * GET /refuel/admin/invitations
 * Super Admin lists all generated invitations with their status and usage.
 */
router.get(
  "/",
  requireAuth,
  requireRefuelSuperAdmin,
  async (_req: RefuelAuthRequest, res: Response): Promise<void> => {
    try {
      const invitations = await prisma.refuelAdminInvitation.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          createdBy: {
            select: {
              id: true,
              initials: true,
              color: true,
              user: { select: { name: true, email: true } },
            },
          },
          redeemedBy: {
            select: {
              id: true,
              initials: true,
              color: true,
              user: { select: { name: true, email: true } },
            },
          },
        },
      });

      const now = new Date();
      const enriched = invitations.map((inv) => {
        let displayStatus: "PENDING" | "REDEEMED" | "REVOKED" | "EXPIRED" = inv.status;
        if (inv.status === "PENDING" && inv.expiresAt < now) {
          displayStatus = "EXPIRED";
        }
        return {
          id: inv.id,
          token: inv.token,
          email: inv.email,
          role: inv.role,
          status: displayStatus,
          rawStatus: inv.status,
          expiresAt: inv.expiresAt,
          createdAt: inv.createdAt,
          redeemedAt: inv.redeemedAt,
          createdBy: inv.createdBy,
          redeemedBy: inv.redeemedBy,
        };
      });

      res.json({ invitations: enriched });
    } catch (err: any) {
      console.error("[ListAdminInvitationsError]", err);
      res.status(500).json({ error: "Failed to list admin invitations." });
    }
  }
);

/**
 * POST /refuel/admin/invitations/:id/revoke
 * Super Admin revokes an unredeemed invitation.
 */
router.post(
  "/:id/revoke",
  requireAuth,
  requireRefuelSuperAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const invitationId = String(req.params.id);
    const superAdmin = req.refuelMember!;
    const user = req.user!;

    try {
      const target = await prisma.refuelAdminInvitation.findUnique({
        where: { id: invitationId },
      });

      if (!target) {
        res.status(404).json({ error: "Invitation not found." });
        return;
      }

      if (target.status === RefuelInvitationStatus.REDEEMED) {
        res.status(400).json({
          error: "Cannot revoke an invitation that has already been redeemed.",
        });
        return;
      }

      if (target.status === RefuelInvitationStatus.REVOKED) {
        res.status(400).json({ error: "Invitation is already revoked." });
        return;
      }

      const revoked = await prisma.refuelAdminInvitation.update({
        where: { id: target.id },
        data: { status: RefuelInvitationStatus.REVOKED },
      });

      await prisma.refuelAuditEvent.create({
        data: {
          correlationId: crypto.randomUUID(),
          actorMemberId: superAdmin.id,
          actorUserId: user.userId,
          actorEmail: user.email,
          actorRole: superAdmin.role,
          action: "ADMIN_INVITATION_REVOKED",
          entityType: "ADMIN_INVITATION",
          entityId: revoked.id,
          beforeState: { status: target.status },
          afterState: { status: RefuelInvitationStatus.REVOKED },
        },
      }).catch((auditErr) => {
        console.error("[AuditLogError] Non-blocking audit error:", auditErr);
      });

      res.json({
        success: true,
        message: "Invitation revoked successfully.",
        invitation: revoked,
      });
    } catch (err: any) {
      console.error("[RevokeAdminInvitationError]", err);
      res.status(500).json({ error: err?.message || "Failed to revoke invitation." });
    }
  }
);

export default router;
