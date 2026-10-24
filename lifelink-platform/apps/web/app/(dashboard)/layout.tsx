import type { ReactNode } from "react";
import DashboardShell from "../../components/navigation";
import { AssistantConversationProvider } from "../../components/assistant/conversation-provider";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <AssistantConversationProvider><DashboardShell>{children}</DashboardShell></AssistantConversationProvider>;
}
