# Prompt Builder

Build well-structured, role-based prompts for technical work. Pick a role, describe the task, choose context options, and copy a ready-to-use prompt.

## Run

```bash
cd prompt-builder
npm start          # or: node server.js
# open http://localhost:3000
```

Node 20.12+ is required. Use `npm run dev` to auto-restart on server changes. The prompt builder itself needs no dependencies; run `npm install` only if you want the AI features.

## AI features (optional)

Turn on **AI features** in the output panel to get two buttons. They are off by default, and each click makes a paid Claude API call:

- **✨ Refine with AI** improves the prompt, explains what changed and lists missing information. You can answer the questions and click **Add answers & rebuild** to add them to the Background context.
- **▶ Test it** runs the prompt and streams the answer. Closing the dialog or pressing **Stop** ends the call so no more tokens are spent.

Setup:

```bash
npm install
cp .env.example .env   # then set ANTHROPIC_API_KEY=sk-ant-...
npm start
```

The key stays on the server and is never sent to the browser. You can set `AI_MODEL` (default `claude-opus-5-5`) and `AI_EFFORT` (default `medium`) in `.env`. Token usage is shown after each call.

## Roles, reviewers and templates

- **Multiple roles:** click as many role cards as you need; click a selected card again to remove it. Each selected role is either:
  - an **Expert**, who shapes the answer. With two or more experts, the prompt describes a team that combines their expertise and principles and makes trade-offs explicit. Focus areas come from all the experts.
  - a **Reviewer**, who critiques the draft, for example an Architect reviewed by a Security Engineer. The prompt gets a *Review Perspectives* section asking the model to critique its draft from each reviewer's view and then revise it.

  Switch a role's mode in the list under the grid.
- **Custom roles:** click **＋ New role**, or **Customize a copy** on a built-in role. Custom roles are saved in your browser and marked *Custom*. **Copy JSON** gives you an entry you can paste into `data/roles.json` to make the role permanent for everyone.
- **Version history:** saving under an existing template name adds a new version (up to 20 per template). Click 🕘 to see what changed between versions, field by field, with a line diff for longer text, and to load any older version.
- **Import / export:** **Export** downloads all templates with their versions as one JSON file, plus any custom roles they use. **Import** merges a file in: same-named templates gain the missing versions, nothing is duplicated, and existing roles are never overwritten.

## Task guidance

Each task type in `data/options.json` has a `placeholder` and a `checklist` of what a good description includes (for example, Debug asks for the error message, steps to reproduce, expected versus actual behaviour, and what you've tried). **Insert outline** adds the missing items as headings, and each one is ticked once it appears as `Item:` in the description.

## How the prompt is structured

Each section is included only when it has content:

| Section | Source |
| --- | --- |
| **Role** | Persona, expertise and principles from `data/roles.json` |
| **Context** | Background text, tech stack, audience |
| **Task** | Task-type instruction + your description |
| **Focus Areas** | Role-specific focus areas you select |
| **Requirements & Constraints** | Constraint chips + custom lines |
| **Approach** | Reasoning instructions (assumptions, self-review…) |
| **Examples** | Optional few-shot example |
| **Output Format** | Format, tone, length |
| **Success Criteria** | How to judge a good answer |

You can render the prompt in three styles: **Markdown**, **XML tags** (best for Claude) or **Plain text**.

## Extending

All content is data-driven. Edit the JSON files and refresh the page; no restart is needed.

- **Add a role:** append an object to `data/roles.json`:
  ```json
  {
    "id": "senior-product-manager",
    "title": "Senior Product Manager",
    "category": "Product",
    "icon": "📈",
    "description": "Short description shown on the card.",
    "persona": "You are a Senior Product Manager with…",
    "expertise": ["…"],
    "focusAreas": ["…"],
    "principles": ["…"]
  }
  ```
  New categories show up automatically as filter chips.
- **Add options:** add entries to any list in `data/options.json` (`taskTypes`, `constraints`, `reasoning`, `outputFormats`, `audiences`, `tones`, `lengths`, `techStack` groups). Each `instruction` is the exact text inserted into the prompt.

## API

```bash
curl -X POST localhost:3000/api/prompt -H 'Content-Type: application/json' \
  -d '{"roleId":"senior-backend-developer","taskType":"api-design","description":"Design an orders API","style":"xml"}'
```

The response has the shape `{ prompt, tokens, score, tips }`. `GET /api/roles` and `GET /api/options` return the raw data.

## Project layout

```
server.js                 zero-dependency HTTP server + API
data/roles.json           role definitions
data/options.json         all other selectable context
public/index.html         UI
public/css/styles.css     styling (light/dark themes)
public/js/prompt-builder.js  prompt engine (shared by browser + server)
public/js/app.js          UI controller
```
