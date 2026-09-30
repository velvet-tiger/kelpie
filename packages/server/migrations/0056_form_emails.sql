-- Form emails: a notification to people the workspace names, and an
-- auto-reply to the submitter, sent by the `forms.send-emails` job after a
-- submit commits. Settings are columns on `forms`; the notification's
-- recipients are `form_notify_recipients`; every message tried is a row of
-- `form_email_sends`. Hand-written: the drizzle-kit snapshot chain is stale.
CREATE TABLE "form_notify_recipients" (
	"workspace_id" text NOT NULL,
	"form_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"member_id" text,
	"address" text,
	CONSTRAINT "form_notify_recipients_form_id_position_pk" PRIMARY KEY("form_id","position"),
	CONSTRAINT "form_notify_recipients_kind_check" CHECK ("form_notify_recipients"."kind" in ('member', 'address')),
	CONSTRAINT "form_notify_recipients_target_check" CHECK (("form_notify_recipients"."kind" = 'member' and "form_notify_recipients"."member_id" is not null and "form_notify_recipients"."address" is null) or ("form_notify_recipients"."kind" = 'address' and "form_notify_recipients"."address" is not null and "form_notify_recipients"."member_id" is null))
);
--> statement-breakpoint
CREATE TABLE "form_email_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"form_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_email_sends_kind_check" CHECK ("form_email_sends"."kind" in ('notification', 'auto_reply')),
	CONSTRAINT "form_email_sends_status_check" CHECK ("form_email_sends"."status" in ('sent', 'skipped', 'error'))
);
--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "notify_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "notify_subject" text DEFAULT 'New submission: {{form.name}}' NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "notify_body" text DEFAULT '{{answers}}' NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "auto_reply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "auto_reply_subject" text DEFAULT 'Thanks for contacting {{workspace.name}}' NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "auto_reply_body" text DEFAULT 'Thanks for getting in touch. We have your message and will reply soon.' NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "auto_reply_reply_to_member_id" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "auto_reply_reply_to_address" text;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_auto_reply_reply_to_check" CHECK ("forms"."auto_reply_reply_to_member_id" is null or "forms"."auto_reply_reply_to_address" is null);--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_auto_reply_reply_to_member_id_workspace_members_id_fk" FOREIGN KEY ("auto_reply_reply_to_member_id") REFERENCES "public"."workspace_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_notify_recipients" ADD CONSTRAINT "form_notify_recipients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_notify_recipients" ADD CONSTRAINT "form_notify_recipients_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_notify_recipients" ADD CONSTRAINT "form_notify_recipients_member_id_workspace_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."workspace_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_email_sends" ADD CONSTRAINT "form_email_sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_email_sends" ADD CONSTRAINT "form_email_sends_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_email_sends" ADD CONSTRAINT "form_email_sends_submission_id_form_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_notify_recipients_workspace_idx" ON "form_notify_recipients" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "form_notify_recipients_member_idx" ON "form_notify_recipients" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_email_sends_message_idx" ON "form_email_sends" USING btree ("submission_id","kind","recipient");--> statement-breakpoint
CREATE INDEX "form_email_sends_recent_idx" ON "form_email_sends" USING btree ("workspace_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "form_email_sends_recipient_idx" ON "form_email_sends" USING btree ("form_id","kind","recipient");
