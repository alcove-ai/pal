CREATE TABLE `needs_me_dismissed_event` (
	`id` text PRIMARY KEY,
	`work_item_key` text NOT NULL,
	`action` text NOT NULL,
	`snooze_until` integer,
	`rule_source` text NOT NULL,
	`dismissed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `needs_me_suppression_pattern` (
	`id` text PRIMARY KEY,
	`rule_source` text NOT NULL,
	`dismiss_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_matched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dismissed_event_work_item_idx` ON `needs_me_dismissed_event` (`work_item_key`);--> statement-breakpoint
CREATE INDEX `dismissed_event_rule_source_idx` ON `needs_me_dismissed_event` (`rule_source`);--> statement-breakpoint
CREATE INDEX `dismissed_event_snooze_until_idx` ON `needs_me_dismissed_event` (`snooze_until`);--> statement-breakpoint
CREATE UNIQUE INDEX `suppression_pattern_rule_source_idx` ON `needs_me_suppression_pattern` (`rule_source`);