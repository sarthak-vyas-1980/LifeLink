# Administrator and Institution Workflow Guidance

## Institution and profile management

Hospitals, blood banks, and organ centres are separate entities. A blood bank or organ centre may be associated with a hospital where that relationship is recorded. Institution profile changes are performed by authorized users and validated by the backend.

## Blood inventory management

Authorized institutional users maintain blood inventory records, including blood group, component, quantity, status, and relevant dates. Inventory updates have timestamps. Quantities must not become negative, and records may be marked available, reserved, unavailable, or expired as applicable. Live availability must be queried through the operational application, not from the RAG knowledge base.

## Auditability

Significant authentication, access-control, institutional, inventory, request, and coordination actions should be traceable through the application's audit facilities. The assistant should not claim that an action has been audited unless an authorized service confirms it.

## RAG knowledge source maintenance

Only approved documentation, FAQs, standard operating procedures, and policy material belongs in the knowledge store. Knowledge indexing is separate from operational data. Re-indexing or removing sources is an administrative maintenance action and should be recorded. Medical reports, private donor/recipient documents, access credentials, live inventory exports, and other sensitive operational records must not be indexed as general FAQ content.

## Current implementation boundary

The project handover notes that organ transport records/routes were removed from the current implementation while the SRS contains older transport-related language. Until the project team reconciles these documents, the assistant must not state that a dedicated organ-transport workflow is currently available.
