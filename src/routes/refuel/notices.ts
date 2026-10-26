import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { requireAuth } from "../../middleware/auth";
import {
  requireRefuelMember,
  requireRefuelAdmin,
  RefuelAuthRequest,
} from "../../middleware/refuelAuth";
import { prisma } from "../../lib/prisma";
import { RefuelNoticeKind } from "@prisma/client";
import { sendPushToMember, sendPushToAllMembers } from "../../lib/webPush";

const router = Router();

/**
 * GET /refuel/notices
 * Fetch announcements and personalized notices targeted at the authenticated member.
 */
router.get(
  "/",
  requireAuth,
  requireRefuelMember,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const member = req.refuelMember!;

    try {
      const notices = await prisma.refuelNotice.findMany({
        where: {
          OR: [
            { targetMemberId: null },
            { targetMemberId: member.id },
          ],
        },
        orderBy: { createdAt: "desc" },
        include: {
          author: {
            select: { id: true, initials: true, color: true },
          },
          reads: {
            where: { memberId: member.id },
            select: { readAt: true },
          },
        },
      });

      const formatted = notices.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        author: n.author,
        targetMemberId: n.targetMemberId,
        metadata: n.metadata,
        isRead: n.reads.length > 0,
        readAt: n.reads[0]?.readAt ?? null,
        createdAt: n.createdAt,
      }));

      res.json({ notices: formatted });
    } catch (err: any) {
      console.error("[GetNoticesError]", err);
      res.status(500).json({ error: "Failed to load notices." });
    }
  }
);

/**
 * POST /refuel/notices/:id/read
 * Mark a notice as read by the authenticated member.
 */
router.post(
  "/:id/read",
  requireAuth,
  requireRefuelMember,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const noticeId = String(req.params.id);
    const member = req.refuelMember!;

    try {
      const notice = await prisma.refuelNotice.findUnique({
        where: { id: noticeId },
      });

      if (!notice) {
        res.status(404).json({ error: "Notice not found." });
        return;
      }

      await prisma.refuelNoticeRead.upsert({
        where: {
          noticeId_memberId: {
            noticeId,
            memberId: member.id,
          },
        },
        update: {
          readAt: new Date(),
        },
        create: {
          noticeId,
          memberId: member.id,
          readAt: new Date(),
        },
      });

      res.json({ success: true, message: "Notice marked as read." });
    } catch (err: any) {
      console.error("[MarkNoticeReadError]", err);
      res.status(500).json({ error: "Failed to mark notice as read." });
    }
  }
);

const CreateNoticeSchema = z.object({
  title: z.string().trim().min(1, "Notice title cannot be empty"),
  body: z.string().trim().min(1, "Notice body cannot be empty"),
  kind: z.nativeEnum(RefuelNoticeKind).default(RefuelNoticeKind.ANNOUNCEMENT),
  targetMemberId: z.string().trim().nullable().optional(),
});

/**
 * POST /refuel/notices/admin
 * Admin publishes an announcement or targeted notice.
 */
router.post(
  "/admin",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const admin = req.refuelMember!;
    const user = req.user!;

    const parseResult = CreateNoticeSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid notice payload", details: parseResult.error.format() });
      return;
    }

    const { title, body, kind, targetMemberId } = parseResult.data;

    try {
      const created = await prisma.$transaction(async (tx) => {
        const notice = await tx.refuelNotice.create({
          data: {
            kind,
            title,
            body,
            authorId: admin.id,
            targetMemberId: targetMemberId || null,
          },
        });

        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: admin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: admin.role,
            action: "ANNOUNCEMENT_POSTED",
            entityType: "NOTICE",
            entityId: notice.id,
            targetMemberId: targetMemberId || null,
            afterState: {
              noticeId: notice.id,
              kind,
              title,
            },
          },
        });

        return notice;
      });

      // Fire Web Push asynchronously in background
      if (!targetMemberId) {
        sendPushToAllMembers({
          title,
          body,
          url: "/learn/refuel/notifications",
        }).catch((err) => console.error("[WebPushNoticeError]", err));
      } else {
        sendPushToMember(targetMemberId, {
          title,
          body,
          url: "/learn/refuel/notifications",
        }).catch((err) => console.error("[WebPushNoticeError]", err));
      }

      res.status(201).json({ success: true, notice: created });
    } catch (err: any) {
      console.error("[CreateNoticeError]", err);
      res.status(500).json({ error: "Failed to publish notice." });
    }
  }
);

const NudgeSchema = z.object({
  targetMemberId: z.string().trim().min(1, "targetMemberId is required"),
  message: z.string().trim().optional(),
});

/**
 * POST /refuel/notices/admin/nudge
 * Admin sends a clock-in nudge to a specific member.
 */
router.post(
  "/admin/nudge",
  requireAuth,
  requireRefuelAdmin,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const admin = req.refuelMember!;
    const user = req.user!;
    const isSuperAdmin = admin.role === "SUPER_ADMIN";

    const parseResult = NudgeSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid nudge payload", details: parseResult.error.format() });
      return;
    }

    const { targetMemberId, message } = parseResult.data;

    try {
      const target = await prisma.refuelMember.findUnique({
        where: { id: targetMemberId },
      });

      if (!target) {
        res.status(404).json({ error: "Target member not found." });
        return;
      }

      if (!isSuperAdmin && target.assignedToId !== admin.id) {
        res.status(403).json({
          error: "Forbidden: You may only nudge members assigned to you.",
        });
        return;
      }

      const bodyText = message || "Please remember to clock in and complete your daily checklist.";

      const created = await prisma.$transaction(async (tx) => {
        const notice = await tx.refuelNotice.create({
          data: {
            kind: RefuelNoticeKind.NUDGE,
            title: "Checklist Reminder",
            body: bodyText,
            authorId: admin.id,
            targetMemberId: target.id,
          },
        });

        await tx.refuelAuditEvent.create({
          data: {
            correlationId: crypto.randomUUID(),
            actorMemberId: admin.id,
            actorUserId: user.userId,
            actorEmail: user.email,
            actorRole: admin.role,
            action: "NUDGE_SENT",
            entityType: "NOTICE",
            entityId: notice.id,
            targetMemberId: target.id,
            afterState: {
              noticeId: notice.id,
              targetMemberId: target.id,
            },
          },
        });

        return notice;
      });

      // Fire Web Push to targeted member asynchronously in background
      sendPushToMember(target.id, {
        title: "Checklist Reminder",
        body: bodyText,
        url: "/learn/refuel/checklist",
      }).catch((err) => console.error("[WebPushNudgeError]", err));

      res.status(200).json({ success: true, nudge: created });
    } catch (err: any) {
      console.error("[SendNudgeError]", err);
      res.status(500).json({ error: "Failed to send nudge." });
    }
  }
);

export default router;
