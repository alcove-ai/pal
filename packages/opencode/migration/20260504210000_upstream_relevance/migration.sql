ALTER TABLE `activity_event` ADD `relevance` text;--> statement-breakpoint
ALTER TABLE `activity_event` ADD `relevance_reasoning` text;--> statement-breakpoint
CREATE INDEX `activity_event_relevance_idx` ON `activity_event` (`relevance`,`timestamp`);
