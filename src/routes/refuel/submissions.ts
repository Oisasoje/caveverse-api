import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { requireAuth } from "../../middleware/auth";
import { requireRefuelMember, RefuelAuthRequest } from "../../middleware/refuelAuth";
import { prisma } from "../../lib/prisma";
import { getLagosToday, isSubmissionLate } from "../../lib/refuelDates";

const router = Router();

const AnswerInputSchema = z.object({
  activityId: z.string().trim().min(1, "Activity ID cannot be empty"),
  value: z.string().default(""),
});

const SubmitChecklistSchema = z.object({
  dayId: z.string().trim().min(1, "dayId is required"),
  checkedIds: z.array(z.string().trim()).default([]),
  answers: z.array(AnswerInputSchema).default([]),
  note: z.string().trim().optional(),
});

/**
 * POST /refuel/submissions
 * Member clocks in or updates answers for a specific day.
 * Generates an immutable revision snapshot on every submission,
 * evaluates lateness against Lagos midnight cutoff, and resets status to PENDING.
 */
router.post(
  "/",
  requireAuth,
  requireRefuelMember,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const parseResult = SubmitChecklistSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid submission payload",
        details: parseResult.error.format(),
      });
      return;
    }

    const { dayId, checkedIds, answers, note } = parseResult.data;
    const member = req.refuelMember!;
    const user = req.user!;
    const now = new Date();
    const lagosToday = getLagosToday(now);

    try {
      // 1. Fetch active programme to ensure submission targets active version
      const rootProgramme = await prisma.refuelProgramme.findUnique({
        where: { id: "refuel-root" },
        include: { activeVersion: true },
      });

      if (!rootProgramme?.activeVersion) {
        res.status(400).json({ error: "No active programme exists to submit for." });
        return;
      }

      const activeVersion = rootProgramme.activeVersion;

      // 2. Fetch the target day and verify it belongs to the active version
      const day = await prisma.refuelPublishedDay.findUnique({
        where: { id: dayId },
        include: { activities: true },
      });

      if (!day || day.programmeVersionId !== activeVersion.id) {
        res.status(400).json({
          error: "The specified day does not belong to the currently active programme.",
          code: "DAY_NOT_IN_ACTIVE_VERSION",
        });
        return;
      }

      // 3. Unlock Boundary Check: Future days cannot be submitted
      if (day.calendarDate > lagosToday) {
        res.status(403).json({
          error: `Day ${day.name} (${day.calendarDate}) is locked. Future days cannot be submitted before they arrive.`,
          code: "FUTURE_DAY_LOCKED",
        });
        return;
      }

      // 4. Relational integrity check: All activity IDs must belong to this day
      const validActivityIds = new Set(day.activities.map((a) => a.id));
      for (const actId of checkedIds) {
        if (!validActivityIds.has(actId)) {
          res.status(400).json({
            error: `Activity ID ${actId} does not belong to day ${day.id}.`,
            code: "CROSS_DAY_RELATION_VIOLATION",
          });
          return;
        }
      }

      for (const ans of answers) {
        if (!validActivityIds.has(ans.activityId)) {
          res.status(400).json({
            error: `Answer activity ID ${ans.activityId} does not belong to day ${day.id}.`,
            code: "CROSS_DAY_RELATION_VIOLATION",
          });
          return;
        }
      }

      // 5. Evaluate lateness against Lagos midnight + buffer
      const isLate = isSubmissionLate(
        day.calendarDate,
        now,
        activeVersion.cutoffBufferMinutes
      );

      // 6. Execute submission in transaction
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.refuelSubmission.findUnique({
          where: {
            memberId_dayId: {
              memberId: member.id,
              dayId: day.id,
            },
          },
          include: { answers: true },
        });

        if (existing) {
          const nextRevision = existing.revisionNumber + 1;

          // Delete existing answers to replace with updated answers
          await tx.refuelAnswer.deleteMany({
            where: { submissionId: existing.id },
          });

          // Insert new answers
          if (answers.length > 0) {
            await tx.refuelAnswer.createMany({
              data: answers.map((a) => ({
                submissionId: existing.id,
                activityId: a.activityId,
                dayId: day.id,
                value: a.value,
              })),
            });
          }

          // Update submission record
          const updatedSubmission = await tx.refuelSubmission.update({
            where: { id: existing.id },
            data: {
              revisionNumber: nextRevision,
              status: "PENDING",
              isLate,
              checkedIds,
              submittedAt: now,
            },
            include: { answers: true },
          });

          // Create immutable revision snapshot
          await tx.refuelSubmissionRevision.create({
            data: {
              submissionId: existing.id,
              revisionNumber: nextRevision,
              checkedIds,
              answersSnapshot: answers,
              isLate,
              submissionNote: note ?? null,
              submittedAt: now,
            },
          });

          // Record audit provenance
          await tx.refuelAuditEvent.create({
            data: {
              correlationId: crypto.randomUUID(),
              actorMemberId: member.id,
              actorUserId: user.userId,
              actorEmail: user.email,
              actorRole: member.role,
              action: "SUBMISSION_RESUBMITTED",
              entityType: "SUBMISSION",
              entityId: existing.id,
              targetMemberId: member.id,
              programmeVersionId: day.programmeVersionId,
              dayId: day.id,
              revisionNumber: nextRevision,
              beforeState: {
                revisionNumber: existing.revisionNumber,
                status: existing.status,
              },
              afterState: {
                revisionNumber: nextRevision,
                status: "PENDING",
                isLate,
                checkedCount: checkedIds.length,
                answersCount: answers.length,
              },
            },
          });

          return updatedSubmission;
        } else {
          // Create brand new submission
          const created = await tx.refuelSubmission.create({
            data: {
              memberId: member.id,
              programmeVersionId: day.programmeVersionId,
              dayId: day.id,
              dayKey: day.dayKey,
              calendarDate: day.calendarDate,
              revisionNumber: 1,
              status: "PENDING",
              isLate,
              checkedIds,
              submittedAt: now,
              answers: {
                create: answers.map((a) => ({
                  activityId: a.activityId,
                  dayId: day.id,
                  value: a.value,
                })),
              },
            },
            include: { answers: true },
          });

          // Create first immutable revision snapshot
          await tx.refuelSubmissionRevision.create({
            data: {
              submissionId: created.id,
              revisionNumber: 1,
              checkedIds,
              answersSnapshot: answers,
              isLate,
              submissionNote: note ?? null,
              submittedAt: now,
            },
          });

          // Record audit provenance
          await tx.refuelAuditEvent.create({
            data: {
              correlationId: crypto.randomUUID(),
              actorMemberId: member.id,
              actorUserId: user.userId,
              actorEmail: user.email,
              actorRole: member.role,
              action: "SUBMISSION_CREATED",
              entityType: "SUBMISSION",
              entityId: created.id,
              targetMemberId: member.id,
              programmeVersionId: day.programmeVersionId,
              dayId: day.id,
              revisionNumber: 1,
              afterState: {
                revisionNumber: 1,
                status: "PENDING",
                isLate,
                checkedCount: checkedIds.length,
                answersCount: answers.length,
              },
            },
          });

          return created;
        }
      });

      res.status(200).json({
        success: true,
        submission: result,
      });
    } catch (err: any) {
      console.error("[RefuelSubmissionError]", err);
      res.status(500).json({
        error: "Failed to process clock-in submission.",
        message: err.message,
      });
    }
  }
);

/**
 * GET /refuel/submissions/:dayId
 * Read the authenticated member's submission and revision history for a specific day.
 */
router.get(
  "/:dayId",
  requireAuth,
  requireRefuelMember,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const dayId = String(req.params.dayId);
    const member = req.refuelMember!;

    try {
      const submission = await prisma.refuelSubmission.findUnique({
        where: {
          memberId_dayId: {
            memberId: member.id,
            dayId,
          },
        },
        include: {
          answers: true,
          revisions: {
            orderBy: { revisionNumber: "desc" },
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

      if (!submission) {
        res.status(404).json({ error: "No submission found for this day." });
        return;
      }

      res.json({ submission });
    } catch (err: any) {
      console.error("[GetDaySubmissionError]", err);
      res.status(500).json({ error: "Failed to load submission." });
    }
  }
);

export default router;
