PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`title` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'design' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_conversations`("id", "project_id", "title", "kind", "created_at", "updated_at") SELECT "id", "project_id", "title", "kind", "created_at", "updated_at" FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_conversations_project` ON `conversations` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_kind` ON `conversations` (`kind`,`updated_at`);--> statement-breakpoint
CREATE TABLE `__new_workspace_roots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workspace_roots`("id", "project_id", "conversation_id", "path", "name", "created_at", "updated_at") SELECT "id", "project_id", "conversation_id", "path", "name", "created_at", "updated_at" FROM `workspace_roots`;--> statement-breakpoint
DROP TABLE `workspace_roots`;--> statement-breakpoint
ALTER TABLE `__new_workspace_roots` RENAME TO `workspace_roots`;