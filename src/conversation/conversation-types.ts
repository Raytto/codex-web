import type { AgentOptions, AgentSelection, Message, ReasoningEffort } from "../api";
import type { ReactNode } from "react";

export type ConversationVoiceState = "idle" | "recording" | "transcribing";

export type ConversationComposerSelection = AgentSelection;

export type ConversationComposerFile = File;

export type ConversationMessageVariant = "main" | "reader";

export type ConversationMessageRenderer = (message: Message) => ReactNode;

export type ConversationModelOption = AgentOptions["models"][number];

export type ConversationReasoningOption = AgentOptions["reasoningEfforts"][number];

export type { AgentOptions, AgentSelection, Message, ReasoningEffort };
