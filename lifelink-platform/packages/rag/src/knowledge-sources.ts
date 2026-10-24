import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { KnowledgeSourceDefinition, KnowledgeChunkInput, KnowledgePage, LifeLinkRole } from "./types";

const ALL_ROLES: LifeLinkRole[] = [
  "USER",
  "ADMINISTRATOR",
  "HOSPITAL_USER",
  "BLOOD_BANK_USER",
  "ORGAN_CENTRE_USER",
];

/**
 * This allow-list is intentionally code-owned. Uploaded files and arbitrary paths are
 * not automatically trusted or indexed. Add a source here only after review/approval.
 */
export const APPROVED_KNOWLEDGE_SOURCES: KnowledgeSourceDefinition[] = [
  {
    sourceKey: "medical-encyclopedia",
    relativePath: "docs/pdf-knowledge/Medical_book.pdf",
    title: "Medical Encyclopedia (General Education)",
    sourceType: "MEDICAL_REFERENCE",
    visibilityRoles: ALL_ROLES,
    description: "General medical education reference. Not for diagnosis, treatment, eligibility, transfusion, or allocation decisions.",
  },
  {
    sourceKey: "lifelink-sample-data",
    relativePath: "docs/pdf-knowledge/LifeLink_Sample_Data_and_Test_Fixtures(1).pdf",
    title: "LifeLink Sample Data and Test Fixtures (Fictional)",
    sourceType: "SYNTHETIC_DATASET",
    visibilityRoles: ALL_ROLES,
    description: "Fictional test records only; never current operational data or for medical decisions.",
  },
  {
    sourceKey: "faq-overview",
    relativePath: "docs/knowledge/lifelink-overview-and-faq.md",
    title: "LifeLink Overview and FAQ",
    sourceType: "FAQ",
    visibilityRoles: ALL_ROLES,
    description: "Product purpose, assistant scope, and frequently asked questions.",
  },
  {
    sourceKey: "blood-request-guide",
    relativePath: "docs/knowledge/blood-request-guide.md",
    title: "Blood Request and Matching Guide",
    sourceType: "WORKFLOW",
    visibilityRoles: ALL_ROLES,
    description: "Blood request states, matching, offers, reservations, and limitations.",
  },
  {
    sourceKey: "organ-coordination-guide",
    relativePath: "docs/knowledge/organ-coordination-guide.md",
    title: "Organ Coordination Guide",
    sourceType: "WORKFLOW",
    visibilityRoles: ["USER", "ADMINISTRATOR", "HOSPITAL_USER", "ORGAN_CENTRE_USER"],
    description: "Organ donor consent, recipient requirements, potential matches, offers, and procurement.",
  },
  {
    sourceKey: "privacy-role-access",
    relativePath: "docs/knowledge/privacy-and-role-access.md",
    title: "Privacy, Roles, and Safe Use",
    sourceType: "POLICY",
    visibilityRoles: ALL_ROLES,
    description: "Role-based access, privacy, state-changing actions, and safety boundaries.",
  },
  {
    sourceKey: "administrator-institution-guide",
    relativePath: "docs/knowledge/administrator-guide.md",
    title: "Administrator and Institution Workflow Guidance",
    sourceType: "POLICY",
    visibilityRoles: ["ADMINISTRATOR", "HOSPITAL_USER", "BLOOD_BANK_USER", "ORGAN_CENTRE_USER"],
    description: "Institutional information, inventory management, auditability, and source maintenance.",
  },
  {
    sourceKey: "internal-srs",
    relativePath: "docs/requirements/SRS.md",
    title: "LifeLink SRS — RAG Scope Summary",
    sourceType: "SRS",
    visibilityRoles: ["ADMINISTRATOR"],
    description: "Administrator-only summary of RAG-specific SRS requirements and implementation constraints; consult the full submitted SRS for complete requirements.",
  },
  {
    sourceKey: "organ-coordination-architecture",
    relativePath: "docs/architecture/organ-coordination-flow.md",
    title: "Organ Coordination Implementation Flow",
    sourceType: "ARCHITECTURE",
    visibilityRoles: ["ADMINISTRATOR", "ORGAN_CENTRE_USER", "HOSPITAL_USER"],
    description: "Current implementation flow and API/authorization boundaries.",
  },
  {
    sourceKey: "blood-request-state",
    relativePath: "docs/architecture/blood-request-state.md",
    title: "Blood Request State Model",
    sourceType: "ARCHITECTURE",
    visibilityRoles: ["ADMINISTRATOR", "HOSPITAL_USER", "BLOOD_BANK_USER"],
    description: "Implemented blood-request states and alternate outcomes.",
  },
];

export interface LoadedKnowledgeSource {
  definition: KnowledgeSourceDefinition;
  absolutePath: string;
  content?: string;
  checksum: string;
  pages?: KnowledgePage[];
}

export async function extractPdfPages(input: string | Uint8Array): Promise<KnowledgePage[]> {
  const data = typeof input === "string" ? new Uint8Array(await readFile(input)) : input;
  if (data.length < 8 || new TextDecoder().decode(data.slice(0, 5)) !== "%PDF-") {
    throw new Error("The approved PDF is empty or does not have a valid PDF header.");
  }
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    const pages = result.pages.map(({ num, text }) => ({ pageNumber: num, content: text.trim() }))
      .filter((page) => page.content.length > 0);
    if (!pages.length) throw new Error("The approved PDF contains no extractable text; OCR may be required.");
    return pages;
  } catch (error) {
    if (error instanceof Error && error.message.includes("no extractable text")) throw error;
    throw new Error("The approved PDF could not be read or contains no extractable text; scanned PDFs require OCR.");
  } finally {
    await parser.destroy();
  }
}

export function chunkDocument(content: string, maxChars = 2400, overlapChars = 280): Array<{ content: string; heading?: string }> {
  const normalized = content.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!normalized) return [];
  if (maxChars < 500 || overlapChars < 0 || overlapChars >= maxChars / 2) {
    throw new Error("Invalid chunking limits.");
  }

  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: Array<{ content: string; heading?: string }> = [];
  let buffer = "";

  const emit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)];
    chunks.push({ content: text, ...(headings.length ? { heading: headings[headings.length - 1][1].trim() } : {}) });
  };

  const flush = () => {
    emit(buffer);
    buffer = "";
  };

  const emitLongParagraph = (paragraph: string) => {
    let cursor = 0;
    while (cursor < paragraph.length) {
      let end = Math.min(cursor + maxChars, paragraph.length);
      if (end < paragraph.length) {
        const breakAt = paragraph.lastIndexOf(" ", end);
        if (breakAt > cursor + Math.floor(maxChars * 0.6)) end = breakAt;
      }
      const piece = paragraph.slice(cursor, end).trim();
      if (piece) emit(piece);
      // Stop after the final piece. Otherwise the overlap tail would be processed forever.
      if (end >= paragraph.length) break;
      cursor = Math.max(end - overlapChars, cursor + 1);
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      emitLongParagraph(paragraph);
      continue;
    }

    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }

    const previous = buffer;
    flush();
    const overlap = previous.slice(Math.max(0, previous.length - overlapChars)).trim();
    const overlappedCandidate = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
    // Keep the chunk-size contract even when the overlap would push a paragraph over the limit.
    buffer = overlappedCandidate.length <= maxChars ? overlappedCandidate : paragraph;
  }
  flush();

  // Very short fragments add little retrieval value.
  return chunks.filter((chunk) => chunk.content.trim().length >= 80);
}

export function findProjectRoot(start = process.cwd()): string {
  const candidates = [
    process.env.LIFELINK_PROJECT_ROOT,
    start,
    path.resolve(start, "../../"),
    path.resolve(start, "../"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (existsSync(path.join(resolved, "docs", "knowledge", "lifelink-overview-and-faq.md"))) {
      return resolved;
    }
  }
  throw new Error("Could not locate the LifeLink project root. Set LIFELINK_PROJECT_ROOT in the API environment.");
}

export async function loadApprovedKnowledgeSources(
  root = findProjectRoot(),
): Promise<LoadedKnowledgeSource[]> {
  const loaded: LoadedKnowledgeSource[] = [];
  const resolvedRoot = path.resolve(root);
  await access(resolvedRoot);
  for (const definition of APPROVED_KNOWLEDGE_SOURCES) {
    const absolutePath = path.resolve(resolvedRoot, definition.relativePath);
    if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Approved source path escaped the knowledge root: ${definition.sourceKey}`);
    }
    let content: string | undefined;
    let pages: KnowledgePage[] | undefined;
    let checksum: string;
    try {
      if (path.extname(absolutePath).toLowerCase() === ".pdf") {
        const bytes = new Uint8Array(await readFile(absolutePath));
        checksum = createHash("sha256").update(bytes).digest("hex");
        pages = await extractPdfPages(bytes);
      } else {
        content = await readFile(absolutePath, "utf8");
        checksum = createHash("sha256").update(content).digest("hex");
      }
    } catch {
      throw new Error(`Approved knowledge source is missing: ${definition.relativePath}`);
    }
    if (content !== undefined && !content.trim()) throw new Error(`Approved knowledge source is empty: ${definition.relativePath}`);
    loaded.push({ definition, absolutePath, content, checksum, pages });
  }
  return loaded;
}

export function buildChunkInputs(source: LoadedKnowledgeSource): KnowledgeChunkInput[] {
  const chunks: Array<{ content: string; heading?: string; pageNumbers?: number[] }> = source.pages
    ? source.pages.flatMap((page) => chunkDocument(page.content).map((chunk) => ({ ...chunk, pageNumbers: [page.pageNumber] })))
    : chunkDocument(source.content ?? "");
  return chunks.map((chunk, chunkIndex) => ({
    sourceKey: source.definition.sourceKey,
    title: source.definition.title,
    sourceType: source.definition.sourceType,
    relativePath: source.definition.relativePath,
    chunkIndex,
    content: chunk.content,
    heading: chunk.heading,
    version: source.checksum,
    visibilityRoles: source.definition.visibilityRoles,
    ...(chunk.pageNumbers ? { pageNumbers: chunk.pageNumbers } : {}),
  }));
}

