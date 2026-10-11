"use client";

import { useEffect, useRef, useState } from "react";
import { requestApi } from "../../lib/api-client";

type MedicalDocument = { id: string; fileName: string; contentType: string; fileSize: number; createdAt: string; updatedAt: string };
type DocumentList = { documents: MedicalDocument[]; canManage: boolean; canUpload: boolean; canDownload: boolean };

function formatSize(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }

export function MedicalDocuments({ target, requestId }: { target: "donor" | "recipient"; requestId: string }) {
	const [data, setData] = useState<DocumentList | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [replaceId, setReplaceId] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const endpoint = `/api/organs/medical-documents/${target}/${requestId}`;
	const refresh = () => { void requestApi<DocumentList>(endpoint).then(setData).catch((reason: Error) => setError(reason.message)); };
	useEffect(() => { refresh(); }, [endpoint]);
	const selectFile = (documentId: string | null) => { setReplaceId(documentId); input.current?.click(); };
	const upload = async (file?: File) => {
		if (!file) return;
		setBusy(true); setError(""); setNotice("");
		try {
			const query = `?fileName=${encodeURIComponent(file.name)}`;
			const url = replaceId ? `${endpoint}/${replaceId}${query}` : `${endpoint}${query}`;
			const response = await requestApi<{ document: MedicalDocument }>(url, { method: replaceId ? "PUT" : "POST", headers: { "content-type": "application/octet-stream", "x-file-content-type": file.type }, body: await file.arrayBuffer() });
			setNotice(`${response.document.fileName} ${replaceId ? "replaced" : "uploaded"}.`);
			refresh();
		} catch (reason) { setError((reason as Error).message); }
		finally { setBusy(false); setReplaceId(null); if (input.current) input.current.value = ""; }
	};
	const download = async (document: MedicalDocument) => {
		setBusy(true); setError("");
		try {
			const result = await requestApi<{ url: string }>(`${endpoint}/${document.id}/download`, { method: "POST" });
			const link = window.document.createElement("a"); link.href = result.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.download = document.fileName; link.click();
		} catch (reason) { setError((reason as Error).message); }
		finally { setBusy(false); }
	};
	const remove = async (document: MedicalDocument) => {
		setBusy(true); setError(""); setNotice("");
		try { await requestApi(`${endpoint}/${document.id}`, { method: "DELETE" }); setNotice(`${document.fileName} deleted.`); refresh(); }
		catch (reason) { setError((reason as Error).message); }
		finally { setBusy(false); }
	};
	const stageHint = target === "recipient" ? "Reports can be added after the recipient request is approved and remain available through later workflow stages." : "Reports can be added after donor authorization is completed and remain available through later workflow stages.";
	return <section className="panel medical-documents"><div className="panel-heading"><div><span className="eyebrow">CLINICIAN DOCUMENTS</span><h2>Medical reports</h2><p>Optional reports attached to this request. The request owner can download reports; the handling institution and administrators can manage them.</p></div>{data?.canManage && <button className="button primary" disabled={busy || !data.canUpload} title={!data.canUpload ? stageHint : undefined} onClick={() => selectFile(null)}>Upload report</button>}</div>
		<input ref={input} hidden type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => void upload(event.target.files?.[0])}/>
		{error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
		{!data && !error && <p>Loading reports…</p>}
		{data?.canManage && !data.canUpload && <p className="medical-document-stage-hint" role="status">{stageHint}</p>}
		{data?.documents.length ? <ul className="medical-document-list">{data.documents.map((document) => <li key={document.id}><span className="medical-document-meta"><strong>{document.fileName}</strong><small>{document.contentType} · {formatSize(document.fileSize)} · Updated {new Date(document.updatedAt).toLocaleString()}</small></span><span className="medical-document-actions"><button className="button small" disabled={busy} onClick={() => void download(document)}>Download</button>{data.canManage && <><button className="button small" disabled={busy} onClick={() => selectFile(document.id)}>Re-upload</button><button className="button small danger" disabled={busy} onClick={() => void remove(document)}>Delete</button></>}</span></li>)}</ul> : data && <div className="empty-state"><h3>No report uploaded</h3><p>{data.canUpload ? "The handling institution can optionally attach a clinician report here." : data.canManage ? stageHint : "The handling institution may attach an optional clinician report at the appropriate review stage. You can download it here once uploaded."}</p></div>}
	</section>;
}
