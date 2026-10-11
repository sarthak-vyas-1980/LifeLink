import { randomUUID } from "node:crypto";
import { database } from "@lifelink/database";
import type { AuthContext } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
type DocumentTarget = "donor" | "recipient";

function storageSettings() {
	const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
	const key = process.env.SUPABASE_SECRET_KEY;
	const bucket = process.env.SUPABASE_MEDICAL_DOCUMENTS_BUCKET ?? "medical_reports_lifelink";
	if (!url || !key) throw new ApiError(503, "DOCUMENT_STORAGE_NOT_CONFIGURED", "Medical document storage is not configured on the API server.");
	return { url, key, bucket };
}

function objectUrl(url: string, bucket: string, path: string, operation: "object" | "sign") {
	return `${url}/storage/v1/${operation === "sign" ? "object/sign" : "object"}/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function storageRequest(url: string, init: RequestInit) {
	let response: Response;
	try { response = await fetch(url, init); }
	catch { throw new ApiError(502, "DOCUMENT_STORAGE_UNAVAILABLE", "Document storage could not be reached. Try again shortly."); }
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new ApiError(502, "DOCUMENT_STORAGE_FAILED", `Document storage rejected the operation (${response.status})${detail ? `: ${detail.slice(0, 160)}` : "."}`);
	}
	return response;
}

function storageHeaders(key: string, extra: Record<string, string> = {}) {
	return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function getTarget(actor: AuthContext, target: DocumentTarget, id: string) {
	const record = target === "donor"
		? await database.organDonor.findUnique({ where: { id }, select: { id: true, reference: true, institutionId: true, userId: true, consentStatus: true, authorizationStatus: true } })
		: await database.organRecipient.findUnique({ where: { id }, select: { id: true, reference: true, institutionId: true, userId: true, status: true } });
	if (!record) throw new ApiError(404, "ORGAN_REQUEST_NOT_FOUND", "The organ request was not found.");
	const isAdmin = actor.role === "ADMINISTRATOR";
	const isInstitution = actor.principalType === "INSTITUTION" && actor.institutionId === record.institutionId && (actor.role === "ORGAN_CENTRE_USER" || actor.role === "HOSPITAL_USER" && Boolean(actor.capabilities?.organ));
	const isOwner = actor.principalType === "USER" && Boolean(actor.userId) && actor.userId === record.userId;
	if (!isAdmin && !isInstitution && !isOwner) throw new ApiError(404, "ORGAN_REQUEST_NOT_FOUND", "The organ request was not found.");
	const canManage = isAdmin || isInstitution;
	const canUpload = target === "recipient"
		? "status" in record && record.status !== "PENDING_REVIEW" && record.status !== "REJECTED" && record.status !== "CANCELLED"
		: "authorizationStatus" in record && record.authorizationStatus === "AUTHORIZED";
	return { record, canManage, canUpload: canManage && canUpload, isOwner };
}

export async function listMedicalDocuments(actor: AuthContext, target: DocumentTarget, id: string) {
	const access = await getTarget(actor, target, id);
	const where = target === "donor" ? { donorId: id, deletedAt: null } : { recipientId: id, deletedAt: null };
	const documents = await database.medicalDocument.findMany({ where, select: { id: true, fileName: true, contentType: true, fileSize: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: "desc" } });
	return { documents, canManage: access.canManage, canUpload: access.canUpload, canDownload: true };
}

function validFileSignature(file: Buffer, contentType: string) {
	if (contentType === "application/pdf") return file.subarray(0, 5).toString("ascii") === "%PDF-";
	if (contentType === "image/jpeg") return file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff;
	if (contentType === "image/png") return file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	return false;
}

function safeFileName(value: string) {
	const name = value.replaceAll("\\", "/").split("/").pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (!name || name.length > 180 || name === "." || name === "..") throw new ApiError(400, "INVALID_DOCUMENT_NAME", "Provide a valid document filename (maximum 180 characters).");
	return name;
}

export async function uploadMedicalDocument(actor: AuthContext, target: DocumentTarget, id: string, file: Buffer, fileName: string, contentType: string, documentId?: string) {
	const access = await getTarget(actor, target, id);
	if (!access.canManage) throw new ApiError(403, "DOCUMENT_MANAGEMENT_FORBIDDEN", "Only the handling institution or an administrator can upload or replace a report.");
	if (documentId) {
		const existing = await database.medicalDocument.findFirst({ where: { id: documentId, ...(target === "donor" ? { donorId: id } : { recipientId: id }), deletedAt: null } });
		if (!existing) throw new ApiError(404, "DOCUMENT_NOT_FOUND", "The report was not found.");
	} else if (!access.canUpload) {
		throw new ApiError(409, "DOCUMENT_UPLOAD_STAGE_CLOSED", target === "recipient" ? "Reports can be added after the recipient request is approved." : "Reports can be added after donor authorization is completed.");
	}
	if (!ALLOWED_TYPES.has(contentType)) throw new ApiError(415, "DOCUMENT_TYPE_NOT_ALLOWED", "Only PDF, JPEG, and PNG medical reports are accepted.");
	if (!Buffer.isBuffer(file) || file.length === 0) throw new ApiError(400, "DOCUMENT_EMPTY", "Select a non-empty report to upload.");
	if (file.length > MAX_FILE_SIZE) throw new ApiError(413, "DOCUMENT_TOO_LARGE", "Medical reports must be 10 MB or smaller.");
	if (!validFileSignature(file, contentType)) throw new ApiError(415, "DOCUMENT_CONTENT_INVALID", "The file contents do not match the selected PDF or image type.");
	const cleanName = safeFileName(fileName);
	const settings = storageSettings();
	const path = documentId
		? (await database.medicalDocument.findUniqueOrThrow({ where: { id: documentId }, select: { objectPath: true } })).objectPath
		: `${target}/${id}/${randomUUID()}`;
	await storageRequest(objectUrl(settings.url, settings.bucket, path, "object"), {
		method: "POST",
		headers: storageHeaders(settings.key, { "Content-Type": contentType, "x-upsert": "true" }),
		body: Uint8Array.from(file).buffer as ArrayBuffer,
	});
	const document = documentId
		? await database.medicalDocument.update({ where: { id: documentId }, data: { fileName: cleanName, contentType, fileSize: file.length }, select: { id: true, fileName: true, contentType: true, fileSize: true, updatedAt: true } })
		: await database.medicalDocument.create({ data: { ...(target === "donor" ? { donorId: id } : { recipientId: id }), bucket: settings.bucket, objectPath: path, fileName: cleanName, contentType, fileSize: file.length, uploadedById: actor.userId ?? null, institutionId: actor.institutionId ?? null }, select: { id: true, fileName: true, contentType: true, fileSize: true, createdAt: true, updatedAt: true } });
	await database.auditLog.create({ data: { actorId: actor.userId ?? null, actorInstitutionId: actor.institutionId ?? null, action: documentId ? "MEDICAL_REPORT_REPLACED" : "MEDICAL_REPORT_UPLOADED", entityType: target === "donor" ? "OrganDonor" : "OrganRecipient", entityId: id, metadata: { documentId: document.id } } });
	return document;
}

export async function deleteMedicalDocument(actor: AuthContext, target: DocumentTarget, requestId: string, documentId: string) {
	const access = await getTarget(actor, target, requestId);
	if (!access.canManage) throw new ApiError(403, "DOCUMENT_MANAGEMENT_FORBIDDEN", "Only the handling institution or an administrator can delete reports.");
	const document = await database.medicalDocument.findFirst({ where: { id: documentId, ...(target === "donor" ? { donorId: requestId } : { recipientId: requestId }), deletedAt: null } });
	if (!document) throw new ApiError(404, "DOCUMENT_NOT_FOUND", "The report was not found.");
	const settings = storageSettings();
	await storageRequest(objectUrl(settings.url, document.bucket, document.objectPath, "object"), { method: "DELETE", headers: storageHeaders(settings.key) });
	await database.medicalDocument.update({ where: { id: document.id }, data: { deletedAt: new Date() } });
	await database.auditLog.create({ data: { actorId: actor.userId ?? null, actorInstitutionId: actor.institutionId ?? null, action: "MEDICAL_REPORT_DELETED", entityType: target === "donor" ? "OrganDonor" : "OrganRecipient", entityId: requestId, metadata: { documentId } } });
	return { deleted: true };
}

export async function createMedicalDocumentDownload(actor: AuthContext, target: DocumentTarget, requestId: string, documentId: string) {
	await getTarget(actor, target, requestId);
	const document = await database.medicalDocument.findFirst({ where: { id: documentId, ...(target === "donor" ? { donorId: requestId } : { recipientId: requestId }), deletedAt: null }, select: { id: true, bucket: true, objectPath: true, fileName: true } });
	if (!document) throw new ApiError(404, "DOCUMENT_NOT_FOUND", "The report was not found.");
	const settings = storageSettings();
	const response = await storageRequest(objectUrl(settings.url, document.bucket, document.objectPath, "sign"), { method: "POST", headers: storageHeaders(settings.key, { "Content-Type": "application/json" }), body: JSON.stringify({ expiresIn: 60, download: document.fileName }) });
	const payload = await response.json() as { signedURL?: string; signedUrl?: string };
	const signedPath = payload.signedURL ?? payload.signedUrl;
	if (!signedPath) throw new ApiError(502, "DOCUMENT_SIGNING_FAILED", "Storage did not return a temporary download link.");
	const url = signedPath.startsWith("http") ? signedPath : `${settings.url}/storage/v1${signedPath.startsWith("/") ? signedPath : `/${signedPath}`}`;
	return { url, fileName: document.fileName };
}
