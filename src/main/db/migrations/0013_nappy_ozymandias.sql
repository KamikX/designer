CREATE TABLE `ai_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`step_number` integer DEFAULT 0 NOT NULL,
	`provider_id` text,
	`provider_slug` text DEFAULT '' NOT NULL,
	`model_id` text DEFAULT '' NOT NULL,
	`started_at` text NOT NULL,
	`first_output_at` text,
	`ended_at` text,
	`step_time_ms` integer,
	`response_time_ms` integer,
	`time_to_first_output_ms` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`usage_state` text DEFAULT 'pending' NOT NULL,
	`input_tokens` integer,
	`input_no_cache_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`output_tokens` integer,
	`output_text_tokens` integer,
	`reasoning_tokens` integer,
	`sdk_total_tokens` integer,
	`provider_total_tokens` integer,
	`usage_reported` text,
	`finish_reason` text,
	`http_status` integer,
	`error_code` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_ai_run_steps_call` ON `ai_run_steps` (`run_id`,`call_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_run_steps_run` ON `ai_run_steps` (`run_id`);--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`conversation_id` text,
	`project_id` text,
	`provider_id` text,
	`provider_slug` text DEFAULT '' NOT NULL,
	`model_id` text DEFAULT '' NOT NULL,
	`scene` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`first_output_at` text,
	`first_file_change_at` text,
	`model_call_count` integer DEFAULT 0 NOT NULL,
	`tool_call_count` integer DEFAULT 0 NOT NULL,
	`tool_failure_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`sdk_total_tokens` integer,
	`tool_breaker` integer DEFAULT false NOT NULL,
	`token_breaker` integer DEFAULT false NOT NULL,
	`error_breaker` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ai_runs_message` ON `ai_runs` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_runs_started` ON `ai_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_runs_project` ON `ai_runs` (`project_id`);--> statement-breakpoint
CREATE TABLE `model_usage_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`provider_key` text NOT NULL,
	`provider_id` text,
	`provider_slug` text DEFAULT '' NOT NULL,
	`model_id` text NOT NULL,
	`scene` text NOT NULL,
	`project_key` text NOT NULL,
	`project_id` text,
	`step_count` integer DEFAULT 0 NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`input_no_cache_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`output_text_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`sdk_total_tokens` integer DEFAULT 0 NOT NULL,
	`provider_total_tokens` integer DEFAULT 0 NOT NULL,
	`reported_input_calls` integer DEFAULT 0 NOT NULL,
	`reported_no_cache_calls` integer DEFAULT 0 NOT NULL,
	`reported_cache_read_calls` integer DEFAULT 0 NOT NULL,
	`reported_cache_write_calls` integer DEFAULT 0 NOT NULL,
	`reported_output_calls` integer DEFAULT 0 NOT NULL,
	`reported_text_calls` integer DEFAULT 0 NOT NULL,
	`reported_reasoning_calls` integer DEFAULT 0 NOT NULL,
	`reported_sdk_total_calls` integer DEFAULT 0 NOT NULL,
	`reported_provider_total_calls` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_model_usage_daily_dim` ON `model_usage_daily` (`date`,`provider_key`,`model_id`,`scene`,`project_key`);--> statement-breakpoint
CREATE TABLE `model_usage_run_days` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`date` text NOT NULL,
	`provider_key` text NOT NULL,
	`model_id` text NOT NULL,
	`scene` text NOT NULL,
	`project_key` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_model_usage_run_days_dim` ON `model_usage_run_days` (`run_id`,`date`,`provider_key`,`model_id`,`scene`,`project_key`);--> statement-breakpoint
CREATE INDEX `idx_model_usage_run_days_date` ON `model_usage_run_days` (`date`);--> statement-breakpoint
CREATE TABLE `tool_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`step_number` integer DEFAULT 0 NOT NULL,
	`tool_name` text NOT NULL,
	`input_started_at` text,
	`input_completed_at` text,
	`exec_started_at` text,
	`exec_completed_at` text,
	`input_chars` integer,
	`output_chars` integer,
	`affected_file_count` integer,
	`target_summary` text,
	`status` text DEFAULT 'running' NOT NULL,
	`error_code` text,
	`error_summary` text,
	`recovered` integer DEFAULT false NOT NULL,
	`breaker_tripped` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_tool_runs_call` ON `tool_runs` (`run_id`,`call_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_runs_run` ON `tool_runs` (`run_id`);