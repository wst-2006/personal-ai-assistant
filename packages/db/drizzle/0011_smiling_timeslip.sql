INSERT INTO "task_legacy_metadata" ("id", "task_id", "planned_effort_minutes", "difficulty", "task_type", "requires_continuous_focus", "archived_at")
SELECT gen_random_uuid(), "id", "planned_effort_minutes", "difficulty", "task_type", "requires_continuous_focus", now()
FROM "tasks"
ON CONFLICT ("task_id") DO UPDATE SET
  "planned_effort_minutes" = EXCLUDED."planned_effort_minutes",
  "difficulty" = EXCLUDED."difficulty",
  "task_type" = EXCLUDED."task_type",
  "requires_continuous_focus" = EXCLUDED."requires_continuous_focus",
  "archived_at" = EXCLUDED."archived_at";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_planned_effort_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "planned_effort_minutes";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "difficulty";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "task_type";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "requires_continuous_focus";
