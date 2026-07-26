CREATE TABLE `group_digests` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`covered_until_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
