ALTER TABLE `todo` ADD `agent` text;--> statement-breakpoint
ALTER TABLE `todo` ADD `comments` text DEFAULT '[]' NOT NULL;