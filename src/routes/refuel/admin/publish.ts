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
  url: z.string().trim().default(""),
});

const ActivityDraftSchema = z.object({
  title: z.string().trim().min(1, "Activity title cannot be empty"),
  detail: z.string().trim().nullable().optional(),
  activityType: z.nativeEnum(RefuelActivityType).default(RefuelActivityType.OTHER),
  completionMethod: z.nativeEnum(RefuelCompletionMethod).default(RefuelCompletionMethod.TICK),
  required: z.boolean().default(true),
  orderIndex: z.number().int().default(0),
  resources: z.array(ResourceDraftSchema).default([]),
});

const DayDraftSchema = z.object({
  dayKey: z.string().trim().min(1, "Day key cannot be empty"),
  name: z.string().trim().min(1, "Day name cannot be empty"),
  weekday: z.nativeEnum(RefuelWeekday),
  orderIndex: z.number().int().default(0),
  activities: z.array(ActivityDraftSchema).default([]),
});

const WeekDraftSchema = z.object({
  weekNumber: z.number().int().min(1, "Week number must be >= 1"),
  title: z.string().trim().min(1, "Week title cannot be empty"),
  days: z.array(DayDraftSchema).min(1, "Week must have at least 1 day").max(7, "Week cannot have more than 7 days"),
});

const PublishRequestSchema = z.object({
  expectedVersionLock: z.number().int().min(1, "expectedVersionLock is required"),
  programmeStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "programmeStartDate must be YYYY-MM-DD"),
  weekStartDay: z.nativeEnum(RefuelWeekday).default(RefuelWeekday.MONDAY),
  cutoffBufferMinutes: z.number().int().min(0).default(0),
  draft: z.object({
    weeks: z.array(WeekDraftSchema).min(1, "Draft must have at least 1 week"),
  }).optional(),
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
      const result = await prisma.$transaction(async (tx) => {
        // Fetch or create root programme
        const programme = await tx.refuelProgramme.upsert({
          where: { id: "refuel-root" },
          update: {},
          create: {
            id: "refuel-root",
            versionLock: 1,
          },
          include: {
            activeVersion: true,
            draft: {
              include: {
                weeks: {
                  include: {
                    days: {
                      include: {
                        activities: {
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

        // 2. Optimistic Concurrency Check:
        // A second admin publishing concurrently gets a 409 conflict and must reload.
        if (programme.versionLock !== expectedVersionLock) {
          const err: any = new Error("Programme was modified by another administrator. Please reload and try again.");
          err.statusCode = 409;
          err.currentVersionLock = programme.versionLock;
          throw err;
        }

        // 3. Resolve the weeks to publish:
        let weeksToPublish: WeekInput[];

        if (bodyDraft && bodyDraft.weeks.length > 0) {
          weeksToPublish = bodyDraft.weeks;
        } else if (programme.draft && programme.draft.weeks.length > 0) {
          weeksToPublish = programme.draft.weeks;
        } else {
          const err: any = new Error("No draft programme found to publish.");
          err.statusCode = 400;
          throw err;
        }

        // Validate resource URLs (blank URL is a note, but if provided must be http/https)
        for (const week of weeksToPublish) {
          for (const day of week.days) {
            for (const activity of day.activities) {
              if (activity.resources) {
                for (const resource of activity.resources) {
                  const url = (resource.url ?? "").trim();
                  if (url && !/^https?:\/\//i.test(url)) {
                    const err: any = new Error(`Resource "${resource.title}" must have a valid http:// or https:// URL.`);
                    err.statusCode = 400;
                    throw err;
                  }
                }
              }
            }
          }
        }

        // 4. Update the draft workspace if a new draft payload was provided
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

          // Delete existing draft weeks for clean replacement
          await tx.refuelDraftWeek.deleteMany({
            where: { draftId: draftRecord.id },
          });

          // Insert new draft weeks, days, activities, resources
          for (const w of weeksToPublish) {
            const createdWeek = await tx.refuelDraftWeek.create({
              data: {
                draftId: draftRecord.id,
                weekNumber: w.weekNumber,
                title: w.title,
              },
            });

            for (const d of w.days) {
              const createdDay = await tx.refuelDraftDay.create({
                data: {
                  weekId: createdWeek.id,
                  dayKey: d.dayKey,
                  name: d.name,
                  weekday: d.weekday,
                  orderIndex: d.orderIndex ?? 0,
                },
              });

              for (const a of d.activities) {
                const createdAct = await tx.refuelDraftActivity.create({
                  data: {
                    dayId: createdDay.id,
                    title: a.title,
                    detail: a.detail ?? null,
                    activityType: a.activityType ?? RefuelActivityType.OTHER,
                    completionMethod: a.completionMethod ?? RefuelCompletionMethod.TICK,
                    required: a.required ?? true,
                    orderIndex: a.orderIndex ?? 0,
                  },
                });

                if (a.resources && a.resources.length > 0) {
                  await tx.refuelDraftResource.createMany({
                    data: a.resources.map((r) => ({
                      activityId: createdAct.id,
                      title: r.title,
                      url: r.url ?? "",
                    })),
                  });
                }
              }
            }
          }
        }

        // 5. Compute next version number
        const nextVersionNumber = (programme.activeVersion?.versionNumber ?? 0) + 1;

        // 6. Create the frozen, immutable published version snapshot
        const publishedVersion = await tx.refuelPublishedVersion.create({
          data: {
            programmeId: programme.id,
            versionNumber: nextVersionNumber,
            programmeStartDate,
            weekStartDay,
            cutoffBufferMinutes,
            timezone: "Africa/Lagos",
            publishedById: member.id,
            weeks: {
              create: weeksToPublish.map((week) => ({
                weekNumber: week.weekNumber,
                title: week.title,
                days: {
                  create: week.days.map((day) => ({
                    dayKey: day.dayKey,
                    name: day.name,
                    weekday: day.weekday,
                    calendarDate: calculateDayCalendarDate(programmeStartDate, week.weekNumber, day.weekday),
                    orderIndex: day.orderIndex ?? 0,
                    activities: {
                      create: day.activities.map((act) => ({
                        title: act.title,
                        detail: act.detail ?? null,
                        activityType: act.activityType ?? RefuelActivityType.OTHER,
                        completionMethod: act.completionMethod ?? RefuelCompletionMethod.TICK,
                        required: act.required ?? true,
                        orderIndex: act.orderIndex ?? 0,
                        resources: {
                          create: (act.resources ?? []).map((res) => ({
                            title: res.title,
                            url: res.url ?? "",
                          })),
                        },
                      })),
                    },
                  })),
                },
              })),
            },
          },
          include: {
            weeks: {
              include: {
                days: {
                  include: {
                    activities: {
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

        // 7. Update root programme: activate published version and increment versionLock
        const updatedProgramme = await tx.refuelProgramme.update({
          where: { id: programme.id },
          data: {
            activeVersionId: publishedVersion.id,
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
            entityId: publishedVersion.id,
            programmeVersionId: publishedVersion.id,
            beforeState: {
              activeVersionId: programme.activeVersionId,
              versionLock: programme.versionLock,
            },
            afterState: {
              activeVersionId: publishedVersion.id,
              versionLock: updatedProgramme.versionLock,
              versionNumber: nextVersionNumber,
              programmeStartDate,
            },
          },
        });

        return {
          publishedVersion,
          versionLock: updatedProgramme.versionLock,
        };
      });

      res.status(200).json({
        success: true,
        version: result.publishedVersion,
        versionLock: result.versionLock,
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
  programmeStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
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
      const savedDraft = await prisma.$transaction(async (tx) => {
        // Upsert root programme
        const programme = await tx.refuelProgramme.upsert({
          where: { id: "refuel-root" },
          update: {},
          create: { id: "refuel-root", versionLock: 1 },
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

        const beforeWeekCount = programme.draft?.weeks.length ?? 0;
        const beforeActivityCount =
          programme.draft?.weeks.reduce(
            (acc, w) => acc + w.days.reduce((dAcc, d) => dAcc + d.activities.length, 0),
            0
          ) ?? 0;

        const draftRecord = await tx.refuelDraftProgramme.upsert({
          where: { programmeId: programme.id },
          update: {
            programmeStartDate: programmeStartDate ?? undefined,
            weekStartDay,
            updatedById: member.id,
          },
          create: {
            programmeId: programme.id,
            programmeStartDate: programmeStartDate ?? null,
            weekStartDay,
            updatedById: member.id,
          },
        });

        // Clean replacement of draft weeks
        await tx.refuelDraftWeek.deleteMany({
          where: { draftId: draftRecord.id },
        });

        let afterActivityCount = 0;

        for (const w of weeks) {
          const createdWeek = await tx.refuelDraftWeek.create({
            data: {
              draftId: draftRecord.id,
              weekNumber: w.weekNumber,
              title: w.title,
            },
          });

          for (const d of w.days) {
            const createdDay = await tx.refuelDraftDay.create({
              data: {
                weekId: createdWeek.id,
                dayKey: d.dayKey,
                name: d.name,
                weekday: d.weekday,
                orderIndex: d.orderIndex ?? 0,
              },
            });

            for (const a of d.activities) {
              afterActivityCount++;
              const createdAct = await tx.refuelDraftActivity.create({
                data: {
                  dayId: createdDay.id,
                  title: a.title,
                  detail: a.detail ?? null,
                  activityType: a.activityType ?? RefuelActivityType.OTHER,
                  completionMethod: a.completionMethod ?? RefuelCompletionMethod.TICK,
                  required: a.required ?? true,
                  orderIndex: a.orderIndex ?? 0,
                },
              });

              if (a.resources && a.resources.length > 0) {
                await tx.refuelDraftResource.createMany({
                  data: a.resources.map((r) => ({
                    activityId: createdAct.id,
                    title: r.title,
                    url: r.url ?? "",
                  })),
                });
              }
            }
          }
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
              activityCount: afterActivityCount,
              programmeStartDate,
            },
          },
        });

        return tx.refuelDraftProgramme.findUnique({
          where: { id: draftRecord.id },
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
      });

      res.status(200).json({ success: true, draft: savedDraft });
    } catch (err: any) {
      console.error("[RefuelSaveDraftError]", err);
      res.status(500).json({ error: "Failed to save draft programme." });
    }
  }
);

export default router;
