-- Delete leads (owner, 25 Nov 2026): addresses the CRM must not email, kept when a lead marked Do not email or a contact
-- that unsubscribed is deleted (only the address). The Mailer skips them; imports flag a new lead / contact for them.
-- Adds one table only.

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_email_key" ON "email_suppressions"("email");

-- AddForeignKey
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
