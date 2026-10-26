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
import { RefuelMembershipStatus } from "@prisma/client";

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
 * POST /refuel/admin/members/:id/approve
 * Approve a requested membership and optionally assign to an admin.
 */
router.post(
  "/:id/approve",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const memberId = String(req.params.id);
    const admin = req.refuelMember!;
    const user = req.user!;
    const { assignedToId } = req.body || {};

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

      const assignedAdminId = assignedToId || admin.id;

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
 * Super Admin promotes a member to ADMIN.
 */
router.post(
  "/:id/promote",
  requireAuth,
  requireRefuelSuperAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const memberId = String(req.params.id);
    const superAdmin = req.refuelMember!;
    const user = req.user!;

    try {
      const target = await prisma.refuelMember.findUnique({
        where: { id: memberId },
      });

      if (!target) {
        res.status(404).json({ error: "Member not found." });
        return;
      }

      if (target.role === "ADMIN" || target.role === "SUPER_ADMIN") {
        res.status(400).json({ error: "Member is already an administrator." });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const member = await tx.refuelMember.update({
          where: { id: target.id },
          data: { role: "ADMIN" },
        });

        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: superAdmin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: superAdmin.role,
            action: "MEMBER_PROMOTED",
            entityType: "MEMBER",
            entityId: target.id,
            targetMemberId: target.id,
            beforeState: { role: target.role },
            afterState: { role: "ADMIN" },
          },
        });

        return member;
      });

      res.json({ success: true, member: updated });
    } catch (err: any) {
      console.error("[PromoteMemberError]", err);
      res.status(500).json({ error: "Failed to promote member." });
    }
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
