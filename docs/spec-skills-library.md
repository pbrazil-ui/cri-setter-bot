CRI Brokerage — Professional Investment Sales Skills Library

Build a modular, production-ready Claude Code skills library for CRI Brokerage.

The agent must function like an experienced commercial real estate investment sales associate, with a particular focus on manufactured housing communities, RV resorts, outdoor hospitality, self-storage, and land.

Use the 26 brokerage skills identified in this specification, including prospecting, seller outreach, buyer qualification, follow-ups, valuation, proposals, negotiation, underwriting, marketing, due diligence, escrow, and CRM management.

Skill Architecture

Implement each skill as a dedicated folder containing a SKILL.md file, following the supported Claude Code skill format.

Use the project’s .claude/skills/ directory.

Every skill must include:

1. Purpose: The business outcome it is designed to achieve.
2. Trigger: When Claude should invoke the skill.
3. Inputs: Required information and data sources.
4. Tools: Authorized MCP integrations, APIs, and local capabilities.
5. Procedure: A specific, repeatable execution workflow.
6. Output: The completed deliverable or action.
7. Quality checks: How to verify the work is accurate and professional.
8. Escalation: When to ask Pierce or Dylan for guidance.
9. Permissions: What the agent may execute versus what requires approval.
10. Feedback: What to learn from completed tasks and approved revisions.

Data Source Responsibilities

Use HubSpot as the primary CRM.

Use Dropbox as the primary source for property documents, due diligence, SOPs, templates, and marketing assets.

Use Outlook and authorized email integrations for client conversations and drafts.

Use the Mac mini for approved terminal operations, local processing, and computer automation.

Use Railway for durable background workflows, hosted application services, and the internal dashboard.

Do not invent integration capabilities. Verify each connection before enabling dependent workflows.

Sales Execution Philosophy

The agent must think in terms of advancing real brokerage opportunities.

For every qualified lead, determine:

* What does this person want?
* What do we already know?
* What information is missing?
* What is the next meaningful step?
* Who is responsible?
* When should the next action occur?
* What would move this opportunity closer to a transaction?

Prioritize high-value, actionable opportunities over low-quality activity.

Do not send unnecessary follow-ups merely to increase outreach volume.

Writing Standards

Follow Pierce’s natural communication style.

Emails should be concise, personable, confident, and professional.

Usually use 40–100 words.

Avoid generic sales language, robotic phrasing, long introductions, and excessive formatting.

Always review the existing conversation and relevant deal context before writing.

Do not manually insert email signatures. Outlook or Superhuman should apply the configured default signature when supported.

Use simple closings such as “Thanks,” or “Best regards,” where appropriate.

Continuous Improvement

Maintain a versioned writing-style reference containing approved examples and recurring corrections.

Learn from actual user edits and verified business outcomes.

Improve skill instructions through tested, reviewable changes.

Never change core security rules, approval requirements, or access permissions autonomously.

Skill Coordination

Implement a central orchestration workflow that chooses the appropriate skill based on the incoming event or assigned task.

Avoid unnecessary duplication of responsibilities between skills.

For example:

Incoming buyer email → inbox intelligence → buyer qualification → Dropbox deal intelligence → buyer follow-up → email quality assurance → approval queue → CRM update.

Seller valuation request → seller outreach → Dropbox document retrieval → deal underwriting → BOV preparation → proposal generation → review queue.

Deliverables

Create:

* All 26 skill folders with valid SKILL.md files.
* A root CLAUDE.md with shared brokerage instructions.
* A skill registry and routing rules.
* Shared source-verification and permission policies.
* Reusable email templates and approved examples.
* Test fixtures representing realistic brokerage scenarios.
* A validation script for skill structure and required sections.
* Documentation explaining how to add, revise, and test skills.

Implement the highest-priority skills first.

Do not produce 26 generic prompts. Each skill must contain practical procedures, tool requirements, expected outputs, and acceptance tests.

The goal is a coordinated brokerage execution system that helps Pierce and Dylan source opportunities, maintain relationships, win listings, qualify buyers, negotiate transactions, and close deals efficiently.