DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "tasks"
    WHERE "schedule_kind" = 'exact'
      AND "deleted_at" IS NULL
      AND (
        "end_at" < "start_at" + interval '30 minutes'
        OR extract(minute from "start_at" at time zone "time_zone") NOT IN (0, 30)
        OR extract(second from "start_at" at time zone "time_zone") <> 0
        OR extract(minute from "end_at" at time zone "time_zone") NOT IN (0, 30)
        OR extract(second from "end_at" at time zone "time_zone") <> 0
      )
  ) THEN
    RAISE EXCEPTION 'Migration 0008 refused: exact tasks violate the 30-minute timeline contract';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_exact_minimum_duration_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_exact_half_hour_boundary_check" CHECK ("tasks"."deleted_at" is not null or "tasks"."start_at" is null or (
        extract(minute from "tasks"."start_at" at time zone "tasks"."time_zone") in (0, 30)
        and extract(second from "tasks"."start_at" at time zone "tasks"."time_zone") = 0
        and extract(minute from "tasks"."end_at" at time zone "tasks"."time_zone") in (0, 30)
        and extract(second from "tasks"."end_at" at time zone "tasks"."time_zone") = 0
      ));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_exact_minimum_duration_check" CHECK ("tasks"."deleted_at" is not null or "tasks"."end_at" is null or "tasks"."end_at" >= "tasks"."start_at" + interval '30 minutes');
