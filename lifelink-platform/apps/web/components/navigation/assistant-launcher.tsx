"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Bot, LoaderCircle, Send, X } from "lucide-react";
import { useAssistantConversation } from "../assistant/conversation-provider";

export default function AssistantLauncher({ hidden = false }: { hidden?: boolean }) {
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	const messagesElement = useRef<HTMLDivElement>(null);
	const { messages, draft, setDraft, restored, pendingMessageId, persistenceWarning, sendMessage } = useAssistantConversation();

	useEffect(() => {
		setOpen(false);
	}, [pathname]);
	useEffect(() => {
		if (!open) return;
		const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [open]);
	useEffect(() => {
		if (open && messagesElement.current) messagesElement.current.scrollTop = messagesElement.current.scrollHeight;
	}, [open, messages, pendingMessageId]);

	const submitMessage = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!draft.trim() || pendingMessageId || !restored) return;
		void sendMessage(draft);
	};

	if (hidden) return null;

	return <div className="assistant-launcher">
		{open && <section className="assistant-launcher-card" id="assistant-launcher-panel" aria-labelledby="assistant-launcher-title" role="dialog" aria-modal="false">
			<header><span className="assistant-launcher-icon"><Bot size={19} aria-hidden="true" /></span><div><strong id="assistant-launcher-title">LifeLink Assistant</strong><small>Here when you need a hand</small></div><button type="button" className="assistant-launcher-close" aria-label="Close assistant panel" onClick={() => setOpen(false)}><X size={17} /></button></header>
			<div ref={messagesElement} className="assistant-launcher-messages" aria-live="polite">
				{messages.length === 0 ? <p className="assistant-launcher-empty">Ask about LifeLink, blood requests, organ services, or finding a facility.</p> : messages.slice(-4).map((message) => <article key={message.id} className={`assistant-launcher-message ${message.role}`}><span>{message.role === "user" ? "You" : "LifeLink Assistant"}</span><p>{message.content}</p>{message.failed && <small role="alert">{message.errorMessage ?? "Message not sent."}</small>}</article>)}
				{pendingMessageId && <p className="assistant-launcher-thinking"><LoaderCircle size={14} />Thinking…</p>}
			</div>
			{persistenceWarning && <p className="assistant-launcher-warning" role="status">{persistenceWarning}</p>}
			<form className="assistant-launcher-form" onSubmit={submitMessage}>
				<textarea aria-label="Message LifeLink Assistant" placeholder={restored ? "Ask a question…" : "Loading your assistant…"} rows={2} maxLength={2000} disabled={!restored || Boolean(pendingMessageId)} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
				<button type="submit" aria-label="Send message" disabled={!draft.trim() || !restored || Boolean(pendingMessageId)}><Send size={16} aria-hidden="true" /></button>
			</form>
			<footer><small>Don’t share passwords or private medical documents.</small><Link href="/assistant">Open full assistant<ArrowUpRight size={13} aria-hidden="true" /></Link></footer>
		</section>}
		<button type="button" className={`assistant-launcher-button${open ? " is-open" : ""}`} aria-label={open ? "Close LifeLink Assistant" : "Open LifeLink Assistant"} aria-expanded={open} aria-controls="assistant-launcher-panel" onClick={() => setOpen((value) => !value)}>
			{open ? <X size={22} aria-hidden="true" /> : <Bot size={23} aria-hidden="true" />}
			<span>{open ? "Close" : "Ask LifeLink"}</span>
		</button>
	</div>;
}
