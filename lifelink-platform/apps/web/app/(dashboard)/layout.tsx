import type { ReactNode } from "react";
import DashboardShell from "../../components/navigation";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
