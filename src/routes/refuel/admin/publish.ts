import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { requireAuth } from "../../../middleware/auth";
import { requireRefuelAdmin, RefuelAuthRequest } from "../../../middleware/refuelAuth";
import { prisma } from "../../../lib/prisma";
import { isMonday, calculateDayCalendarDate } from "../../../lib/refuelDates";
import {
  RefuelWeekday,
  RefuelActivityType,
  RefuelCompletionMethod,
} from "@prisma/client";

const router = Router();

const ResourceDraftSchema = z.object({
  title: z.string().trim().min(1, "Resource title cannot be empty"),
  url: z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((v) => v ?? ""),
});

const ActivityDraftSchema = z.object({
  title: z.string().trim().min(1, "Activity title cannot be empty"),
  detail: z.string().trim().nullable().optional(),
  activityType: z.nativeEnum(RefuelActivityType).default(RefuelActivityType.OTHER),
  completionMethod: z.nativeEnum(RefuelCompletionMethod).default(RefuelCompletionMethod.TICK),
  required: z.boolean().default(true),
  orderIndex: z.number().int().default(0),
  resources: z
    .array(ResourceDraftSchema)
    .nullable()
    .optional()
    .transform((v) => v ?? []),
});

const DayDraftSchema = z.object({
  dayKey: z.string().trim().min(1, "Day key cannot be empty"),
  name: z.string().trim().min(1, "Day name cannot be empty"),
  weekday: z.nativeEnum(RefuelWeekday),
  orderIndex: z.number().int().default(0),
  activities: z
    .array(ActivityDraftSchema)
    .nullable()
    .optional()
    .transform((v) => v ?? []),
});

const WeekDraftSchema = z.object({
  weekNumber: z.number().int().min(1, "Week number must be >= 1"),
  title: z.string().trim().min(1, "Week title cannot be empty"),
  days: z
    .array(DayDraftSchema)
    .min(1, "Week must have at least 1 day")
    .max(7, "Week cannot have more than 7 days"),
});

const PublishRequestSchema = z.object({
  expectedVersionLock: z.number().int().min(1, "expectedVersionLock is required"),
  programmeStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "programmeStartDate must be YYYY-MM-DD"),
  weekStartDay: z.nativeEnum(RefuelWeekday).default(RefuelWeekday.MONDAY),
  cutoffBufferMinutes: z.number().int().min(0).default(0),
  draft: z
    .object({
      weeks: z.array(WeekDraftSchema).min(1, "Draft must have at least 1 week"),
    })
    .optional(),
});

interface WeekInput {
  weekNumber: number;
  title: string;
  days: Array<{
    dayKey: string;
    name: string;
    weekday: RefuelWeekday;
    orderIndex?: number;
    activities: Array<{
      title: string;
      detail?: string | null;
      activityType?: RefuelActivityType;
      completionMethod?: RefuelCompletionMethod;
      required?: boolean;
      orderIndex?: number;
      resources?: Array<{
        title: string;
        url?: string;
      }>;
    }>;
  }>;
}

/**
 * POST /refuel/admin/programme/publish
 * Checks Monday start date, seals each day calendarDate, verifies optimistic concurrency,
 * creates immutable published version snapshot, bumps versionLock, and switches active version.
 */
router.post(
  "/programme/publish",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const parseResult = PublishRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid publish payload",
        details: parseResult.error.format(),
      });
      return;
    }

    const {
      expectedVersionLock,
      programmeStartDate,
      weekStartDay,
      cutoffBufferMinutes,
      draft: bodyDraft,
    } = parseResult.data;

    // 1. Strict validation: programmeStartDate must fall on a Monday
    if (!isMonday(programmeStartDate)) {
      res.status(400).json({
        error: "Programme start date must be a Monday.",
        code: "START_DATE_NOT_A_MONDAY",
      });
      return;
    }

    const member = req.refuelMember!;
    const user = req.user!;

    try {
      // Ensure root programme exists before starting the interactive transaction
      let rootProg: any = await prisma.refuelProgramme.findUnique({
        where: { id: "refuel-root" },
        include: {
          activeVersion: true,
          ...(bodyDraft && bodyDraft.weeks.length > 0
            ? {}
            : {
                draft: {
                  include: {
                    weeks: {
                      orderBy: { weekNumber: "asc" },
                      include: {
                        days: {
                          orderBy: { orderIndex: "asc" },
                          include: {
                            activities: {
                              orderBy: { orderIndex: "asc" },
                              include: { resources: true },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              }),
        },
      });

      if (!rootProg) {
        rootProg = await prisma.refuelProgramme.create({
          data: { id: "refuel-root", versionLock: 1 },
          include: { activeVersion: true },
        });
      }

      // 2. Optimistic Concurrency Check
      if (rootProg.versionLock !== expectedVersionLock) {
        res.status(409).json({
          error: "Programme was modified by another administrator. Please reload and try again.",
          currentVersionLock: rootProg.versionLock,
          code: "VERSION_LOCK_CONFLICT",
        });
        return;
      }

      // 3. Resolve the weeks to publish
      let weeksToPublish: WeekInput[];
      const existingDraft = rootProg.draft;

      if (bodyDraft && bodyDraft.weeks.length > 0) {
        weeksToPublish = bodyDraft.weeks;
      } else if (existingDraft && existingDraft.weeks.length > 0) {
        weeksToPublish = existingDraft.weeks;
      } else {
        res.status(400).json({
          error: "No draft programme found to publish.",
        });
        return;
      }

      // Validate week/day uniqueness & resource URLs before entering transaction
      const seenWeekNumbers = new Set<number>();
      for (const week of weeksToPublish) {
        if (seenWeekNumbers.has(week.weekNumber)) {
          res.status(400).json({
            error: `Duplicate weekNumber ${week.weekNumber} found in draft.`,
          });
          return;
        }
        seenWeekNumbers.add(week.weekNumber);

        const seenDayKeys = new Set<string>();
        const seenWeekdays = new Set<string>();
        for (const day of week.days) {
          if (seenDayKeys.has(day.dayKey)) {
            res.status(400).json({
              error: `Week ${week.weekNumber} has duplicate dayKey "${day.dayKey}".`,
            });
            return;
          }
          seenDayKeys.add(day.dayKey);

          if (seenWeekdays.has(day.weekday)) {
            res.status(400).json({
              error: `Week ${week.weekNumber} has multiple days assigned to ${day.weekday}. Each day in a week must have a unique weekday.`,
            });
            return;
          }
          seenWeekdays.add(day.weekday);

          for (const activity of day.activities) {
            if (activity.resources) {
              for (const resource of activity.resources) {
                const url = (resource.url ?? "").trim();
                if (url && !/^https?:\/\//i.test(url)) {
                  res.status(400).json({
                    error: `Resource "${resource.title}" must have a valid http:// or https:// URL.`,
                  });
                  return;
                }
              }
            }
          }
        }
      }

      const txResult = await prisma.$transaction(
        async (tx) => {
          // Verify versionLock inside transaction
          const programme = await tx.refuelProgramme.findUniqueOrThrow({
            where: { id: "refuel-root" },
            include: { activeVersion: true },
          });

          if (programme.versionLock !== expectedVersionLock) {
            const err: any = new Error(
              "Programme was modified by another administrator. Please reload and try again."
            );
            err.statusCode = 409;
            err.currentVersionLock = programme.versionLock;
            throw err;
          }

          // 4. Update the draft workspace if a new draft payload was provided (using bulk createMany)
          if (bodyDraft) {
            const draftRecord = await tx.refuelDraftProgramme.upsert({
              where: { programmeId: programme.id },
              update: {
                programmeStartDate,
                weekStartDay,
                updatedById: member.id,
              },
              create: {
                programmeId: programme.id,
                programmeStartDate,
                weekStartDay,
                updatedById: member.id,
              },
            });

            await tx.refuelDraftWeek.deleteMany({
              where: { draftId: draftRecord.id },
            });

            const draftWeeksData: Array<{
              id: string;
              draftId: string;
              weekNumber: number;
              title: string;
            }> = [];
            const draftDaysData: Array<{
              id: string;
              weekId: string;
              dayKey: string;
              name: string;
              weekday: RefuelWeekday;
              orderIndex: number;
            }> = [];
            const draftActivitiesData: Array<{
              id: string;
              dayId: string;
              title: string;
              detail: string | null;
              activityType: RefuelActivityType;
              completionMethod: RefuelCompletionMethod;
              required: boolean;
              orderIndex: number;
            }> = [];
            const draftResourcesData: Array<{
              id: string;
              activityId: string;
              title: string;
              url: string;
            }> = [];

            for (const w of weeksToPublish) {
              const weekId = crypto.randomUUID();
              draftWeeksData.push({
                id: weekId,
                draftId: draftRecord.id,
                weekNumber: w.weekNumber,
                title: w.title,
              });

              for (const d of w.days) {
                const dayId = crypto.randomUUID();
                draftDaysData.push({
                  id: dayId,
                  weekId,
                  dayKey: d.dayKey,
                  name: d.name,
                  weekday: d.weekday,
                  orderIndex: d.orderIndex ?? 0,
                });

                for (const a of d.activities) {
                  const actId = crypto.randomUUID();
                  draftActivitiesData.push({
                    id: actId,
                    dayId,
                    title: a.title,
                    detail: a.detail ?? null,
                    activityType: a.activityType ?? RefuelActivityType.OTHER,
                    completionMethod: a.completionMethod ?? RefuelCompletionMethod.TICK,
                    required: a.required ?? true,
                    orderIndex: a.orderIndex ?? 0,
                  });

                  if (a.resources && a.resources.length > 0) {
                    for (const r of a.resources) {
                      draftResourcesData.push({
                        id: crypto.randomUUID(),
                        activityId: actId,
                        title: r.title,
                        url: r.url ?? "",
                      });
                    }
                  }
                }
              }
            }

            if (draftWeeksData.length > 0) {
              await tx.refuelDraftWeek.createMany({ data: draftWeeksData });
            }
            if (draftDaysData.length > 0) {
              await tx.refuelDraftDay.createMany({ data: draftDaysData });
            }
            if (draftActivitiesData.length > 0) {
              await tx.refuelDraftActivity.createMany({ data: draftActivitiesData });
            }
            if (draftResourcesData.length > 0) {
              await tx.refuelDraftResource.createMany({ data: draftResourcesData });
            }
          }

          // 5. Compute next version number safely
          const maxVer = await tx.refuelPublishedVersion.aggregate({
            where: { programmeId: programme.id },
            _max: { versionNumber: true },
          });
          const nextVersionNumber =
            Math.max(
              programme.activeVersion?.versionNumber ?? 0,
              maxVer._max.versionNumber ?? 0
            ) + 1;

          // 6. Create the frozen, immutable published version snapshot using bulk createMany
          const publishedVersionId = crypto.randomUUID();
          await tx.refuelPublishedVersion.create({
            data: {
              id: publishedVersionId,
              programmeId: programme.id,
              versionNumber: nextVersionNumber,
              programmeStartDate,
              weekStartDay,
              cutoffBufferMinutes,
              timezone: "Africa/Lagos",
              publishedById: member.id,
            },
          });

          const pubWeeksData: Array<{
            id: string;
            programmeVersionId: string;
            weekNumber: number;
            title: string;
          }> = [];
          const pubDaysData: Array<{
            id: string;
            programmeVersionId: string;
            weekId: string;
            dayKey: string;
            name: string;
            weekday: RefuelWeekday;
            calendarDate: string;
            orderIndex: number;
          }> = [];
          const pubActivitiesData: Array<{
            id: string;
            dayId: string;
            title: string;
            detail: string | null;
            activityType: RefuelActivityType;
            completionMethod: RefuelCompletionMethod;
            required: boolean;
            orderIndex: number;
          }> = [];
          const pubResourcesData: Array<{
            id: string;
            activityId: string;
            title: string;
            url: string;
          }> = [];

          for (const week of weeksToPublish) {
            const weekId = crypto.randomUUID();
            pubWeeksData.push({
              id: weekId,
              programmeVersionId: publishedVersionId,
              weekNumber: week.weekNumber,
              title: week.title,
            });

            for (const day of week.days) {
              const dayId = crypto.randomUUID();
              pubDaysData.push({
                id: dayId,
                programmeVersionId: publishedVersionId,
                weekId,
                dayKey: day.dayKey,
                name: day.name,
                weekday: day.weekday,
                calendarDate: calculateDayCalendarDate(
                  programmeStartDate,
                  week.weekNumber,
                  day.weekday
                ),
                orderIndex: day.orderIndex ?? 0,
              });

              for (const act of day.activities) {
                const actId = crypto.randomUUID();
                pubActivitiesData.push({
                  id: actId,
                  dayId,
                  title: act.title,
                  detail: act.detail ?? null,
                  activityType: act.activityType ?? RefuelActivityType.OTHER,
                  completionMethod: act.completionMethod ?? RefuelCompletionMethod.TICK,
                  required: act.required ?? true,
                  orderIndex: act.orderIndex ?? 0,
                });

                for (const res of act.resources ?? []) {
                  pubResourcesData.push({
                    id: crypto.randomUUID(),
                    activityId: actId,
                    title: res.title,
                    url: res.url ?? "",
                  });
                }
              }
            }
          }

          if (pubWeeksData.length > 0) {
            await tx.refuelPublishedWeek.createMany({ data: pubWeeksData });
          }
          if (pubDaysData.length > 0) {
            await tx.refuelPublishedDay.createMany({ data: pubDaysData });
          }
          if (pubActivitiesData.length > 0) {
            await tx.refuelPublishedActivity.createMany({ data: pubActivitiesData });
          }
          if (pubResourcesData.length > 0) {
            await tx.refuelPublishedResource.createMany({ data: pubResourcesData });
          }

          // 7. Update root programme: activate published version and increment versionLock
          const updatedProgramme = await tx.refuelProgramme.update({
            where: { id: programme.id },
            data: {
              activeVersionId: publishedVersionId,
              versionLock: { increment: 1 },
            },
          });

          // 8. Record audit provenance
          await tx.refuelAuditEvent.create({
            data: {
              correlationId: crypto.randomUUID(),
              actorMemberId: member.id,
              actorUserId: user.userId,
              actorEmail: user.email,
              actorRole: member.role,
              action: "PROGRAMME_PUBLISHED",
              entityType: "PROGRAMME",
              entityId: publishedVersionId,
              programmeVersionId: publishedVersionId,
              beforeState: {
                activeVersionId: programme.activeVersionId,
                versionLock: programme.versionLock,
              },
              afterState: {
                activeVersionId: publishedVersionId,
                versionLock: updatedProgramme.versionLock,
                versionNumber: nextVersionNumber,
                programmeStartDate,
              },
            },
          });

          return {
            publishedVersionId,
            versionLock: updatedProgramme.versionLock,
          };
        },
        { timeout: 60000, maxWait: 15000 }
      );

      // Fetch the complete published version outside the transaction
      const publishedVersion = await prisma.refuelPublishedVersion.findUniqueOrThrow({
        where: { id: txResult.publishedVersionId },
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
      });

      res.status(200).json({
        success: true,
        version: publishedVersion,
        versionLock: txResult.versionLock,
      });
    } catch (err: any) {
      if (err.statusCode === 409) {
        res.status(409).json({
          error: err.message,
          currentVersionLock: err.currentVersionLock,
          code: "VERSION_LOCK_CONFLICT",
        });
        return;
      }
      if (err.statusCode === 400) {
        res.status(400).json({
          error: err.message,
        });
        return;
      }

      console.error("[RefuelPublishError]", err);
      res.status(500).json({
        error: "Internal server error while publishing programme snapshot.",
        message: err.message,
      });
    }
  }
);

const SaveDraftSchema = z.object({
  programmeStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  weekStartDay: z.nativeEnum(RefuelWeekday).default(RefuelWeekday.MONDAY),
  weeks: z.array(WeekDraftSchema).default([]),
});

/**
 * POST /refuel/admin/programme/draft
 * Save changes to the draft workspace without publishing.
 * Logs PROGRAMME_DRAFT_SAVED audit event.
 */
router.post(
  "/programme/draft",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const parseResult = SaveDraftSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid draft payload",
        details: parseResult.error.format(),
      });
      return;
    }

    const { programmeStartDate, weekStartDay, weeks } = parseResult.data;
    const member = req.refuelMember!;
    const user = req.user!;

    try {
      // Ensure root programme exists before starting transaction
      let rootProg = await prisma.refuelProgramme.findUnique({
        where: { id: "refuel-root" },
        include: {
          draft: {
            include: {
              weeks: {
                include: {
                  days: {
                    include: { activities: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!rootProg) {
        rootProg = await prisma.refuelProgramme.create({
          data: { id: "refuel-root", versionLock: 1 },
          include: {
            draft: {
              include: {
                weeks: {
                  include: {
                    days: {
                      include: { activities: true },
                    },
                  },
                },
              },
            },
          },
        });
      }

      const beforeWeekCount = rootProg.draft?.weeks.length ?? 0;
      const beforeActivityCount =
        rootProg.draft?.weeks.reduce(
          (acc, w) => acc + w.days.reduce((dAcc, d) => dAcc + d.activities.length, 0),
          0
        ) ?? 0;

      const draftId = await prisma.$transaction(
        async (tx) => {
          const draftRecord = await tx.refuelDraftProgramme.upsert({
            where: { programmeId: rootProg.id },
            update: {
              programmeStartDate: programmeStartDate ?? undefined,
              weekStartDay,
              updatedById: member.id,
            },
            create: {
              programmeId: rootProg.id,
              programmeStartDate: programmeStartDate ?? null,
              weekStartDay,
              updatedById: member.id,
            },
          });

          // Clean replacement of draft weeks
          await tx.refuelDraftWeek.deleteMany({
            where: { draftId: draftRecord.id },
          });

          const draftWeeksData: Array<{
            id: string;
            draftId: string;
            weekNumber: number;
            title: string;
          }> = [];
          const draftDaysData: Array<{
            id: string;
            weekId: string;
            dayKey: string;
            name: string;
            weekday: RefuelWeekday;
            orderIndex: number;
          }> = [];
          const draftActivitiesData: Array<{
            id: string;
            dayId: string;
            title: string;
            detail: string | null;
            activityType: RefuelActivityType;
            completionMethod: RefuelCompletionMethod;
            required: boolean;
            orderIndex: number;
          }> = [];
          const draftResourcesData: Array<{
            id: string;
            activityId: string;
            title: string;
            url: string;
          }> = [];

          for (const w of weeks) {
            const weekId = crypto.randomUUID();
            draftWeeksData.push({
              id: weekId,
              draftId: draftRecord.id,
              weekNumber: w.weekNumber,
              title: w.title,
            });

            for (const d of w.days) {
              const dayId = crypto.randomUUID();
              draftDaysData.push({
                id: dayId,
                weekId,
                dayKey: d.dayKey,
                name: d.name,
                weekday: d.weekday,
                orderIndex: d.orderIndex ?? 0,
              });

              for (const a of d.activities) {
                const actId = crypto.randomUUID();
                draftActivitiesData.push({
                  id: actId,
                  dayId,
                  title: a.title,
                  detail: a.detail ?? null,
                  activityType: a.activityType ?? RefuelActivityType.OTHER,
                  completionMethod: a.completionMethod ?? RefuelCompletionMethod.TICK,
                  required: a.required ?? true,
                  orderIndex: a.orderIndex ?? 0,
                });

                if (a.resources && a.resources.length > 0) {
                  for (const r of a.resources) {
                    draftResourcesData.push({
                      id: crypto.randomUUID(),
                      activityId: actId,
                      title: r.title,
                      url: r.url ?? "",
                    });
                  }
                }
              }
            }
          }

          if (draftWeeksData.length > 0) {
            await tx.refuelDraftWeek.createMany({ data: draftWeeksData });
          }
          if (draftDaysData.length > 0) {
            await tx.refuelDraftDay.createMany({ data: draftDaysData });
          }
          if (draftActivitiesData.length > 0) {
            await tx.refuelDraftActivity.createMany({ data: draftActivitiesData });
          }
          if (draftResourcesData.length > 0) {
            await tx.refuelDraftResource.createMany({ data: draftResourcesData });
          }

          // Record audit event
          await tx.refuelAuditEvent.create({
            data: {
              correlationId: crypto.randomUUID(),
              actorMemberId: member.id,
              actorUserId: user.userId,
              actorEmail: user.email,
              actorRole: member.role,
              action: "PROGRAMME_DRAFT_SAVED",
              entityType: "PROGRAMME",
              entityId: draftRecord.id,
              beforeState: {
                weekCount: beforeWeekCount,
                activityCount: beforeActivityCount,
              },
              afterState: {
                weekCount: weeks.length,
                activityCount: draftActivitiesData.length,
                programmeStartDate,
              },
            },
          });

          return draftRecord.id;
        },
        { timeout: 60000, maxWait: 15000 }
      );

      const savedDraft = await prisma.refuelDraftProgramme.findUnique({
        where: { id: draftId },
        include: {
          weeks: {
            orderBy: { weekNumber: "asc" },
            include: {
              days: {
                orderBy: { orderIndex: "asc" },
                include: {
                  activities: {
                    orderBy: { orderIndex: "asc" },
                    include: { resources: true },
                  },
                },
              },
            },
          },
        },
      });

      res.status(200).json({ success: true, draft: savedDraft });
    } catch (err: any) {
      console.error("[RefuelSaveDraftError]", err);
      res.status(500).json({ error: "Failed to save draft programme." });
    }
  }
);

export default router;
