CREATE TABLE IF NOT EXISTS `radar_result` (
	`url` text PRIMARY KEY,
	`session_id` text,
	`summary` text NOT NULL,
	`impact` text,
	`change_description` text,
	`urgency` integer NOT NULL DEFAULT 5,
	`status` text NOT NULL,
	`analyzed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `radar_result_status_idx` ON `radar_result` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `radar_result_analyzed_at_idx` ON `radar_result` (`analyzed_at`);
