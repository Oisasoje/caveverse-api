import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { requireAuth } from "../../../middleware/auth";
import { requireRefuelAdmin, RefuelAuthRequest } from "../../../middleware/refuelAuth";
import { prisma } from "../../../lib/prisma";

const router = Router();

const GrantGraceSchema = z.object({
  memberId: z.string().trim().min(1, "memberId is required"),
  dayId: z.string().trim().min(1, "dayId is required"),
  reason: z.string().trim().min(1, "A non-empty reason is mandatory when granting grace."),
});

/**
 * POST /refuel/admin/grace
 * Admin grants permanent grace for a member on a specific day.
 * Enforces mandatory reason, uniqueness per (memberId, dayId), and audit logging.
 */
router.post(
  "/",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const admin = req.refuelMember!;
    const user = req.user!;
    const isSuperAdmin = admin.role === "SUPER_ADMIN";

    const parseResult = GrantGraceSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid grace request payload",
        details: parseResult.error.format(),
      });
      return;
    }

    const { memberId, dayId, reason } = parseResult.data;

    try {
      // 1. Verify target member exists and check assignment authorization
      const targetMember = await prisma.refuelMember.findUnique({
        where: { id: memberId },
      });

      if (!targetMember) {
        res.status(404).json({ error: "Target member not found." });
        return;
      }

      if (!isSuperAdmin && targetMember.assignedToId !== admin.id) {
        res.status(403).json({
          error: "Forbidden: You may only grant grace to members assigned to you.",
        });
        return;
      }

      // 2. Verify target day belongs to active programme version
      const root = await prisma.refuelProgramme.findUnique({
        where: { id: "refuel-root" },
      });

      const day = await prisma.refuelPublishedDay.findUnique({
        where: { id: dayId },
      });

      if (!day || day.programmeVersionId !== root?.activeVersionId) {
        res.status(400).json({
          error: "The specified day does not belong to the active published programme.",
        });
        return;
      }

      // 3. Insert grace record and audit event in transaction
      const result = await prisma.$transaction(async (tx) => {
        // Check existing grace record
        const existing = await tx.refuelGraceRecord.findUnique({
          where: {
            memberId_dayId: { memberId, dayId },
          },
        });

        if (existing) {
          const err: any = new Error("Grace has already been granted for this member on this day.");
          err.statusCode = 409;
          throw err;
        }

        const graceRecord = await tx.refuelGraceRecord.create({
          data: {
            memberId,
            dayId,
            grantedById: admin.id,
            reason,
          },
          include: {
            day: { select: { id: true, name: true, calendarDate: true } },
            member: { select: { id: true, initials: true, color: true } },
          },
        });

        // Record audit provenance
        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: admin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: admin.role,
            action: "GRACE_GRANTED",
            entityType: "GRACE",
            entityId: graceRecord.id,
            targetMemberId: memberId,
            programmeVersionId: day.programmeVersionId,
            dayId,
            reason,
            afterState: {
              graceId: graceRecord.id,
              calendarDate: day.calendarDate,
              reason,
            },
          },
        });

        return graceRecord;
      });

      res.status(200).json({
        success: true,
        grace: result,
      });
    } catch (err: any) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: err.message });
        return;
      }

      console.error("[RefuelGrantGraceError]", err);
      res.status(500).json({
        error: "Internal server error granting grace.",
        message: err.message,
      });
    }
  }
);

/**
 * GET /refuel/admin/grace
 * List grace records.
 */
router.get(
  "/",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const admin = req.refuelMember!;
    const isSuperAdmin = admin.role === "SUPER_ADMIN";
    const { memberId, dayId } = req.query;

    const whereClause: any = {};
    if (memberId && typeof memberId === "string") whereClause.memberId = memberId;
    if (dayId && typeof dayId === "string") whereClause.dayId = dayId;

    if (!isSuperAdmin) {
      whereClause.member = { assignedToId: admin.id };
    }

    try {
      const graceRecords = await prisma.refuelGraceRecord.findMany({
        where: whereClause,
        orderBy: { grantedAt: "desc" },
        include: {
          member: {
            include: { user: { select: { name: true, email: true } } },
          },
          day: { select: { id: true, name: true, calendarDate: true } },
          grantedBy: { select: { id: true, initials: true } },
        },
      });

      res.json({ graceRecords });
    } catch (err: any) {
      console.error("[GetGraceRecordsError]", err);
      res.status(500).json({ error: "Failed to load grace records." });
    }
  }
);

export default router;
