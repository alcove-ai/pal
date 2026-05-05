CREATE TABLE `activity_event` (
	`id` text PRIMARY KEY,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`event_type` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`actor` text,
	`timestamp` integer NOT NULL,
	`url` text,
	`metadata` text,
	`is_read` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `poll_state` (
	`id` text PRIMARY KEY,
	`source` text NOT NULL,
	`last_poll_ts` integer NOT NULL,
	`last_success_ts` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_event_dedup_idx` ON `activity_event` (`source`,`source_id`,`event_type`,`timestamp`);--> statement-breakpoint
CREATE INDEX `activity_event_timestamp_idx` ON `activity_event` (`timestamp`);--> statement-breakpoint
CREATE INDEX `activity_event_is_read_timestamp_idx` ON `activity_event` (`is_read`,`timestamp`);