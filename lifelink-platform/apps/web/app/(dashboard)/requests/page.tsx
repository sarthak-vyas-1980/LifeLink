import { Suspense } from "react";
import RequestsWorkspace from "../../../components/requests";

export default function RequestsPage() {
  return (
    <Suspense fallback={null}>
      <RequestsWorkspace />
    </Suspense>
  );
}
