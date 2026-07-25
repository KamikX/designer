CREATE TABLE `workspace_roots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
