-- CreateEnum
CREATE TYPE "RefuelRole" AS ENUM ('MEMBER', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "RefuelMembershipStatus" AS ENUM ('REQUESTED', 'ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "RefuelWeekday" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "RefuelActivityType" AS ENUM ('PRAYER', 'BIBLE', 'LISTENING', 'READING', 'REFLECTION', 'DISCUSSION', 'ASSIGNMENT', 'ATTENDANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "RefuelCompletionMethod" AS ENUM ('TICK', 'TEXT', 'LINK');

-- CreateEnum
CREATE TYPE "RefuelSubmissionStatus" AS ENUM ('DRAFT', 'PENDING', 'VALID', 'INVALID');

-- CreateEnum
CREATE TYPE "RefuelDecisionType" AS ENUM ('APPROVE', 'REJECT', 'REOPEN');

-- CreateEnum
CREATE TYPE "RefuelNoticeKind" AS ENUM ('ANNOUNCEMENT', 'REVIEW_FEEDBACK', 'NUDGE');

-- CreateEnum
CREATE TYPE "RefuelAuditAction" AS ENUM ('MEMBERSHIP_REQUESTED', 'MEMBERSHIP_APPROVED', 'MEMBERSHIP_REJECTED', 'MEMBER_REMOVED', 'MEMBER_REASSIGNED', 'MEMBER_PROMOTED', 'MEMBER_DEMOTED', 'PROGRAMME_DRAFT_SAVED', 'PROGRAMME_PUBLISHED', 'PROGRAMME_START_DATE_CHANGED', 'SUBMISSION_CREATED', 'SUBMISSION_UPDATED', 'SUBMISSION_RESUBMITTED', 'CLOCK_IN_APPROVED', 'CLOCK_IN_REJECTED', 'CLOCK_IN_REOPENED', 'GRACE_GRANTED', 'NUDGE_SENT', 'ANNOUNCEMENT_POSTED');

-- CreateTable
CREATE TABLE "Build" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'laptop',
    "color" TEXT NOT NULL DEFAULT 'paper',
    "stage" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildStep" (
    "id" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "answer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuildStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelProgramme" (
    "id" TEXT NOT NULL DEFAULT 'refuel-root',
    "activeVersionId" TEXT,
    "versionLock" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefuelProgramme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelDraftProgramme" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "programmeStartDate" TEXT,
    "weekStartDay" "RefuelWeekday" NOT NULL DEFAULT 'MONDAY',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefuelDraftProgramme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelDraftWeek" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "RefuelDraftWeek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelDraftDay" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weekday" "RefuelWeekday" NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RefuelDraftDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelDraftActivity" (
    "id" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "activityType" "RefuelActivityType" NOT NULL DEFAULT 'OTHER',
    "completionMethod" "RefuelCompletionMethod" NOT NULL DEFAULT 'TICK',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RefuelDraftActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelDraftResource" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "RefuelDraftResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelPublishedVersion" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "programmeStartDate" TEXT NOT NULL,
    "weekStartDay" "RefuelWeekday" NOT NULL DEFAULT 'MONDAY',
    "cutoffBufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT NOT NULL,

    CONSTRAINT "RefuelPublishedVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelPublishedWeek" (
    "id" TEXT NOT NULL,
    "programmeVersionId" TEXT NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "RefuelPublishedWeek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelPublishedDay" (
    "id" TEXT NOT NULL,
    "programmeVersionId" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weekday" "RefuelWeekday" NOT NULL,
    "calendarDate" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RefuelPublishedDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelPublishedActivity" (
    "id" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "activityType" "RefuelActivityType" NOT NULL DEFAULT 'OTHER',
    "completionMethod" "RefuelCompletionMethod" NOT NULL DEFAULT 'TICK',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RefuelPublishedActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelPublishedResource" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "RefuelPublishedResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RefuelRole" NOT NULL DEFAULT 'MEMBER',
    "status" "RefuelMembershipStatus" NOT NULL DEFAULT 'REQUESTED',
    "assignedToId" TEXT,
    "initials" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#8a7d9a',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefuelMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelSubmission" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "programmeVersionId" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "calendarDate" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "RefuelSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "checkedIds" TEXT[],
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefuelSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelSubmissionRevision" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "checkedIds" TEXT[],
    "answersSnapshot" JSONB NOT NULL,
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "submissionNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefuelSubmissionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelAnswer" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "RefuelAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelDecision" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "reviewedRevisionNumber" INTEGER NOT NULL,
    "decision" "RefuelDecisionType" NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefuelDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelGraceRecord" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefuelGraceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelNotice" (
    "id" TEXT NOT NULL,
    "kind" "RefuelNoticeKind" NOT NULL DEFAULT 'ANNOUNCEMENT',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "targetMemberId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefuelNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelNoticeRead" (
    "id" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefuelNoticeRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelPushSubscription" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefuelPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefuelAuditEvent" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "actorMemberId" TEXT,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "actorRole" TEXT NOT NULL,
    "action" "RefuelAuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "targetMemberId" TEXT,
    "programmeVersionId" TEXT,
    "dayId" TEXT,
    "revisionNumber" INTEGER,
    "reason" TEXT,
    "beforeState" JSONB,
    "afterState" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefuelAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Build_userId_idx" ON "Build"("userId");

-- CreateIndex
CREATE INDEX "BuildStep_buildId_idx" ON "BuildStep"("buildId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildStep_buildId_stepNumber_key" ON "BuildStep"("buildId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelProgramme_activeVersionId_key" ON "RefuelProgramme"("activeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelProgramme_activeVersionId_id_key" ON "RefuelProgramme"("activeVersionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelDraftProgramme_programmeId_key" ON "RefuelDraftProgramme"("programmeId");

-- CreateIndex
CREATE INDEX "RefuelDraftWeek_draftId_idx" ON "RefuelDraftWeek"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelDraftWeek_draftId_weekNumber_key" ON "RefuelDraftWeek"("draftId", "weekNumber");

-- CreateIndex
CREATE INDEX "RefuelDraftDay_weekId_idx" ON "RefuelDraftDay"("weekId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelDraftDay_weekId_dayKey_key" ON "RefuelDraftDay"("weekId", "dayKey");

-- CreateIndex
CREATE INDEX "RefuelDraftActivity_dayId_idx" ON "RefuelDraftActivity"("dayId");

-- CreateIndex
CREATE INDEX "RefuelDraftResource_activityId_idx" ON "RefuelDraftResource"("activityId");

-- CreateIndex
CREATE INDEX "RefuelPublishedVersion_programmeId_idx" ON "RefuelPublishedVersion"("programmeId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelPublishedVersion_id_programmeId_key" ON "RefuelPublishedVersion"("id", "programmeId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelPublishedVersion_programmeId_versionNumber_key" ON "RefuelPublishedVersion"("programmeId", "versionNumber");

-- CreateIndex
CREATE INDEX "RefuelPublishedWeek_programmeVersionId_idx" ON "RefuelPublishedWeek"("programmeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelPublishedWeek_id_programmeVersionId_key" ON "RefuelPublishedWeek"("id", "programmeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelPublishedWeek_programmeVersionId_weekNumber_key" ON "RefuelPublishedWeek"("programmeVersionId", "weekNumber");

-- CreateIndex
CREATE INDEX "RefuelPublishedDay_programmeVersionId_idx" ON "RefuelPublishedDay"("programmeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelPublishedDay_id_programmeVersionId_key" ON "RefuelPublishedDay"("id", "programmeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelPublishedDay_weekId_dayKey_key" ON "RefuelPublishedDay"("weekId", "dayKey");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelPublishedDay_programmeVersionId_calendarDate_key" ON "RefuelPublishedDay"("programmeVersionId", "calendarDate");

-- CreateIndex
CREATE INDEX "RefuelPublishedActivity_dayId_idx" ON "RefuelPublishedActivity"("dayId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelPublishedActivity_id_dayId_key" ON "RefuelPublishedActivity"("id", "dayId");

-- CreateIndex
CREATE INDEX "RefuelPublishedResource_activityId_idx" ON "RefuelPublishedResource"("activityId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelMember_userId_key" ON "RefuelMember"("userId");

-- CreateIndex
CREATE INDEX "RefuelMember_assignedToId_idx" ON "RefuelMember"("assignedToId");

-- CreateIndex
CREATE INDEX "RefuelMember_role_status_idx" ON "RefuelMember"("role", "status");

-- CreateIndex
CREATE INDEX "RefuelSubmission_memberId_idx" ON "RefuelSubmission"("memberId");

-- CreateIndex
CREATE INDEX "RefuelSubmission_status_idx" ON "RefuelSubmission"("status");

-- CreateIndex
CREATE INDEX "RefuelSubmission_calendarDate_idx" ON "RefuelSubmission"("calendarDate");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelSubmission_id_dayId_key" ON "RefuelSubmission"("id", "dayId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelSubmission_memberId_dayId_key" ON "RefuelSubmission"("memberId", "dayId");

-- CreateIndex
CREATE INDEX "RefuelSubmissionRevision_submissionId_idx" ON "RefuelSubmissionRevision"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelSubmissionRevision_submissionId_revisionNumber_key" ON "RefuelSubmissionRevision"("submissionId", "revisionNumber");

-- CreateIndex
CREATE INDEX "RefuelAnswer_submissionId_idx" ON "RefuelAnswer"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelAnswer_submissionId_activityId_key" ON "RefuelAnswer"("submissionId", "activityId");

-- CreateIndex
CREATE INDEX "RefuelDecision_submissionId_idx" ON "RefuelDecision"("submissionId");

-- CreateIndex
CREATE INDEX "RefuelGraceRecord_memberId_idx" ON "RefuelGraceRecord"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelGraceRecord_memberId_dayId_key" ON "RefuelGraceRecord"("memberId", "dayId");

-- CreateIndex
CREATE INDEX "RefuelNotice_targetMemberId_idx" ON "RefuelNotice"("targetMemberId");

-- CreateIndex
CREATE INDEX "RefuelNotice_kind_idx" ON "RefuelNotice"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelNoticeRead_noticeId_memberId_key" ON "RefuelNoticeRead"("noticeId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "RefuelPushSubscription_endpoint_key" ON "RefuelPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "RefuelPushSubscription_memberId_idx" ON "RefuelPushSubscription"("memberId");

-- CreateIndex
CREATE INDEX "RefuelAuditEvent_targetMemberId_idx" ON "RefuelAuditEvent"("targetMemberId");

-- CreateIndex
CREATE INDEX "RefuelAuditEvent_entityType_entityId_idx" ON "RefuelAuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "RefuelAuditEvent_action_idx" ON "RefuelAuditEvent"("action");

-- CreateIndex
CREATE INDEX "RefuelAuditEvent_correlationId_idx" ON "RefuelAuditEvent"("correlationId");

-- AddForeignKey
ALTER TABLE "Build" ADD CONSTRAINT "Build_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildStep" ADD CONSTRAINT "BuildStep_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelProgramme" ADD CONSTRAINT "RefuelProgramme_activeVersionId_id_fkey" FOREIGN KEY ("activeVersionId", "id") REFERENCES "RefuelPublishedVersion"("id", "programmeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelDraftProgramme" ADD CONSTRAINT "RefuelDraftProgramme_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "RefuelProgramme"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelDraftWeek" ADD CONSTRAINT "RefuelDraftWeek_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "RefuelDraftProgramme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelDraftDay" ADD CONSTRAINT "RefuelDraftDay_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "RefuelDraftWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelDraftActivity" ADD CONSTRAINT "RefuelDraftActivity_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "RefuelDraftDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelDraftResource" ADD CONSTRAINT "RefuelDraftResource_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "RefuelDraftActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelPublishedVersion" ADD CONSTRAINT "RefuelPublishedVersion_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "RefuelProgramme"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelPublishedWeek" ADD CONSTRAINT "RefuelPublishedWeek_programmeVersionId_fkey" FOREIGN KEY ("programmeVersionId") REFERENCES "RefuelPublishedVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelPublishedDay" ADD CONSTRAINT "RefuelPublishedDay_weekId_programmeVersionId_fkey" FOREIGN KEY ("weekId", "programmeVersionId") REFERENCES "RefuelPublishedWeek"("id", "programmeVersionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelPublishedActivity" ADD CONSTRAINT "RefuelPublishedActivity_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "RefuelPublishedDay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelPublishedResource" ADD CONSTRAINT "RefuelPublishedResource_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "RefuelPublishedActivity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelMember" ADD CONSTRAINT "RefuelMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelMember" ADD CONSTRAINT "RefuelMember_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "RefuelMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelSubmission" ADD CONSTRAINT "RefuelSubmission_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RefuelMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelSubmission" ADD CONSTRAINT "RefuelSubmission_dayId_programmeVersionId_fkey" FOREIGN KEY ("dayId", "programmeVersionId") REFERENCES "RefuelPublishedDay"("id", "programmeVersionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelSubmissionRevision" ADD CONSTRAINT "RefuelSubmissionRevision_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RefuelSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelAnswer" ADD CONSTRAINT "RefuelAnswer_submissionId_dayId_fkey" FOREIGN KEY ("submissionId", "dayId") REFERENCES "RefuelSubmission"("id", "dayId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelAnswer" ADD CONSTRAINT "RefuelAnswer_activityId_dayId_fkey" FOREIGN KEY ("activityId", "dayId") REFERENCES "RefuelPublishedActivity"("id", "dayId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelDecision" ADD CONSTRAINT "RefuelDecision_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RefuelSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelDecision" ADD CONSTRAINT "RefuelDecision_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "RefuelMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelGraceRecord" ADD CONSTRAINT "RefuelGraceRecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RefuelMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelGraceRecord" ADD CONSTRAINT "RefuelGraceRecord_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "RefuelPublishedDay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelGraceRecord" ADD CONSTRAINT "RefuelGraceRecord_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "RefuelMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelNotice" ADD CONSTRAINT "RefuelNotice_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "RefuelMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelNotice" ADD CONSTRAINT "RefuelNotice_targetMemberId_fkey" FOREIGN KEY ("targetMemberId") REFERENCES "RefuelMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelNoticeRead" ADD CONSTRAINT "RefuelNoticeRead_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "RefuelNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelNoticeRead" ADD CONSTRAINT "RefuelNoticeRead_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RefuelMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefuelPushSubscription" ADD CONSTRAINT "RefuelPushSubscription_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RefuelMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =====================================================================
-- IMMUTABILITY & APPEND-ONLY TRIGGERS
-- =====================================================================

-- 1. Append-Only Trigger Function
CREATE OR REPLACE FUNCTION trg_prevent_append_only_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Table % is strictly append-only. UPDATE and DELETE are prohibited.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_audit_immutable
BEFORE UPDATE OR DELETE ON "RefuelAuditEvent"
FOR EACH ROW EXECUTE FUNCTION trg_prevent_append_only_mutation();

CREATE TRIGGER check_decision_immutable
BEFORE UPDATE OR DELETE ON "RefuelDecision"
FOR EACH ROW EXECUTE FUNCTION trg_prevent_append_only_mutation();

CREATE TRIGGER check_grace_immutable
BEFORE UPDATE OR DELETE ON "RefuelGraceRecord"
FOR EACH ROW EXECUTE FUNCTION trg_prevent_append_only_mutation();

CREATE TRIGGER check_revision_immutable
BEFORE UPDATE OR DELETE ON "RefuelSubmissionRevision"
FOR EACH ROW EXECUTE FUNCTION trg_prevent_append_only_mutation();

-- 2. Published Snapshot Immutability Trigger Function
CREATE OR REPLACE FUNCTION trg_prevent_published_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Table % is an immutable published programme snapshot. UPDATE and DELETE are prohibited.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_pub_version_immutable
BEFORE UPDATE OR DELETE ON "RefuelPublishedVersion"
FOR EACH ROW EXECUTE FUNCTION trg_prevent_published_mutation();

CREATE TRIGGER check_pub_week_immutable
BEFORE UPDATE OR DELETE ON "RefuelPublishedWeek"
FOR EACH ROW EXECUTE FUNCTION trg_prevent_published_mutation();

CREATE TRIGGER check_pub_day_immutable
BEFORE UPDATE OR DELETE ON "RefuelPublishedDay"
FOR EACH ROW EXECUTE FUNCTION trg_prevent_published_mutation();

CREATE TRIGGER check_pub_act_immutable
BEFORE UPDATE OR DELETE ON "RefuelPublishedActivity"
FOR EACH ROW EXECUTE FUNCTION trg_prevent_published_mutation();

CREATE TRIGGER check_pub_res_immutable
BEFORE UPDATE OR DELETE ON "RefuelPublishedResource"
FOR EACH ROW EXECUTE FUNCTION trg_prevent_published_mutation();
