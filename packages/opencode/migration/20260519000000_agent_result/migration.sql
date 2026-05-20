CREATE TABLE IF NOT EXISTS `agent_result` (
	`source_id` text PRIMARY KEY,
	`session_id` text,
	`summary` text NOT NULL,
	`recommended_action` text,
	`status` text NOT NULL,
	`analyzed_event_ts` integer NOT NULL,
	`analyzed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_result_status_idx` ON `agent_result` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_result_analyzed_at_idx` ON `agent_result` (`analyzed_at`);
