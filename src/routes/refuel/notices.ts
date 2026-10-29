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

let reactionTableReady: Promise<void> | null = null;

function ensureNoticeReactionTable(): Promise<void> {
  if (!reactionTableReady) {
    reactionTableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "RefuelNoticeReaction" (
          "id" TEXT NOT NULL,
          "noticeId" TEXT NOT NULL,
          "memberId" TEXT NOT NULL,
          "emoji" TEXT NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "RefuelNoticeReaction_pkey" PRIMARY KEY ("id")
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "RefuelNoticeReaction_noticeId_idx"
        ON "RefuelNoticeReaction"("noticeId");
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "RefuelNoticeReaction_noticeId_memberId_emoji_key"
        ON "RefuelNoticeReaction"("noticeId", "memberId", "emoji");
      `);
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'RefuelNoticeReaction_noticeId_fkey'
          ) THEN
            ALTER TABLE "RefuelNoticeReaction"
              ADD CONSTRAINT "RefuelNoticeReaction_noticeId_fkey"
              FOREIGN KEY ("noticeId") REFERENCES "RefuelNotice"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'RefuelNoticeReaction_memberId_fkey'
          ) THEN
            ALTER TABLE "RefuelNoticeReaction"
              ADD CONSTRAINT "RefuelNoticeReaction_memberId_fkey"
              FOREIGN KEY ("memberId") REFERENCES "RefuelMember"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
        END $$;
      `);
    })().catch((err) => {
      reactionTableReady = null;
      console.error("[EnsureNoticeReactionTableError]", err);
    });
  }
  return reactionTableReady;
}

// Run migration check immediately when backend route module loads
ensureNoticeReactionTable();

type RawReactionRow = {
  id: string;
  noticeId: string;
  memberId: string;
  emoji: string;
  createdAt: Date;
};

function summarizeReactions(rows: RawReactionRow[], currentMemberId: string) {
  const byEmoji = new Map<
    string,
    { emoji: string; count: number; reacted: boolean; memberIds: string[] }
  >();
  for (const r of rows) {
    const existing = byEmoji.get(r.emoji) || {
      emoji: r.emoji,
      count: 0,
      reacted: false,
      memberIds: [],
    };
    existing.count += 1;
    existing.memberIds.push(r.memberId);
    if (r.memberId === currentMemberId) {
      existing.reacted = true;
    }
    byEmoji.set(r.emoji, existing);
  }
  return Array.from(byEmoji.values());
}

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
      await ensureNoticeReactionTable();

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
            select: {
              id: true,
              initials: true,
              color: true,
              user: { select: { name: true } },
            },
          },
          reads: {
            where: { memberId: member.id },
            select: { readAt: true },
          },
        },
      });

      const noticeIds = notices.map((n) => n.id);
      const reactionRows: RawReactionRow[] =
        noticeIds.length > 0
          ? await prisma.$queryRaw<RawReactionRow[]>`
              SELECT "id", "noticeId", "memberId", "emoji", "createdAt"
              FROM "RefuelNoticeReaction"
              WHERE "noticeId" = ANY(${noticeIds}::text[])
              ORDER BY "createdAt" ASC
            `
          : [];

      const reactionsByNotice = new Map<string, RawReactionRow[]>();
      for (const row of reactionRows) {
        const list = reactionsByNotice.get(row.noticeId) || [];
        list.push(row);
        reactionsByNotice.set(row.noticeId, list);
      }

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
        reactions:
          n.kind === RefuelNoticeKind.ANNOUNCEMENT
            ? summarizeReactions(
                reactionsByNotice.get(n.id) || [],
                member.id,
              )
            : [],
        createdAt: n.createdAt,
      }));

      res.json({ notices: formatted });
    } catch (err: any) {
      console.error("[GetNoticesError]", err);
      res.status(500).json({ error: "Failed to load notices." });
    }
  }
);

const ToggleReactionSchema = z.object({
  emoji: z.string().trim().min(1, "Emoji is required").max(16),
});

/**
 * POST /refuel/notices/:id/reactions
 * Toggle an emoji reaction on a notice for the authenticated member.
 */
router.post(
  "/:id/reactions",
  requireAuth,
  requireRefuelMember,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const noticeId = String(req.params.id);
    const member = req.refuelMember!;

    const parsed = ToggleReactionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid reaction payload",
        details: parsed.error.format(),
      });
      return;
    }

    const { emoji } = parsed.data;

    try {
      await ensureNoticeReactionTable();

      const notice = await prisma.refuelNotice.findUnique({
        where: { id: noticeId },
      });

      if (
        !notice ||
        (notice.targetMemberId && notice.targetMemberId !== member.id)
      ) {
        res.status(404).json({ error: "Notice not found." });
        return;
      }

      if (notice.kind !== RefuelNoticeKind.ANNOUNCEMENT) {
        res
          .status(400)
          .json({ error: "Reactions are only supported on announcements." });
        return;
      }

      const existing = await prisma.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "RefuelNoticeReaction"
        WHERE "noticeId" = ${noticeId}
          AND "memberId" = ${member.id}
          AND "emoji" = ${emoji}
        LIMIT 1
      `;

      let reacted: boolean;
      if (existing.length > 0) {
        await prisma.$executeRaw`
          DELETE FROM "RefuelNoticeReaction"
          WHERE "id" = ${existing[0].id}
        `;
        reacted = false;
      } else {
        const newId = crypto.randomUUID();
        await prisma.$executeRaw`
          INSERT INTO "RefuelNoticeReaction" ("id", "noticeId", "memberId", "emoji", "createdAt")
          VALUES (${newId}, ${noticeId}, ${member.id}, ${emoji}, NOW())
          ON CONFLICT ("noticeId", "memberId", "emoji") DO NOTHING
        `;
        reacted = true;
      }

      const updatedRows = await prisma.$queryRaw<RawReactionRow[]>`
        SELECT "id", "noticeId", "memberId", "emoji", "createdAt"
        FROM "RefuelNoticeReaction"
        WHERE "noticeId" = ${noticeId}
        ORDER BY "createdAt" ASC
      `;

      res.json({
        success: true,
        noticeId,
        emoji,
        reacted,
        reactions: summarizeReactions(updatedRows, member.id),
      });
    } catch (err: any) {
      console.error("[ToggleNoticeReactionError]", err);
      res.status(500).json({ error: "Failed to toggle notice reaction." });
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
