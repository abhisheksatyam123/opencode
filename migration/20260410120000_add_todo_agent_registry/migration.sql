CREATE TABLE `todo_agent` (
  `root_session_id` text NOT NULL,
  `name` text NOT NULL,
  `session_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `model_id` text NOT NULL,
  `source` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY(`root_session_id`, `name`),
  FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `todo_agent_root_idx` ON `todo_agent` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `todo_agent_session_idx` ON `todo_agent` (`session_id`);
