import "dotenv/config";
import crypto from "crypto";
import { prisma } from "../src/lib/prisma";
import { RefuelRole, RefuelMembershipStatus } from "@prisma/client";
import {
  getInitials,
  getDeterministicAvatarColor,
  AVATAR_PALETTE,
} from "../src/lib/refuelAvatar";

export { getInitials, getDeterministicAvatarColor, AVATAR_PALETTE };

export interface CreateRefuelMemberInput {
  /**
   * The Caveverse user ID. Must exist in the Caveverse User table.
   * Provide either userId or email.
   */
  userId?: string;

  /**
   * The Caveverse user email. Must exist in the Caveverse User table.
   * Provide either userId or email.
   */
  email?: string;

  /**
   * Refuel role for the new member. Defaults to MEMBER.
   * Options: MEMBER, ADMIN, SUPER_ADMIN
   */
  role?: RefuelRole;

  /**
   * Refuel membership status. Defaults to ACTIVE when created via script.
   * Options: ACTIVE, REQUESTED, REMOVED
   */
  status?: RefuelMembershipStatus;

  /**
   * Up to 4 initials (e.g., "JD").
   * If omitted, will be derived automatically from the Caveverse user's name or email.
   */
  initials?: string;

  /**
   * Valid 6-character hex color code (e.g., "#6366F1").
   * If omitted, a vibrant color is deterministically calculated from the user's email/initials.
   */
  color?: string;

  /**
   * ID of an existing Refuel Admin member to assign this member to.
   */
  assignedToId?: string;

  /**
   * Email of an existing Refuel Admin to assign this member to.
   */
  assignedToEmail?: string;

  /**
   * Whether to automatically assign to the admin with the fewest active members
   * if no specific admin is provided and the member role is MEMBER.
   * Defaults to true.
   */
  autoAssign?: boolean;
}

/**
 * Finds the active Refuel Admin (strictly RefuelRole.ADMIN, excluding SUPER_ADMIN)
 * with the fewest assigned members.
 * Returns null if no active ADMIN exists in the database yet.
 */
export async function getLeastLoadedAdmin(): Promise<{
  id: string;
  user: { name: string; email: string };
  assignedCount: number;
} | null> {
  const admins = await prisma.refuelMember.findMany({
    where: {
      role: RefuelRole.ADMIN, // Only regular ADMINs are assigned members, not SUPER_ADMIN
      status: RefuelMembershipStatus.ACTIVE,
    },
    select: {
      id: true,
      user: { select: { name: true, email: true } },
      _count: {
        select: {
          assignedMembers: true,
        },
      },
    },
    orderBy: [
      {
        assignedMembers: {
          _count: "asc",
        },
      },
      {
        joinedAt: "asc", // Tiebreaker 1: Admin who has been an admin the longest
      },
      {
        id: "asc", // Tiebreaker 2: Deterministic database ID tiebreaker
      },
    ],
    take: 1,
  });

  if (admins.length === 0) return null;

  return {
    id: admins[0].id,
    user: admins[0].user,
    assignedCount: admins[0]._count.assignedMembers,
  };
}

/**
 * Creates a new Refuel member for an existing Caveverse user.
 *
 * NOTE: The user MUST already have an account in the Caveverse `User` table.
 *
 * @param input Parameters to configure and create the Refuel member.
 * @returns The newly created RefuelMember record including user information.
 */
export async function createRefuelMember(input: CreateRefuelMemberInput) {
  const {
    userId,
    email,
    role = RefuelRole.MEMBER,
    status = RefuelMembershipStatus.ACTIVE,
    initials: customInitials,
    color: customColor,
    assignedToId: customAssignedToId,
    assignedToEmail,
  } = input;

  if (!userId && !email) {
    throw new Error(
      "Either 'userId' or 'email' must be provided to create a Refuel member."
    );
  }

  // 1. Verify that the user already exists on Caveverse
  const user = await prisma.user.findUnique({
    where: userId ? { id: userId } : { email },
    select: { id: true, name: true, email: true },
  });

  if (!user) {
    throw new Error(
      `Caveverse user not found (${userId ? `id: "${userId}"` : `email: "${email}"`}). ` +
        `The user MUST already exist in Caveverse before they can be added to Refuel.`
    );
  }

  // 2. Check if a Refuel member record already exists for this Caveverse user
  const existingMember = await prisma.refuelMember.findUnique({
    where: { userId: user.id },
  });

  if (existingMember) {
    throw new Error(
      `User ${user.email} (id: ${user.id}) is already a Refuel member with status '${existingMember.status}' and role '${existingMember.role}'.`
    );
  }

  // 3. Resolve assigned admin:
  // - If specific admin ID or email is provided, validate that their role is ADMIN (not SUPER_ADMIN).
  // - Otherwise, if role === 'MEMBER' and autoAssign !== false, auto-assign to the least-loaded ADMIN.
  // - If no ADMINs exist in Caveverse/Refuel yet, resolvedAssignedToId safely stays null (no failure!).
  let resolvedAssignedToId: string | null = null;
  if (customAssignedToId) {
    const admin = await prisma.refuelMember.findUnique({
      where: { id: customAssignedToId },
    });
    if (!admin) {
      throw new Error(`Assigned admin member with id "${customAssignedToId}" was not found.`);
    }
    if (admin.role !== RefuelRole.ADMIN) {
      throw new Error(
        `Cannot assign member to a ${admin.role}. Members can only be assigned to an ADMIN.`
      );
    }
    resolvedAssignedToId = admin.id;
  } else if (assignedToEmail) {
    const adminUser = await prisma.user.findUnique({
      where: { email: assignedToEmail },
      include: { refuelMember: true },
    });
    if (!adminUser || !adminUser.refuelMember) {
      throw new Error(
        `Assigned admin with email "${assignedToEmail}" does not have an active Refuel member record.`
      );
    }
    if (adminUser.refuelMember.role !== RefuelRole.ADMIN) {
      throw new Error(
        `Cannot assign member to ${assignedToEmail} because their role is ${adminUser.refuelMember.role}. Members can only be assigned to an ADMIN.`
      );
    }
    resolvedAssignedToId = adminUser.refuelMember.id;
  } else if (role === RefuelRole.MEMBER && input.autoAssign !== false) {
    const leastLoaded = await getLeastLoadedAdmin();
    if (leastLoaded) {
      resolvedAssignedToId = leastLoaded.id;
    }
    // If leastLoaded is null (no admin exists yet), resolvedAssignedToId remains null without error
  }

  // 4. Validate or compute initials & color
  const initials = customInitials?.trim()
    ? customInitials.trim().slice(0, 4).toUpperCase()
    : getInitials(user.name, user.email);

  const hexColorRegex = /^#[0-9a-fA-F]{6}$/;
  const validatedColor =
    customColor && hexColorRegex.test(customColor)
      ? customColor
      : getDeterministicAvatarColor(user.email || user.name || initials);

  // 5. Create RefuelMember and record an audit event in a transaction
  const result = await prisma.$transaction(async (tx) => {
    const member = await tx.refuelMember.create({
      data: {
        userId: user.id,
        role,
        status,
        initials,
        color: validatedColor,
        assignedToId: resolvedAssignedToId,
      },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
        assignedTo: {
          select: { id: true, initials: true, color: true },
        },
      },
    });

    await tx.refuelAuditEvent.create({
      data: {
        correlationId: crypto.randomUUID(),
        actorUserId: user.id,
        actorEmail: user.email,
        actorRole: role,
        action:
          status === RefuelMembershipStatus.ACTIVE
            ? "MEMBERSHIP_APPROVED"
            : "MEMBERSHIP_REQUESTED",
        entityType: "MEMBER",
        entityId: member.id,
        targetMemberId: member.id,
        afterState: {
          userId: user.id,
          email: user.email,
          role,
          status,
          initials,
          color: validatedColor,
          assignedToId: resolvedAssignedToId,
        },
      },
    });

    return member;
  });

  return result;
}

// -------------------------------------------------------------
// CLI Execution Handler
// Example usage:
//   npx tsx scripts/createRefuelMember.ts --email user@example.com --role MEMBER --status ACTIVE
//   npx tsx scripts/createRefuelMember.ts --userId <cuid>
// -------------------------------------------------------------
async function runCli() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  npx tsx scripts/createRefuelMember.ts [options]

Options:
  --email <email>            Email of existing Caveverse user
  --userId <id>              User ID of existing Caveverse user
  --role <role>              Refuel role: MEMBER (default), ADMIN, SUPER_ADMIN
  --status <status>          Refuel status: ACTIVE (default), REQUESTED, REMOVED
  --initials <initials>      Custom initials (1-4 letters, e.g. "JD")
  --color <hex>              Custom hex color (e.g. "#6366F1", auto-generated if omitted)
  --assignedToId <id>        Refuel member ID of the supervising admin
  --assignedToEmail <email>  Caveverse email of the supervising admin
  --noAutoAssign             Disable auto-assignment to least-loaded admin

Examples:
  npx tsx scripts/createRefuelMember.ts --email "john@example.com"
  npx tsx scripts/createRefuelMember.ts --email "admin@example.com" --role ADMIN --status ACTIVE
`);
    return;
  }

  const parsedArgs: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      parsedArgs[key] = val;
    }
  }

  try {
    const autoAssign = parsedArgs.noAutoAssign === "true" || parsedArgs.autoAssign === "false" ? false : true;

    const member = await createRefuelMember({
      userId: parsedArgs.userId,
      email: parsedArgs.email,
      role: parsedArgs.role as RefuelRole | undefined,
      status: parsedArgs.status as RefuelMembershipStatus | undefined,
      initials: parsedArgs.initials,
      color: parsedArgs.color,
      assignedToId: parsedArgs.assignedToId,
      assignedToEmail: parsedArgs.assignedToEmail,
      autoAssign,
    });

    console.log("Successfully created Refuel member:");
    console.dir(member, { depth: null });
  } catch (error: any) {
    console.error("Error creating Refuel member:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  runCli();
}
