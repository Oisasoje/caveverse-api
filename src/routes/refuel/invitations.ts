import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth, AuthRequest } from "../../middleware/auth";
import { prisma } from "../../lib/prisma";
import { RefuelInvitationStatus, RefuelRole, RefuelMembershipStatus } from "@prisma/client";
import { getInitials, getDeterministicAvatarColor } from "../../lib/refuelAvatar";

const router = Router();

/**
 * GET /refuel/invitations/:token
 * Public endpoint to check and preview an invitation before redemption.
 * Idempotent: opening or refreshing this endpoint NEVER consumes the invitation.
 */
router.get("/:token", async (req: Request, res: Response): Promise<void> => {
  const token = String(req.params.token).trim();

  try {
    const invitation = await prisma.refuelAdminInvitation.findUnique({
      where: { token },
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

    if (!invitation) {
      res.status(404).json({
        valid: false,
        reason: "NOT_FOUND",
        error: "Invitation link is invalid or does not exist.",
      });
      return;
    }

    if (invitation.status === RefuelInvitationStatus.REVOKED) {
      res.status(410).json({
        valid: false,
        reason: "REVOKED",
        error: "This invitation link has been revoked by a Super Admin.",
      });
      return;
    }

    if (invitation.status === RefuelInvitationStatus.REDEEMED) {
      res.status(410).json({
        valid: false,
        reason: "ALREADY_REDEEMED",
        error: "This single-use invitation link has already been redeemed.",
      });
      return;
    }

    const now = new Date();
    if (invitation.expiresAt < now) {
      res.status(410).json({
        valid: false,
        reason: "EXPIRED",
        error: "This invitation link has expired.",
      });
      return;
    }

    res.json({
      valid: true,
      invitation: {
        email: invitation.email,
        role: invitation.role,
        isEmailRestricted: !!invitation.email,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        inviterName: invitation.createdBy.user.name,
        inviterInitials: invitation.createdBy.initials,
        inviterColor: invitation.createdBy.color,
      },
    });
  } catch (err: any) {
    console.error("[GetInvitationError]", err);
    res.status(500).json({ error: "Failed to verify invitation link." });
  }
});

/**
 * POST /refuel/invitations/:token/redeem
 * Authenticated endpoint to redeem an invitation.
 * Atomically consumes the invitation and elevates or creates the user's RefuelMember record as ADMIN.
 */
router.post(
  "/:token/redeem",
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const token = String(req.params.token).trim();
    const userAuth = req.user!;

    try {
      // 1. Fetch live user details
      const user = await prisma.user.findUnique({
        where: { id: userAuth.userId },
        include: { refuelMember: true },
      });

      if (!user) {
        res.status(401).json({ error: "User account not found." });
        return;
      }

      // 2. Fetch invitation
      const invitation = await prisma.refuelAdminInvitation.findUnique({
        where: { token },
      });

      if (!invitation) {
        res.status(404).json({ error: "Invitation not found." });
        return;
      }

      if (invitation.status === RefuelInvitationStatus.REVOKED) {
        res.status(410).json({
          error: "This invitation link has been revoked by an administrator.",
          code: "INVITATION_REVOKED",
        });
        return;
      }

      if (invitation.status === RefuelInvitationStatus.REDEEMED) {
        res.status(410).json({
          error: "This invitation link has already been redeemed.",
          code: "INVITATION_ALREADY_REDEEMED",
        });
        return;
      }

      const now = new Date();
      if (invitation.expiresAt < now) {
        res.status(410).json({
          error: "This invitation link has expired.",
          code: "INVITATION_EXPIRED",
        });
        return;
      }

      // 3. Enforce email restriction if configured
      if (invitation.email) {
        const normalizedTarget = invitation.email.trim().toLowerCase();
        const normalizedUserEmail = user.email.trim().toLowerCase();

        if (normalizedTarget !== normalizedUserEmail) {
          res.status(403).json({
            error: `This invitation was issued specifically to ${invitation.email}. You are currently logged in as ${user.email}. Please switch to the invited account to accept.`,
            code: "EMAIL_MISMATCH",
            expectedEmail: invitation.email,
            actualEmail: user.email,
          });
          return;
        }
      }

      // 4. Validate existing Refuel status
      const targetRole = invitation.role;
      if (user.refuelMember) {
        if (
          user.refuelMember.role === RefuelRole.SUPER_ADMIN ||
          user.refuelMember.role === targetRole
        ) {
          res.status(400).json({
            error:
              user.refuelMember.role === RefuelRole.SUPER_ADMIN
                ? "You are already a Refuel Super Administrator."
                : "You are already a Refuel Administrator.",
            code: "ALREADY_ADMIN",
            member: user.refuelMember,
          });
          return;
        }
      }

      // 5. Atomic redemption in transaction
      const result = await prisma.$transaction(
        async (tx) => {
        // Concurrency check: Ensure invitation is still PENDING and unexpired
        const updatedCount = await tx.refuelAdminInvitation.updateMany({
          where: {
            id: invitation.id,
            status: RefuelInvitationStatus.PENDING,
            expiresAt: { gt: now },
          },
          data: {
            status: RefuelInvitationStatus.REDEEMED,
            redeemedAt: now,
          },
        });

        if (updatedCount.count === 0) {
          throw new Error("CONCURRENT_REDEMPTION: This invitation has already been redeemed or expired.");
        }

        let member;
        if (user.refuelMember) {
          // Elevate existing member to target role (ADMIN or SUPER_ADMIN) and ACTIVE, removing assigned supervisor
          member = await tx.refuelMember.update({
            where: { id: user.refuelMember.id },
            data: {
              role: targetRole,
              status: RefuelMembershipStatus.ACTIVE,
              assignedToId: null, // Admins / Super Admins manage members, they are not assigned to an admin
            },
          });
        } else {
          // Create new RefuelMember with targetRole
          const initials = getInitials(user.name, user.email);
          const color = getDeterministicAvatarColor(user.email || user.name || user.id);

          member = await tx.refuelMember.create({
            data: {
              userId: user.id,
              role: targetRole,
              status: RefuelMembershipStatus.ACTIVE,
              initials,
              color,
              assignedToId: null,
            },
          });
        }

        // Link redeemed member to invitation
        await tx.refuelAdminInvitation.update({
          where: { id: invitation.id },
          data: { redeemedById: member.id },
        });

        // Audit Event
        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorUserId: user.id,
            actorEmail: user.email,
            actorMemberId: member.id,
            actorRole: targetRole,
            action: "ADMIN_INVITATION_REDEEMED",
            entityType: "ADMIN_INVITATION",
            entityId: invitation.id,
            targetMemberId: member.id,
            metadata: {
              invitationId: invitation.id,
              role: targetRole,
              tokenPrefix: token.slice(0, 8),
              previousRole: user.refuelMember?.role || null,
              previousStatus: user.refuelMember?.status || null,
            },
            afterState: {
              memberId: member.id,
              role: targetRole,
              status: RefuelMembershipStatus.ACTIVE,
            },
          },
        });

        return member;
      }, { timeout: 15000, maxWait: 10000 });

      res.json({
        success: true,
        message:
          targetRole === RefuelRole.SUPER_ADMIN
            ? "Invitation redeemed successfully. You are now a Refuel Super Administrator!"
            : "Invitation redeemed successfully. You are now a Refuel Administrator!",
        member: result,
      });
    } catch (err: any) {
      if (err.message && err.message.includes("CONCURRENT_REDEMPTION")) {
        res.status(409).json({
          error: "This invitation was already claimed by another session.",
          code: "CONCURRENT_CLAIM",
        });
        return;
      }
      console.error("[RedeemAdminInvitationError]", err);
      res.status(500).json({ error: "Failed to redeem invitation." });
    }
  }
);

export default router;
