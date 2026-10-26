import webpush from "web-push";
import { prisma } from "./prisma";

// Default keys generated for Refuel VAPID Web Push
const DEFAULT_VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY ||
  "BLS4lcHV9ggGslDCelwHzE35MmHvyp2lLl9x8_RN_Np149y-uLUQ1xXigpsQU33g2x8qtQtjLoB8I3FOn55TTfs";

const DEFAULT_VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY ||
  "qgVYMy_1qiALBUMVoY7aJ98MKPsHqwsx-50ygidosY0";

const DEFAULT_VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || "mailto:support@caveverse.org";

// Configure web-push with VAPID details
webpush.setVapidDetails(
  DEFAULT_VAPID_SUBJECT,
  DEFAULT_VAPID_PUBLIC_KEY,
  DEFAULT_VAPID_PRIVATE_KEY
);

export function getVapidPublicKey(): string {
  return DEFAULT_VAPID_PUBLIC_KEY;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
}

/**
 * Sends a Web Push notification to all active devices registered for a specific Refuel member.
 * Automatically prunes expired (HTTP 404/410) subscriptions.
 */
export async function sendPushToMember(
  memberId: string,
  payload: PushNotificationPayload
): Promise<{ sent: number; failed: number }> {
  try {
    const subscriptions = await prisma.refuelPushSubscription.findMany({
      where: { memberId },
    });

    if (subscriptions.length === 0) {
      return { sent: 0, failed: 0 };
    }

    const jsonPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || "/learn/refuel",
      tag: payload.tag || "refuel-notice",
      icon: payload.icon || "/icons/icon-192.png",
      badge: payload.badge || "/icons/badge-72.png",
    });

    let sent = 0;
    let failed = 0;

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webpush.sendNotification(pushSubscription, jsonPayload);
          sent++;
        } catch (err: any) {
          failed++;
          // 404 Not Found or 410 Gone indicates the browser unsubscribed or registration expired
          if (err.statusCode === 404 || err.statusCode === 410) {
            console.log(`[WebPush] Pruning expired subscription endpoint: ${sub.endpoint}`);
            await prisma.refuelPushSubscription.deleteMany({
              where: { endpoint: sub.endpoint },
            }).catch(() => null);
          } else {
            console.error(`[WebPushError] Failed to send push to ${sub.endpoint}:`, err.message);
          }
        }
      })
    );

    return { sent, failed };
  } catch (err: any) {
    console.error("[WebPushSendMemberError]", err);
    return { sent: 0, failed: 0 };
  }
}

/**
 * Broadcasts a Web Push notification to all active members with registered devices.
 */
export async function sendPushToAllMembers(
  payload: PushNotificationPayload
): Promise<{ sent: number; failed: number }> {
  try {
    const subscriptions = await prisma.refuelPushSubscription.findMany({
      where: {
        member: { status: "ACTIVE" },
      },
    });

    if (subscriptions.length === 0) {
      return { sent: 0, failed: 0 };
    }

    const jsonPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || "/learn/refuel",
      tag: payload.tag || "refuel-announcement",
      icon: payload.icon || "/icons/icon-192.png",
      badge: payload.badge || "/icons/badge-72.png",
    });

    let sent = 0;
    let failed = 0;

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webpush.sendNotification(pushSubscription, jsonPayload);
          sent++;
        } catch (err: any) {
          failed++;
          if (err.statusCode === 404 || err.statusCode === 410) {
            await prisma.refuelPushSubscription.deleteMany({
              where: { endpoint: sub.endpoint },
            }).catch(() => null);
          }
        }
      })
    );

    return { sent, failed };
  } catch (err: any) {
    console.error("[WebPushBroadcastError]", err);
    return { sent: 0, failed: 0 };
  }
}
