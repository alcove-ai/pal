ALTER TABLE `activity_event` ADD `actor_type` text NOT NULL DEFAULT 'human';--> statement-breakpoint
CREATE INDEX `activity_event_actor_type_idx` ON `activity_event` (`actor_type`,`timestamp`);
