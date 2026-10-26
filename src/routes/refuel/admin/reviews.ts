import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { requireAuth } from "../../../middleware/auth";
import { requireRefuelAdmin, RefuelAuthRequest } from "../../../middleware/refuelAuth";
import { prisma } from "../../../lib/prisma";
import { RefuelDecisionType, RefuelSubmissionStatus } from "@prisma/client";
import { sendPushToMember } from "../../../lib/webPush";

const router = Router();

const DecisionRequestSchema = z.object({
  reviewedRevisionNumber: z.number().int().min(1, "reviewedRevisionNumber must be >= 1"),
  decision: z.nativeEnum(RefuelDecisionType),
  reason: z.string().trim().optional(),
}).refine(
  (data) => {
    if (data.decision === RefuelDecisionType.REJECT) {
      return typeof data.reason === "string" && data.reason.length > 0;
    }
    return true;
  },
  {
    message: "A non-empty reason is mandatory when rejecting a submission.",
    path: ["reason"],
  }
);

/**
 * GET /refuel/admin/reviews/submissions
 * Query submissions awaiting review or with filters.
 * Ordinary Admins only see their assigned members unless they are Super Admins.
 */
router.get(
  "/submissions",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const admin = req.refuelMember!;
    const isSuperAdmin = admin.role === "SUPER_ADMIN";

    const { status, memberId, dayId, allMembers } = req.query;

    const whereClause: any = {};

    if (status && Object.values(RefuelSubmissionStatus).includes(status as any)) {
      whereClause.status = status;
    }

    if (memberId && typeof memberId === "string") {
      whereClause.memberId = memberId;
    }

    if (dayId && typeof dayId === "string") {
      whereClause.dayId = dayId;
    }

    // Role-based scope: If not Super Admin or if allMembers !== 'true', filter to assigned members
    if (!isSuperAdmin || allMembers !== "true") {
      if (!isSuperAdmin) {
        whereClause.member = {
          assignedToId: admin.id,
        };
      }
    }

    try {
      const submissions = await prisma.refuelSubmission.findMany({
        where: whereClause,
        orderBy: { submittedAt: "desc" },
        include: {
          member: {
            include: {
              user: {
                select: { id: true, name: true, email: true },
              },
            },
          },
          day: {
            select: { id: true, name: true, calendarDate: true, dayKey: true },
          },
          answers: {
            include: {
              activity: {
                select: { id: true, title: true, activityType: true, completionMethod: true },
              },
            },
          },
          revisions: {
            orderBy: { revisionNumber: "desc" },
            take: 1,
          },
          decisions: {
            orderBy: { createdAt: "desc" },
            include: {
              reviewer: {
                select: { id: true, initials: true, color: true },
              },
            },
          },
        },
      });

      res.json({ submissions });
    } catch (err: any) {
      console.error("[GetSubmissionsError]", err);
      res.status(500).json({ error: "Failed to load submissions for review." });
    }
  }
);

/**
 * POST /refuel/admin/reviews/submissions/:id/decision
 * Admin reviews a member's submission.
 * Enforces atomic revision check to prevent reviewing stale submissions,
 * requires non-empty reason for rejections, and logs audit + feedback notice.
 */
router.post(
  "/submissions/:id/decision",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const submissionId = String(req.params.id);
    const admin = req.refuelMember!;
    const user = req.user!;
    const isSuperAdmin = admin.role === "SUPER_ADMIN";

    const parseResult = DecisionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid decision payload",
        details: parseResult.error.format(),
      });
      return;
    }

    const { reviewedRevisionNumber, decision, reason } = parseResult.data;

    try {
      const result = await prisma.$transaction(async (tx) => {
        // 1. Fetch submission with member and day
        const submission = await tx.refuelSubmission.findUnique({
          where: { id: submissionId },
          include: {
            member: true,
            day: true,
          },
        });

        if (!submission) {
          const err: any = new Error("Submission not found.");
          err.statusCode = 404;
          throw err;
        }

        // 2. Authorization check: assigned admin or super admin
        if (!isSuperAdmin && submission.member.assignedToId !== admin.id) {
          const err: any = new Error(
            "Forbidden: You are only authorized to review submissions for members assigned to you."
          );
          err.statusCode = 403;
          throw err;
        }

        // 3. Atomic Stale Review Check:
        // Admin cannot approve or reject Revision 1 if member has already updated to Revision 2.
        if (submission.revisionNumber !== reviewedRevisionNumber) {
          const err: any = new Error(
            `This submission was updated by the member (current revision is ${submission.revisionNumber}, but you reviewed revision ${reviewedRevisionNumber}). Please reload to review the latest submission.`
          );
          err.statusCode = 409;
          err.currentRevisionNumber = submission.revisionNumber;
          throw err;
        }

        // 4. Determine state transition
        let nextStatus: RefuelSubmissionStatus;
        let auditAction: "CLOCK_IN_APPROVED" | "CLOCK_IN_REJECTED" | "CLOCK_IN_REOPENED";

        if (decision === RefuelDecisionType.APPROVE) {
          nextStatus = RefuelSubmissionStatus.VALID;
          auditAction = "CLOCK_IN_APPROVED";
        } else if (decision === RefuelDecisionType.REJECT) {
          nextStatus = RefuelSubmissionStatus.INVALID;
          auditAction = "CLOCK_IN_REJECTED";
        } else {
          nextStatus = RefuelSubmissionStatus.PENDING;
          auditAction = "CLOCK_IN_REOPENED";
        }

        // 5. Create immutable decision record
        const decisionRecord = await tx.refuelDecision.create({
          data: {
            submissionId: submission.id,
            reviewedRevisionNumber,
            decision,
            reviewerId: admin.id,
            reason: reason ?? null,
          },
        });

        // 6. Update submission status
        const updatedSubmission = await tx.refuelSubmission.update({
          where: { id: submission.id },
          data: {
            status: nextStatus,
          },
        });

        // 7. If rejected, create feedback notice for the member
        if (decision === RefuelDecisionType.REJECT) {
          await tx.refuelNotice.create({
            data: {
              kind: "REVIEW_FEEDBACK",
              title: `Feedback on ${submission.day.name} clock-in`,
              body: reason!,
              authorId: admin.id,
              targetMemberId: submission.memberId,
              metadata: {
                submissionId: submission.id,
                dayId: submission.dayId,
                dayKey: submission.dayKey,
                calendarDate: submission.calendarDate,
                status: "INVALID",
                reviewedRevisionNumber,
                reason,
              },
            },
          });
        }

        // 8. Record audit provenance
        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: admin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: admin.role,
            action: auditAction,
            entityType: "DECISION",
            entityId: decisionRecord.id,
            targetMemberId: submission.memberId,
            programmeVersionId: submission.programmeVersionId,
            dayId: submission.dayId,
            revisionNumber: reviewedRevisionNumber,
            reason: reason ?? null,
            beforeState: {
              status: submission.status,
              revisionNumber: submission.revisionNumber,
            },
            afterState: {
              status: nextStatus,
              decisionId: decisionRecord.id,
              decision,
              reviewedRevisionNumber,
            },
          },
        });

        return {
          decision: decisionRecord,
          submission: updatedSubmission,
        };
      });

      // Fire Web Push to member if rejected
      if (decision === RefuelDecisionType.REJECT) {
        sendPushToMember(result.submission.memberId, {
          title: "Clock-in Needs Attention",
          body: `Admin feedback on your submission: ${reason}`,
          url: "/learn/refuel/notifications",
        }).catch((err) => console.error("[WebPushReviewError]", err));
      }

      res.status(200).json({
        success: true,
        decision: result.decision,
        submission: result.submission,
      });
    } catch (err: any) {
      if (err.statusCode) {
        res.status(err.statusCode).json({
          error: err.message,
          currentRevisionNumber: err.currentRevisionNumber,
        });
        return;
      }

      console.error("[RefuelDecisionError]", err);
      res.status(500).json({
        error: "Internal server error processing review decision.",
        message: err.message,
      });
    }
  }
);

export default router;
