CRI Brokerage AI — Dropbox Integration & Deal Intelligence

Primary Document System

Dropbox is CRI Brokerage’s central document repository and primary source of truth for deal files, due diligence, offering materials, marketing assets, SOPs, and transaction documents.

Build Dropbox into the core architecture of the AI brokerage operating system.

The AI must be able to locate, read, organize, analyze, and reference authorized Dropbox files when working on buyers, sellers, listings, underwriting, escrow, and marketing.

Do not create a separate, competing document repository. Maintain Dropbox as the primary file storage system.

1. Dropbox Integration

Implement an authenticated Dropbox integration using the official Dropbox API and supported OAuth permissions.

Use MCP where a reliable, appropriately scoped integration exists.

Required capabilities:

* Browse authorized folders and subfolders.
* Search filenames and document content through an indexed search layer.
* Retrieve PDFs, Word documents, Excel files, CSVs, images, and other supported file formats.
* Extract relevant document text, financial tables, and metadata.
* Locate the latest approved version of a document.
* Retrieve authorized Dropbox sharing links.
* Detect file changes and synchronize document metadata.
* Create or update files only when the operation is explicitly authorized.
* Preserve existing folder structures and naming conventions.

Inspect the actual Dropbox structure before building mappings. Never assume a file exists or invent a Dropbox link.

2. Understand the Entire Deal Pipeline

The AI should understand how files relate to every stage of a brokerage transaction.

Seller Prospecting

Locate owner correspondence, property information, historical valuations, broker opinions of value, financial records, and prior outreach.

Listing Preparation

Locate rent rolls, trailing financials, operating statements, photographs, maps, surveys, utility information, and listing agreements.

Marketing

Locate offering memorandums, approved property descriptions, marketing photos, email templates, social media assets, and approved listing information.

Buyer Activity

Locate offering packages, confidentiality agreements, buyer questions, underwriting materials, tour information, and relevant correspondence.

Offers and Negotiations

Locate LOIs, counteroffers, purchase agreements, amendments, financial analyses, and transaction correspondence.

Due Diligence and Escrow

Locate executed contracts, title reports, surveys, utility records, insurance, environmental reports, leases, permits, inspection reports, and closing checklists.

Closing and Post-Closing

Locate closing statements, final transaction documents, approved sales announcements, and archived deal records.

3. Deal Knowledge Index

Build a searchable deal intelligence index connected to Dropbox, HubSpot, and email.

Each indexed document should record:

* Dropbox file ID and path.
* Property or transaction association.
* Document type.
* Version and modification date.
* Source and access permissions.
* Relevant deal stage.
* Extracted facts with source references.
* Confidentiality classification.

Support semantic search for questions such as:

“Find the latest rent roll for Lighthouse Resort.”

“Which documents are still outstanding on Ken Mar Gardens?”

“Find the approved offering memorandum for Tierra Buena.”

“Pull the best approved property photos for a LinkedIn listing post.”

“Find the SOP for sending a confidentiality agreement to a buyer.”

Always link findings to the original Dropbox source.

Never invent missing information.

4. Due Diligence Management

Build a document checklist and missing-items workflow for every active escrow.

The agent should:

1. Identify the transaction and current due diligence requirements.
2. Review available Dropbox documents.
3. Compare existing files against the transaction checklist.
4. Identify missing, outdated, incomplete, or inconsistent items.
5. Check relevant email conversations for documents already requested.
6. Draft concise requests for outstanding information.
7. Track who is responsible for each item.
8. Monitor deadlines and escalate critical issues.
9. Update the checklist as new documents arrive.

Do not assume a document is missing simply because it has an unexpected filename or is stored in a different folder.

Do not mark a document complete merely because a file exists. Verify the document actually satisfies the requirement.

5. SOP and Template Library

Index CRI’s operating procedures and templates.

When executing a workflow, retrieve the relevant approved SOP before taking action.

Examples:

* Buyer qualification.
* NDA and confidentiality procedures.
* Offering memorandum distribution.
* Property tour coordination.
* Seller valuation preparation.
* Listing launch procedures.
* LOI and purchase agreement workflows.
* Escrow opening and due diligence.
* Closing coordination.
* Marketing approvals.
* Social media publication.

Approved SOPs take precedence over general workflow preferences, subject to security and authorization requirements.

If an SOP is missing, outdated, or conflicts with current instructions, escalate the issue.

Do not autonomously rewrite approved SOPs. Prepare proposed revisions for review.

6. Marketing and Social Media Assets

Use Dropbox as the central approved media library.

Build the ability to:

* Find property photographs by listing.
* Identify approved marketing images.
* Retrieve offering memorandum graphics.
* Find company logos and brand assets.
* Reuse approved social media templates.
* Prepare LinkedIn and other social media drafts.
* Generate proposed listing announcements.
* Assemble marketing packages from approved assets.

Never substitute photographs from unrelated properties.

Never publish unapproved pricing, property information, confidential listings, or transaction announcements.

Do not modify original photographs or overwrite source files without approval.

7. Intelligent Document Processing

Support PDF, DOCX, XLSX, CSV, and image processing.

For financial documents, preserve spreadsheet formulas, financial periods, and source references.

Extract and reconcile:

* Rent roll income.
* Occupancy.
* Site counts.
* Operating expenses.
* NOI.
* Capital expenditures.
* Utility arrangements.
* Financing assumptions.

Flag conflicts between offering materials, rent rolls, financial statements, and email correspondence.

Do not silently treat historical or projected financial information as current actual results.

8. File Organization and Version Control

Respect CRI’s existing Dropbox structure.

Do not move, rename, overwrite, or delete existing files without authorization.

When proposing organization improvements, prepare a preview of the changes.

Use document IDs and version metadata to distinguish drafts, historical files, and final approved documents.

Maintain an audit log for all authorized file modifications.

9. Confidentiality and Access Control

Dropbox may contain highly sensitive buyer, seller, financial, and transaction information.

Enforce permissions at the document and transaction level.

A user’s access to the AI must not automatically grant access to every Dropbox file.

Never expose private Dropbox files through publicly accessible URLs.

Never share confidential due diligence materials with a buyer unless required agreements and authorizations have been verified.

Do not index secrets, credentials, or unnecessary personal information.

10. Integration with the Brokerage Dashboard

Add a document intelligence section to each property page.

Show:

* Offering memorandum.
* Rent roll.
* Financial statements.
* Property photographs.
* Due diligence folder.
* Executed documents.
* Missing items.
* Last document update.
* Relevant SOPs.
* Source links.

The AI should understand which documents are relevant to each stage of the deal and surface them without requiring Pierce to manually search Dropbox.

11. Continuous Synchronization

Implement Dropbox change detection using supported webhooks and reconciliation jobs.

When files are added or modified:

* Update the document index.
* Reprocess affected content when necessary.
* Update relevant deal knowledge.
* Check whether outstanding due diligence requests have been satisfied.
* Notify the appropriate workflow when a meaningful change occurs.

Do not continuously reprocess unchanged files.

Use stable Dropbox identifiers, revision metadata, and deduplication to avoid unnecessary API usage.

12. Implementation Priority

Build Dropbox integration early, before advanced buyer matching or autonomous marketing.

Start with read-only access.

First deliver a working demonstration where Claude can:

1. Identify an active property in HubSpot.
2. Locate its Dropbox deal folder.
3. Find the latest offering memorandum and rent roll.
4. Answer a financial question using verified document references.
5. Identify outstanding due diligence items.
6. Draft a relevant buyer or seller email.
7. Link the original source documents.
8. Escalate missing or conflicting information.

Once this works reliably, add approved write operations, marketing workflows, and automated document organization.

Success means the agent understands the deal, knows where the supporting documents live, and can use them to advance the transaction without Pierce manually locating every file.