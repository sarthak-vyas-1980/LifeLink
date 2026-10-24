import type { ChatMessage } from "./conversation-types";

export function buildAssistantHistory(messages: ChatMessage[], retryMessageId?: string) {
  return messages.filter((item) => !item.failed && item.id !== retryMessageId).slice(-8)
    .map(({ role, content }) => ({ role, content }));
}

export function shouldSendOnAssistantEnter(key: string, shiftKey: boolean, isComposing: boolean) {
  return key === "Enter" && !shiftKey && !isComposing;
}

export function isConversationNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 90) {
  return scrollHeight - scrollTop - clientHeight < threshold;
}
