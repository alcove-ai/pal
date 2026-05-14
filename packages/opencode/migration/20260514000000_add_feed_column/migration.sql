ALTER TABLE `activity_event` ADD `feed` text;
CREATE INDEX `activity_event_feed_idx` ON `activity_event` (`feed`,`timestamp`);
