import { Router, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { requireRefuelMember, RefuelAuthRequest } from "../../middleware/refuelAuth";
import { prisma } from "../../lib/prisma";
import { getVapidPublicKey, sendPushToMember } from "../../lib/webPush";

const router = Router();

/**
 * GET /refuel/push/public-key
 * Returns the VAPID public key so client browsers can generate push subscriptions.
 */
router.get("/public-key", (_req, res: Response) => {
  res.json({
    publicKey: getVapidPublicKey(),
  });
});

const SubscribeSchema = z.object({
  endpoint: z.string().url("A valid push subscription endpoint URL is required"),
  keys: z.object({
    p256dh: z.string().min(1, "p256dh key is required"),
    auth: z.string().min(1, "auth key is required"),
  }),
  userAgent: z.string().optional(),
});

/**
 * POST /refuel/push/subscribe
 * Register or update a browser's Web Push subscription for the authenticated member.
 */
router.post(
  "/subscribe",
  requireAuth,
  requireRefuelMember,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const member = req.refuelMember!;
    const parseResult = SubscribeSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid push subscription payload",
        details: parseResult.error.format(),
      });
      return;
    }

    const { endpoint, keys, userAgent } = parseResult.data;

    try {
      const subscription = await prisma.refuelPushSubscription.upsert({
        where: { endpoint },
        update: {
          memberId: member.id,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent: userAgent || req.headers["user-agent"] || null,
        },
        create: {
          memberId: member.id,
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent: userAgent || req.headers["user-agent"] || null,
        },
      });

      res.status(200).json({
        success: true,
        message: "Push subscription registered successfully.",
        subscriptionId: subscription.id,
      });
    } catch (err: any) {
      console.error("[PushSubscribeError]", err);
      res.status(500).json({ error: "Failed to register push subscription." });
    }
  }
);

const UnsubscribeSchema = z.object({
  endpoint: z.string().min(1, "endpoint is required"),
});

/**
 * POST /refuel/push/unsubscribe
 * Remove a browser's Web Push subscription.
 */
router.post(
  "/unsubscribe",
  requireAuth,
  requireRefuelMember,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const parseResult = UnsubscribeSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }

    const { endpoint } = parseResult.data;

    try {
      await prisma.refuelPushSubscription.deleteMany({
        where: { endpoint },
      });

      res.json({ success: true, message: "Push subscription removed." });
    } catch (err: any) {
      console.error("[PushUnsubscribeError]", err);
      res.status(500).json({ error: "Failed to remove push subscription." });
    }
  }
);

/**
 * POST /refuel/push/test
 * Sends a test Web Push notification to the authenticated member.
 */
router.post(
  "/test",
  requireAuth,
  requireRefuelMember,
  async (req: RefuelAuthRequest, res: Response): Promise<void> => {
    const member = req.refuelMember!;

    try {
      const result = await sendPushToMember(member.id, {
        title: "Refuel Push Test",
        body: "Web Push notifications are working properly on your device!",
        url: "/learn/refuel/notifications",
      });

      res.json({
        success: true,
        sent: result.sent,
        failed: result.failed,
      });
    } catch (err: any) {
      console.error("[PushTestError]", err);
      res.status(500).json({ error: "Failed to send test push notification." });
    }
  }
);

export default router;
