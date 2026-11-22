-- Release 3C: calls and meetings are timed tasks. Existing rows become untimed follow-ups.
ALTER TABLE "tasks" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'followup',
ADD COLUMN "due_time" VARCHAR(5),
ADD COLUMN "duration_minutes" INTEGER;
