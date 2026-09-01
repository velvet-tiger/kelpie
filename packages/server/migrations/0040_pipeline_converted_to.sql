ALTER TABLE "enquiries" ADD COLUMN "converted_target_type" text;--> statement-breakpoint
ALTER TABLE "enquiries" ADD COLUMN "converted_target_id" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "converted_target_type" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "converted_target_id" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "converted_target_type" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "converted_target_id" text;--> statement-breakpoint
ALTER TABLE "raises" ADD COLUMN "converted_target_type" text;--> statement-breakpoint
ALTER TABLE "raises" ADD COLUMN "converted_target_id" text;--> statement-breakpoint
ALTER TABLE "partnerships" ADD COLUMN "converted_target_type" text;--> statement-breakpoint
ALTER TABLE "partnerships" ADD COLUMN "converted_target_id" text;--> statement-breakpoint
UPDATE "enquiries"
SET
  "converted_target_type" = 'deal',
  "converted_target_id" = "converted_deal_id"
WHERE "converted_deal_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_converted_target_type_check" CHECK ("enquiries"."converted_target_type" is null or "enquiries"."converted_target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership'));--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_converted_target_type_check" CHECK ("deals"."converted_target_type" is null or "deals"."converted_target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership'));--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_converted_target_type_check" CHECK ("opportunities"."converted_target_type" is null or "opportunities"."converted_target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership'));--> statement-breakpoint
ALTER TABLE "raises" ADD CONSTRAINT "raises_converted_target_type_check" CHECK ("raises"."converted_target_type" is null or "raises"."converted_target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership'));--> statement-breakpoint
ALTER TABLE "partnerships" ADD CONSTRAINT "partnerships_converted_target_type_check" CHECK ("partnerships"."converted_target_type" is null or "partnerships"."converted_target_type" in ('enquiry', 'deal', 'opportunity', 'raise', 'partnership'));
