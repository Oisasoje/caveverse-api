import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { requireAuth } from "../../../middleware/auth";
import {
  requireRefuelAdmin,
  requireRefuelSuperAdmin,
  RefuelAuthRequest,
} from "../../../middleware/refuelAuth";
import { prisma } from "../../../lib/prisma";
import { RefuelMembershipStatus, RefuelRole, RefuelMember } from "@prisma/client";

const router = Router();

/**
 * GET /refuel/admin/members
 * Admin member triage and roster listing.
 */
router.get(
  "/",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const { status, assignedToId } = req.query;

    const whereClause: any = {};
    if (status && Object.values(RefuelMembershipStatus).includes(status as any)) {
      whereClause.status = status;
    }
    if (assignedToId && typeof assignedToId === "string") {
      whereClause.assignedToId = assignedToId === "unassigned" ? null : assignedToId;
    }

    try {
      const members = await prisma.refuelMember.findMany({
        where: whereClause,
        orderBy: [{ status: "asc" }, { joinedAt: "asc" }],
        include: {
          user: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, initials: true, color: true } },
          _count: {
            select: {
              submissions: true,
              graceReceived: true,
            },
          },
        },
      });

      res.json({ members });
    } catch (err: any) {
      console.error("[GetAdminMembersError]", err);
      res.status(500).json({ error: "Failed to list members." });
    }
  }
);

/**
 * Resolves the supervising admin for a newly approved member using round-robin
 * (least-loaded active regular ADMIN).
 * Returns null if no active regular ADMIN exists yet, allowing members to exist without an admin.
 */
async function resolveApprovalAdminId(): Promise<string | null> {
  const leastLoaded = await prisma.refuelMember.findFirst({
    where: {
      role: RefuelRole.ADMIN,
      status: RefuelMembershipStatus.ACTIVE,
    },
    select: { id: true },
    orderBy: [
      { assignedMembers: { _count: "asc" } },
      { joinedAt: "asc" },
      { id: "asc" },
    ],
  });

  return leastLoaded?.id ?? null;
}

/**
 * POST /refuel/admin/members/:id/approve
 * Approve a requested membership and auto-assign via round-robin to the least-loaded regular ADMIN
 * (or leave unassigned with assignedToId = null if no regular ADMIN exists yet).
 */
router.post(
  "/:id/approve",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const memberId = String(req.params.id);
    const admin = req.refuelMember!;
    const user = req.user!;

    try {
      const target = await prisma.refuelMember.findUnique({
        where: { id: memberId },
      });

      if (!target) {
        res.status(404).json({ error: "Member not found." });
        return;
      }

      if (target.status !== "REQUESTED") {
        res.status(400).json({
          error: `Cannot approve member with status '${target.status}'. Only 'REQUESTED' members can be approved.`,
        });
        return;
      }

      const assignedAdminId = await resolveApprovalAdminId();

      const updated = await prisma.$transaction(async (tx) => {
        const approved = await tx.refuelMember.update({
          where: { id: target.id },
          data: {
            status: "ACTIVE",
            assignedToId: assignedAdminId,
          },
        });

        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: admin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: admin.role,
            action: "MEMBERSHIP_APPROVED",
            entityType: "MEMBER",
            entityId: target.id,
            targetMemberId: target.id,
            beforeState: { status: "REQUESTED" },
            afterState: {
              status: "ACTIVE",
              assignedToId: assignedAdminId,
              role: approved.role,
            },
          },
        });

        return approved;
      });

      res.json({ success: true, member: updated });
    } catch (err: any) {
      console.error("[ApproveMemberError]", err);
      res.status(500).json({ error: "Failed to approve member." });
    }
  }
);

/**
 * POST /refuel/admin/members/:id/reject
 * Reject a requested membership and transition to REMOVED.
 */
router.post(
  "/:id/reject",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const memberId = String(req.params.id);
    const admin = req.refuelMember!;
    const user = req.user!;
    const { reason } = req.body || {};

    try {
      const target = await prisma.refuelMember.findUnique({
        where: { id: memberId },
      });

      if (!target) {
        res.status(404).json({ error: "Member not found." });
        return;
      }

      if (target.status !== "REQUESTED") {
        res.status(400).json({
          error: `Cannot reject member with status '${target.status}'. Only 'REQUESTED' members can be rejected.`,
        });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const rejected = await tx.refuelMember.update({
          where: { id: target.id },
          data: {
            status: "REMOVED",
            assignedToId: null,
          },
        });

        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: admin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: admin.role,
            action: "MEMBERSHIP_REJECTED",
            entityType: "MEMBER",
            entityId: target.id,
            targetMemberId: target.id,
            reason: reason ? String(reason).trim() : null,
            beforeState: { status: "REQUESTED" },
            afterState: {
              status: "REMOVED",
            },
          },
        });

        return rejected;
      });

      res.json({ success: true, message: "Membership request rejected.", member: updated });
    } catch (err: any) {
      console.error("[RejectMemberError]", err);
      res.status(500).json({ error: "Failed to reject member request." });
    }
  }
);

const AssignSchema = z.object({
  assignedToId: z.string().trim().nullable(),
});

/**
 * POST /refuel/admin/members/:id/assign
 * Reassign a member to an admin.
 */
router.post(
  "/:id/assign",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const memberId = String(req.params.id);
    const admin = req.refuelMember!;
    const user = req.user!;

    const parseResult = AssignSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid payload", details: parseResult.error.format() });
      return;
    }

    const { assignedToId } = parseResult.data;

    try {
      const target = await prisma.refuelMember.findUnique({
        where: { id: memberId },
      });

      if (!target) {
        res.status(404).json({ error: "Member not found." });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const member = await tx.refuelMember.update({
          where: { id: target.id },
          data: { assignedToId },
        });

        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: admin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: admin.role,
            action: "MEMBER_REASSIGNED",
            entityType: "MEMBER",
            entityId: target.id,
            targetMemberId: target.id,
            beforeState: { assignedToId: target.assignedToId },
            afterState: { assignedToId },
          },
        });

        return member;
      });

      res.json({ success: true, member: updated });
    } catch (err: any) {
      console.error("[AssignMemberError]", err);
      res.status(500).json({ error: "Failed to reassign member." });
    }
  }
);

/**
 * POST /refuel/admin/members/:id/promote
 * Deprecated and disabled. The only way to create a new Refuel Admin is via an invitation link.
 */
router.post(
  "/:id/promote",
  requireAuth,
  requireRefuelSuperAdmin,
  async (_req: RefuelAuthRequest, res: Response): Promise<void> => {
    res.status(403).json({
      error:
        "Direct member promotion is disabled. New Refuel admins must be invited via one-time invitation links generated by a Super Admin.",
      code: "PROMOTION_VIA_INVITATION_ONLY",
    });
  }
);

const ReasonSchema = z.object({
  reason: z.string().trim().min(1, "A non-empty reason is mandatory."),
});

/**
 * POST /refuel/admin/members/:id/demote
 * Super Admin demotes an admin to MEMBER. Requires mandatory reason.
 */
router.post(
  "/:id/demote",
  requireAuth,
  requireRefuelSuperAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const memberId = String(req.params.id);
    const superAdmin = req.refuelMember!;
    const user = req.user!;

    const parseResult = ReasonSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "A mandatory reason is required to demote an admin." });
      return;
    }

    const { reason } = parseResult.data;

    try {
      const target = await prisma.refuelMember.findUnique({
        where: { id: memberId },
      });

      if (!target) {
        res.status(404).json({ error: "Member not found." });
        return;
      }

      if (target.role === "MEMBER") {
        res.status(400).json({ error: "Target is already an ordinary member." });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const member = await tx.refuelMember.update({
          where: { id: target.id },
          data: { role: "MEMBER" },
        });

        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: superAdmin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: superAdmin.role,
            action: "MEMBER_DEMOTED",
            entityType: "MEMBER",
            entityId: target.id,
            targetMemberId: target.id,
            reason,
            beforeState: { role: target.role },
            afterState: { role: "MEMBER" },
          },
        });

        return member;
      });

      res.json({ success: true, member: updated });
    } catch (err: any) {
      console.error("[DemoteMemberError]", err);
      res.status(500).json({ error: "Failed to demote admin." });
    }
  }
);

/**
 * POST /refuel/admin/members/:id/remove
 * Admin or Super Admin removes a member. Requires mandatory reason.
 */
router.post(
  "/:id/remove",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const memberId = String(req.params.id);
    const admin = req.refuelMember!;
    const user = req.user!;
    const isSuperAdmin = admin.role === "SUPER_ADMIN";

    const parseResult = ReasonSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "A mandatory reason is required to remove a member." });
      return;
    }

    const { reason } = parseResult.data;

    try {
      const target = await prisma.refuelMember.findUnique({
        where: { id: memberId },
      });

      if (!target) {
        res.status(404).json({ error: "Member not found." });
        return;
      }

      // Ordinary admin can only remove members assigned to them
      if (!isSuperAdmin && target.assignedToId !== admin.id) {
        res.status(403).json({
          error: "Forbidden: You may only remove members assigned to you.",
        });
        return;
      }

      // Cannot remove another admin unless Super Admin
      if (target.role !== "MEMBER" && !isSuperAdmin) {
        res.status(403).json({
          error: "Forbidden: Only Super Admins can remove administrative members.",
        });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const member = await tx.refuelMember.update({
          where: { id: target.id },
          data: { status: "REMOVED" },
        });

        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: admin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: admin.role,
            action: "MEMBER_REMOVED",
            entityType: "MEMBER",
            entityId: target.id,
            targetMemberId: target.id,
            reason,
            beforeState: { status: target.status },
            afterState: { status: "REMOVED" },
          },
        });

        return member;
      });

      res.json({ success: true, member: updated });
    } catch (err: any) {
      console.error("[RemoveMemberError]", err);
      res.status(500).json({ error: "Failed to remove member." });
    }
  }
);

export default router;
