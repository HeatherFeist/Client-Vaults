// agent.js
// -----------------------------------------------------------------------------
// The AI agent. You give it a plain-English prompt ("Add a new client, Bob's
// Bakery, and build them a lead-gen plan and funnel content") and it uses tools
// to actually do the work: create clients and write Markdown notes into vaults.
//
// It runs a small "tool loop": Claude asks to use a tool, we run it, hand back
// the result, and repeat until Claude has finished and gives a final answer.
// -----------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');
const store = require('./store');

const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-5';
const MAX_STEPS = 10;

const SYSTEM_PROMPT = `You are the assistant inside "Client Vaults", an app a business owner uses to manage
their clients. Each client has a vault: a folder of Markdown notes holding their business
profile, lead-generation plan, and marketing funnel content.

Your job is to help the owner:
- add new clients,
- write and improve their business profile,
- build practical, specific lead-generation plans, and
- write marketing funnel content (awareness, nurture, conversion).

Guidelines:
- Use the provided tools to make real changes. Don't just describe what you would do — do it.
- When asked to build a plan or content, actually write it into the relevant note using write_note
  (to replace) or append_note (to add on). Prefer clear, well-structured Markdown with headings,
  bullet points, and concrete, actionable specifics — real channel ideas, real offer angles,
  real post/email drafts — not vague placeholders.
- Standard note names in each vault are "Profile.md", "Lead Generation Plan.md", "Funnel Content.md",
  and "Notes.md". You may create additional notes when it helps (e.g. "Email Sequence.md").
- If the owner refers to a client you can't find, call list_clients to check, and create the client
  if that's clearly the intent.
- Keep the marketing advice grounded and realistic for a small business.
- After you finish, briefly summarize what you changed and in which client's vault.`;

const TOOLS = [
  {
    name: 'list_clients',
    description: 'List all existing clients with their id, name, and business.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_client',
    description: 'Create a new client. Returns the new client id and their access code. Seeds a starter vault.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Client or business name, e.g. "Bob\'s Bakery".' },
        business: { type: 'string', description: 'One-line description of what the business does.' },
        contactEmail: { type: 'string' },
        contactPhone: { type: 'string' },
        notes: { type: 'string', description: 'Any extra context to seed the Profile note with.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_notes',
    description: 'List the Markdown notes in a client vault.',
    input_schema: {
      type: 'object',
      properties: { clientId: { type: 'string' } },
      required: ['clientId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_note',
    description: 'Read the full contents of one note in a client vault.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        filename: { type: 'string', description: 'e.g. "Profile.md"' },
      },
      required: ['clientId', 'filename'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_note',
    description: 'Create or completely replace a note in a client vault with new Markdown content.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        filename: { type: 'string', description: 'e.g. "Lead Generation Plan.md"' },
        content: { type: 'string', description: 'The full Markdown content for the note.' },
      },
      required: ['clientId', 'filename', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_note',
    description: 'Append additional Markdown content to the end of an existing note (or create it).',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        filename: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['clientId', 'filename', 'content'],
      additionalProperties: false,
    },
  },
];

// Run a single tool call and return a plain-object result plus a human summary.
function runTool(name, input, { restrictClientId } = {}) {
  // When invoked from a specific client's page, keep the agent scoped to that client.
  if (restrictClientId && input && input.clientId && input.clientId !== restrictClientId) {
    return { error: `This agent is scoped to client "${restrictClientId}" and cannot touch other clients.` };
  }

  switch (name) {
    case 'list_clients':
      return { clients: store.listClients().map((c) => ({ id: c.id, name: c.name, business: c.business })) };

    case 'create_client': {
      const c = store.createClient(input);
      return { id: c.id, name: c.name, accessCode: c.accessCode };
    }

    case 'list_notes': {
      if (!store.getClient(input.clientId)) return { error: 'No such client.' };
      return { notes: store.listNotes(input.clientId).map((n) => n.name) };
    }

    case 'read_note': {
      const note = store.readNote(input.clientId, input.filename);
      return note ? { content: note.content } : { error: 'Note not found.' };
    }

    case 'write_note': {
      if (!store.getClient(input.clientId)) return { error: 'No such client.' };
      store.writeNote(input.clientId, input.filename, input.content);
      return { ok: true, wrote: input.filename };
    }

    case 'append_note': {
      if (!store.getClient(input.clientId)) return { error: 'No such client.' };
      store.appendNote(input.clientId, input.filename, input.content);
      return { ok: true, appended: input.filename };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function summarizeAction(name, input, result) {
  if (result && result.error) return `⚠️ ${name} failed: ${result.error}`;
  switch (name) {
    case 'create_client':
      return `Created client "${result.name}" (access code ${result.accessCode}).`;
    case 'write_note':
      return `Wrote "${input.filename}" in ${input.clientId}'s vault.`;
    case 'append_note':
      return `Added to "${input.filename}" in ${input.clientId}'s vault.`;
    case 'list_clients':
      return `Looked up the client list.`;
    case 'list_notes':
      return `Listed notes in ${input.clientId}'s vault.`;
    case 'read_note':
      return `Read "${input.filename}" from ${input.clientId}'s vault.`;
    default:
      return `Ran ${name}.`;
  }
}

async function runAgent({ prompt, clientId }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error(
      'The AI agent needs an Anthropic API key. Add ANTHROPIC_API_KEY to your .env file (see .env.example), then restart the app.'
    );
    err.code = 'NO_API_KEY';
    throw err;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let contextLine = '';
  if (clientId) {
    const c = store.getClient(clientId);
    if (c) {
      contextLine =
        `\n\nThe owner is currently viewing the vault for client "${c.name}" (id: ${c.id}). ` +
        `Assume requests refer to this client unless they clearly name a different one.`;
    }
  }

  const messages = [{ role: 'user', content: `${prompt}${contextLine}` }];
  const actions = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { reply: text || '(done)', actions };
    }

    // Run every tool the model asked for and feed the results back.
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let result;
      try {
        result = runTool(block.name, block.input || {}, { restrictClientId: clientId });
      } catch (e) {
        result = { error: e.message };
      }
      actions.push(summarizeAction(block.name, block.input || {}, result));
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    reply: "I reached the step limit while working. Here's what I got done so far — you can ask me to continue.",
    actions,
  };
}

module.exports = { runAgent, MODEL };
