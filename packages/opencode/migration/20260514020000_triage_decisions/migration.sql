CREATE TABLE `needs_me_triage_decision` (
	`id` text PRIMARY KEY,
	`work_item_key` text NOT NULL,
	`rule_source` text NOT NULL,
	`event_type` text NOT NULL,
	`item_score` integer NOT NULL,
	`item_tier` integer NOT NULL,
	`feed` text,
	`mode` text,
	`action` text NOT NULL,
	`action_detail` text,
	`session_id` text,
	`decided_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `triage_decision_rule_source_idx` ON `needs_me_triage_decision` (`rule_source`);--> statement-breakpoint
CREATE INDEX `triage_decision_action_idx` ON `needs_me_triage_decision` (`action`);--> statement-breakpoint
CREATE INDEX `triage_decision_decided_at_idx` ON `needs_me_triage_decision` (`decided_at`);
