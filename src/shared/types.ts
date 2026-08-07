export type ExportFormat = "markdown" | "json" | "plain" | "html";

export type MessageRole = "user" | "assistant";

export type MessageStatus =
  | "pending"
  | "completed"
  | "interrupted"
  | "cancelled"
  | "failed";

export interface ChatThreadRef {
  resource_id: string;
  thread_id: string;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageView {
  message_id: string;
  thread_resource_id: string;
  sequence: number;
  role: MessageRole;
  status: MessageStatus;
  text: string;
  artifact_refs: string[];
  run_ref: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ThreadPage {
  thread: ChatThreadRef;
  messages: ChatMessageView[];
  next_cursor: number | null;
}

export interface ChatTranscript {
  thread: ChatThreadRef;
  messages: ChatMessageView[];
}

export interface ThreadActionContext {
  thread_id: string;
  resource_id: string;
  revision: number;
}
