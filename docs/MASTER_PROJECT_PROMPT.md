# MASTER PROJECT PROMPT — EXPERTMOTION

## 1. Role and Mission

Act as a multidisciplinary senior engineering team responsible for designing, documenting, and preparing the implementation of **Expertmotion**, a local-first, AI-powered motion video creation application.

Operate with the combined expertise of:

- Principal Software Architect
- Senior Product Manager and Business Analyst
- Frontend, Backend, and Desktop Application Engineers
- AI Agent Architect
- Remotion Specialist
- UI/UX Designer
- Database and Security Engineer
- DevSecOps Engineer
- QA and Test Automation Engineer
- Technical Writer

Transform the product vision and reference materials into a comprehensive, internally consistent, implementation-ready engineering project.

Documentation must be sufficiently detailed for different coding agents and models to continue development without losing critical context, inventing requirements, or making incompatible architectural decisions.

Do not produce generic templates filled with vague statements. Specify concrete requirements, decisions, workflows, interfaces, dependencies, acceptance criteria, and actionable implementation tasks.

**The product name is always Expertmotion.** Other names appearing in reference documents, screenshots, libraries, examples, or external projects must not be mistaken for the product name.

## 2. Product Vision

Expertmotion enables beginners, independent content creators, and small businesses to create polished motion videos through an intuitive, AI-assisted visual editor.

Users should not need to understand JavaScript, React, Node.js, npm, or Remotion internals.

The intended workflow is:

1. Launch Expertmotion from a desktop executable.
2. Open the local web-based editor.
3. Complete guided onboarding.
4. Connect an AI provider and select models.
5. Import video, audio, and image assets using drag-and-drop.
6. Arrange assets and select visual styles.
7. Discuss creative ideas with a Brainstorming Agent.
8. Let an Editor Agent translate instructions and selections into structured editing operations.
9. Review the composition through the preview and timeline.
10. Render and export a finished video locally.

The application should be beginner-friendly while supporting sophisticated motion graphics.

Use familiar interaction patterns from modern creative software as inspiration, but establish a distinct visual identity. Do not copy another product's interface pixel-for-pixel.

## 3. Mandatory Reference Materials

Inspect the following resources before finalizing specifications.

### Local files

- `docs/Remason Editor.png` — primary visual reference for the proposed editor. Verify the exact filename and path before proceeding.
- `docs/Remotion-untuk-Pemula.pdf` — introductory Remotion guide and reference for identifying features to automate.

Treat these materials as references, not authoritative architectural specifications.

### Official Remotion resources

- Main website: https://www.remotion.dev/
- Learning resources: https://www.remotion.dev/learn
- Elements: https://www.remotion.dev/elements
- Source repository: https://github.com/remotion-dev/remotion

Explore the official navigation, documentation, relevant learning materials, composition capabilities, rendering requirements, licensing, and technical dependencies.

Verify current capabilities against official documentation. Do not assume every feature is available under every license, works offline, or can be commercially redistributed without additional conditions.

Record source URLs, access dates, licensing considerations, and technical findings.

If a reference is unavailable, document that limitation explicitly. Never claim to have inspected material you have not actually examined.

## 4. Core Product Principles

### 4.1 Local-first execution

- The editor and core orchestration logic run on the user's computer.
- Project data and media remain local by default.
- Rendering should occur locally whenever technically feasible.
- Users must not need to deploy a server.
- External AI providers are accessed only when configured and authorized.
- Explain which information is transmitted to external providers.
- Do not introduce cloud dependencies for core editing without explicit justification.

### 4.2 Zero-manual-runtime installation

The primary distribution target is a Windows desktop executable, with possible future support for other operating systems.

Users must not manually install Node.js, Python, C++, npm, or other development dependencies.

Package the required runtime components and native dependencies wherever licensing and distribution constraints permit.

Evaluate desktop technologies based on:

- Installation simplicity
- Runtime compatibility
- Local service lifecycle
- Rendering performance
- Memory consumption
- Native dependencies
- Updates and recovery
- Security boundaries
- Package size
- Commercial distribution rights

Compare Electron, Tauri, and other realistic alternatives. Document the rationale for the final selection.

### 4.3 Intellectual property protection

Minimize exposure of proprietary source code, orchestration logic, internal prompts, and implementation details.

Design defense in depth using appropriate techniques such as:

- Compiled or bundled components
- Selective obfuscation
- Removal of production source maps and development artifacts
- Separation of public frontend assets from sensitive logic
- Secure credential storage
- Signed executables and verified updates
- Dependency integrity checks
- Restricted local service interfaces
- Process isolation and least privilege
- Integrity validation where appropriate

Never embed developer-owned API secrets in the application.

Use operating-system credential facilities where available. Do not store encryption keys alongside encrypted data.

Explain realistic protection boundaries. A distributed desktop application cannot be guaranteed to be impossible to reverse-engineer, particularly by an administrator or owner of the computer.

### 4.4 Beginner-first design

Users select what they want instead of writing code, configuring React components, or constructing JSON payloads.

Hide technical details unless they are needed for troubleshooting.

## 5. Required Documentation

Inspect the repository before creating files. Follow existing conventions and avoid duplicate sources of truth.

Create the following documents or clearly justified equivalents.

### Product and business

1. `docs/PRD.md` — Product Requirements Document.
2. `docs/BRD.md` — Business Requirements Document.
3. `docs/FRD.md` — Functional Requirements Document.
4. `docs/SRS.md` — Software Requirements Specification.
5. `docs/UXRD.md` — User Experience Requirements Document.
6. `docs/ROADMAP.md` — Milestones and release strategy.
7. `docs/BLUEPRINT.md` — End-to-end product blueprint.

### Architecture and technical design

8. `docs/ARCHITECTURE.md`
9. `docs/TRD.md`
10. `docs/DATABASE_SCHEMA.md`
11. `docs/API_SPECIFICATION.md`
12. `docs/AI_WORKFLOW.md`
13. `docs/AGENT_DESIGN.md`
14. `docs/SECURITY.md`
15. `docs/THREAT_MODEL.md`
16. `docs/VULNERABILITY_CHECKLIST.md`
17. `docs/DEPLOYMENT_AND_PACKAGING.md`
18. `docs/PERFORMANCE.md`

### Engineering process

19. `docs/DEFINITION_OF_DONE.md`
20. `docs/QA_PROCESS.md`
21. `docs/TEST_PLAN.md`
22. `docs/DEVELOPMENT_WORKFLOW.md`
23. `docs/STAGE_MANAGEMENT.md`
24. `docs/DECISIONS.md`
25. `docs/RISKS_AND_ASSUMPTIONS.md`

### Coding-agent instructions and continuity

26. `AGENTS.md` — canonical repository-wide instructions.
27. `CLAUDE.md` — Claude Code-specific instructions that reference canonical rules.
28. `agent.md` — create only if it has a distinct purpose; avoid conflicting duplicates.
29. `process.md` — execution log, current stage, blockers, and next actions.
30. `memory.md` — durable project context and confirmed decisions.
31. `SYSTEM_PROMPT.md` — versioned runtime AI agent instructions.
32. `docs/AGENT_SKILLS.md`
33. `docs/HOOKS_AND_GUARDRAILS.md`
34. `docs/MCP_AND_TOOLING.md`

### UI/UX

35. `docs/UI_UX_SPECIFICATION.md`
36. `docs/USER_FLOWS.md`
37. `docs/EDITOR_INTERACTION_MODEL.md`
38. `docs/ACCESSIBILITY_AND_I18N.md`

Create additional documents when justified. Do not create empty files merely to satisfy a checklist.

If a document is deferred, record why, its dependencies, and when it must be completed.

Distinguish requirements, plans, implemented functionality, and unresolved decisions.

## 6. Documentation Quality and Traceability

Assign stable requirement identifiers, such as:

- `PRD-001`
- `FR-001`
- `NFR-001`
- `SEC-001`
- `UX-001`
- `AI-001`
- `QA-001`

Include the following wherever applicable:

- Description and rationale
- Priority
- Dependencies
- Acceptance criteria
- Failure conditions
- Security and privacy implications
- Verification method
- Implementation status

Use MoSCoW prioritization or an equivalent system.

Maintain traceability between business objectives, requirements, architecture, implementation tasks, and tests.

Architectural decisions must document the problem, alternatives, selected solution, rationale, trade-offs, and consequences.

Never claim a build, test, security review, or feature succeeded without actual verification.

## 7. Proposed Editor Interface

Use `docs/Remason Editor.png` as the primary visual reference.

Inspect the image at full resolution. Convert its visible structure into explicit UI specifications. Document any assumptions where the image does not define behavior.

### 7.1 Top navigation

Provide four primary sections:

- **File**
- **Home**
- **Design**
- **Tools**

**File** should include:

- New project
- Open project
- Save
- Save As
- Import assets
- Export video
- Project settings
- Recent projects
- Recovery and error handling

**Home** should include:

- Add text
- Font family
- Font size
- Font weight and style
- Text color
- Alignment
- Text variants
- Text styling presets

**Design** should include:

- Transitions
- Captions
- Backgrounds
- Motion presets
- Shapes and graphic elements
- Easing
- Visual effects
- Audio-related design options

**Tools** should include:

- Voice generation
- Music generation
- Thumbnail generation
- Caption generation
- Hashtag suggestions

For every command, define its behavior, inputs, outputs, agent instruction, validation, and error handling.

Prevent destructive operations from silently overwriting unrelated settings.

### 7.2 Left column — Creative library and asset management

Provide:

- Preview and discovery of creative options
- Asset upload and management
- Drag-and-drop import
- File listing and thumbnails
- Asset metadata
- Asset selection and ordering
- Sequence assignment and insertion
- Search and filtering where useful
- Loading, empty, unsupported-file, and error states

Users must be able to preview transitions, captions, backgrounds, motion presets, shapes, easing, visual effects, and audio options before applying them.

Translate selections into structured edit intents.

Allow users to establish the intended sequence order before inserting imported assets into the composition.

Document supported formats, codecs, file-size constraints, and failure cases.

### 7.3 Center column — Preview and timeline

The upper area contains the main composition preview.

Provide:

- Play and pause
- Playhead and time display
- Total duration
- Aspect ratio and resolution indicators
- Loading and rendering states
- Error and recovery feedback

Below the preview, display a timeline or structured sequence view representing:

- Video clips
- Audio tracks
- Text and captions
- Transitions
- Motion elements
- Visual effects
- Backgrounds
- AI-generated assets
- Other composition elements

Prioritize a reliable timeline representation over a fully featured professional nonlinear editor.

Explicitly define supported interactions such as selection, playback scrubbing, sequence inspection, and any limited reordering or trimming included in scope.

The user should not need to manually configure every composition element, but the internal representation must remain structured, inspectable, and recoverable.

AI-generated changes must not overwrite unrelated edits or destroy previous project state.

### 7.4 Right column — AI and output controls

Organize this area into three sections:

1. Brainstorming Agent
2. Editor Agent
3. Output and rendering settings

Define minimum supported desktop dimensions, panel resizing, collapse behavior, and responsive rules.

## 8. AI Agent Architecture

Design an explicit, controlled workflow. Use multiple agents only when separate responsibilities, permissions, or model selection justify the added complexity.

### 8.1 Brainstorming Agent

Responsibilities:

- Understand creative objectives.
- Ask clarifying questions when necessary.
- Suggest concepts, styles, and story structures.
- Help organize assets and narrative order.
- Propose composition changes.
- Explain ideas in beginner-friendly language.
- Send approved or sufficiently specified edit requests to the Editor Agent.

Allow independent model selection.

Maintain conversation context without unnecessarily resending the entire conversation to every provider request.

### 8.2 Editor Agent

Translate user intentions into executable, validated composition changes.

Inputs include:

- User instructions
- Brainstorming Agent recommendations
- UI selections
- Design presets
- Imported assets and metadata
- Project and composition state
- Output settings
- Supported application capabilities

Examples of operations:

- Apply transitions to selected clips.
- Add text with specified styling.
- Apply a background or motion preset.
- Generate captions.
- Add audio.
- Change aspect ratio.
- Adjust timing and sequence order.
- Update rendering settings.

Do not give the agent vague instructions when structured selection data already exists.

### 8.3 Structured edit-intent pipeline

Implement this pipeline:

1. Capture the user action.
2. Create a typed edit-intent object.
3. Attach project, sequence, and asset references.
4. Validate against the supported feature catalog.
5. Resolve conflicts with current composition state.
6. Rewrite the request into a complete execution instruction when an LLM is needed.
7. Generate a structured edit plan.
8. Validate the plan against schemas and capability rules.
9. Show a preview or request confirmation when appropriate.
10. Execute through controlled application tools.
11. Update composition state and timeline.
12. Validate the result.
13. Report success or a recoverable error.
14. Persist state and relevant execution metadata.

The LLM must not be the sole authority for enforcing application invariants.

Use deterministic application code for validation, ordering, dependencies, conflict resolution, and state updates.

Define typed schemas for intents, plans, operations, results, errors, and rollback information.

### 8.4 Conflict prevention

Implement:

- Project and sequence versioning
- Operation dependencies
- Conflict detection
- Idempotency where applicable
- Transactional state updates
- Safe retries
- Cancellation
- Undo and redo
- Rollback for failed operations
- Pre- and post-execution validation
- Stale-plan detection
- Confirmation for destructive changes

For example, if two operations modify the same clip boundary, detect and resolve the conflict predictably.

Never silently replace unrelated styling, audio, timing, or user-selected properties.

### 8.5 Tool security

Agents must use narrow, documented application tools rather than unrestricted filesystem or shell access.

The Editor Agent may request supported operations, but deterministic application code validates and executes them.

Never execute arbitrary LLM-generated code with unrestricted local privileges.

Evaluate MCP against typed internal APIs. MCP is optional unless it provides a concrete benefit to the MVP.

Hooks should enforce real security and quality controls.

Distinguish development-time coding-agent skills from runtime AI capabilities in Expertmotion.

## 9. AI Providers and Model Configuration

Evaluate integrations for:

- OpenRouter
- OpenAI
- Anthropic
- Google Gemini

Verify current APIs, authentication, model identifiers, structured-output capabilities, streaming, terms, and pricing.

The onboarding workflow should allow users to:

1. Select a provider.
2. Configure API credentials.
3. Validate the connection.
4. Retrieve or select supported models.
5. Assign a model to the Brainstorming Agent.
6. Assign a model to the Editor Agent.
7. Configure optional budget and usage limits.
8. Test the configuration.
9. Save settings securely.

Display model capabilities, approximate costs when reliable pricing is available, context limitations, and usage information when supported.

Do not claim exact cost or token reporting when the provider does not expose sufficient data.

Implement timeouts, rate-limit handling, retries, structured errors, and graceful failure.

Never make the product dependent on a single provider.

Treat provider responses as untrusted input and validate all proposed operations.

## 10. Remotion Integration

Remotion is the underlying composition and rendering technology, not the product interface.

Build an abstraction layer between the UI, AI orchestration, project model, and Remotion.

The user should not need to know that Remotion exists.

Use this pipeline:

**User Interface → Edit Intent → Validated Edit Plan → Composition Model → Remotion Adapter → Preview and Render → Output Validation**

Document:

- Relevant Remotion APIs and primitives
- Suitable composition patterns
- Composition data structures
- Sequence and timing management
- Transitions and motion presets
- Text and captions
- Audio integration
- Image and video assets
- Preview and rendering behavior
- Rendering concurrency and resources
- Error handling and recovery
- Output validation
- Supported formats and codec dependencies
- Offline boundaries
- Licensing and commercial redistribution

Build reusable, parameterized composition templates and effects.

Prefer selecting and configuring approved templates over generating arbitrary React code for every operation.

If dynamic code generation is unavoidable, define strict isolation, validation, compilation, and execution boundaries.

Verify compatibility with the chosen Remotion version and packaging model.

Test preview-to-export parity. Do not assume browser preview and final rendering behave identically.

## 11. Local Database and Storage

Store project information locally by default.

Design a schema covering:

- Projects
- Project settings
- Sequences and compositions
- Assets and metadata
- Timeline elements
- Tracks or layers
- Design presets
- Edit intents
- Agent plans and operation history
- Conversations
- Provider configurations
- Model assignments
- Usage and cost estimates
- Rendering jobs
- Rendered outputs
- User preferences
- Application settings
- Schema migrations
- Recovery checkpoints

Protect API credentials using an appropriate secure mechanism rather than ordinary plaintext database fields.

Avoid storing large media files directly in the database without justification.

Evaluate a local relational database, filesystem media storage, and metadata index.

Define:

- Keys and relationships
- Constraints and indexes
- Transactions
- Migrations
- Backup and restore
- Crash recovery
- Data retention
- Project portability
- Disk management
- Schema versioning
- Encryption and key management

Handle unexpected shutdowns, failed renders, interrupted AI requests, and incomplete edits.

Do not claim that encryption makes local data inaccessible to the device owner.

## 12. Desktop Packaging and Runtime Security

The executable is the user's entry point to Expertmotion.

Bundle required frontend, backend or local service, runtime, rendering dependencies, and native libraries where permitted.

Define:

- Installation and launch lifecycle
- Local service startup and shutdown
- Port allocation or alternative local communication
- Desktop-to-service authentication
- Localhost origin and request protections
- Cross-origin restrictions
- CSRF and request-forgery defenses where applicable
- Local API authorization
- Filesystem restrictions
- File import validation
- Dependency integrity
- Update signing and verification
- Crash diagnostics
- Recovery after interrupted updates
- Production build hardening
- Uninstall and data-retention behavior

Do not expose an unauthenticated local control interface.

Do not assume localhost binding alone is sufficient protection.

Verify compatibility between the selected desktop shell, rendering engine, and native dependencies.

The objective is a self-contained installation experience and realistic IP protection, not perfect secrecy.

## 13. Output and Rendering Settings

### Aspect ratios

Support common presets:

- 16:9 landscape
- 9:16 portrait
- 1:1 square
- 4:5
- 5:4
- 4:3
- 3:4

Evaluate additional formats according to user demand.

Clearly distinguish width-to-height notation and provide a visual orientation preview.

### Resolution

Provide presets such as:

- HD / 720p
- Full HD / 1080p
- 2K with a precisely defined output profile
- 4K / 2160p

Define exact dimensions for each supported preset and aspect ratio.

### Frame rate

Support practical presets such as 24, 25, 30, 50, and 60 FPS, subject to rendering compatibility.

### Performance profiles

Consider:

- Standard
- Accelerated
- Turbo

Map these labels to documented resource-management and rendering policies. Do not imply that they magically increase hardware capability.

Before rendering, validate available disk space, memory pressure, dimensions, and relevant resource constraints.

Provide progress, cancellation, estimated remaining time when supportable, error recovery, and output-location controls.

## 14. Hardware Monitoring

Evaluate lightweight monitoring for:

- CPU utilization
- Available system memory
- Process memory
- Disk capacity and free space
- GPU availability where detectable
- Rendering workload
- Background tasks

Use the results to inform safe defaults and warn users about resource-intensive operations.

Do not require a dedicated GPU unless a feature explicitly depends on one.

Distinguish CPU-based rendering from GPU acceleration available in particular configurations.

Document monitoring overhead, privacy, and fallback behavior.

## 15. AI-Powered Creative Tools

The Tools menu should support:

- Voiceovers
- Music
- Thumbnails
- Captions
- Hashtags

Prioritize Indonesian and English.

Evaluate open-source and locally runnable models based on:

- Licensing and redistribution
- Commercial-use rights
- Hardware requirements
- Model size
- Language quality
- Inference speed
- Offline availability
- Dependency footprint
- Packaging complexity
- Maintenance status

Do not assume all open-source models allow unrestricted commercial use.

Separate local capabilities from external API integrations and separately downloaded models.

Prioritize a practical, testable subset for the MVP.

Evaluate caption generation, voiceover integration, and thumbnail composition according to user value and technical feasibility.

Provide fallback behavior when a model is unavailable or hardware is insufficient.

## 16. UI/UX and Interaction Rules

Users primarily select, preview, and describe what they want.

The application translates choices into validated operations.

Preserve the distinction between:

- User preference
- Proposed AI interpretation
- Approved edit plan
- Executed operation
- Verified composition state

Define a consistent design system covering typography, colors, spacing, layout, icons, buttons, tooltips, shortcuts, dialogs, notifications, loading indicators, empty states, error states, accessibility, and responsive behavior.

For each significant UI action, specify:

1. User action.
2. Application response.
3. Structured edit intent.
4. Agent involvement, if required.
5. State changes.
6. Preview updates.
7. Timeline updates.
8. Persistence behavior.
9. Error handling.
10. Undo or recovery.

Do not send trivial formatting changes to an LLM when deterministic operations suffice.

For example, selecting a known font size should create a typed operation directly. Use the LLM for broader creative interpretation, ambiguity resolution, and complex composition planning.

This hybrid approach reduces latency, cost, model errors, and token usage.

## 17. MVP Scope

### P0 — Essential MVP

1. Packaged desktop application without manual runtime installation.
2. Local Expertmotion editor.
3. Project creation, opening, and saving.
4. Local project persistence.
5. Supported video, image, and audio imports.
6. Asset preview and ordering.
7. Basic composition and timeline representation.
8. Aspect ratio, resolution, and frame-rate settings.
9. Main video preview.
10. At least one supported external AI provider.
11. Independent Brainstorming Agent and Editor Agent model assignments where supported.
12. Structured edit intents and validated operations.
13. Remotion composition generation.
14. Valid video rendering and export.
15. Rendering progress and recoverable errors.
16. Persistence and basic recovery.
17. Essential security and reliable production packaging.

### P1 — Next priority

- Expanded transition and motion libraries
- Richer text styling and captions
- Additional providers and model capabilities
- Voiceover generation
- Improved undo and redo
- Hardware-aware performance settings
- More timeline interactions

### P2 — Later enhancements

- Advanced visual effects
- Music generation
- Advanced thumbnail generation
- Expanded local model support
- More sophisticated editing
- Additional operating systems
- Plugin ecosystem

Validate these priorities against the reference UI, technical feasibility, licensing, and the smallest complete user workflow.

Maintain an explicit out-of-scope list. Do not implement P1 or P2 at the expense of a reliable P0 release.

## 18. Roadmap and Stage Management

Use these proposed stages as a starting point.

### Stage 0 — Discovery and repository assessment

- Inspect repository and reference files.
- Review Remotion capabilities and licensing.
- Identify existing code, dependencies, and constraints.
- Document assumptions and risks.

### Stage 1 — Product definition and architecture

- Finalize MVP requirements.
- Select the technology stack.
- Define system boundaries and contracts.
- Establish security and threat models.
- Specify the editor interaction model.

### Stage 2 — Technical proof of concept

- Verify desktop packaging.
- Verify local runtime startup.
- Build a minimal Remotion composition.
- Test preview and rendering.
- Verify native dependency distribution.
- Test AI integration and structured output.
- Validate architectural risks early.

### Stage 3 — Application foundation

- Build desktop launcher.
- Establish local application lifecycle.
- Implement persistence and migrations.
- Implement base UI and design system.
- Add asset import and validation.

### Stage 4 — Editor MVP

- Build the three-column editor.
- Implement asset ordering and basic composition.
- Implement preview and timeline representation.
- Add core presets and output settings.

### Stage 5 — AI orchestration

- Implement provider configuration.
- Implement both agents.
- Add structured intents and validation.
- Add conflict handling, persistence, and recovery.

### Stage 6 — Rendering and export

- Integrate rendering with the composition model.
- Implement progress, cancellation, and error handling.
- Verify dimensions, frame rate, duration, and playback.

### Stage 7 — Hardening and release

- Complete security reviews.
- Run functional, regression, performance, and packaging tests.
- Verify installation on a clean supported Windows environment.
- Document limitations.
- Produce reproducible release artifacts.

For each stage, define objectives, scope, dependencies, tasks, deliverables, risks, tests, acceptance criteria, entry and exit criteria, estimated effort, confidence, and blockers.

Distinguish estimates from commitments. Do not invent completion dates without realistic capacity assumptions.

## 19. QA, Testing, and Definition of Done

### Functional testing

Test project creation, saving, reopening, asset import, sequence ordering, design selection, AI instructions, rendering, and export.

### AI workflow testing

Test structured-output validation, ambiguous requests, invalid plans, unsupported operations, conflicts, retries, cancellation, provider errors, and recovery.

### Rendering testing

Verify dimensions, aspect ratio, frame rate, duration, audio synchronization, asset availability, and preview-to-export consistency.

### Security testing

Test local API authorization, file access restrictions, credential handling, malicious asset inputs, request forgery, unsafe execution paths, dependency integrity, and production artifact exposure.

### Performance testing

Measure representative workloads on documented hardware configurations. Establish realistic targets after the proof of concept.

### Packaging testing

Install and run on a clean supported Windows environment without preinstalled development tools.

Verify startup, shutdown, updates, uninstall behavior, persistence, and recovery.

### Definition of Done

A task is complete only when:

- Acceptance criteria are satisfied.
- Relevant automated tests pass.
- Important errors are handled.
- Security and privacy requirements are met.
- Documentation is updated.
- Dependencies and interfaces remain consistent.
- The feature is verified in the relevant environment.
- Limitations are documented.
- Changes are traceable to requirements or decisions.

A generated UI, untested code change, or successful compilation alone does not prove a feature is complete.

## 20. Coding-Agent Skills, Hooks, and Subagents

Inspect the supported conventions of the actual development environment.

Do not assume all coding agents interpret the same filenames, frontmatter, hooks, or permissions identically.

Separate:

1. Repository instructions.
2. Reusable development skills and workflow automation.
3. Runtime agents embedded in Expertmotion.

Potential development skills:

- Requirements analysis
- Architecture review
- Remotion integration
- UI implementation
- Database and migrations
- AI provider integration
- Agent workflow implementation
- Security review
- Testing and debugging
- Desktop packaging
- Documentation maintenance

For every skill, define purpose, activation criteria, inputs, outputs, tools, constraints, and validation.

Use supported hooks for deterministic checks such as formatting, type checking, tests, secret scanning, policy validation, and documentation requirements.

Define subagents only where responsibilities can be safely separated.

For each subagent, define scope, inputs, outputs, permissions, files it may modify, dependencies, validation, and integration owner.

Avoid concurrent modifications to shared schemas or architecture documents without explicit coordination.

A coordinating agent must integrate outputs, resolve conflicts, and verify the result.

## 21. Project Continuity

The project must remain resumable across LLM providers, models, accounts, and sessions.

Treat repository documentation as the durable source of truth rather than relying on hidden conversational memory.

### process.md

Record:

- Current stage
- Current objectives
- Completed tasks
- Files created or modified
- Verification performed and actual results
- Blockers
- Failed approaches and lessons
- Pending decisions
- Next actionable tasks
- Reproducible continuation steps

### memory.md

Record:

- Product vision and non-negotiable constraints
- Confirmed architecture decisions
- Technology stack and important versions
- Canonical documentation locations
- Critical contracts and schemas
- Important discoveries
- Known limitations
- Stable conventions
- Context another agent would otherwise need to rediscover

Use concise, structured entries. Do not duplicate the entire repository or conversation.

Update these files after meaningful work units, architecture decisions, milestones, failed experiments, and roadmap changes.

When context or token budget runs low, stop at a safe checkpoint and update continuity documentation.

The next agent must be able to resume by reading repository instructions, process.md, memory.md, the current stage plan, and relevant source files.

Never record API keys, passwords, credentials, or unnecessary personal information.

## 22. Execution Rules

1. Inspect the repository before making architectural assumptions.
2. Read the UI reference and Remotion materials before finalizing specifications.
3. Verify current external facts using authoritative sources.
4. Separate verified facts from assumptions and recommendations.
5. Record significant decisions and rationale.
6. Prefer simple, typed, testable architecture.
7. Avoid features that do not contribute to the MVP.
8. Do not describe placeholders as production-ready.
9. Do not silently omit difficult requirements.
10. Document the purpose, license, and operational implications of new dependencies.
11. Never execute arbitrary LLM-generated code without a validated execution boundary.
12. Never expose developer-owned secrets in the distributed executable.
13. Never promise that encryption or obfuscation makes reverse engineering impossible.
14. Never claim unverified builds, tests, or security reviews succeeded.
15. Maintain consistent terminology, schemas, and requirements.
16. Document conflicts and resolve them explicitly.
17. Make clearly labeled provisional decisions when safe.
18. Ask for clarification only when missing information materially blocks correct implementation.
19. Prioritize a complete, reliable end-to-end MVP.
20. Write all project documentation, technical specifications, agent instructions, and architecture decisions in English.

The application's eventual Indonesian UI may be localized separately.

## 23. Required Initial Deliverables

### Deliverable A — Repository and reference assessment

- Existing repository structure
- Available source files and conventions
- Analysis of the UI reference
- Findings from the introductory Remotion PDF
- Findings from official Remotion resources
- Initial feasibility and licensing assessment
- Gaps, conflicts, and risks

### Deliverable B — Product and architecture foundation

- MVP requirements and out-of-scope features
- Proposed architecture
- Technology stack comparison and recommendation
- Agent orchestration design
- Database and storage design
- Packaging and security strategy
- Initial UI/UX specification
- Requirements traceability structure

### Deliverable C — Execution framework

- Dependency-aware roadmap
- Stage gates and acceptance criteria
- QA and Definition of Done
- Development-agent instructions
- Skills, hooks, and subagent design
- process.md and memory.md

### Deliverable D — Technical proof-of-concept plan

Identify the highest-risk assumptions and define the smallest experiments needed to validate:

- Desktop packaging without manual runtime installation
- Remotion preview and rendering compatibility
- Native dependency distribution
- AI connectivity and structured outputs
- Local persistence and recovery
- Production artifact security
- Resource consumption on realistic hardware

Do not postpone high-risk technical tests until after the entire UI is implemented.

## 24. Final Operating Instruction

Start by inspecting the repository and available reference materials.

Establish the canonical documentation structure, assess technical risks, and produce the implementation-ready MVP blueprint.

Then proceed through the roadmap in dependency order. Implement and verify the smallest useful end-to-end vertical slice before expanding secondary features.

At the end of every meaningful stage:

1. Update relevant documentation.
2. Update process.md.
3. Update memory.md.
4. Run relevant verification steps.
5. Record actual results and unresolved issues.
6. Identify the next concrete tasks.

The objective is not merely a collection of planning documents. It is a coherent, technically feasible, security-conscious, well-documented foundation from which Expertmotion can be developed, tested, packaged, and maintained by engineering teams and AI coding agents.

**Product identity:** Expertmotion.

**Primary objective:** Make sophisticated motion-video creation accessible to nontechnical users through a local-first, AI-assisted desktop editor powered by Remotion.

**Primary release target:** A reliable Windows desktop executable that launches the Expertmotion editor, bundles required runtime dependencies, protects proprietary implementation details as realistically as possible, and supports a complete, verified MVP workflow from project creation to exported video.