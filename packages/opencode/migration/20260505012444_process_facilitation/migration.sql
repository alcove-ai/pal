CREATE TABLE `issue_process_state` (
	`issue_key` text PRIMARY KEY,
	`phase` text NOT NULL,
	`problem_quality` text DEFAULT 'missing' NOT NULL,
	`scope_quality` text DEFAULT 'missing' NOT NULL,
	`exemption_reason` text,
	`last_assessed` integer NOT NULL,
	`skip_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposed_epic` (
	`id` text PRIMARY KEY,
	`cluster_key` text NOT NULL,
	`issue_keys` text NOT NULL,
	`proposed_at` integer NOT NULL,
	`dismissed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `process_skip_tracking` (
	`id` text PRIMARY KEY,
	`issue_key` text NOT NULL,
	`skipped_at` integer NOT NULL,
	`advisory_shown` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issue_process_state_phase_idx` ON `issue_process_state` (`phase`);--> statement-breakpoint
CREATE INDEX `proposed_epic_cluster_key_idx` ON `proposed_epic` (`cluster_key`);--> statement-breakpoint
CREATE INDEX `proposed_epic_proposed_at_idx` ON `proposed_epic` (`proposed_at`);--> statement-breakpoint
CREATE INDEX `skip_tracking_issue_key_idx` ON `process_skip_tracking` (`issue_key`);--> statement-breakpoint
CREATE INDEX `skip_tracking_skipped_at_idx` ON `process_skip_tracking` (`skipped_at`);
