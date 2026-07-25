PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`type` text DEFAULT 'chat' NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`context_window` integer DEFAULT 64000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_models`("id", "provider_id", "model_id", "display_name", "type", "capabilities", "context_window", "enabled", "is_builtin", "sort_order", "created_at", "updated_at") SELECT "id", "provider_id", "model_id", "display_name", CASE WHEN "capabilities" LIKE '%"image"%' THEN 'image' ELSE 'chat' END, "capabilities", "context_window", "enabled", "is_builtin", "sort_order", "created_at", "updated_at" FROM `models`;--> statement-breakpoint
DROP TABLE `models`;--> statement-breakpoint
ALTER TABLE `__new_models` RENAME TO `models`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_models_provider_model` ON `models` (`provider_id`,`model_id`);