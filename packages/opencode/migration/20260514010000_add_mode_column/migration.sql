ALTER TABLE `activity_event` ADD `mode` text;
--> statement-breakpoint
CREATE INDEX `activity_event_mode_idx` ON `activity_event` (`mode`,`timestamp`);
