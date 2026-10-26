import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth";
import { prisma } from "../lib/prisma";
import { RefuelMember } from "@prisma/client";

export interface RefuelAuthRequest extends AuthRequest {
  refuelMember?: RefuelMember;
}

/**
 * Requires the authenticated user to be an active Refuel member.
 * Must be preceded by `requireAuth`.
 */
export async function requireRefuelMember(
  req: RefuelAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const member = await prisma.refuelMember.findUnique({
      where: { userId: req.user.userId },
    });

    if (!member) {
      res.status(403).json({
        error: "Forbidden: You are not a registered Refuel member.",
        code: "NOT_REFUEL_MEMBER",
      });
      return;
    }

    if (member.status !== "ACTIVE") {
      res.status(403).json({
        error: "Forbidden: Your Refuel membership is not active.",
        code: "MEMBERSHIP_NOT_ACTIVE",
      });
      return;
    }

    req.refuelMember = member;
    next();
  } catch (err: any) {
    console.error("[RefuelAuthError]", err);
    res.status(500).json({ error: "Internal server error verifying authorization." });
  }
}

/**
 * Requires the authenticated user to be an active Refuel ADMIN or SUPER_ADMIN.
 * Must be preceded by `requireAuth`.
 */
export async function requireRefuelAdmin(
  req: RefuelAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const member = await prisma.refuelMember.findUnique({
      where: { userId: req.user.userId },
    });

    if (!member) {
      res.status(403).json({
        error: "Forbidden: You are not a registered Refuel member.",
        code: "NOT_REFUEL_MEMBER",
      });
      return;
    }

    if (member.status !== "ACTIVE") {
      res.status(403).json({
        error: "Forbidden: Your Refuel membership is not active.",
        code: "MEMBERSHIP_NOT_ACTIVE",
      });
      return;
    }

    if (member.role !== "ADMIN" && member.role !== "SUPER_ADMIN") {
      res.status(403).json({
        error: "Forbidden: Refuel administrator privileges required.",
        code: "ADMIN_REQUIRED",
      });
      return;
    }

    req.refuelMember = member;
    next();
  } catch (err: any) {
    console.error("[RefuelAuthError]", err);
    res.status(500).json({ error: "Internal server error verifying authorization." });
  }
}

/**
 * Requires the authenticated user to be an active Refuel SUPER_ADMIN.
 * Must be preceded by `requireAuth`.
 */
export async function requireRefuelSuperAdmin(
  req: RefuelAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const member = await prisma.refuelMember.findUnique({
      where: { userId: req.user.userId },
    });

    if (!member || member.status !== "ACTIVE" || member.role !== "SUPER_ADMIN") {
      res.status(403).json({
        error: "Forbidden: Refuel Super Admin privileges required.",
        code: "SUPER_ADMIN_REQUIRED",
      });
      return;
    }

    req.refuelMember = member;
    next();
  } catch (err: any) {
    console.error("[RefuelAuthError]", err);
    res.status(500).json({ error: "Internal server error verifying authorization." });
  }
}

