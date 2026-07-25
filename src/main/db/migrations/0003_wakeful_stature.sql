CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text DEFAULT 'stdio' NOT NULL,
	`command` text,
	`args` text DEFAULT '[]' NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`url` text,
	`headers` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
