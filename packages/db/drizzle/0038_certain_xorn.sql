CREATE TABLE "health_daily_actuals" (
	"local_date" date PRIMARY KEY NOT NULL,
	"protein_grams" integer,
	"fiber_grams" integer,
	"water_milliliters" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_daily_actuals_protein_check" CHECK ("health_daily_actuals"."protein_grams" is null or "health_daily_actuals"."protein_grams" between 0 and 1000),
	CONSTRAINT "health_daily_actuals_fiber_check" CHECK ("health_daily_actuals"."fiber_grams" is null or "health_daily_actuals"."fiber_grams" between 0 and 200),
	CONSTRAINT "health_daily_actuals_water_check" CHECK ("health_daily_actuals"."water_milliliters" is null or "health_daily_actuals"."water_milliliters" between 0 and 10000),
	CONSTRAINT "health_daily_actuals_has_value_check" CHECK ("health_daily_actuals"."protein_grams" is not null or "health_daily_actuals"."fiber_grams" is not null or "health_daily_actuals"."water_milliliters" is not null)
);
