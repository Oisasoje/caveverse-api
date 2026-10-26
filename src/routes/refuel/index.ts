import { Router } from "express";
import publishRoute from "./admin/publish";
import reviewsRoute from "./admin/reviews";
import graceRoute from "./admin/grace";
import adminMembersRoute from "./admin/members";
import checklistRoute from "./checklist";
import submissionsRoute from "./submissions";
import membersRoute from "./members";
import noticesRoute from "./notices";
import pushRoute from "./push";
import { prisma } from "../../lib/prisma";

const router = Router();

// Member and Public Refuel Endpoints
router.use("/checklist", checklistRoute);
router.use("/submissions", submissionsRoute);
router.use("/members", membersRoute);
router.use("/notices", noticesRoute);
router.use("/push", pushRoute);

// Admin Refuel Endpoints
router.use("/admin", publishRoute);
router.use("/admin/reviews", reviewsRoute);
router.use("/admin/grace", graceRoute);
router.use("/admin/members", adminMembersRoute);

// GET /refuel/programme/active - Read active published programme
router.get("/programme/active", async (_req, res) => {
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
        versionLock: programme?.versionLock ?? 1,
      });
      return;
    }

    res.json({
      programmeId: programme.id,
      versionLock: programme.versionLock,
      activeVersion: programme.activeVersion,
    });
  } catch (err: any) {
    console.error("[GetActiveProgrammeError]", err);
    res.status(500).json({ error: "Failed to load active programme." });
  }
});

// GET /refuel/programme/draft - Read draft programme workspace
router.get("/programme/draft", async (_req, res) => {
  try {
    const programme = await prisma.refuelProgramme.findUnique({
      where: { id: "refuel-root" },
      include: {
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

    res.json({
      programmeId: programme?.id ?? "refuel-root",
      versionLock: programme?.versionLock ?? 1,
      draft: programme?.draft ?? null,
    });
  } catch (err: any) {
    console.error("[GetDraftProgrammeError]", err);
    res.status(500).json({ error: "Failed to load draft programme." });
  }
});

export default router;

