CREATE TABLE `artifact_files` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_artifact_files_path` ON `artifact_files` (`artifact_id`,`path`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`message_id` text,
	`version` integer NOT NULL,
	`base_artifact_id` text,
	`summary` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_project` ON `artifacts` (`project_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`backend` text DEFAULT 'local' NOT NULL,
	`location` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `change_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tbl` text NOT NULL,
	`row_id` text NOT NULL,
	`op` text NOT NULL,
	`changed_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'design' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_conversations_project` ON `conversations` (`project_id`);--> statement-breakpoint
CREATE TABLE `local_meta` (
	`k` text PRIMARY KEY NOT NULL,
	`v` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'complete' NOT NULL,
	`usage` text,
	`provider_slug` text,
	`model_id` text,
	`artifact_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_conversation` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`capabilities` text DEFAULT '["chat"]' NOT NULL,
	`context_window` integer DEFAULT 64000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_models_provider_model` ON `models` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`adapter` text NOT NULL,
	`base_url` text,
	`api_key_cipher` text,
	`key_storage` text DEFAULT 'safe' NOT NULL,
	`key_hint` text,
	`enabled` integer DEFAULT true NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_slug_unique` ON `providers` (`slug`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`stack` text DEFAULT 'html' NOT NULL,
	`design_mode` text DEFAULT 'design' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "name", "stack", "design_mode", "description", "created_at", "updated_at") SELECT "id", "name", 'html', 'design', '', "created_at", "updated_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_projects_updated_at` ON `projects` (`updated_at`);