-- CreateTable
CREATE TABLE IF NOT EXISTS "RefuelNoticeReaction" (
    "id" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefuelNoticeReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RefuelNoticeReaction_noticeId_idx" ON "RefuelNoticeReaction"("noticeId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RefuelNoticeReaction_noticeId_memberId_emoji_key" ON "RefuelNoticeReaction"("noticeId", "memberId", "emoji");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'RefuelNoticeReaction_noticeId_fkey'
    ) THEN
        ALTER TABLE "RefuelNoticeReaction" ADD CONSTRAINT "RefuelNoticeReaction_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "RefuelNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'RefuelNoticeReaction_memberId_fkey'
    ) THEN
        ALTER TABLE "RefuelNoticeReaction" ADD CONSTRAINT "RefuelNoticeReaction_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RefuelMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
