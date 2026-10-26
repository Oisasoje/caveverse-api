import { Router, Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireRefuelMember, RefuelAuthRequest } from "../../middleware/refuelAuth";
import { prisma } from "../../lib/prisma";
import { getLagosToday, deriveDayOutcome } from "../../lib/refuelDates";

const router = Router();

/**
 * GET /refuel/checklist
 * Returns the current active programme populated with the authenticated member's
 * submissions, answers, grace records, and deterministic day outcomes.
 */
router.get(
  "/",
  requireAuth,
  requireRefuelMember,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const member = req.refuelMember!;
    const lagosToday = getLagosToday();

    try {
      const programme = await prisma.refuelProgramme.findUnique({
        where: { id: "refuel-root" },
        include: {
          activeVersion: {
            include: {
              weeks: {
                orderBy: { weekNumber: "asc" },
                include: {
                  days: {
                    orderBy: { orderIndex: "asc" },
                    include: {
                      activities: {
                        orderBy: { orderIndex: "asc" },
                        include: {
                          resources: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!programme || !programme.activeVersion) {
        res.status(404).json({
          error: "No active programme has been published yet.",
        });
        return;
      }

      const activeVersion = programme.activeVersion;

      // Fetch member's submissions for this published version
      const submissions = await prisma.refuelSubmission.findMany({
        where: {
          memberId: member.id,
          programmeVersionId: activeVersion.id,
        },
        include: {
          answers: true,
          decisions: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });

      // Map submissions by dayId
      const submissionMap = new Map(submissions.map((s) => [s.dayId, s]));

      // Fetch member's grace records
      const graceRecords = await prisma.refuelGraceRecord.findMany({
        where: { memberId: member.id },
      });
      const graceMap = new Map(graceRecords.map((g) => [g.dayId, g]));

      // Enrich weeks & days with member outcomes
      const enrichedWeeks = activeVersion.weeks.map((week) => {
        const enrichedDays = week.days.map((day) => {
          const submission = submissionMap.get(day.id) || null;
          const grace = graceMap.get(day.id) || null;
          const outcome = deriveDayOutcome(day, submission, grace, lagosToday);
          const isUnlocked = day.calendarDate <= lagosToday;
          const latestDecision = submission?.decisions?.[0] || null;

          return {
            id: day.id,
            dayKey: day.dayKey,
            name: day.name,
            weekday: day.weekday,
            calendarDate: day.calendarDate,
            orderIndex: day.orderIndex,
            isUnlocked,
            outcome,
            submission: submission
              ? {
                  id: submission.id,
                  status: submission.status,
                  revisionNumber: submission.revisionNumber,
                  isLate: submission.isLate,
                  checkedIds: submission.checkedIds,
                  submittedAt: submission.submittedAt,
                  answers: submission.answers.map((a) => ({
                    activityId: a.activityId,
                    value: a.value,
                  })),
                  rejectionReason:
                    submission.status === "INVALID" ? latestDecision?.reason ?? null : null,
                }
              : null,
            grace: grace
              ? {
                  id: grace.id,
                  reason: grace.reason,
                  grantedAt: grace.grantedAt,
                }
              : null,
            activities: day.activities.map((act) => ({
              id: act.id,
              title: act.title,
              detail: act.detail,
              activityType: act.activityType,
              completionMethod: act.completionMethod,
              required: act.required,
              orderIndex: act.orderIndex,
              resources: act.resources,
            })),
          };
        });

        return {
          id: week.id,
          weekNumber: week.weekNumber,
          title: week.title,
          days: enrichedDays,
        };
      });

      res.json({
        programmeId: programme.id,
        versionId: activeVersion.id,
        versionNumber: activeVersion.versionNumber,
        programmeStartDate: activeVersion.programmeStartDate,
        weekStartDay: activeVersion.weekStartDay,
        cutoffBufferMinutes: activeVersion.cutoffBufferMinutes,
        lagosToday,
        member: {
          id: member.id,
          userId: member.userId,
          role: member.role,
          status: member.status,
          initials: member.initials,
          color: member.color,
          assignedToId: member.assignedToId,
        },
        weeks: enrichedWeeks,
      });
    } catch (err: any) {
      console.error("[GetMemberChecklistError]", err);
      res.status(500).json({ error: "Failed to load member checklist." });
    }
  }
);

export default router;
