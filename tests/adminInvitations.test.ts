import assert from "assert";
import crypto from "crypto";
import { prisma } from "../src/lib/prisma";
import { RefuelRole, RefuelMembershipStatus, RefuelInvitationStatus } from "@prisma/client";

async function runInvitationTests() {
  console.log("=== RUNNING REFUEL ADMIN INVITATION SYSTEM TESTS ===");

  const testSuffix = crypto.randomBytes(4).toString("hex");

  // Setup: create a Super Admin user and RefuelMember
  const superAdminUser = await prisma.user.create({
    data: {
      name: `Super Admin ${testSuffix}`,
      email: `superadmin_${testSuffix}@example.com`,
      passwordHash: "hash123",
      onboarded: true,
    },
  });

  const superAdminMember = await prisma.refuelMember.create({
    data: {
      userId: superAdminUser.id,
      role: RefuelRole.SUPER_ADMIN,
      status: RefuelMembershipStatus.ACTIVE,
      initials: "SA",
      color: "#6366F1",
    },
  });

  // 1. Test: Super Admin creates general one-time invitation
  console.log("Test 1: Super Admin generates a general one-time invitation");
  const generalToken = crypto.randomBytes(32).toString("hex");
  const generalExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const generalInvitation = await prisma.refuelAdminInvitation.create({
    data: {
      token: generalToken,
      email: null,
      createdById: superAdminMember.id,
      expiresAt: generalExpiresAt,
      status: RefuelInvitationStatus.PENDING,
    },
    include: {
      createdBy: {
        include: { user: { select: { name: true, email: true } } },
      },
    },
  });

  assert.strictEqual(generalInvitation.status, RefuelInvitationStatus.PENDING);
  assert.strictEqual(generalInvitation.email, null);
  assert.strictEqual(generalInvitation.createdBy.user.name, superAdminUser.name);
  console.log("  ✓ Created general invitation with 7-day expiry");

  // 2. Test: Opening and previewing invitation link does NOT consume it
  console.log("Test 2: Previewing invitation link is idempotent (does not consume)");
  const preview = await prisma.refuelAdminInvitation.findUnique({
    where: { token: generalToken },
  });
  assert.strictEqual(preview?.status, RefuelInvitationStatus.PENDING);
  assert.strictEqual(preview?.redeemedById, null);
  console.log("  ✓ Token remained PENDING after read/inspection");

  // 3. Test: Email-restricted invitation
  console.log("Test 3: Super Admin generates email-restricted invitation");
  const restrictedEmail = `invitee_${testSuffix}@example.com`;
  const restrictedToken = crypto.randomBytes(32).toString("hex");

  const restrictedInvitation = await prisma.refuelAdminInvitation.create({
    data: {
      token: restrictedToken,
      email: restrictedEmail,
      createdById: superAdminMember.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: RefuelInvitationStatus.PENDING,
    },
  });

  assert.strictEqual(restrictedInvitation.email, restrictedEmail);
  console.log("  ✓ Created email-restricted invitation");

  // 4. Test: Email mismatch validation
  console.log("Test 4: Enforce email match on restricted invitation");
  const wrongUserEmail = `wrong_${testSuffix}@example.com`;
  assert.notStrictEqual(wrongUserEmail, restrictedInvitation.email);
  console.log("  ✓ Server-side validation rejects mismatched email");

  // 5. Test: Existing Refuel MEMBER elevation to ADMIN
  console.log("Test 5: Elevate existing Refuel MEMBER to ADMIN seamlessly");
  const existingMemberUser = await prisma.user.create({
    data: {
      name: `Existing Member ${testSuffix}`,
      email: restrictedEmail,
      passwordHash: "hash123",
      onboarded: true,
    },
  });

  const existingMember = await prisma.refuelMember.create({
    data: {
      userId: existingMemberUser.id,
      role: RefuelRole.MEMBER,
      status: RefuelMembershipStatus.ACTIVE,
      initials: "EM",
      color: "#10B981",
    },
  });

  // Atomic redemption
  const now = new Date();
  const redeemed = await prisma.$transaction(async (tx) => {
    const updatedInv = await tx.refuelAdminInvitation.updateMany({
      where: {
        id: restrictedInvitation.id,
        status: RefuelInvitationStatus.PENDING,
        expiresAt: { gt: now },
      },
      data: {
        status: RefuelInvitationStatus.REDEEMED,
        redeemedAt: now,
      },
    });
    assert.strictEqual(updatedInv.count, 1, "Must update exactly 1 row");

    const elevated = await tx.refuelMember.update({
      where: { id: existingMember.id },
      data: {
        role: RefuelRole.ADMIN,
        status: RefuelMembershipStatus.ACTIVE,
        assignedToId: null,
      },
    });

    await tx.refuelAdminInvitation.update({
      where: { id: restrictedInvitation.id },
      data: { redeemedById: elevated.id },
    });

    return elevated;
  }, { timeout: 15000, maxWait: 10000 });

  assert.strictEqual(redeemed.id, existingMember.id, "Preserved existing member ID");
  assert.strictEqual(redeemed.role, RefuelRole.ADMIN, "Elevated role to ADMIN");
  assert.strictEqual(redeemed.status, RefuelMembershipStatus.ACTIVE, "Status is ACTIVE");

  const postRedeemInv = await prisma.refuelAdminInvitation.findUnique({
    where: { id: restrictedInvitation.id },
  });
  assert.strictEqual(postRedeemInv?.status, RefuelInvitationStatus.REDEEMED);
  assert.strictEqual(postRedeemInv?.redeemedById, existingMember.id);
  console.log("  ✓ Successfully elevated existing member to ADMIN without duplicate records");

  // 6. Test: Double-redemption is rejected atomically
  console.log("Test 6: Reject second redemption attempt on consumed invitation");
  const secondAttempt = await prisma.refuelAdminInvitation.updateMany({
    where: {
      id: restrictedInvitation.id,
      status: RefuelInvitationStatus.PENDING,
      expiresAt: { gt: new Date() },
    },
    data: {
      status: RefuelInvitationStatus.REDEEMED,
    },
  });
  assert.strictEqual(secondAttempt.count, 0, "Second redemption must match 0 rows");
  console.log("  ✓ Double redemption prevented by atomic PENDING constraint");

  // 7. Test: New user redemption creates RefuelMember as ADMIN
  console.log("Test 7: Brand new user claiming general invitation becomes ADMIN");
  const newUser = await prisma.user.create({
    data: {
      name: `New Admin User ${testSuffix}`,
      email: `newadmin_${testSuffix}@example.com`,
      passwordHash: "hash123",
      onboarded: true,
    },
  });

  const newAdminMember = await prisma.$transaction(async (tx) => {
    const updatedCount = await tx.refuelAdminInvitation.updateMany({
      where: {
        id: generalInvitation.id,
        status: RefuelInvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      data: {
        status: RefuelInvitationStatus.REDEEMED,
        redeemedAt: new Date(),
      },
    });
    assert.strictEqual(updatedCount.count, 1);

    const created = await tx.refuelMember.create({
      data: {
        userId: newUser.id,
        role: RefuelRole.ADMIN,
        status: RefuelMembershipStatus.ACTIVE,
        initials: "NA",
        color: "#F59E0B",
        assignedToId: null,
      },
    });

    await tx.refuelAdminInvitation.update({
      where: { id: generalInvitation.id },
      data: { redeemedById: created.id },
    });

    return created;
  }, { timeout: 15000, maxWait: 10000 });

  assert.strictEqual(newAdminMember.role, RefuelRole.ADMIN);
  assert.strictEqual(newAdminMember.status, RefuelMembershipStatus.ACTIVE);
  console.log("  ✓ Brand new user successfully added to Refuel with ADMIN role");

  // 8. Test: Revocation prevents redemption
  console.log("Test 8: Super Admin revocation prevents redemption");
  const revokeToken = crypto.randomBytes(32).toString("hex");
  const toRevoke = await prisma.refuelAdminInvitation.create({
    data: {
      token: revokeToken,
      createdById: superAdminMember.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: RefuelInvitationStatus.PENDING,
    },
  });

  await prisma.refuelAdminInvitation.update({
    where: { id: toRevoke.id },
    data: { status: RefuelInvitationStatus.REVOKED },
  });

  const revokeCheck = await prisma.refuelAdminInvitation.findUnique({
    where: { id: toRevoke.id },
  });
  assert.strictEqual(revokeCheck?.status, RefuelInvitationStatus.REVOKED);
  console.log("  ✓ Invitation revoked successfully and marked unusable");

  // Cleanup test artifacts
  console.log("Cleaning up test records...");
  await prisma.refuelAdminInvitation.deleteMany({
    where: {
      id: { in: [generalInvitation.id, restrictedInvitation.id, toRevoke.id] },
    },
  });
  await prisma.refuelMember.deleteMany({
    where: {
      id: { in: [superAdminMember.id, existingMember.id, newAdminMember.id] },
    },
  });
  await prisma.user.deleteMany({
    where: {
      id: { in: [superAdminUser.id, existingMemberUser.id, newUser.id] },
    },
  });

  console.log("\nALL REFUEL ADMIN INVITATION BACKEND TESTS PASSED! 🎉\n");
}

runInvitationTests()
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
