CREATE TABLE `transcript_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`source_id` text NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`author` text NOT NULL,
	`original_transcript` text NOT NULL,
	`working_content` text NOT NULL,
	`initial_summary` text DEFAULT '' NOT NULL,
	`last_prompt` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`method` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
