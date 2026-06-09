CREATE TABLE `todo_attachment` (
	`session_id` text PRIMARY KEY NOT NULL,
	`task_path` text NOT NULL,
	`label` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `todo_attachment_task_path_idx` ON `todo_attachment` (`task_path`);
