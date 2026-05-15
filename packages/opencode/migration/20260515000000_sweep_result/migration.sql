CREATE TABLE IF NOT EXISTS `sweep_result` (
	`source_id` text PRIMARY KEY,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`action` text NOT NULL,
	`priority` text NOT NULL,
	`phase` text,
	`url` text,
	`actor` text,
	`last_event_ts` integer NOT NULL,
	`swept_at` integer NOT NULL,
	`feed` text,
	`mode` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sweep_result_priority_idx` ON `sweep_result` (`priority`, `last_event_ts`);
