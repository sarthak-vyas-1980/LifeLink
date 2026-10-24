import { findProjectRoot } from "../packages/rag/src/knowledge-sources";
import { queueKnowledgeSourceProcessing } from "../packages/rag/src/indexing";

async function main() {
  const root = findProjectRoot();
  const sourceKey = process.argv[2];
  console.log(`LifeLink RAG indexing started at ${root}.`);
  const outcomes = await queueKnowledgeSourceProcessing(sourceKey);
  for (const outcome of outcomes) {
    console.log(`${outcome.sourceKey}: ${outcome.status} (${outcome.chunkCount} chunks)`);
  }
  console.log(`Finished. Processed ${outcomes.length} approved source(s).`);
}

main().catch((error: unknown) => {
  console.error("LifeLink RAG indexing failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
