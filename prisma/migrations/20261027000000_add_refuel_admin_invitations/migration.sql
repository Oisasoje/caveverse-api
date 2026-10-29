-- AlterEnum
ALTER TYPE "RefuelAuditAction" ADD VALUE 'ADMIN_INVITATION_CREATED';
ALTER TYPE "RefuelAuditAction" ADD VALUE 'ADMIN_INVITATION_REVOKED';
ALTER TYPE "RefuelAuditAction" ADD VALUE 'ADMIN_INVITATION_REDEEMED';

-- CreateEnum
CREATE TYPE "RefuelInvitationStatus" AS ENUM ('PENDING', 'REDEEMED', 'REVOKED');

-- CreateTable
CREATE TABLE "RefuelAdminInvitation" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT,
    "status" "RefuelInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "redeemedById" TEXT,
    "redeemedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefuelAdminInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefuelAdminInvitation_token_key" ON "RefuelAdminInvitation"("token");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelAdminInvitation_redeemedById_key" ON "RefuelAdminInvitation"("redeemedById");

-- CreateIndex
CREATE INDEX "RefuelAdminInvitation_token_idx" ON "RefuelAdminInvitation"("token");

-- CreateIndex
CREATE INDEX "RefuelAdminInvitation_status_idx" ON "RefuelAdminInvitation"("status");

-- CreateIndex
CREATE INDEX "RefuelAdminInvitation_createdById_idx" ON "RefuelAdminInvitation"("createdById");

-- AddForeignKey
ALTER TABLE "RefuelAdminInvitation" ADD CONSTRAINT "RefuelAdminInvitation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "RefuelMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelAdminInvitation" ADD CONSTRAINT "RefuelAdminInvitation_redeemedById_fkey" FOREIGN KEY ("redeemedById") REFERENCES "RefuelMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
