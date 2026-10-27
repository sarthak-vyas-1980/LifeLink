import { AssistantPanel } from "../../../components/assistant";
import { HeartPulse, ShieldCheck } from "lucide-react";

export default function AssistantPage() {
  return (
    <main className="assistant-page">
      <div className="assistant-page-heading">
        <div className="assistant-page-title">
          <p className="assistant-page-kicker"><HeartPulse size={14} aria-hidden="true" />LifeLink · Care network</p>
          <h1>Care Assistant</h1>
          <p>Find nearby care, check live blood availability, and get answers from LifeLink's approved documents.</p>
        </div>
        <div className="assistant-private-note"><ShieldCheck size={14} aria-hidden="true" />Private, signed-in session</div>
      </div>
      <AssistantPanel />
    </main>
  );
}
